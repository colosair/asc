// `asc update` — 갈아 끼우는 판정 (C-14 §3 의 연장).
//
// 이 라운드에 설치본을 다섯 번 갈아 끼웠고, 매번 사람이 구본을 먼저 지우고 setup 을 통째로
// 다시 돌렸다. 그 순서가 실제로 위험했다는 것이 여기 있는 검사들의 출처다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { describe, it } from 'node:test'

import { planUpdate, requiredMajorFrom, UPDATE_ORDER, updateLine } from '../core/distribution/update.ts'

const base = { executableVisible: true, nodeVersion: 'v24.4.0' } as const

describe('planUpdate — 무엇을 할 것인가', () => {
  it('같은 버전이면 아무 것도 하지 않는다', () => {
    const plan = planUpdate({ ...base, installed: '0.6.0', latest: '0.6.0' })
    assert.equal(plan.state, 'CURRENT')
    assert.deepEqual(plan.steps, [])
  })

  it('낡았으면 정해진 순서로 계획한다', () => {
    const plan = planUpdate({ ...base, installed: '0.5.4', latest: '0.6.0' })
    assert.equal(plan.state, 'UPDATE_AVAILABLE')
    assert.deepEqual(plan.steps, [...UPDATE_ORDER])
    assert.equal(plan.rollbackTo, '0.5.4', '되돌릴 자리를 계획 단계에서 정해 둔다')
  })

  it('설치된 적이 없으면 되돌릴 곳도 없다', () => {
    const plan = planUpdate({ ...base, executableVisible: false, latest: '0.6.0' })
    assert.equal(plan.state, 'UPDATE_AVAILABLE')
    assert.equal(plan.rollbackTo, undefined, '없던 것으로 되돌릴 수는 없다')
    assert.match(updateLine(plan), /Not installed/)
  })

  it('registry 를 못 물으면 최신이라고 말하지 않는다', () => {
    const plan = planUpdate({ ...base, installed: '0.5.4' })
    assert.equal(plan.state, 'UNKNOWN')
    assert.deepEqual(plan.steps, [], '모르는 채로 설치하지 않는다')
    assert.match(plan.detail ?? '', /registry/)
  })

  it('요구 Node 가 이 기계에 없으면 설치하지 않는다', () => {
    const plan = planUpdate({
      ...base,
      nodeVersion: 'v22.19.0',
      installed: '0.5.4',
      latest: '0.6.0',
      requiredNodeMajor: 24,
    })
    assert.equal(plan.state, 'INCOMPATIBLE')
    assert.deepEqual(plan.steps, [], '깨진 설치를 만들어 놓고 실패하지 않는다')
  })

  it('낮은 Node 로 돌고 있어도 이 기계에 후보가 있으면 진행한다', () => {
    const plan = planUpdate({
      ...base,
      nodeVersion: 'v22.19.0',
      nodeCandidates: [{ path: '/opt/homebrew/opt/node@24/bin/node', version: 'v24.9.0' }],
      installed: '0.5.4',
      latest: '0.6.0',
      requiredNodeMajor: 24,
    })
    assert.equal(plan.state, 'UPDATE_AVAILABLE')
  })

  it('설치는 됐는데 부를 수 없으면 그 사실이 먼저 나온다', () => {
    const plan = planUpdate({ ...base, executableVisible: false, installed: '0.5.4', latest: '0.6.0' })
    assert.equal(plan.state, 'BROKEN')
    assert.equal(plan.rollbackTo, '0.5.4')
    assert.match(plan.detail ?? '', /not visible/)
  })

  it('같은 버전이어도 실행물이 안 보이면 CURRENT 가 아니다', () => {
    // "설치돼 있으니 최신" 으로 답하면 사람은 부를 수 없는 명령을 최신이라고 믿는다.
    const plan = planUpdate({ ...base, executableVisible: false, installed: '0.6.0', latest: '0.6.0' })
    assert.equal(plan.state, 'BROKEN')
  })
})

describe('순서 불변식 — 놓고 나서 확인한다', () => {
  it('설치가 등록물 수렴보다 앞이다', () => {
    const steps = planUpdate({ ...base, installed: '0.5.4', latest: '0.6.0' }).steps
    assert.ok(steps.indexOf('install') < steps.indexOf('converge-service'))
    assert.ok(steps.indexOf('install') < steps.indexOf('verify-install'))
    assert.equal(steps.at(-1), 'verify-health', '마지막은 언제나 확인이다')
  })

  it('삭제 단계가 존재하지 않는다', () => {
    // 구본을 먼저 지우면 실패했을 때 아무것도 안 남는다. 그 단계는 어휘에 없다.
    assert.deepEqual(
      UPDATE_ORDER.filter((step) => /remove|delete|uninstall|clean/.test(step)),
      [],
    )
  })
})

describe('engines 읽기 — 모르는 것은 모른다고 한다', () => {
  it('흔한 형태를 읽는다', () => {
    assert.equal(requiredMajorFrom('>=24'), 24)
    assert.equal(requiredMajorFrom('>=24.0.0 <27'), 24)
    assert.equal(requiredMajorFrom('^24.1.0'), 24)
  })

  it('못 읽으면 undefined — 0 이나 큰 수로 뭉개지 않는다', () => {
    assert.equal(requiredMajorFrom(undefined), undefined)
    assert.equal(requiredMajorFrom('*'), undefined)
    assert.equal(requiredMajorFrom(''), undefined)
  })
})


const CLI = join(process.cwd(), 'cli', 'asc.ts')

/** `~/.asc` 를 통째로 훑는다 — 파일 목록과 내용 둘 다. */
async function ascHomeSnapshot(home: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else files[relative(home, full).split(sep).join('/')] = await readFile(full, 'utf8').catch(() => '')
    }
  }
  await walk(home)
  return files
}

describe('상태를 다시 정하지 않는다 — 이 명령의 존재 이유', () => {
  it('읽기 경로는 `~/.asc` 를 한 바이트도 바꾸지 않는다', async () => {
    const base = await mkdtemp(join(tmpdir(), 'asc-update-'))
    const home = join(base, 'asc')
    try {
      // 먼저 이 machine 이 아는 것을 만들어 둔다 — 빈 곳에서 "안 바뀌었다" 는 증거가 약하다.
      spawnSync(process.execPath, [CLI, 'runtime', 'list', '--json'], {
        env: { ...process.env, ASC_HOME: home, ASC_SERVICE: 'off' },
        encoding: 'utf8',
      })
      const before = await ascHomeSnapshot(home)

      const result = spawnSync(process.execPath, [CLI, 'update', 'plan', '--json'], {
        env: { ...process.env, ASC_HOME: home, ASC_SERVICE: 'off' },
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      const plan = JSON.parse(result.stdout) as { state: string; steps: string[] }
      assert.ok(
        ['CURRENT', 'UPDATE_AVAILABLE', 'UNKNOWN', 'BROKEN', 'INCOMPATIBLE'].includes(plan.state),
        result.stdout,
      )

      assert.deepEqual(await ascHomeSnapshot(home), before, 'plan 이 상태를 건드렸다')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('update 경로가 setup 재실행을 부르지 않는다', async () => {
    // 이번 라운드에 사람이 손으로 한 것이 바로 그것이었다 — `setup apply` 는 profile ·
    // binding · 정본을 **다시 추론**하는 경로이고, 업데이트는 그 위에서 실행본만 바꾼다.
    const source = await readFile(CLI, 'utf8')
    const start = source.indexOf('async function runUpdate(')
    const end = source.indexOf('async function runRuntimeService(')
    const block = source.slice(start, end)
    assert.ok(start > 0 && end > start)

    for (const forbidden of ['runSetup', 'runProfileAdopt', 'applySetup', 'relock', 'writeProfile', 'uninstall(']) {
      assert.ok(!block.includes(forbidden), `update 경로가 ${forbidden} 를 부른다`)
    }
  })
})


describe('갱신은 새 build 가 한다 (0.7.1)', () => {
  it('update 경로가 이 프로세스의 host 설치 함수를 부르지 않는다', async () => {
    // 실기계에서 update 가 "host: …/SKILL.md" 를 적고 끝났는데 probe 는 여전히
    // INSTALLED_STALE 이었다. 갱신했다고 말하면서 **교체되기 전 build 의 내용**을 다시
    // 쓴 것이다 — 이 프로세스의 hookScript() 는 옛 내용을 만든다.
    const source = await readFile(CLI, 'utf8')
    const start = source.indexOf('async function applyUpdate(')
    const end = source.indexOf('async function refreshWithNewRuntime(')
    assert.ok(start > 0 && end > start)
    const block = source.slice(start, end)

    assert.ok(!/\binstall\(hostPaths\(\)/.test(block), 'update 가 자기 build 로 host 를 쓴다')
    assert.match(block, /refreshWithNewRuntime\(\)/)
  })

  it('갱신은 전역 실행물을 통해 나간다', async () => {
    const source = await readFile(CLI, 'utf8')
    const start = source.indexOf('async function refreshWithNewRuntime(')
    const block = source.slice(start, source.indexOf('\n}', start))

    assert.match(block, /globalRuntimeEntry\(\)/, '새로 설치된 자리를 찾는다')
    // 새 build 가 부르는 것은 그 build 의 `asc refresh` 다 — update 와 refresh 가 각자
    // host 를 갱신하면 언젠가 서로 다른 것을 쓴다 (§25).
    assert.match(block, /\[entry, 'refresh'\]/)
    // 못 찾으면 조용히 넘어가지 않는다 — 낡은 hook 이 새 runtime 옆에 남는다
    assert.match(block, /could not find the installed runtime/)
  })
})
