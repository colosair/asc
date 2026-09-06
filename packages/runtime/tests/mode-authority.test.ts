// AUTO 로 들어가는 문과 AUTO 에서 나가는 문 (0.8.0 보정 §B·§C·§J·§Q).
//
// 이 파일은 CLI 를 **프로세스로** 돌린다. 검사하려는 것이 "이 명령을 쳤을 때 무엇이
// 일어나는가" 이고, 그것은 in-process 호출로는 재현되지 않는다(지원 하한 아래의 Node 에서
// CLI 는 자기를 다시 실행한다).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const CLI = join(process.cwd(), 'cli', 'asc.ts')

function git(cwd: string, args: string[]): void {
  spawnSync('git', args, { cwd, encoding: 'utf8' })
}

/** 실제로 붙은 workspace 하나. `asc init` 이 만드는 그대로를 쓴다. */
async function attached(): Promise<{ repo: string; home: string; root: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), 'asc-auth-'))
  const repo = join(base, 'repo')
  const home = join(base, 'home')
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' })
  await writeFile(join(repo, 'README.md'), '# project\n', 'utf8')
  git(repo, ['add', '-A'])
  git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  git(repo, ['remote', 'add', 'origin', 'git@lab.example.com:group/project.git'])

  const init = run(repo, home, ['init', '--profile', 'pilot-local'])
  assert.equal(init.code, 0, init.stderr)
  const index = JSON.parse(await readFile(join(home, 'workspace-index.json'), 'utf8')) as {
    locators: Record<string, { root: string }>
  }
  const root = Object.values(index.locators)[0]!.root
  return { repo, home, root, cleanup: () => rm(base, { recursive: true, force: true }) }
}

function run(cwd: string, home: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
    cwd,
    env: { ...process.env, ASC_HOME: home },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** policy scope 에 mode 를 직접 적는다 — CLI 의 activation 문을 지나지 않고 상태만 만든다. */
async function setMode(root: string, mode: 'MANUAL' | 'AUTO'): Promise<void> {
  const file = join(root, 'adapters', 'policy', 'execution-mode.json')
  await mkdir(join(root, 'adapters', 'policy'), { recursive: true })
  await writeFile(
    file,
    JSON.stringify({
      key: 'execution-mode',
      value: JSON.stringify({ mode, since: '2026-09-07T00:00:00.000Z', by: 'controller-a' }),
    }),
    'utf8',
  )
}

const identities = (root: string, map: Record<string, string[]>) =>
  writeFile(join(root, 'identities.json'), JSON.stringify(map, null, 2), 'utf8')

describe('T-02 — AUTO 는 경로 전체가 설 때만 켜진다', () => {
  it('control-plane 하나로는 부족하다 — 나갈 통로가 없으면 거부하고 mode 를 그대로 둔다', async () => {
    const { repo, home, root, cleanup } = await attached()
    try {
      await identities(root, { 'controller-a': ['local:colosair'] })
      const raised = run(repo, home, ['mode', 'auto', '--json'])
      assert.equal(raised.code, 1)
      const verdict = JSON.parse(raised.stdout) as {
        applied: boolean
        autoReadiness: { axes: { axis: string; state: string }[] }
      }
      assert.equal(verdict.applied, false)
      // 검수·되돌림·통로까지 축으로 서 있어야 한다 (§C).
      const axes = verdict.autoReadiness.axes.map((axis) => axis.axis)
      for (const axis of ['control-plane', 'controller', 'binding', 'executor', 'provider', 'review', 'verify', 'guard', 'host']) {
        assert.ok(axes.includes(axis), `${axis} 축이 없다`)
      }
      // 기록은 그대로 없다 — 실패한 전환은 아무것도 남기지 않는다.
      const status = run(repo, home, ['status', '--json'])
      const state = JSON.parse(status.stdout) as { executionMode: { mode: string; chosen: boolean } }
      assert.deepEqual(state.executionMode, { mode: 'MANUAL', chosen: false })
    } finally {
      await cleanup()
    }
  })
})

describe('T-07 — AUTO 에서 내려오는 것은 Controller 의 자리다 (§J)', () => {
  it('권한 없이 부른 `asc mode manual` 은 거부되고 AUTO 가 유지된다', async () => {
    const { repo, home, root, cleanup } = await attached()
    try {
      await identities(root, { 'controller-a': ['local:colosair'] })
      await setMode(root, 'AUTO')

      const attempted = run(repo, home, ['mode', 'manual'])
      assert.equal(attempted.code, 2)
      assert.match(attempted.stderr, /controller decision/)

      const after = run(repo, home, ['mode', '--json'])
      assert.equal((JSON.parse(after.stdout) as { mode: string }).mode, 'AUTO', 'mode 가 움직이지 않았다')
    } finally {
      await cleanup()
    }
  })

  it('권한이 있으면 내려온다 — 출구는 닫혀 있지 않다', async () => {
    const { repo, home, root, cleanup } = await attached()
    try {
      await identities(root, { 'controller-a': ['local:colosair'] })
      await setMode(root, 'AUTO')

      const lowered = run(repo, home, ['mode', 'manual', '--as', 'controller-a', '--json'])
      assert.equal(lowered.code, 0, lowered.stderr)
      assert.equal((JSON.parse(lowered.stdout) as { mode: string }).mode, 'MANUAL')
    } finally {
      await cleanup()
    }
  })

  it('AUTO 에서 enforcement 를 걷어내는 명령도 같은 문을 지난다', async () => {
    const { repo, home, root, cleanup } = await attached()
    try {
      await identities(root, { 'controller-a': ['local:colosair'] })
      await setMode(root, 'AUTO')

      // Host 가 `Bash(asc:*)` 를 허용한 것은 ASC 가 갇히지 않게 하려는 것이지, Agent 가
      // 자기 감시를 스스로 떼어내라는 뜻이 아니다.
      const removed = run(repo, home, ['host', 'claude', 'uninstall'])
      assert.equal(removed.code, 2)
      assert.match(removed.stderr, /controller decision/)

      const swapped = run(repo, home, ['runtime', 'use', 'development', repo])
      assert.equal(swapped.code, 2)
      assert.match(swapped.stderr, /controller decision/)
    } finally {
      await cleanup()
    }
  })
})

describe('T-13 — 돌고 있는 일을 몰래 버리지 않는다 (§Q)', () => {
  it('활성 세션이 있으면 uninstall 은 거부하고 다음 걸음을 준다', async () => {
    const { repo, home, cleanup } = await attached()
    try {
      const issued = run(repo, home, [
        'session', 'issue', 'S-20260907-01',
        '--role', 'implementer',
        '--goal', '무언가를 만든다',
      ])
      assert.equal(issued.code, 0, issued.stderr)
      assert.equal(run(repo, home, ['session', 'start', 'S-20260907-01']).code, 0)

      const removed = run(repo, home, ['uninstall'])
      assert.equal(removed.code, 2)
      assert.match(removed.stderr, /S-20260907-01/)
      assert.match(removed.stderr, /asc work finish/)
      assert.match(removed.stderr, /Nothing was removed/)
    } finally {
      await cleanup()
    }
  })

  it('plan 도 그 사실을 함께 말한다 — 그리고 아무것도 지우지 않는다', async () => {
    const { repo, home, cleanup } = await attached()
    try {
      run(repo, home, ['session', 'issue', 'S-20260907-02', '--role', 'implementer', '--goal', '진행 중'])
      run(repo, home, ['session', 'start', 'S-20260907-02'])

      const planned = run(repo, home, ['uninstall', 'plan', '--json'])
      assert.equal(planned.code, 0)
      const plan = JSON.parse(planned.stdout) as { blockedBy?: { sessions: string[] } }
      assert.deepEqual(plan.blockedBy?.sessions, ['S-20260907-02'])
    } finally {
      await cleanup()
    }
  })
})

describe('T-09 — 호출됐다는 사실이 승인이 아니다 (§R)', () => {
  it('사람이 준 내용과 정한 사람이 없으면 Grant 가 만들어지지 않는다', async () => {
    const { repo, home, cleanup } = await attached()
    try {
      run(repo, home, ['session', 'issue', 'S-20260907-03', '--role', 'implementer', '--goal', '게시한다'])
      run(repo, home, ['session', 'start', 'S-20260907-03'])

      const published = run(repo, home, [
        'work', 'publish', 'S-20260907-03',
        '--action', 'gitlab.note.create',
        '--target', 'group/project!7',
      ])
      assert.notEqual(published.code, 0)
      // Grant 는 하나도 만들어지지 않았다.
      const grants = run(repo, home, ['session', 'audit', 'S-20260907-03'])
      assert.doesNotMatch(grants.stdout, /grant_issued/)
    } finally {
      await cleanup()
    }
  })
})
