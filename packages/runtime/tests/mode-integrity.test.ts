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

describe('mode 전환은 막지 않고 드러낸다', () => {
  // 한 회차 동안 여기에는 Request → Inbox → 승인 → 소진이 서 있었다. 그것은 같은 셸을
  // 쥔 Agent 를 막으려는 장치였는데, 같은 셸이면 승인 명령도 칠 수 있다 — 막지 못하는
  // 것을 막는 척하면서 사람에게만 세 걸음을 물리는 구조였다. 그 의식을 지우고, 대신
  // **바뀌었다는 사실이 남는지**를 지킨다. ASC 가 지키는 것은 실수하는 Agent 이고,
  // 적대적 Agent 로부터 ASC 자신을 지키는 일은 Host/OS 신뢰 경계의 몫이다.
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
    const base = await mkdtemp(join(tmpdir(), 'asc-mode-'))
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
    await mkdir(join(root, 'adapters', 'policy'), { recursive: true })
    await writeFile(
      join(root, 'adapters', 'policy', 'execution-mode.json'),
      JSON.stringify({ key: 'execution-mode', value: JSON.stringify({ mode: 'AUTO', since: NOW, by: 'controller-a' }) }),
      'utf8',
    )
    return { repo, home, root, cleanup: () => rm(base, { recursive: true, force: true }) }
  }

  it('AUTO 에서 MANUAL 로 내려가는 것은 한 명령이다 — 사람을 세 걸음 걷게 하지 않는다', async () => {
    const { repo, home, cleanup } = await attachedAuto()
    try {
      const lowered = run(repo, home, ['mode', 'manual', '--as', 'colosair', '--json'])
      assert.equal(lowered.code, 0, lowered.stderr)
      assert.equal((JSON.parse(lowered.stdout) as { mode: string }).mode, 'MANUAL')
    } finally {
      await cleanup()
    }
  })

  it('그 전환은 기록에 남는다 — 누가 그렇게 했다고 말했는지까지', async () => {
    const { repo, home, root, cleanup } = await attachedAuto()
    try {
      run(repo, home, ['mode', 'manual', '--as', 'colosair'])
      const history = await readFile(join(root, 'monitor', 'log-current.md'), 'utf8').catch(() => '')
      assert.match(history, /execution_mode/)
      assert.match(history, /AUTO → MANUAL/)
      assert.match(history, /colosair/, '주장한 이름이 남는다 — 증명이 아니라 귀속이다')
    } finally {
      await cleanup()
    }
  })

  it('Guard 는 그 명령을 막지 않는다 — 거절이 필요하면 Core 가 한다', async () => {
    const { repo, home, cleanup } = await attachedAuto()
    try {
      const dir = await tempDir('asc-mode-hook-')
      const script = join(dir, 'guard-hook.mjs')
      await writeFile(script, hookScript(), 'utf8')
      const hook = spawnSync(process.execPath, [script], {
        input: JSON.stringify({
          tool_name: 'Bash',
          session_id: 'p1',
          cwd: repo,
          tool_input: { command: 'asc mode manual' },
        }),
        env: { ...process.env, ASC_HOME: home },
        encoding: 'utf8',
      })
      assert.equal(hook.status ?? 0, 0, 'guard 가 control-plane 을 막았다')
    } finally {
      await cleanup()
    }
  })

  it('돌고 있는 일은 여전히 몰래 버려지지 않는다', async () => {
    // 안전 의식을 지웠다고 해서 일이 사라져도 된다는 뜻은 아니다. 이쪽은 사람이 잃는
    // 것이 실제로 있는 자리이므로 그대로 둔다.
    const { repo, home, cleanup } = await attachedAuto()
    try {
      run(repo, home, ['session', 'issue', 'S-20260907-09', '--role', 'implementer', '--goal', '진행 중'])
      run(repo, home, ['session', 'start', 'S-20260907-09'])
      const removed = run(repo, home, ['uninstall'])
      assert.equal(removed.code, 2)
      assert.match(removed.stderr, /S-20260907-09/)
      assert.match(removed.stderr, /Nothing was removed/)
    } finally {
      await cleanup()
    }
  })
})

// 같은 기록을 두 구현이 읽는다.
//
//   enforcementOf     core/policy/execution-mode.ts   zod 로 파싱된 상태를 받는다
//   executionState    guard.ts 의 hook 안             파일을 직접 읽고 스스로 파싱한다
//
// 차단 패턴 쪽은 hookScript() 가 forbiddenIn 소스를 그대로 실어 이 중복을 피했지만,
// 판정 쪽은 그럴 수 없다 — enforcementOf 는 파싱된 상태를 받으므로 hook 이 그대로 쓸 수
// 없고, zod 를 hook 에 끌어들이면 hook 이 무거워진다. 그래서 통합하는 대신 **같은 자리에서
// 같은 답이 나오는지** 를 고정한다. 갈리면 여기서 잡힌다.
describe('mode 판정 두 구현이 같은 답을 낸다', () => {
  const stored = (mode: string): string =>
    JSON.stringify({ key: 'execution-mode', value: JSON.stringify({ mode, since: NOW, by: 'test' }) })

  async function hookEnforces(file: string | undefined): Promise<boolean> {
    const root = await tempDir('asc-parity-')
    const asc = join(root, '.asc')
    await mkdir(join(asc, 'adapters', 'policy'), { recursive: true })
    if (file !== undefined) await writeFile(join(asc, 'adapters', 'policy', 'execution-mode.json'), file, 'utf8')
    const dir = await tempDir('asc-parity-hook-')
    const script = join(dir, 'guard-hook.mjs')
    await writeFile(script, hookScript(), 'utf8')
    const child = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ tool_name: 'Bash', session_id: 'p-none', cwd: root, tool_input: { command: 'git push origin main' } }),
      encoding: 'utf8',
      timeout: 10_000,
    })
    // 결합이 없는 자리다. ENFORCE 면 막고(2), ADVISE 면 한 줄 남기고 통과한다(0).
    return (child.status ?? 1) !== 0
  }

  async function coreEnforces(file: string | undefined): Promise<boolean> {
    const scope = new MemoryStateStore().scope('policy')
    // 저장소는 값만 담는다 — hook 이 파일에서 벗겨내는 그 껍질을 여기서도 벗긴다.
    if (file !== undefined) {
      let value = file
      try {
        value = JSON.parse(file).value as string
      } catch {
        // 껍질조차 깨진 경우. 그대로 넣어 두 구현이 같은 쓰레기를 보게 한다.
      }
      await scope.set('execution-mode', value)
    }
    return enforcementOf(await readExecutionMode(scope)) === 'ENFORCE'
  }

  for (const [name, file] of [
    ['기록 없음', undefined],
    ['AUTO', stored('AUTO')],
    ['MANUAL', stored('MANUAL')],
    ['파싱 불가', '{ this is not json'],
    ['모드 값이 이상함', JSON.stringify({ key: 'execution-mode', value: JSON.stringify({ mode: 'SOMETHING' }) })],
  ] as const) {
    it(`${name} — hook 과 core 가 같은 쪽으로 답한다`, async () => {
      const hook = await hookEnforces(file)
      const core = await coreEnforces(file)
      assert.equal(hook, core, `hook=${hook} core=${core} — 두 구현이 갈렸다`)
    })
  }
})
