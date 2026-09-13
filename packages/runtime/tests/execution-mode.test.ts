// 0.8.0 Axis C — 실행을 누가 하는가, 그리고 그것이 무엇을 바꾸지 않는가.
//
// 이 파일이 지키는 것은 세 축의 독립이다:
//
//   Execution Mode 는 Agent Management 를 바꾸지 않는다 (AM-01 ~ AM-03)
//   Execution Mode 는 Decision Authority 를 바꾸지 않는다 (H-01 ~ H-04)
//   나갈 길이 없으면 AUTO 로 들어가지 않는다 (E-01), 그리고 나갈 길은 언제나 열려 있다 (E-02)
//
// 0.9.0: 실행을 가로막는 hook 은 없다. 여기서 지키는 것은 mode 기록·readiness 판정·축의
// 독립뿐이다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { CLAUDE_PROVIDER, claudeBindings } from '../adapters/claude-code/binding.ts'
import { CONTROL_PLANE_ALLOW_RULES, controlPlaneAccess } from '../adapters/claude-code/install.ts'
import { MarkdownStateStore } from '../adapters/markdown/state-store.ts'
import {
  DEFAULT_EXECUTION_MODE,
  READINESS_AXES,
  judgeAutoReadiness,
  readExecutionMode,
  writeExecutionMode,
  type ReadinessAxis,
} from '../core/policy/execution-mode.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { tempDir } from './support/temp.ts'

const NOW = '2026-09-06T10:00:00+09:00'

const READY: ReadinessAxis[] = [
  { axis: 'executor', state: 'READY' },
  { axis: 'control-plane', state: 'READY' },
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
    // decidedFor 는 이 답이 누구 것인지를 말한다 (0.8.4). Run 의 답이 없으면 workspace 다.
    assert.deepEqual(read, {
      mode: 'MANUAL',
      since: NOW,
      by: 'controller-a',
      chosen: true,
      decidedFor: 'workspace',
    })
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
      READY.map((axis) => (axis.axis === 'executor' ? { ...axis, state: 'UNKNOWN' as const } : axis)),
    )
    assert.equal(verdict.ready, false)
  })

  it('나갈 통로가 없으면 AUTO 가 아니다 — 막기만 하는 mode 는 만들지 않는다', () => {
    const verdict = judgeAutoReadiness(
      READY.map((axis) => (axis.axis === 'executor' ? { ...axis, state: 'MISSING' as const } : axis)),
    )
    assert.equal(verdict.ready, false)
    assert.deepEqual(verdict.blocking.map((axis) => axis.axis), ['executor'])
  })

  it('물어보는 것이 둘뿐이다 — 행위마다 달라지는 사실은 실행할 때 본다', () => {
    // 예전에는 binding·provider·review·verify 까지 activation 시점에 물었다. 그 넷은
    // 행위마다 답이 다른 것들이고, CHECK 단계가 이미 같은 것을 묻는다.
    assert.deepEqual([...READINESS_AXES], ['executor', 'control-plane'])
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

  it('mode 는 승인을 판정하지 않는다 (H-05) — AUTO 여도 발급 권한 검사는 그대로다', async () => {
    // 0.9.0: 실행 모드가 바꾸는 것은 "누가 실행하는가" 하나다. 승인·발급 권한은 Grant 가
    // 별도로 판정하고, AUTO 라는 사실이 그 판정을 느슨하게 하지 않는다.
    const store = new MemoryStateStore()
    const scope = store.scope('policy')
    await writeExecutionMode(scope, 'AUTO', 'controller-a', NOW)
    const state = await readExecutionMode(scope)
    assert.equal(state.mode, 'AUTO')
    // 실행 모드 상태에는 승인 어휘가 없다 — 결정권은 다른 축이다
    assert.deepEqual(
      Object.keys(state).filter((key) => /approv|authority|grant/i.test(key)),
      [],
    )
  })
})
