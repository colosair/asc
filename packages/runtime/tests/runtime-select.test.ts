// B-70 Gate — 어느 build를 부를 것인가 (C-14 §4·§5, 불변식 ②·④·⑤).
//
// 두 가지가 핵심이다: **거절은 resolver에서 끝난다**(나중에 module-not-found를 맞지
// 않는다), 그리고 **선택을 바꾸는 것은 project를 바꾸는 것이 아니다**.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  RUNTIME_ENTRY,
  RUNTIME_PACKAGE,
  normalizeSelection,
  readRuntimeSelection,
  resolveRuntimeTarget,
  runtimeSelectionLine,
  selectionPath,
  writeRuntimeSelection,
} from '../core/distribution/runtime-select.ts'

const CLI = join(import.meta.dirname, '..', 'cli', 'asc.ts')

const dirs: string[] = []
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 진짜처럼 보이는 checkout을 만든다. built 여부를 골라서. */
async function checkout(opts: { name?: string; built: boolean }): Promise<string> {
  const dir = await temp('asc-checkout-')
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: opts.name ?? RUNTIME_PACKAGE }), 'utf8')
  if (opts.built) {
    await mkdir(join(dir, 'dist', 'cli'), { recursive: true })
    await writeFile(join(dir, RUNTIME_ENTRY), '// built\n', 'utf8')
  }
  return dir
}

describe('B-70 Gate — 선택 파일 (C-14 §5)', () => {
  it('왕복한다 — package', async () => {
    const home = await temp('asc-home-')
    await writeRuntimeSelection(home, { version: 1, runtime: { mode: 'package' } })
    assert.deepEqual(await readRuntimeSelection(home), { version: 1, runtime: { mode: 'package' } })
  })

  it('왕복한다 — development, Windows 형태 경로 포함', async () => {
    const home = await temp('asc-home-')
    const source = 'C:\\projects\\asc\\packages\\runtime'
    await writeRuntimeSelection(home, { version: 1, runtime: { mode: 'development', source } })
    const read = await readRuntimeSelection(home)
    assert.equal(read?.runtime.mode === 'development' && read.runtime.source, source)
  })

  it('없는 파일은 undefined다 — 첫 실행이 설정을 요구하지 않는다', async () => {
    assert.equal(await readRuntimeSelection(await temp('asc-home-')), undefined)
  })

  it('읽지 못하는 선택은 없는 것으로 본다', async () => {
    const home = await temp('asc-home-')
    await writeFile(selectionPath(home), 'not json at all', 'utf8')
    assert.equal(await readRuntimeSelection(home), undefined)
  })

  it('형식이 어긋나면 받아들이지 않는다 — 반쯤 해석하지 않는다', () => {
    assert.equal(normalizeSelection({ version: 2, runtime: { mode: 'package' } }), undefined)
    assert.equal(normalizeSelection({ version: 1, runtime: { mode: 'weird' } }), undefined)
    assert.equal(normalizeSelection({ version: 1, runtime: { mode: 'development' } }), undefined)
    assert.equal(normalizeSelection({ version: 1, runtime: { mode: 'development', source: '  ' } }), undefined)
    assert.equal(normalizeSelection(null), undefined)
  })

  it('credential도 project key도 담지 않는다', async () => {
    const home = await temp('asc-home-')
    await writeRuntimeSelection(home, { version: 1, runtime: { mode: 'development', source: '/x' } })
    const raw = await readFile(selectionPath(home), 'utf8')
    assert.doesNotMatch(raw, /token|secret|password|profile|workspace/i)
  })
})

describe('B-70 Gate — resolver가 거절을 끝낸다 (C-14 §4.1)', () => {
  it('선택이 없으면 지금 실행물이 답이다', async () => {
    assert.deepEqual(await resolveRuntimeTarget(undefined), { kind: 'package' })
  })

  it('빌드된 checkout은 그 진입점으로 간다', async () => {
    const source = await checkout({ built: true })
    const target = await resolveRuntimeTarget({ version: 1, runtime: { mode: 'development', source } })
    assert.equal('kind' in target && target.kind === 'development' ? target.entry : null, join(source, RUNTIME_ENTRY))
  })

  it('없는 경로는 무엇을 하라고 말하며 거절한다', async () => {
    const target = await resolveRuntimeTarget({ version: 1, runtime: { mode: 'development', source: '/no/such' } })
    assert.equal('code' in target && target.code, 'ASC_DEVELOPMENT_SOURCE_INVALID')
    assert.match(('nextCommand' in target && target.nextCommand) || '', /runtime use development/)
  })

  it('ASC가 아닌 저장소는 이름으로 거절한다', async () => {
    const source = await checkout({ name: 'something-else', built: true })
    const target = await resolveRuntimeTarget({ version: 1, runtime: { mode: 'development', source } })
    assert.equal('code' in target, true)
    assert.match(('detail' in target && target.detail) || '', /something-else/)
  })

  it('빌드 안 된 checkout은 build 하라고 말한다 — 경로 문제와 구분한다', async () => {
    const source = await checkout({ built: false })
    const target = await resolveRuntimeTarget({ version: 1, runtime: { mode: 'development', source } })
    assert.equal('nextCommand' in target && target.nextCommand, 'npm run build')
  })

  it('사람이 읽는 줄이 지금 무엇이 도는지 먼저 말한다', async () => {
    assert.match(runtimeSelectionLine(await resolveRuntimeTarget(undefined)), /package/)
  })
})

describe('B-70 Gate — 선택 변경은 project 변경이 아니다 (불변식 ⑤)', () => {
  const run = (cwd: string, home: string, args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ASC_HOME: home, NO_COLOR: '1' },
      encoding: 'utf8',
    })

  it('나쁜 선택은 저장하지 않는다 — 다음 명령에서 죽게 두지 않는다', async () => {
    const home = await temp('asc-home-')
    const work = await temp('asc-work-')
    const bad = run(work, home, ['runtime', 'use', 'development', join(work, 'nope')])
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /ASC_DEVELOPMENT_SOURCE_INVALID/)
    assert.equal(await readRuntimeSelection(home), undefined, '거절한 선택이 파일에 남았다')
  })

  it('선택을 바꿔도 저장소에는 아무 일도 없다', async () => {
    const home = await temp('asc-home-')
    const work = await temp('asc-work-')
    await writeFile(join(work, 'a.txt'), 'x\n', 'utf8')
    spawnSync('git', ['init', '-q', work])

    const porcelain = () => spawnSync('git', ['status', '--porcelain'], { cwd: work, encoding: 'utf8' }).stdout
    const before = porcelain()

    const ok = run(work, home, ['runtime', 'use', 'package'])
    assert.equal(ok.status, 0)
    assert.equal(porcelain(), before, 'runtime 선택이 저장소 상태를 바꿨다')
    assert.equal(await readFile(join(work, 'a.txt'), 'utf8'), 'x\n')
  })

  it('깨진 선택이어도 그것을 고치는 명령은 돈다 — 사람이 갇히지 않는다', async () => {
    const home = await temp('asc-home-')
    const work = await temp('asc-work-')
    await writeRuntimeSelection(home, { version: 1, runtime: { mode: 'development', source: '/no/such' } })

    const status = run(work, home, ['runtime', 'status'])
    assert.equal(status.status, 1)
    assert.match(status.stderr, /ASC_DEVELOPMENT_SOURCE_INVALID/)

    const fixed = run(work, home, ['runtime', 'use', 'package'])
    assert.equal(fixed.status, 0)
    assert.deepEqual(await readRuntimeSelection(home), { version: 1, runtime: { mode: 'package' } })
  })

  it('붙지 않은 곳에서도 답한다 — project와 무관한 질문이다', async () => {
    const home = await temp('asc-home-')
    const work = await temp('asc-work-')
    const status = run(work, home, ['runtime', 'status'])
    assert.equal(status.status, 0)
    assert.match(status.stdout, /package/)
  })
})
