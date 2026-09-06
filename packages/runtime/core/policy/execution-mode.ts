// Execution Mode — 실행을 누가 하는가 (0.8.0 Axis C).
//
// 세 축은 서로를 대신하지 않는다:
//
//   Agent Management   누가 무엇을 맡았고 어디까지 왔는가   (Work / Session / Handoff)
//   Decision Authority  이 판단은 사람의 것인가              (Inbox / Approval / Query)
//   Execution Mode      결정된 행위를 누가 실행하는가        ← 이 파일
//
// 이 파일에는 mode 하나와 그 mode 로 갈 수 있는지를 판정하는 순수 함수만 있다.
// state machine 도 approval entity 도 만들지 않는다 — mode 는 기존 policy 저장소의
// 필드 하나이고, readiness 는 이미 관측되는 사실에서 파생한다.

import { z } from 'zod'

import type { ScopedStore } from '../../ports/state-store.ts'

/**
 * MANUAL  ASC 가 작업·판단·기록을 관리하지만 외부 side effect 를 강제 라우팅하지 않는다.
 *         사람과 Host 가 실행한다. Guard 는 아무것도 hard-block 하지 않는다.
 * AUTO    ASC-managed Agent 가 자율 실행하고, 외부 write 는 승인된 실행 경로로만 나간다.
 *         raw 외부 write 는 Guard 가 막는다.
 *
 * **어느 쪽도 HITL 을 바꾸지 않는다.** AUTO 가 사람의 결정을 대신 승인하지 않고,
 * MANUAL 이 승인을 받은 것으로 만들지도 않는다 (H-03 · H-04).
 */
export const ExecutionMode = z.enum(['MANUAL', 'AUTO'])
export type ExecutionMode = z.infer<typeof ExecutionMode>

/** policy scope 안의 키. freeze 정책이 사는 그 자리다 — 새 저장소를 만들지 않는다. */
export const EXECUTION_MODE_KEY = 'execution-mode'

export const ExecutionModeRecord = z.object({
  mode: ExecutionMode,
  /** 언제 정해졌는가. 기록이 없는 workspace 와 명시적으로 정한 workspace 를 가른다. */
  since: z.string().optional(),
  /** 누가 정했는가. AUTO→MANUAL 은 Controller 권한이 필요하다 (§11). */
  by: z.string().optional(),
})
export type ExecutionModeRecord = z.infer<typeof ExecutionModeRecord>

/**
 * 지금 이 workspace 의 실행 축. `chosen` 은 **사람이 골랐는가** 다.
 *
 * 상태가 셋이 아니다 — mode 는 여전히 MANUAL·AUTO 둘이고, `chosen` 은 기록이 있느냐를
 * 그대로 옮긴 값이다. 새 상태를 만들지 않으면서 "아직 정하지 않았다" 를 말할 수 있어야
 * 화면이 사람에게 정확히 무엇을 물을지 정한다.
 */
export type ExecutionModeState = ExecutionModeRecord & { chosen: boolean }

/**
 * 기록이 없으면 AUTO 가 **아니다**.
 *
 * 처음에는 반대로 두었다: 0.7 workspace 가 말없이 보호를 잃지 않게 하려는 것이었다.
 * 그 결정은 이 릴리스의 상위 계약과 충돌한다 — AUTO 는 사람이 고르고 readiness 를 통과한
 * 결과로만 존재할 수 있고(E-01), 기록이 없다는 사실은 그 둘 중 어느 것도 증명하지 않는다.
 * 기록 없이 AUTO 로 읽으면 readiness 를 한 번도 거치지 않은 enforcement 가 켜진다.
 *
 * 그래서 기록이 없는 workspace 는 hard enforcement 없이 돈다. ASC 가 꺼지는 것이 아니다 —
 * 일 관리·결정권·검수·감사는 그대로 살아 있고, Guard 만 강제하지 않는다 (§F).
 */
export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'MANUAL'

export async function readExecutionMode(scope: ScopedStore): Promise<ExecutionModeState> {
  const raw = await scope.get(EXECUTION_MODE_KEY)
  if (!raw) return { mode: DEFAULT_EXECUTION_MODE, chosen: false }
  return { ...ExecutionModeRecord.parse(JSON.parse(raw)), chosen: true }
}

export async function writeExecutionMode(
  scope: ScopedStore,
  mode: ExecutionMode,
  by: string | undefined,
  now: string = new Date().toISOString(),
): Promise<ExecutionModeRecord> {
  const record = ExecutionModeRecord.parse({ mode, since: now, ...(by ? { by } : {}) })
  await scope.set(EXECUTION_MODE_KEY, JSON.stringify(record))
  return record
}

/**
 * AUTO 로 갈 수 있는지 판정하는 축들. **새 health subsystem 이 아니다** — 각 축의 상태는
 * 이미 다른 곳에서 관측되는 사실이고, 여기서는 그 사실을 받아 판정만 한다.
 *
 * 순서가 §9 의 전환 순서다. Guard 가 마지막인 것은 규칙이다: 나갈 길을 확인하기 전에
 * 막는 쪽을 먼저 켜면 그것이 곧 출구 없는 AUTO 다.
 */
export const READINESS_AXES = [
  'control-plane',
  'controller',
  'binding',
  'executor',
  'provider',
  'review',
  'verify',
  'guard',
  'host',
] as const
export type ReadinessAxisName = (typeof READINESS_AXES)[number]

/**
 * READY            그대로 쓸 수 있다
 * BLOCKED_BY_HOST  Host 정책이 막고 있다 — ASC 가 고칠 수 없는 자리다
 * MISSING          아직 없다
 * DEGRADED         있지만 지금 쓸 수 없다
 * UNKNOWN          확인하지 못했다. 있다고도 없다고도 말하지 않는다
 */
export type AxisState = 'READY' | 'BLOCKED_BY_HOST' | 'MISSING' | 'DEGRADED' | 'UNKNOWN'

export type ReadinessAxis = {
  axis: ReadinessAxisName
  state: AxisState
  detail?: string
}

export type AutoReadiness = {
  ready: boolean
  axes: ReadinessAxis[]
  /** AUTO 를 막는 축들. 순서는 §9 의 확인 순서 그대로다. */
  blocking: ReadinessAxis[]
}

/**
 * AUTO 를 켜도 되는가 (E-01).
 *
 * **READY 가 아닌 것은 전부 막는다.** UNKNOWN 을 READY 로 뭉개면 그 판정이 곧 사람이
 * 나갈 길이 없는 AUTO 로 들어가는 근거가 된다 — 0.7.1 실측에서 실제로 일어난 일이다.
 *
 * 그리고 control-plane 하나로 끝내지 않는다. AUTO 는 "관리된 외부 쓰기 경로가 실제로
 * 쓸 수 있는 상태" 를 뜻하므로, 그 경로의 모든 마디가 서 있어야 한다:
 *
 * ```text
 * AUTO = control-plane usable
 *        AND managed executor usable      (binding · executor · provider)
 *        AND review/verify path usable    (검수 전 · 읽기 되돌림 후)
 *        AND Guard usable
 * ```
 */
export function judgeAutoReadiness(observed: readonly ReadinessAxis[]): AutoReadiness {
  const order = new Map(READINESS_AXES.map((axis, index) => [axis, index]))
  const axes = [...observed].sort((a, b) => (order.get(a.axis) ?? 99) - (order.get(b.axis) ?? 99))
  const blocking = axes.filter((axis) => axis.state !== 'READY')
  return { ready: blocking.length === 0, axes, blocking }
}
