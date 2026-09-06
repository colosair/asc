// 0.8.0 Axis C — 실행을 누가 하는가, 그리고 그것이 무엇을 바꾸지 않는가.
//
// 이 파일이 지키는 것은 세 축의 독립이다:
//
//   Execution Mode 는 Agent Management 를 바꾸지 않는다 (AM-01 ~ AM-03)
//   Execution Mode 는 Decision Authority 를 바꾸지 않는다 (H-01 ~ H-04)
//   나갈 길이 없으면 AUTO 로 들어가지 않는다 (E-01), 그리고 나갈 길은 언제나 열려 있다 (E-02)
//
// guard 는 생성된 문자열이라 단위 호출로 검사할 수 없다. 그래서 **파일로 써서 node 로
// 돌린다** — 설치될 물건 그대로가 아니면 이 Gate 는 아무것도 지키지 않는다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { CLAUDE_PROVIDER, claudeBindings } from '../adapters/claude-code/binding.ts'
import { hookScript } from '../adapters/claude-code/guard.ts'
import { CONTROL_PLANE_ALLOW_RULES, controlPlaneAccess } from '../adapters/claude-code/install.ts'
import { MarkdownStateStore } from '../adapters/markdown/state-store.ts'
import {
  DEFAULT_EXECUTION_MODE,
  judgeAutoReadiness,
  readExecutionMode,
  writeExecutionMode,
  type ReadinessAxis,
} from '../core/policy/execution-mode.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { tempDir } from './support/temp.ts'

const NOW = '2026-09-06T10:00:00+09:00'

const READY: ReadinessAxis[] = [
  { axis: 'control-plane', state: 'READY' },
  { axis: 'controller', state: 'READY' },
  { axis: 'executor', state: 'READY' },
  { axis: 'provider', state: 'READY' },
  { axis: 'guard', state: 'READY' },
  { axis: 'host', state: 'READY' },
]

describe('Execution Mode — 기록과 기본값', () => {
  it('T-01 — 기록이 없으면 AUTO 가 아니다. 고른 적이 없다는 것까지 말한다', async () => {
    // AUTO 는 사람이 고르고 readiness 를 통과한 결과로만 존재한다 (E-01). 기록이 없다는
    // 사실은 그 둘 중 어느 것도 증명하지 않으므로, 그 자리에서 강제를 켜면 한 번도
    // 검사되지 않은 enforcement 가 서는 것이다.
    const scope = new MemoryStateStore().scope('policy')
    const state = await readExecutionMode(scope)
    assert.equal(state.mode, 'MANUAL')
    assert.equal(state.chosen, false, '기본값과 사람이 고른 MANUAL 은 다른 사실이다')
    assert.equal(DEFAULT_EXECUTION_MODE, 'MANUAL')
  })

  it('정한 것은 그대로 읽힌다 — 누가 언제 정했는지까지', async () => {
    const scope = new MemoryStateStore().scope('policy')
    const written = await writeExecutionMode(scope, 'MANUAL', 'controller-a', NOW)
    assert.equal(written.mode, 'MANUAL')
    const read = await readExecutionMode(scope)
    assert.deepEqual(read, { mode: 'MANUAL', since: NOW, by: 'controller-a', chosen: true })
  })
})

describe('E-01 — 나갈 길이 없으면 AUTO 가 아니다', () => {
  it('전부 READY 여야 AUTO 다', () => {
    assert.equal(judgeAutoReadiness(READY).ready, true)
  })

  it('Host 가 control-plane 을 막고 있으면 AUTO 가 아니다 — 0.7.1 의 deadlock 자리', () => {
    const verdict = judgeAutoReadiness(
      READY.map((axis) => (axis.axis === 'control-plane' ? { ...axis, state: 'BLOCKED_BY_HOST' as const } : axis)),
    )
    assert.equal(verdict.ready, false)
    assert.deepEqual(verdict.blocking.map((axis) => axis.axis), ['control-plane'])
  })

  it('UNKNOWN 을 READY 로 뭉개지 않는다', () => {
    const verdict = judgeAutoReadiness(
      READY.map((axis) => (axis.axis === 'provider' ? { ...axis, state: 'UNKNOWN' as const } : axis)),
    )
    assert.equal(verdict.ready, false)
  })

  it('확인 순서가 §9 그대로다 — guard 가 마지막이다', () => {
    // 나갈 길을 확인하기 전에 막는 쪽을 먼저 켜면 그것이 곧 출구 없는 AUTO 다.
    const axes = judgeAutoReadiness([...READY].reverse()).axes.map((axis) => axis.axis)
    assert.deepEqual(axes, ['control-plane', 'controller', 'executor', 'provider', 'guard', 'host'])
    assert.ok(axes.indexOf('guard') > axes.indexOf('executor'))
  })
})

describe('guard 는 mode 를 읽는다 (§69)', () => {
  /**
   * hook 을 실제 프로세스로 돌린다. **통과한 경우의 stderr 도 읽는다** — MANUAL 의 조언은
   * 통과하면서 남기는 말이라, 실패 경로에서만 stderr 를 보면 그 말을 영영 검사하지 못한다.
   */
  async function invokeHook(input: Record<string, unknown>): Promise<{ code: number; stderr: string }> {
    const dir = await tempDir('asc-mode-hook-')
    const script = join(dir, 'guard-hook.mjs')
    await writeFile(script, hookScript(), 'utf8')
    const child = spawnSync(process.execPath, [script], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 10_000,
    })
    return { code: child.status ?? 1, stderr: child.stderr ?? '' }
  }

  /** 관리 대상 세션 하나가 있는 프로젝트. mode 를 주면 그 mode 로 적는다. */
  async function project(mode?: 'MANUAL' | 'AUTO'): Promise<string> {
    const root = await tempDir('asc-modeproj-')
    const store = await MarkdownStateStore.open(join(root, '.asc'))
    await claudeBindings(store).claim(
      { logicalSessionId: 'S-20260906-01', provider: CLAUDE_PROVIDER, physicalSessionId: 'claude-abc' },
      NOW,
    )
    if (mode) await writeExecutionMode(store.scope('policy'), mode, 'controller-a', NOW)
    await mkdir(join(root, 'src'), { recursive: true })
    return root
  }

  const bash = (cwd: string, command: string, session = 'claude-abc') => ({
    tool_name: 'Bash',
    session_id: session,
    cwd,
    tool_input: { command },
  })

  it('MANUAL — 외부 write 를 하나도 hard-block 하지 않는다', async () => {
    const cwd = await project('MANUAL')
    for (const command of ['git fetch origin', 'git push origin main', 'glab mr create --fill']) {
      const outcome = await invokeHook(bash(cwd, command))
      assert.equal(outcome.code, 0, `${command} — MANUAL 은 막지 않는다: ${outcome.stderr}`)
    }
  })

  it('MANUAL — 세션 밖의 파일 변경도 막지 않는다', async () => {
    const cwd = await project('MANUAL')
    const outcome = await invokeHook({
      tool_name: 'Write',
      session_id: 'other-session',
      cwd,
      tool_input: { file_path: join(cwd, 'src', 'a.ts') },
    })
    assert.equal(outcome.code, 0)
  })

  it('AUTO — raw 외부 write 는 막히고, 읽기는 그대로 지난다', async () => {
    const cwd = await project('AUTO')
    assert.equal((await invokeHook(bash(cwd, 'git fetch origin'))).code, 0)
    const blocked = await invokeHook(bash(cwd, 'git push origin main'))
    assert.equal(blocked.code, 2)
    assert.match(blocked.stderr, /asc work publish/, '공식 출구를 그 자리에서 준다')
  })

  it('AUTO — ASC control-plane 은 무엇 하나 막히지 않는다 (E-02)', async () => {
    const cwd = await project('AUTO')
    for (const command of [
      'asc status',
      'asc mode manual --as controller-a',
      'asc work publish --action gitlab.mr.create --target group/project --body-file /tmp/b.md --as controller-a',
      'asc refresh',
      'asc update',
      'asc grant run G-0001',
    ]) {
      const outcome = await invokeHook(bash(cwd, command, 'no-such-session'))
      assert.equal(outcome.code, 0, `${command} 가 막혔다: ${outcome.stderr}`)
    }
  })

  it('T-01 — mode 기록이 없으면 강제하지 않는다. 대신 그 사실을 말한다', async () => {
    // 검사되지 않은 AUTO 는 만들지 않는다 (§B). ASC 가 꺼진 것이 아니다 — 일 관리·검수·
    // 감사는 그대로 돌고, 이 자리에서 달라지는 것은 강제 라우팅 하나다.
    const cwd = await project()
    const outcome = await invokeHook(bash(cwd, 'git push origin main'))
    assert.equal(outcome.code, 0)
    assert.match(outcome.stderr, /MANUAL/)
  })

  it('T-05 — MANUAL 에서 밖으로 나가는 쓰기에는 조언이 붙는다 (막지는 않는다)', async () => {
    const cwd = await project('MANUAL')
    const outcome = await invokeHook(bash(cwd, 'glab mr create --fill'))
    assert.equal(outcome.code, 0)
    // 검수는 Guard 가 아니라 Remote Review 의 일이다 — 그 자리를 그대로 가리킨다.
    assert.match(outcome.stderr, /asc work publish --review/)
    assert.match(outcome.stderr, /asc mode auto/)
  })
})

describe('control-plane 접근은 Host 설정에서 읽는다 (§8·Phase I)', () => {
  const home = async (settings: unknown): Promise<{ claudeHome: string }> => {
    const dir = await tempDir('asc-hostsettings-')
    const claudeHome = join(dir, '.claude')
    await mkdir(claudeHome, { recursive: true })
    await writeFile(join(claudeHome, 'settings.json'), JSON.stringify(settings), 'utf8')
    return { claudeHome }
  }

  it('허용 규칙이 있으면 READY 다', async () => {
    const access = await controlPlaneAccess(await home({ permissions: { allow: [...CONTROL_PLANE_ALLOW_RULES] } }))
    assert.deepEqual({ allowed: access.allowed, denied: access.denied }, { allowed: true, denied: false })
  })

  it('Host 가 ASC 명령을 막고 있으면 그 사실을 말한다 — 0.7.1 이 갇혔던 자리', async () => {
    const access = await controlPlaneAccess(await home({ permissions: { deny: ['Bash(asc:*)'] } }))
    assert.equal(access.denied, true)
    assert.equal(access.allowed, false)
    assert.match(access.detail ?? '', /denies/)
  })

  it('아무 규칙도 없으면 없는 것이다 — 있다고 치지 않는다', async () => {
    const access = await controlPlaneAccess(await home({}))
    assert.deepEqual({ allowed: access.allowed, denied: access.denied }, { allowed: false, denied: false })
  })
})

describe('세 축은 서로를 대신하지 않는다', () => {
  it('mode 를 바꿔도 세션의 주인·범위·진행은 그대로다 (AM-02)', async () => {
    const root = await tempDir('asc-axis-')
    const store = await MarkdownStateStore.open(join(root, '.asc'))
    const scope = store.scope('policy')
    const binding = claudeBindings(store)
    await binding.claim(
      { logicalSessionId: 'S-20260906-02', provider: CLAUDE_PROVIDER, physicalSessionId: 'claude-xyz' },
      NOW,
    )
    const before = await binding.current()

    await writeExecutionMode(scope, 'MANUAL', 'controller-a', NOW)
    await writeExecutionMode(scope, 'AUTO', 'controller-a', NOW)

    assert.deepEqual(await binding.current(), before)
  })

  it('guard 는 승인을 판정하지 않는다 (H-05) — 그 낱말이 hook 에 없다', () => {
    const script = hookScript()
    // 승인 기록도, 승인 권한자도 읽지 않는다. 여기서 하는 판정은 "이 명령이 지금 이
    // workspace 의 실행 경로를 우회하는가" 하나뿐이다. `glab mr approve` 는 막을 명령의
    // 이름이지 승인 판정이 아니다.
    assert.doesNotMatch(script, /identities|approver|GrantService|inbox/i)
    // 결정권·세션 관리·Controller 선택도 guard 의 일이 아니다.
    assert.doesNotMatch(script, /decisionAuthority|controllerIdentities|collectSessions/)
  })
})
