// 0.8.0 보정 라운드 — 기록 없음 / 못 읽음, 그리고 안전을 낮추는 결정 (P0-1 · P0-2~4).
//
// 두 사실을 가르는 것이 이 파일의 전부다:
//
//   기록이 없다   아무도 고르지 않았다        → 강제 없음
//   못 읽는다     무엇이 저장돼 있었는지 모른다 → 밖으로 나가는 raw 쓰기는 나가지 않는다
//
// 그리고 강제를 낮추는 것은 `--as` 한 줄이 아니라 사람이 남긴 결정 하나여야 한다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { hookScript } from '../adapters/claude-code/guard.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { enforcementOf, readExecutionMode, writeExecutionMode } from '../core/policy/execution-mode.ts'
import { tempDir } from './support/temp.ts'

const NOW = '2026-09-07T12:00:00+09:00'
const CLI = join(process.cwd(), 'cli', 'asc.ts')

describe('P0-1 — 기록 없음과 읽기 실패는 다른 사실이다', () => {
  it('기록이 없으면 MANUAL · chosen false · 강제 없음', async () => {
    const state = await readExecutionMode(new MemoryStateStore().scope('policy'))
    assert.deepEqual(state, { mode: 'MANUAL', chosen: false })
    assert.equal(enforcementOf(state), 'ADVISE')
  })

  it('기록이 깨져 있으면 MANUAL 로 적지 않는다 — 무엇이 저장됐었는지 모른다', async () => {
    const store = new MemoryStateStore()
    await store.scope('policy').set('execution-mode', '{ this is not json')
    const state = await readExecutionMode(store.scope('policy'))
    assert.equal(state.mode, undefined, 'MANUAL 이라고 주장하지 않는다')
    assert.equal(state.degraded, 'MODE_STATE_INVALID')
    assert.equal(enforcementOf(state), 'ENFORCE', '모르는 것을 여는 쪽으로 기울지 않는다')
  })

  it('읽지 못하면 UNREADABLE 이고, 역시 강제 쪽이다', async () => {
    const scope = new MemoryStateStore().scope('policy')
    const broken = { ...scope, get: async () => { throw new Error('EACCES') } }
    const state = await readExecutionMode(broken as unknown as typeof scope)
    assert.equal(state.degraded, 'MODE_STATE_UNREADABLE')
    assert.equal(enforcementOf(state), 'ENFORCE')
  })

  it('사람이 고른 값은 그대로다', async () => {
    const scope = new MemoryStateStore().scope('policy')
    await writeExecutionMode(scope, 'AUTO', 'controller-a', NOW)
    const state = await readExecutionMode(scope)
    assert.equal(state.mode, 'AUTO')
    assert.equal(state.chosen, true)
    assert.equal(enforcementOf(state), 'ENFORCE')
  })
})

describe('P0-1 — guard 도 같은 세 자리를 본다', () => {
  async function project(mode?: string): Promise<string> {
    const root = await tempDir('asc-integrity-')
    const asc = join(root, '.asc')
    await mkdir(join(asc, 'adapters', 'claude-code'), { recursive: true })
    await mkdir(join(asc, 'adapters', 'policy'), { recursive: true })
    await writeFile(
      join(asc, 'adapters', 'claude-code', 'runtime-binding-S-1.json'),
      JSON.stringify({
        key: 'runtime-binding:S-1',
        value: JSON.stringify({
          logicalSessionId: 'S-20260907-01',
          provider: 'claude-code',
          physicalSessionId: 'p1',
          updatedAt: NOW,
        }),
      }),
      'utf8',
    )
    if (mode !== undefined) await writeFile(join(asc, 'adapters', 'policy', 'execution-mode.json'), mode, 'utf8')
    return root
  }

  async function invokeHook(cwd: string, command: string): Promise<{ code: number; stderr: string }> {
    const dir = await tempDir('asc-integrity-hook-')
    const script = join(dir, 'guard-hook.mjs')
    await writeFile(script, hookScript(), 'utf8')
    const child = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ tool_name: 'Bash', session_id: 'p1', cwd, tool_input: { command } }),
      encoding: 'utf8',
      timeout: 10_000,
    })
    return { code: child.status ?? 1, stderr: child.stderr ?? '' }
  }

  it('T-15 — 기록이 없으면 raw push 가 통과한다', async () => {
    const cwd = await project()
    const outcome = await invokeHook(cwd, 'git push origin main')
    assert.equal(outcome.code, 0)
    assert.match(outcome.stderr, /MANUAL/)
  })

  it('T-16 — 기록이 깨져 있으면 raw push 는 나가지 않는다 (silent downgrade 0)', async () => {
    const cwd = await project('this is not json')
    const outcome = await invokeHook(cwd, 'git push origin main')
    assert.equal(outcome.code, 2)
    assert.match(outcome.stderr, /MODE_STATE_INVALID/)
    assert.doesNotMatch(outcome.stderr, /MANUAL —/, 'MANUAL 이라고 말하지 않는다')
  })

  it('T-16 — 그 상태에서도 control-plane 은 통과한다 (복구 출구)', async () => {
    const cwd = await project('{ "key": "execution-mode", "value": "{ broken" }')
    for (const command of ['asc status', 'asc mode', 'asc refresh', 'asc update']) {
      const outcome = await invokeHook(cwd, command)
      assert.equal(outcome.code, 0, `${command} 가 막혔다`)
    }
  })

  it('mode 값이 낯설면 그것도 읽지 못한 것으로 본다', async () => {
    const cwd = await project(JSON.stringify({ key: 'execution-mode', value: JSON.stringify({ mode: 'SEMI' }) }))
    const outcome = await invokeHook(cwd, 'git push origin main')
    assert.equal(outcome.code, 2)
    assert.match(outcome.stderr, /MODE_STATE_INVALID/)
  })
})

describe('P0-2~4 — 강제를 낮추는 것은 사람의 결정이다', () => {
  function run(cwd: string, home: string, args: string[]): { code: number; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
      cwd,
      env: { ...process.env, ASC_HOME: home },
      encoding: 'utf8',
      timeout: 60_000,
    })
    return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  async function attachedAuto(): Promise<{
    repo: string
    home: string
    root: string
    cleanup: () => Promise<void>
  }> {
    const base = await mkdtemp(join(tmpdir(), 'asc-downgrade-'))
    const repo = join(base, 'repo')
    const home = join(base, 'home')
    spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' })
    await writeFile(join(repo, 'README.md'), '# project\n', 'utf8')
    spawnSync('git', ['add', '-A'], { cwd: repo })
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
    spawnSync('git', ['remote', 'add', 'origin', 'git@lab.example.com:group/project.git'], { cwd: repo })
    const init = run(repo, home, ['init', '--profile', 'pilot-local'])
    assert.equal(init.code, 0, init.stderr)
    const index = JSON.parse(await readFile(join(home, 'workspace-index.json'), 'utf8')) as {
      locators: Record<string, { root: string }>
    }
    const root = Object.values(index.locators)[0]!.root
    await writeFile(join(root, 'identities.json'), JSON.stringify({ 'controller-a': ['local:colosair'] }), 'utf8')
    await mkdir(join(root, 'adapters', 'policy'), { recursive: true })
    await writeFile(
      join(root, 'adapters', 'policy', 'execution-mode.json'),
      JSON.stringify({ key: 'execution-mode', value: JSON.stringify({ mode: 'AUTO', since: NOW, by: 'controller-a' }) }),
      'utf8',
    )
    return { repo, home, root, cleanup: () => rm(base, { recursive: true, force: true }) }
  }

  it('T-17 — `--as` 만으로는 내려가지 않는다. 사람이 정할 자리를 만들고 멈춘다', async () => {
    const { repo, home, cleanup } = await attachedAuto()
    try {
      const attempted = run(repo, home, ['mode', 'manual', '--as', 'controller-a'])
      assert.equal(attempted.code, 2)
      assert.match(attempted.stderr, /person's decision/)
      assert.match(attempted.stderr, /asc inbox decide/)
      // mode 는 그대로 AUTO 다.
      const after = run(repo, home, ['mode', '--json'])
      assert.equal((JSON.parse(after.stdout) as { mode: string }).mode, 'AUTO')
      // 올릴 자리는 만들어졌다 — 올리는 것은 승인이 아니다.
      const inbox = run(repo, home, ['inbox', '--json'])
      const requests = JSON.parse(inbox.stdout) as { requestId: string; status: string }[]
      assert.equal(requests.length, 1)
      assert.equal(requests[0]!.status, 'AWAITING_APPROVAL')
    } finally {
      await cleanup()
    }
  })

  it('T-18 — 사람이 Inbox 에서 승인한 결정이 있으면 내려간다', async () => {
    const { repo, home, root, cleanup } = await attachedAuto()
    try {
      run(repo, home, ['mode', 'manual'])
      const inbox = run(repo, home, ['inbox', '--json'])
      const request = (JSON.parse(inbox.stdout) as { requestId: string }[])[0]!.requestId

      const decided = run(repo, home, ['inbox', 'decide', request, 'approve', '--as', 'colosair'])
      assert.equal(decided.code, 0, decided.stderr)

      const lowered = run(repo, home, ['mode', 'manual', '--request', request, '--json'])
      assert.equal(lowered.code, 0, lowered.stderr)
      assert.equal((JSON.parse(lowered.stdout) as { mode: string }).mode, 'MANUAL')

      // 한 번 쓴 결정은 소진된다. AUTO 로 되돌려 놓고 같은 승인을 다시 들이밀면 거절된다.
      await writeFile(
        join(root, 'adapters', 'policy', 'execution-mode.json'),
        JSON.stringify({ key: 'execution-mode', value: JSON.stringify({ mode: 'AUTO', since: NOW, by: 'controller-a' }) }),
        'utf8',
      )
      const again = run(repo, home, ['mode', 'manual', '--request', request])
      assert.equal(again.code, 2)
      assert.match(again.stderr, /DONE|승인한 결정만/)
    } finally {
      await cleanup()
    }
  })

  it('T-19 — Guard 는 그 명령을 막지 않는다. 거절은 Core 가 한다', async () => {
    const { repo, home, root, cleanup } = await attachedAuto()
    try {
      const dir = await tempDir('asc-downgrade-hook-')
      const script = join(dir, 'guard-hook.mjs')
      await writeFile(script, hookScript(), 'utf8')
      const hook = spawnSync(process.execPath, [script], {
        input: JSON.stringify({
          tool_name: 'Bash',
          session_id: 'p1',
          cwd: repo,
          tool_input: { command: 'asc mode manual --as controller-a' },
        }),
        env: { ...process.env, ASC_HOME: home },
        encoding: 'utf8',
      })
      assert.equal(hook.status ?? 0, 0, 'guard 가 control-plane 을 막았다')
      // 그리고 Core 는 거절한다 — 두 층의 답이 서로 다르다는 것이 이 설계다.
      assert.equal(run(repo, home, ['mode', 'manual', '--as', 'controller-a']).code, 2)
      assert.ok(root.length > 0)
    } finally {
      await cleanup()
    }
  })

  it('AUTO 를 걷어내는 다른 명령도 같은 결정을 요구한다', async () => {
    const { repo, home, cleanup } = await attachedAuto()
    try {
      const removed = run(repo, home, ['host', 'claude', 'uninstall', '--as', 'controller-a'])
      assert.equal(removed.code, 2)
      assert.match(removed.stderr, /asc inbox decide/)
    } finally {
      await cleanup()
    }
  })
})
