// Core가 이해하는 Logical Entity Model. 파일 배치·Markdown 표현이 아니라 이 타입들이
// Core Contract다 — State Store Adapter는 이걸 저장 방식으로 투영할 뿐이다 (OM §7.0).
// 스키마가 곧 타입의 정본이며 (z.infer로 타입 도출) 이중 정본을 두지 않는다.

import { z } from 'zod'
import { BlockId, EventKey, GrantId, QueueItemId, RequestId, SessionId, Timestamp, Version } from './ids.ts'

// ── 공통 ────────────────────────────────────────────────────────────────────

/** 전이를 수행할 수 있는 주체. Writer 규칙(OM §7.2)과 상태 전이 권한의 기준. */
export const ActorRole = z.enum(['controller', 'monitor', 'executor', 'session'])
export type ActorRole = z.infer<typeof ActorRole>

export const Priority = z.enum(['P0', 'P1', 'P2'])
export type Priority = z.infer<typeof Priority>

/**
 * 이벤트 유형 — Phase B 조사 깊이를 결정한다 (OM §10.3).
 * informational 정보형 / actionable 대응형 / work 작업형.
 */
export const EventType = z.enum(['informational', 'actionable', 'work'])
export type EventType = z.infer<typeof EventType>

/**
 * Canonical source별 baseline. Project는 canonical 하나가 아니라 Session이 소비하는
 * source 집합을 갖는다 (OM §8) — snapshot도 단일 commit이 아니라 source별로 기록한다.
 */
export const CanonicalSnapshot = z.object({
  sourceId: z.string().min(1),
  baseline: z.string().min(1), // commit hash / event id 등 provider가 정하는 baseline
})
export type CanonicalSnapshot = z.infer<typeof CanonicalSnapshot>

// ── Session / Checkpoint / Handoff ──────────────────────────────────────────

/** Logical Session 상태 (OM §6.2). Physical Run과 1:1이 아니다. */
export const SessionStatus = z.enum(['READY', 'ACTIVE', 'PAUSED', 'BLOCKED', 'DONE', 'FAILED'])
export type SessionStatus = z.infer<typeof SessionStatus>

export const SessionRole = z.enum(['planner', 'researcher', 'implementer', 'verifier'])
export type SessionRole = z.infer<typeof SessionRole>

/** 중단 시 남기는 Run 승계 정보 — 다른 Physical Run이 같은 Logical Session을 이어받는다. */
export const Checkpoint = z.object({
  position: z.string().min(1),
  completedTasks: z.array(z.string()).default([]),
  nextAction: z.string().min(1),
  uncommittedChanges: z.array(z.string()).default([]),
  /**
   * 의미 있는 전환을 남기기 위한 필드들 (C-10 §2.1). 시간 경과는 전환이 아니다 —
   * "지금 무엇이 사실이라고 보는가"와 "그 판단의 근거"가 있어야 다음 사람이 이어받는다.
   *
   * 전부 optional·default다: 기존 세션 파일이 그대로 읽혀야 한다 (doneCriteria 선례).
   * 퍼센트는 여기 없다 — 필요하면 렌더가 만드는 projection이지 기록이 아니다.
   */
  currentJudgment: z.string().optional(),
  blockers: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  evidenceRefs: z.array(z.string()).default([]),
  /** 누가 적었는가 (execution principal). 소유권 검사와 함께 의미를 갖는다. */
  writtenBy: z.string().optional(),
  recordedAt: Timestamp,
})
export type Checkpoint = z.infer<typeof Checkpoint>

/** 세션 종료 산출물. 계약↔결과 짝이 어긋나지 않도록 Session entity 안에 둔다 (OM §7.1). */
export const Handoff = z.object({
  done: z.array(z.string()).default([]),
  changed: z.array(z.string()).default([]),
  verified: z.string(), // self-check임을 본문에 명시 (Verifier 독립 검증과 구분)
  unresolved: z.array(z.string()).default([]),
  next: z.string(),
  snapshot: z.array(CanonicalSnapshot).default([]),
  recordedAt: Timestamp,
})
export type Handoff = z.infer<typeof Handoff>

export const Session = z.object({
  id: SessionId,
  version: Version,
  status: SessionStatus,
  role: SessionRole,
  blockId: BlockId.optional(),
  goal: z.string().min(1),
  /**
   * 검증 가능한 완료조건 (C-03 §2). "무엇을 할지"(goal)와 "언제 끝인지"를 분리한다 —
   * Host completion loop projection과 Verifier test plan의 근거가 된다.
   * default([])라 기존 entity 파일이 그대로 읽힌다.
   */
  doneCriteria: z.array(z.string()).default([]),
  /**
   * 이 일을 끝까지 끌고 갈 주체 (C-04 §1.1). 다른 파트에 무언가를 물었다는 이유로
   * 바뀌지 않는다 — 바꾸는 경로 자체를 두지 않는다.
   */
  owner: z.string().min(1).optional(),
  /**
   * 이 일에 걸린 결정 영역. "무엇을 정해야 하는가"의 목록이며 결정권자는 아니다.
   * 비어 있는 것이 정상이다 — 대부분의 구현 세션은 cross-part 결정을 요구하지 않는다.
   */
  decisionDomains: z.array(z.string()).default([]),
  /**
   * 이번 세션에 한해 정한 결정권자 (domain → role). Profile ownership으로 풀리지 않는
   * 영역을 여기서 명시한다. OM §7.5의 `Authority:`(실행 자율도)와 다른 축이라 이름을
   * 나눴다 — 저쪽은 "이 세션이 무엇을 자율로 해도 되는가", 이쪽은 "이 결정이 누구 것인가".
   */
  decisionAuthority: z.record(z.string()).default({}),
  /** 외부에서 받아야 할 입력. 받는다는 사실이지 ownership 이전이 아니다 (C-04 §1.2). */
  dependencies: z.array(z.string()).default([]),
  taskPointer: z.string().optional(), // 공식 작업 목록 포인터 — 내용 복제 금지 (OM §1.3)
  canonicalSources: z.array(CanonicalSnapshot).default([]),
  readScope: z.array(z.string()).default([]),
  writeBoundary: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
  /** Controller가 이 세션에 한해 허용한 SOFT DENY 항목 (OM §5.1 Policy Exception). */
  policyExceptions: z.array(z.string()).default([]),
  checkpoint: Checkpoint.optional(),
  handoff: Handoff.optional(),
})
export type Session = z.infer<typeof Session>

// ── ApprovalRequest / ApprovalDecision ──────────────────────────────────────

/** Inbox lifecycle (OM §11.2). APPROVED는 승인 완료일 뿐 외부 write 권한이 아니다. */
export const RequestStatus = z.enum([
  'AWAITING_APPROVAL',
  'APPROVED',
  'QUEUED',
  'DEFERRED',
  'DISMISSED',
  'DONE',
])
export type RequestStatus = z.infer<typeof RequestStatus>

export const DecisionKind = z.enum(['approve', 'revise', 'defer', 'dismiss', 'queue'])
export type DecisionKind = z.infer<typeof DecisionKind>

/**
 * Controller가 원 Thread를 다시 읽지 않고 판단할 수 있도록 Monitor가 준비한 Decision
 * Packet (OM §11.1). 이 내용은 생성 시점의 분석 snapshot이며, 조회 시점의 현재 상태와
 * 섞지 않는다 — 현재 맥락은 Derived View로 따로 만든다 (C-01 §6).
 */
export const ApprovalRequest = z.object({
  id: RequestId,
  version: Version,
  status: RequestStatus,
  type: EventType,
  priority: Priority,
  title: z.string().min(1),
  detectedAt: Timestamp,
  source: z.object({
    eventKey: EventKey,
    reference: z.string().min(1), // Issue #19, PR #50 등 사람이 읽는 참조
    threadLastEventId: z.string().optional(),
  }),
  situation: z.string(),
  context: z.string().default(''),
  impact: z.object({
    interruptRequired: z.boolean(),
    affectedSessions: z.array(SessionId).default([]),
    rationale: z.string().default(''),
  }),
  recommendation: z.string().default(''),
  draft: z.string().optional(), // 대응형만. 게시는 Grant 경로로만 (OM §11.5)
  snapshot: z.array(CanonicalSnapshot).default([]),
  /** 이 요청을 결정할 수 있는 Controller identity (OM §11.6). */
  authorizedApprover: z.string().min(1),
  allowedDecisions: z.array(DecisionKind).nonempty(),
  expiresAt: Timestamp.optional(),
  /**
   * 이 요청이 Agent의 상신에서 왔다면 그 근거 (C-13 §2).
   *
   * optional인 이유: Monitor packet 경로(외부 사건 감지)는 escalation이 아니므로 이 값이
   * 없다. 기존 요청 파일도 그대로 읽힌다.
   */
  escalation: z
    .object({
      escalationId: z.string().min(1),
      predicates: z.array(z.string()).nonempty(),
      evidenceRefs: z.array(z.string()).nonempty(),
      affectedNodes: z.array(z.string()).default([]),
      /** 지금 못 하는 작업 노드. 경계 영역(blockedScope)과 다른 축이다. */
      blockedNodes: z.array(z.string()).nonempty(),
      blockedScope: z.array(z.string()).default([]),
      stillRunnableNodes: z.array(z.string()).default([]),
      previousEscalationId: z.string().optional(),
    })
    .optional(),
  decision: z
    .object({
      kind: DecisionKind,
      actor: z.string().min(1), // Adapter가 인증한 actor
      channel: z.string().min(1), // 'local' 등 — 채널 id는 Adapter가 정한다
      revision: z.string().optional(), // "마지막 문장 빼고 승인" 류 수정본
      decidedAt: Timestamp,
    })
    .optional(),
  resultRef: z.string().optional(), // 외부 반영 결과 (comment URL 등)
})
export type ApprovalRequest = z.infer<typeof ApprovalRequest>

/**
 * 채널 무관 결정 DTO. 모든 채널이 동일 requestId를 쓰며, 최초 유효 Decision 이후의
 * 입력은 CAS 실패로 거절된다 (C-01 §7~8).
 */
export const ApprovalDecision = z.object({
  requestId: RequestId,
  expectedVersion: Version,
  kind: DecisionKind,
  actor: z.string().min(1),
  channel: z.string().min(1),
  revision: z.string().optional(),
  decidedAt: Timestamp,
})
export type ApprovalDecision = z.infer<typeof ApprovalDecision>

// ── ExecutionGrant ──────────────────────────────────────────────────────────

/** Grant lifecycle (OM §11.5). 성공한 Grant는 재소비 불가 — replay guard의 근간. */
export const GrantStatus = z.enum(['READY', 'CLAIMED', 'EXECUTED', 'INVALIDATED', 'EXPIRED'])
export type GrantStatus = z.infer<typeof GrantStatus>

/**
 * Policy hierarchy의 하위 override가 아니라, Controller가 hierarchy 밖에서 생성하는
 * one-shot execution contract (OM §5.2). Session 권한은 그대로 두고 별도 Executor에게만
 * 단일 Action을 허용한다.
 */
export const ExecutionGrant = z.object({
  id: GrantId,
  version: Version,
  requestId: RequestId,
  status: GrantStatus,
  issuedBy: z.string().min(1),
  issuedAt: Timestamp,
  expiresAt: Timestamp.optional(),
  singleUse: z.boolean().default(true),
  action: z.string().min(1), // '<adapter>.<행위>' 형태의 행위 키 — Adapter가 해석한다
  target: z.string().min(1), // 대상 참조. 문법은 Adapter가 정한다
  payload: z.string(), // 승인된 내용 그대로. Executor가 재작성하지 않는다
  /** 게시 직전 Drift Guard가 대조할 기준 (OM §11.9). */
  snapshot: z.array(CanonicalSnapshot).default([]),
  threadLastEventId: z.string().optional(),
  allowedWrites: z.array(z.string()).default([]), // 명시된 것 외 모든 write 금지
  claimedBy: z.string().optional(),
  consumedAt: Timestamp.optional(),
  resultRef: z.string().optional(),
})
export type ExecutionGrant = z.infer<typeof ExecutionGrant>

// ── QueueItem / MonitorEvent / State ────────────────────────────────────────

export const QueueState = z.enum(['READY', 'ACTIVE', 'BLOCKED', 'DONE'])
export type QueueState = z.infer<typeof QueueState>

/** 승인되어 수행하기로 한 작업 (OM §4.8). inbox = 판단 대기, queue = 승인된 작업. */
export const QueueItem = z.object({
  id: QueueItemId,
  version: Version,
  state: QueueState,
  title: z.string().min(1),
  sourceRequestId: RequestId.optional(),
  blockId: BlockId.optional(),
  sessionId: SessionId.optional(),
})
export type QueueItem = z.infer<typeof QueueItem>

/** Phase B 처리 결과 — 부분 실패해도 cursor는 전진하고 실패분만 재시도한다 (OM §10.5). */
export const EventProcessing = z.enum(['LOGGED', 'PROCESSED', 'PENDING_RETRY'])
export type EventProcessing = z.infer<typeof EventProcessing>

export const MonitorEvent = z.object({
  eventKey: EventKey,
  version: Version,
  detectedAt: Timestamp,
  type: EventType,
  suggestedPriority: Priority,
  processing: EventProcessing,
  inboxCandidate: z.boolean(),
  requestId: RequestId.optional(), // Phase B가 패킷을 만든 경우
  /**
   * 관련성 판정과 그 근거 (C-07 §3). 숫자가 아니라 문장을 남기는 이유는, 판정이 틀렸을 때
   * 사람이 어디가 틀렸는지 보고 뒤집을 수 있어야 하기 때문이다.
   * optional이라 기존 event 파일이 그대로 읽힌다.
   */
  relevance: z
    .object({
      explicit: z.enum(['HIGH', 'LOW']),
      actual: z.enum(['HIGH', 'LOW']),
      disposition: z.enum(['INBOX', 'SHADOW']),
      evidence: z.array(z.string()).default([]),
    })
    .optional(),
  /**
   * 조사를 다시 하려면 원본이 있어야 한다. cursor는 이미 지나갔고 provider가 같은 것을
   * 또 주리라는 보장이 없으므로, 재시도에 필요한 만큼을 여기 남긴다 (OM §10.5).
   */
  replay: z
    .object({
      reference: z.string().min(1),
      raw: z.unknown().optional(),
      hints: z.record(z.unknown()).optional(),
      /**
       * 이미 끝난 조사 단계 (C-07 §6.3). 재시도가 처음부터 다시 하면 비싼 단계에서
       * 실패한 사건은 영영 넘지 못한다.
       */
      steps: z
        .array(
          z.object({
            id: z.string().min(1),
            kind: z.enum(['DONE', 'UNDECIDABLE', 'SKIPPED']),
            findings: z.array(z.string()).default([]),
            detail: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
})
export type MonitorEvent = z.infer<typeof MonitorEvent>

/**
 * Controller single-writer 상태 문서 (OM §7.2). Monitoring 절에는 포인터만 두고
 * 갱신자 없는 숫자·시각을 두지 않는다.
 */
export const ControlState = z.object({
  version: Version,
  activeBlock: BlockId.optional(),
  activeSessions: z.array(SessionId).default([]),
  recentHandoff: SessionId.optional(),
  writeBoundaryOccupancy: z.array(z.object({ sessionId: SessionId, paths: z.array(z.string()) })).default([]),
  awaitingController: z.array(z.string()).default([]),
  controllerAttention: z.array(z.string()).default([]),
})
export type ControlState = z.infer<typeof ControlState>
