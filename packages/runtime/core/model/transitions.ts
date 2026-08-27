// Entity 상태머신 — 어떤 전이가 가능하고 누가 수행할 수 있는지를 데이터로 선언한다.
// 전이표가 설계 정본(OM §6.2 Session / §11.2 Inbox / §11.5·§11.9 Grant / §10.5 Monitor)과
// 1:1 대응하는지는 tests/model.test.ts가 검증한다.
// 저장·동시성은 여기 없다 — 순수 함수로 다음 상태를 계산할 뿐이고, 실제 CAS는
// State Store Port가 수행한다 (OM §7.0·§7.2).

import type { ActorRole, ApprovalRequest, ExecutionGrant, MonitorEvent, QueueItem, Session } from './entities.ts'

export type TransitionRule<S extends string> = {
  from: S
  to: S
  /** 이 전이를 수행할 수 있는 주체. 비어 있는 전이는 만들지 않는다. */
  actors: readonly ActorRole[]
  /** 전이 성립에 필요한 부가 조건의 이름 — 래퍼가 실제 값 존재를 확인한다. */
  requires?: 'checkpoint' | 'handoff' | 'decision' | 'result'
}

export type TransitionFailure = 'ILLEGAL_TRANSITION' | 'FORBIDDEN_ACTOR' | 'MISSING_REQUIREMENT'

export class TransitionError extends Error {
  readonly reason: TransitionFailure

  constructor(reason: TransitionFailure, message: string) {
    super(message)
    this.name = 'TransitionError'
    this.reason = reason
  }
}

function resolve<S extends string>(
  table: readonly TransitionRule<S>[],
  from: S,
  to: S,
  actor: ActorRole,
): TransitionRule<S> {
  const candidates = table.filter((r) => r.from === from && r.to === to)
  if (candidates.length === 0) {
    throw new TransitionError('ILLEGAL_TRANSITION', `${from} → ${to} is not a legal transition`)
  }
  const allowed = candidates.find((r) => r.actors.includes(actor))
  if (!allowed) {
    throw new TransitionError('FORBIDDEN_ACTOR', `${actor} may not perform ${from} → ${to}`)
  }
  return allowed
}

/** 전이표에서 terminal 상태(나가는 전이가 없는 상태) 목록. */
export function terminalStates<S extends string>(
  table: readonly TransitionRule<S>[],
  all: readonly S[],
): S[] {
  return all.filter((s) => !table.some((r) => r.from === s))
}

// ── Session (OM §6.2) ───────────────────────────────────────────────────────
// Logical Session은 여러 Physical Run에 걸친다. PAUSED는 Checkpoint 없이 만들 수 없고,
// DONE은 Handoff 없이 만들 수 없다 — 인수인계 누락을 상태머신이 막는다.

export const SESSION_TRANSITIONS: readonly TransitionRule<Session['status']>[] = [
  { from: 'READY', to: 'ACTIVE', actors: ['session', 'controller'] },
  { from: 'ACTIVE', to: 'PAUSED', actors: ['session'], requires: 'checkpoint' },
  { from: 'ACTIVE', to: 'BLOCKED', actors: ['session'] },
  { from: 'ACTIVE', to: 'DONE', actors: ['session'], requires: 'handoff' },
  { from: 'ACTIVE', to: 'FAILED', actors: ['session', 'controller'] },
  { from: 'PAUSED', to: 'ACTIVE', actors: ['session', 'controller'] },
  { from: 'PAUSED', to: 'FAILED', actors: ['controller'] },
  { from: 'BLOCKED', to: 'ACTIVE', actors: ['controller'] },
  { from: 'BLOCKED', to: 'FAILED', actors: ['controller'] },
]

export function transitionSession(
  session: Session,
  to: Session['status'],
  actor: ActorRole,
  patch: Partial<Pick<Session, 'checkpoint' | 'handoff'>> = {},
): Session {
  const rule = resolve(SESSION_TRANSITIONS, session.status, to, actor)
  const next: Session = { ...session, ...patch, status: to, version: session.version + 1 }
  if (rule.requires === 'checkpoint' && !next.checkpoint) {
    throw new TransitionError('MISSING_REQUIREMENT', `${session.id}: PAUSED requires a checkpoint`)
  }
  if (rule.requires === 'handoff' && !next.handoff) {
    throw new TransitionError('MISSING_REQUIREMENT', `${session.id}: DONE requires a handoff`)
  }
  return next
}

// ── ApprovalRequest (OM §11.2) ──────────────────────────────────────────────
// AWAITING_APPROVAL은 Monitor만 만들고(생성 시점), 처분은 Controller 전용,
// DONE 전환은 Grant를 수행한 Executor만 한다. APPROVED는 승인 상태일 뿐
// 외부 write 권한이 아니다 — 실제 write는 ExecutionGrant에만 있다.

export const REQUEST_TRANSITIONS: readonly TransitionRule<ApprovalRequest['status']>[] = [
  { from: 'AWAITING_APPROVAL', to: 'APPROVED', actors: ['controller'], requires: 'decision' },
  { from: 'AWAITING_APPROVAL', to: 'QUEUED', actors: ['controller'], requires: 'decision' },
  { from: 'AWAITING_APPROVAL', to: 'DEFERRED', actors: ['controller'], requires: 'decision' },
  { from: 'AWAITING_APPROVAL', to: 'DISMISSED', actors: ['controller'], requires: 'decision' },
  { from: 'DEFERRED', to: 'APPROVED', actors: ['controller'], requires: 'decision' },
  { from: 'DEFERRED', to: 'QUEUED', actors: ['controller'], requires: 'decision' },
  { from: 'DEFERRED', to: 'DISMISSED', actors: ['controller'], requires: 'decision' },
  { from: 'APPROVED', to: 'DONE', actors: ['executor'], requires: 'result' },
]

export function transitionRequest(
  request: ApprovalRequest,
  to: ApprovalRequest['status'],
  actor: ActorRole,
  patch: Partial<Pick<ApprovalRequest, 'decision' | 'resultRef'>> = {},
): ApprovalRequest {
  const rule = resolve(REQUEST_TRANSITIONS, request.status, to, actor)
  const next: ApprovalRequest = { ...request, ...patch, status: to, version: request.version + 1 }
  if (rule.requires === 'decision' && !next.decision) {
    throw new TransitionError('MISSING_REQUIREMENT', `${request.id}: ${to} requires a recorded decision`)
  }
  if (rule.requires === 'result' && !next.resultRef) {
    throw new TransitionError('MISSING_REQUIREMENT', `${request.id}: DONE requires a result reference`)
  }
  return next
}

// ── ExecutionGrant (OM §11.5·§11.9) ─────────────────────────────────────────
// 성공한 Grant는 재소비 불가(EXECUTED terminal). CLAIMED에서도 게시 직전 Drift Guard가
// 대상 변화를 발견하면 INVALIDATED로 끝난다 — 오래된 초안이 나가지 않게 하는 마지막 장치.

export const GRANT_TRANSITIONS: readonly TransitionRule<ExecutionGrant['status']>[] = [
  { from: 'READY', to: 'CLAIMED', actors: ['executor'] },
  { from: 'READY', to: 'INVALIDATED', actors: ['controller', 'executor'] },
  { from: 'READY', to: 'EXPIRED', actors: ['controller', 'executor'] },
  { from: 'CLAIMED', to: 'EXECUTED', actors: ['executor'], requires: 'result' },
  // CLAIM 이후의 무효화는 Drift Guard를 돌린 Executor만 한다 (OM §11.9). 정본에 Controller가
  // 진행 중인 Grant를 가로채는 경로가 없고, 실행 직전 상태 판단은 Executor 손에 있다.
  { from: 'CLAIMED', to: 'INVALIDATED', actors: ['executor'] },
]

export function transitionGrant(
  grant: ExecutionGrant,
  to: ExecutionGrant['status'],
  actor: ActorRole,
  patch: Partial<Pick<ExecutionGrant, 'claimedBy' | 'consumedAt' | 'resultRef'>> = {},
): ExecutionGrant {
  const rule = resolve(GRANT_TRANSITIONS, grant.status, to, actor)
  const next: ExecutionGrant = { ...grant, ...patch, status: to, version: grant.version + 1 }
  if (rule.requires === 'result' && !next.resultRef) {
    throw new TransitionError('MISSING_REQUIREMENT', `${grant.id}: EXECUTED requires a result reference`)
  }
  return next
}

// ── QueueItem (OM §4.8) — Controller ONLY ───────────────────────────────────

export const QUEUE_TRANSITIONS: readonly TransitionRule<QueueItem['state']>[] = [
  { from: 'READY', to: 'ACTIVE', actors: ['controller'] },
  { from: 'READY', to: 'BLOCKED', actors: ['controller'] },
  { from: 'ACTIVE', to: 'BLOCKED', actors: ['controller'] },
  { from: 'ACTIVE', to: 'DONE', actors: ['controller'] },
  { from: 'BLOCKED', to: 'READY', actors: ['controller'] },
  { from: 'BLOCKED', to: 'ACTIVE', actors: ['controller'] },
]

export function transitionQueueItem(
  item: QueueItem,
  to: QueueItem['state'],
  actor: ActorRole,
  patch: Partial<Pick<QueueItem, 'sessionId' | 'blockId'>> = {},
): QueueItem {
  resolve(QUEUE_TRANSITIONS, item.state, to, actor)
  return { ...item, ...patch, state: to, version: item.version + 1 }
}

// ── MonitorEvent (OM §10.5) ─────────────────────────────────────────────────
// Phase B 실패는 그 이벤트만 PENDING_RETRY로 남는다 — cursor는 전진하고 다음 Run이
// 실패분만 재시도한다.

export const EVENT_TRANSITIONS: readonly TransitionRule<MonitorEvent['processing']>[] = [
  { from: 'LOGGED', to: 'PROCESSED', actors: ['monitor'] },
  { from: 'LOGGED', to: 'PENDING_RETRY', actors: ['monitor'] },
  { from: 'PENDING_RETRY', to: 'PROCESSED', actors: ['monitor'] },
  { from: 'PENDING_RETRY', to: 'PENDING_RETRY', actors: ['monitor'] },
]

export function transitionEvent(
  event: MonitorEvent,
  to: MonitorEvent['processing'],
  actor: ActorRole,
  patch: Partial<Pick<MonitorEvent, 'requestId'>> = {},
): MonitorEvent {
  resolve(EVENT_TRANSITIONS, event.processing, to, actor)
  return { ...event, ...patch, processing: to, version: event.version + 1 }
}
