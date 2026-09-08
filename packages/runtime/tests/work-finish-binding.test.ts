// #63 — 끝난 세션은 Run 도 놓는다.
//
// 0.8.0 노트는 `asc work finish` 가 "writes the handoff, releases the physical binding,
// collects and archives in one command" 라고 적었는데, 넷 중 셋만 일어났다. 빠진 하나가
// 하필 **그 Run 이 다음 일을 시작할 수 있는지**를 정하는 것이었다.
//
// 사람이 `asc host claude release` 를 손으로 칠 때까지 그 Run 은 묶여 있고, finish 는
// 그 사실을 말하지 않은 채 성공을 보고했다. 0.8.1 dogfood 회차에서 세 번 부딪히고 나서야
// 결함으로 이름이 붙었다 — 그만큼 사람 실수로 읽히기 쉬운 모양이다.
//
// 여기서는 CLI 를 실제로 돌린다. 이 결함은 `bindings.release` 안에 있던 것이 아니라
// **finish 가 그것을 부르지 않는다**는 연결의 부재였으므로, 연결을 지나는 경로로만 잡힌다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const CLI = new URL('../cli/asc.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function run(cwd: string, home: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
    cwd,
    env: { ...process.env, ASC_HOME: home },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function attached(): Promise<{ repo: string; home: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), 'asc-finish-'))
  const repo = join(base, 'repo')
  const home = join(base, 'home')
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' })
  await writeFile(join(repo, 'README.md'), '# project\n', 'utf8')
  spawnSync('git', ['add', '-A'], { cwd: repo })
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
  spawnSync('git', ['remote', 'add', 'origin', 'git@lab.example.com:group/project.git'], { cwd: repo })
  const init = run(repo, home, ['init', '--profile', 'pilot-local'])
  assert.equal(init.code, 0, init.stderr)
  return { repo, home, cleanup: () => rm(base, { recursive: true, force: true }) }
}

const PHYS = '11111111-2222-4333-8444-555555555555'

/** 세션 하나를 발급하고 시작해 이 Run 에 묶는다. */
function hold(repo: string, home: string, id: string, goal: string): void {
  assert.equal(run(repo, home, ['session', 'issue', id, '--role', 'implementer', '--goal', goal]).code, 0)
  assert.equal(run(repo, home, ['session', 'start', id]).code, 0)
  const bound = run(repo, home, ['host', 'claude', 'bind', id, '--physical', PHYS])
  assert.equal(bound.code, 0, bound.stderr)
}

describe('#63 — asc work finish 가 physical binding 을 놓는다', () => {
  it('끝낸 뒤 같은 Run 이 다음 세션을 바로 잡는다', async () => {
    const { repo, home, cleanup } = await attached()
    try {
      hold(repo, home, 'S-20260907-01', '첫 번째')

      const finished = run(repo, home, [
        'work', 'finish', 'S-20260907-01',
        '--physical', PHYS,
        '--verified', '검증했다',
        '--next', '다음',
        '--as', 'colosair',
      ])
      assert.equal(finished.code, 0, finished.stderr)
      assert.match(finished.stdout, /ownership released/)

      // 이것이 결함의 실제 증상이었다 — finish 뒤의 bind 가 거부됐다
      assert.equal(run(repo, home, ['session', 'issue', 'S-20260907-02', '--role', 'implementer', '--goal', '두 번째']).code, 0)
      assert.equal(run(repo, home, ['session', 'start', 'S-20260907-02']).code, 0)
      const next = run(repo, home, ['host', 'claude', 'bind', 'S-20260907-02', '--physical', PHYS])
      assert.equal(next.code, 0, next.stderr)
    } finally {
      await cleanup()
    }
  })

  it('결합 기록 자체가 사라진다 — 화면 문구만 바뀌는 것이 아니다', async () => {
    const { repo, home, cleanup } = await attached()
    try {
      hold(repo, home, 'S-20260907-01', '첫 번째')
      const index = JSON.parse(await readFile(join(home, 'workspace-index.json'), 'utf8')) as {
        locators: Record<string, { root: string }>
      }
      const root = Object.values(index.locators)[0]!.root
      const record = join(root, 'adapters', 'claude-code', 'runtime-binding-S-20260907-01.json')
      assert.ok(await readFile(record, 'utf8').then(() => true).catch(() => false), '묶인 상태를 못 만들었다')

      run(repo, home, ['work', 'finish', 'S-20260907-01', '--physical', PHYS, '--verified', 'v', '--next', 'n', '--as', 'colosair'])

      // updatedAt 만 바뀌고 파일이 남던 것이 #63 의 관측이었다
      assert.equal(await readFile(record, 'utf8').then(() => true).catch(() => false), false)
    } finally {
      await cleanup()
    }
  })


  it('끝난 세션이 Run 을 쥐고 있으면 status 가 그것을 든다', async () => {
    // stale() 은 이 자리를 못 본다 — 이력으로만 판정하는데 RELEASED 가 안 남은 결합에는
    // 볼 이력이 없다. 그래서 실기계에서 여섯 개가 일주일 동안 아무 화면에도 안 나왔다.
    const { repo, home, cleanup } = await attached()
    try {
      hold(repo, home, 'S-20260907-01', '끝날 것')
      // finish 를 거치지 않고 세션만 끝낸다 — 이 결함이 남긴 상태를 그대로 만든다
      assert.equal(
        run(repo, home, ['session', 'done', 'S-20260907-01', '--physical', PHYS, '--verified', 'v', '--next', 'n']).code,
        0,
      )
      const status = run(repo, home, ['status'])
      assert.match(status.stdout, /finished session\(s\) still hold a Run/)
      assert.match(status.stdout, /S-20260907-01/)
    } finally {
      await cleanup()
    }
  })

  it('끝난 세션이 붙들고 있는 것과 살아 있는 세션을 잡고 있는 것을 갈라 말한다', async () => {
    // 하나는 놓아야 할 잔재이고 하나는 설계대로다. 같은 문장으로 말하던 동안 앞의 경우가
    // 세 번이나 사람 실수로 읽혔다.
    const { repo, home, cleanup } = await attached()
    try {
      hold(repo, home, 'S-20260907-01', '살아 있는 것')
      assert.equal(run(repo, home, ['session', 'issue', 'S-20260907-02', '--role', 'implementer', '--goal', '다른 것']).code, 0)
      assert.equal(run(repo, home, ['session', 'start', 'S-20260907-02']).code, 0)

      const live = run(repo, home, ['host', 'claude', 'bind', 'S-20260907-02', '--physical', PHYS])
      assert.equal(live.code, 1)
      assert.match(live.stderr, /한 Run 은 한 세션만 잡는다/)
      assert.match(live.stderr, /다른 Run 으로/)
      assert.doesNotMatch(live.stderr, /끝난 세션/)
    } finally {
      await cleanup()
    }
  })
})
