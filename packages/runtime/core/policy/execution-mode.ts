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

/** 기록이 있는데 읽지 못한 이유. **새 mode 값이 아니다** — 읽기의 결과일 뿐이다. */
export type ModeStateProblem = 'MODE_STATE_UNREADABLE' | 'MODE_STATE_INVALID'

/**
 * 지금 이 workspace 의 실행 축.
 *
 * mode 는 여전히 MANUAL·AUTO 둘뿐이다. 달라진 것은 **모를 수 있다는 사실을 적는다**는 것:
 *
 * ```text
 * 기록 없음            mode MANUAL · chosen false      아무도 고르지 않았다
 * 기록 있음            mode 그대로 · chosen true       사람이 고른 값이다
 * 기록 있는데 못 읽음   mode 없음   · degraded         AUTO 였을 수도 있다 — 모른다
 * ```
 *
 * 마지막 자리를 MANUAL 로 적으면 그것이 fail-open 이다: 저장돼 있던 AUTO 가 파일 손상·
 * 권한·I/O 하나로 조용히 풀린다. 그래서 `mode` 를 비워 두고, 호출자가 그 사실을 마주하게 한다.
 */
export type ExecutionModeState = {
  mode?: ExecutionMode
  chosen: boolean
  since?: string
  by?: string
  degraded?: ModeStateProblem
}

/**
 * 이 상태에서 밖으로 나가는 raw 쓰기를 강제 경로로 돌릴 것인가.
 *
 * ```text
 * ENFORCE  AUTO 이거나, 기록을 읽지 못했다 (모르는 것을 푸는 쪽으로 기울지 않는다)
 * ADVISE   MANUAL 이거나, 아무도 고르지 않았다
 * ```
 *
 * **ENFORCE 는 AUTO 라는 뜻이 아니다.** 읽지 못한 자리는 AUTO 라고 주장하지 않으면서도
 * 열어 두지 않는다 — 그 둘은 다른 말이고, 화면은 그 차이를 그대로 보여 준다.
 */
export function enforcementOf(state: ExecutionModeState): 'ENFORCE' | 'ADVISE' {
  return state.degraded !== undefined || state.mode === 'AUTO' ? 'ENFORCE' : 'ADVISE'
}

/** 사람이 읽는 한 줄. 세 자리를 각각 다르게 말한다. */
export function modeLine(state: ExecutionModeState): string {
  if (state.degraded) {
    return state.degraded === 'MODE_STATE_INVALID'
      ? 'Execution Mode: unreadable — the stored record is not valid. Raw external writes stay blocked until it is fixed.'
      : 'Execution Mode: unreadable — the stored record could not be read. Raw external writes stay blocked until it is fixed.'
  }
  return `Execution Mode: ${state.mode}${state.chosen ? '' : ' (never chosen — nothing is being enforced)'}`
}

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

/**
 * 읽는다. **없는 것과 못 읽은 것을 가른다** (0.8.0 보정 P0-1).
 *
 * 없으면 아무도 고르지 않은 것이고, 못 읽으면 무엇이 저장돼 있었는지 모르는 것이다.
 * 뒤엣것을 MANUAL 로 적는 순간 저장된 AUTO 가 파일 하나로 풀린다.
 */
export async function readExecutionMode(scope: ScopedStore): Promise<ExecutionModeState> {
  let raw: string | null
  try {
    raw = await scope.get(EXECUTION_MODE_KEY)
  } catch {
    return { chosen: true, degraded: 'MODE_STATE_UNREADABLE' }
  }
  if (raw === null) return { mode: DEFAULT_EXECUTION_MODE, chosen: false }
  try {
    return { ...ExecutionModeRecord.parse(JSON.parse(raw)), chosen: true }
  } catch {
    return { chosen: true, degraded: 'MODE_STATE_INVALID' }
  }
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
 * AUTO 를 켤 때 물어야 하는 것 — **셋이다.**
 *
 * 한때 아홉이었다. binding·provider·review·verify·controller 까지 activation 시점에
 * 물었는데, 그것들은 행위마다 달라지는 사실이다: 어느 저장소로 가는지, 그 행위를 이
 * 통로가 되돌려 읽을 수 있는지는 **그 행위를 할 때** 답할 질문이고, 실제로 CHECK 단계가
 * 그것을 다시 묻는다. 같은 사실을 두 번 판정하면 둘이 갈릴 자리를 만드는 것이고,
 * "AUTO 를 켜려면 미래의 모든 행위가 지금 가능해야 한다" 는 과장이 된다.
 *
 * 남은 셋은 activation 시점에만 답할 수 있는 것들이다:
 *
 * ```text
 * executor       관리된 쓰기 경로가 조립되는가 — 없으면 AUTO 는 막기만 하는 mode 다
 * guard          막을 것을 실제로 막을 수 있는가 — 없으면 AUTO 는 이름뿐이다
 * control-plane  Host 안에서 ASC 명령이 도는가 — 없으면 나갈 문이 없다 (0.7.1 실측)
 * ```
 */
export const READINESS_AXES = ['executor', 'guard', 'control-plane'] as const
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
 * AUTO 를 켜도 되는가.
 *
 * 묻는 것은 하나다 — **AUTO 를 켠 뒤에도 일이 나갈 길과 사람이 나갈 길이 있는가.**
 * 행위 하나하나가 지금 가능한지는 그 행위를 할 때 CHECK 가 답한다.
 *
 * READY 가 아닌 것은 전부 막는다. UNKNOWN 을 READY 로 뭉개면 그것이 곧 나갈 길 없는
 * AUTO 로 들어가는 근거가 된다.
 */
export function judgeAutoReadiness(observed: readonly ReadinessAxis[]): AutoReadiness {
  const order = new Map(READINESS_AXES.map((axis, index) => [axis, index]))
  const axes = [...observed].sort((a, b) => (order.get(a.axis) ?? 99) - (order.get(b.axis) ?? 99))
  const blocking = axes.filter((axis) => axis.state !== 'READY')
  return { ready: blocking.length === 0, axes, blocking }
}
