// Front Session Restore — 새 대화를 열었을 때 지금 상태를 되찾는다 (C-12 §4).
//
// 사람이 매번 `asc status`·`asc resume`·`asc inbox list` 를 차례로 쳐서 자기 상황을
// 재구성하는 것은 최종형이 아니다. **상태는 지속되고 대화는 갈아입는다** — 새 Front
// Session이 붙으면 그 자리에서 지금 무엇이 걸려 있는지 보여야 한다.
//
// 여기는 **읽기만 한다** (C-12 불변식 ⑮):
//
//   전이하지 않는다 · 승인 대기를 소비하지 않는다 · 소유권을 뺏지 않는다
//
// 복원이 상태를 건드리면 "확인했더니 바뀌었다"가 되고, 그러면 사람이 화면을 여는 것조차
// 조심스러워진다.

import type { Session } from '../model/entities.ts'
import type { StateStore } from '../../ports/state-store.ts'
import type { HealthAlert } from '../monitor/health-alerts.ts'
import type { EscalationRecord } from './escalation.ts'
import type { DecisionSummary } from '../view/decision-view.ts'

export type FrontState = {
  /** 지금 돌고 있는 것. */
  active: {
    id: string
    role: string
    status: string
    goal: string
    position?: string
    /**
     * 지금 이 세션을 집고 있는 physical 실행 id (기존 한계 L-4).
     *
     * `--physical` 을 요구하는 명령(progress report·pause·done·release)이 여럿인데
     * 그 값을 되찾을 곳은 `asc session audit <S-ID>` 뿐이었다 — 세션 id를 이미 알아야
     * 부를 수 있는 명령이다. 지금 무엇이 도는지 보는 화면이 그것을 같이 말한다.
     */
    physical?: string
  }[]
  /**
   * 발급됐는데 아무도 집지 않은 것 (C-10 §1.1). 회수 대기와 다른 상태다 —
   * 이건 시작조차 안 됐다는 뜻이고, 그 사실이 안 보이면 위임이 조용히 증발한다.
   */
  unclaimed: { id: string; role: string; goal: string }[]
  /** 회수를 기다리는 handoff. 끝났는데 아무도 안 거둔 것들이다. */
  awaitingCollect: { id: string; next: string }[]
  /** 사람이 결정해야 하는 것. */
  pendingDecisions: DecisionSummary[]
  /** Controller 상태가 든 미결. closure·query가 여기 합류한다. */
  awaitingController: readonly string[]
  /** 감시 자체의 상태. 비어 있지 않으면 위 목록을 그대로 믿으면 안 된다. */
  health: readonly HealthAlert[]
  /**
   * 사람이 결정해야 풀리는 것 (C-13). **무엇이 계속 가는지 함께 든다** —
   * 외부 대기 하나가 전체를 세운 것처럼 보이면 사람이 그 세션을 포기한다.
   */
  escalations: readonly {
    id: string
    predicates: string[]
    question: string
    blocked: string[]
    /** 막힌 경계(쓰기 범위). 막힌 항목과 다른 사실이라 따로 든다. */
    blockedScope: string[]
    runnable: string[]
  }[]
  /** 이 workspace가 무엇인지. 붙은 자리를 사람이 확인할 수 있어야 한다. */
  workspace?: { workspaceId: string; locator: string }
}

export type RestoreInput = {
  store: StateStore
  pending: readonly DecisionSummary[]
  health?: readonly HealthAlert[]
  /** 미해소 상신. 없으면 이 축은 그리지 않는다 — 없는 것을 0으로 보이게 하지 않는다. */
  escalations?: readonly EscalationRecord[]
  workspace?: { workspaceId: string; locator: string }
  /**
   * 세션별 소유권 조회. **구조로만 받는다** — Core가 Host adapter를 알면 안 된다.
   * 없으면 이 축은 그리지 않는다(모르는 것을 "없음"으로 그리지 않는다).
   */
  bindings?: { get(sessionId: string): Promise<{ physicalSessionId: string } | null> }
}

/**
 * 지금 상태를 모은다. **쓰지 않는다.**
 *
 * 세션 목록은 entity에서, 미결은 Control State에서 온다 — 둘 다 이미 있는 것이고
 * 새로 계산하지 않는다. 여기서 파생을 만들면 그 파생이 곧 두 번째 정본이 된다.
 */
export async function restoreFront(input: RestoreInput): Promise<FrontState> {
  const sessions = await input.store.list('session')
  const control = await input.store.getControlState()

  const running = sessions.filter((s: Session) => s.status === 'ACTIVE' || s.status === 'PAUSED')
  // 도는 세션만 소유권을 묻는다 — 전수 조회가 아니라 화면에 나오는 것만.
  const owners = new Map<string, string>()
  if (input.bindings) {
    for (const session of running) {
      const owner = await input.bindings.get(session.id).catch(() => null)
      if (owner) owners.set(session.id, owner.physicalSessionId)
    }
  }

  const active = running
    .map((s: Session) => ({
      id: s.id,
      role: s.role,
      status: s.status,
      goal: s.goal,
      ...(owners.has(s.id) ? { physical: owners.get(s.id)! } : {}),
      // 이어받을 지점이 있으면 그것까지. 없으면 없는 대로 둔다.
      ...(s.checkpoint ? { position: s.checkpoint.position } : {}),
    }))

  const unclaimed = sessions
    .filter((s: Session) => s.status === 'READY')
    .map((s: Session) => ({ id: s.id, role: s.role, goal: s.goal }))

  const awaitingCollect = sessions
    .filter((s: Session) => s.status === 'DONE' && s.handoff)
    .map((s: Session) => ({ id: s.id, next: s.handoff!.next }))

  return {
    active,
    unclaimed,
    awaitingCollect,
    pendingDecisions: [...input.pending],
    awaitingController: control.awaitingController ?? [],
    health: input.health ?? [],
    escalations: (input.escalations ?? []).map((record) => ({
      id: record.escalationId,
      predicates: [...record.predicates],
      question: record.question,
      blocked: [...record.blockedNodes],
      blockedScope: [...record.blockedScope],
      runnable: [...record.stillRunnableNodes],
    })),
    ...(input.workspace ? { workspace: input.workspace } : {}),
  }
}

/**
 * 새 Front Session이 열렸을 때의 판정 (C-12 §4).
 *
 * **Host를 모른다.** Claude Code든 다른 무엇이든 "여기서 세션이 열렸다"는 사실 하나를
 * 받고, 붙을 수 있는지와 무엇이 걸려 있는지를 답한다. Host adapter는 이 답을 자기
 * 호스트의 형식으로 옮기기만 한다 — Core에 `if (host === 'claude')` 가 생기면 그 순간
 * 두 번째 호스트는 Core를 고쳐야 들어온다.
 *
 * 세 갈래를 **구분한다**:
 *
 *   NOT_ASC       이 경로는 ASC 소관이 아니다. 조용히 지나간다 — 남의 도구를 방해하지
 *                 않는다 (C-11 불변식 ⑪).
 *   UNAVAILABLE   붙어야 하는데 못 붙었다. **빈 화면을 주지 않고 왜인지 말한다**
 *                 (C-12 불변식 ⑰).
 *   BOUND         붙었다. 지금 무엇이 걸려 있는지가 함께 온다.
 */
export type FrontOpening =
  | { kind: 'NOT_ASC' }
  | { kind: 'UNAVAILABLE'; detail: string }
  | { kind: 'BOUND'; state: FrontState }

/**
 * 세션이 열렸다 — 붙을 수 있는가.
 *
 * **읽기만 한다.** 세션을 만들지 않는다: 실제 작업 요청이 없는데 Session Contract를
 * 만들어 내는 것은 없던 사실을 제조하는 일이다 (AGENTS.md "Do not create a session to
 * demonstrate that setup worked" 와 같은 선).
 */
export async function openFront(input: {
  /** 이 경로가 어느 workspace인가. `null` 이면 ASC 소관이 아니다. */
  workspace: { workspaceId: string; locator: string } | null
  /** 상태를 읽는다. 던지면 UNAVAILABLE 로 접힌다 — 못 읽은 것을 "없음"으로 그리지 않는다. */
  restore: () => Promise<FrontState>
}): Promise<FrontOpening> {
  if (!input.workspace) return { kind: 'NOT_ASC' }
  try {
    return { kind: 'BOUND', state: await input.restore() }
  } catch (error) {
    return { kind: 'UNAVAILABLE', detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Host가 사람에게 보여 줄 줄. **Host별 포장은 여기 없다** — 문자열 목록까지가 Core다.
 *
 * `NOT_ASC` 는 빈 목록이다. 할 말이 없는 것과 "아무 일도 없다"는 다르고, 전자는
 * 아무것도 띄우지 않는 것이 맞다.
 */
export function frontOpeningLines(opening: FrontOpening): string[] {
  switch (opening.kind) {
    case 'NOT_ASC':
      return []
    case 'UNAVAILABLE':
      // 조용히 빈 화면을 주지 않는다 (C-12 불변식 ⑰)
      return [`ASC is attached here but its state could not be read — ${opening.detail}`]
    case 'BOUND':
      return renderFront(opening.state)
  }
}

/**
 * 사람이 읽는 복원 화면.
 *
 * 순서가 곧 우선순위다: **내가 지금 결정해야 하는 것**이 먼저고, 돌고 있는 것이 그다음,
 * 감시 상태가 마지막이다. 다만 감시가 고장 났으면 그 사실을 목록보다 먼저 말한다 —
 * 믿을 수 없는 목록을 조용히 보여주는 것이 가장 나쁘다.
 */
export function renderFront(state: FrontState): string[] {
  const lines: string[] = []

  if (state.workspace) lines.push(`workspace ${state.workspace.workspaceId} · ${state.workspace.locator}`)
  if (state.health.length > 0) {
    lines.push('Read this first — monitoring state:')
    for (const alert of state.health) lines.push(`  [${alert.kind}] ${alert.detail}`)
  }

  lines.push(
    state.pendingDecisions.length > 0
      ? `Awaiting your decision (${state.pendingDecisions.length}):`
      : 'Nothing awaiting your decision',
  )
  for (const item of state.pendingDecisions.slice(0, 5)) {
    lines.push(`  ${item.priority} ${item.requestId}  ${item.reference}  ${item.title}`)
  }
  if (state.pendingDecisions.length > 5) lines.push(`  … and ${state.pendingDecisions.length - 5} more`)

  if (state.active.length > 0) {
    lines.push(`Running (${state.active.length}):`)
    for (const session of state.active) {
      lines.push(`  ${session.id} [${session.role}] ${session.status} — ${session.goal}`)
      // --physical 을 요구하는 명령이 여럿이다. 그 값을 여기서 집어 갈 수 있어야 한다 (L-4).
      if (session.physical) lines.push(`    held by: ${session.physical}`)
      if (session.position) lines.push(`    resume at: ${session.position}`)
    }
  }

  if (state.escalations.length > 0) {
    lines.push(`Awaiting an outside decision (${state.escalations.length}):`)
    for (const item of state.escalations) {
      lines.push(`  ${item.id} [${item.predicates.join(', ')}] ${item.question}`)
      lines.push(`    blocked: ${item.blocked.join(', ')}`)
      // 막힌 항목과 막힌 경계는 다른 사실이다 — 경계가 안 보이면 "어디까지 남의 것인가"를 다시 물어야 한다
      if (item.blockedScope.length > 0) lines.push(`    boundary: ${item.blockedScope.join(', ')}`)
      // 계속 가는 것을 같이 보여야 "전부 멈췄다"로 읽히지 않는다 (C-13 §6)
      if (item.runnable.length > 0) lines.push(`    still running: ${item.runnable.join(', ')}`)
    }
  }

  if (state.unclaimed.length > 0) {
    lines.push(`Issued but nobody has picked them up (${state.unclaimed.length}):`)
    for (const session of state.unclaimed) lines.push(`  ${session.id} [${session.role}] ${session.goal}`)
  }

  if (state.awaitingCollect.length > 0) {
    lines.push(`Awaiting collection (${state.awaitingCollect.length}) — \`asc controller collect --as <actor>\``)
    for (const done of state.awaitingCollect) lines.push(`  ${done.id} → ${done.next}`)
  }

  if (state.awaitingController.length > 0) {
    lines.push('Still open:')
    for (const line of state.awaitingController.slice(0, 5)) lines.push(`  - ${line}`)
    if (state.awaitingController.length > 5) {
      lines.push(`  … and ${state.awaitingController.length - 5} more`)
    }
  }

  if (
    state.pendingDecisions.length === 0 &&
    state.active.length === 0 &&
    state.escalations.length === 0 &&
    state.unclaimed.length === 0 &&
    state.awaitingCollect.length === 0 &&
    state.awaitingController.length === 0
  ) {
    // 비어 있는 것과 못 보는 것을 구분한다 (C-12 불변식 ⑫과 같은 태도)
    lines.push(
      state.health.length > 0
        ? 'Nothing is pending — but read the monitoring state above first.'
        : 'Nothing is pending.',
    )
  }

  return lines
}
