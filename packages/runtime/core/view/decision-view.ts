// Shared Decision View Model — 모든 채널(MM/Local/Web)이 같은 ApprovalRequest를 각자
// 재구성하지 않도록 Renderer 앞에 두는 공통 의미 구조 (C-01 §3).
// 강제하는 것은 화면 모양이 아니라 의미 구조와 request reference의 동일성이다.
// 채널은 접기·요약할 수 있어도 필드의 뜻을 바꾸거나 새로 만들 수 없다.

import { z } from 'zod'
import { CanonicalSnapshot, DecisionKind, EventType, Priority, RequestStatus } from '../model/entities.ts'
import { RequestId, SessionId, Timestamp, Version } from '../model/ids.ts'

/**
 * 조회 시점 기준으로 이 요청이 얼마나 신선한지 (C-01 §7).
 * 사용성·사전 경고 장치이며, 게시 직전 Drift Guard(OM §11.9)를 대체하지 않는다 —
 * CURRENT로 보였더라도 Executor는 실행 직전 대상 상태를 다시 확인한다.
 */
export const Freshness = z.enum([
  'CURRENT', // 확인할 수 있었던 범위에서 달라진 것이 없다 — 무엇을 확인했는지는 verification이 말한다
  'STALE_CONTEXT', // 로컬 작업 맥락이 변했다 (Active Session 교체 등)
  'SOURCE_CHANGED', // 대상 스레드 또는 canonical source가 변했다
  'ALREADY_DECIDED', // 다른 채널에서 이미 결정됐다
])
export type Freshness = z.infer<typeof Freshness>

/**
 * 무엇을 실제로 확인했는지. `CURRENT`는 "변화 없음"이 아니라 "확인할 수 있었던 범위에서
 * 변화 없음"이고, 그 범위가 어디까지였는지는 여기서만 알 수 있다.
 * 이 구분이 없으면 외부 연결이 끊긴 채 조회한 결과와 정말로 조용한 요청이 똑같아 보인다.
 */
export const VerificationStatus = z.enum([
  'VERIFIED', // 확인했고 달라진 것이 없다
  'UNAVAILABLE', // 확인해야 하는데 확인할 수단이 없었다
  'NOT_APPLICABLE', // 확인할 대상 자체가 없다
])
export type VerificationStatus = z.infer<typeof VerificationStatus>

export const VerificationCoverage = z.object({
  /** 활성 세션·Controller 상태 대조. */
  localContext: VerificationStatus,
  /** 스레드 최신 이벤트와 canonical baseline 대조 — 외부 연결이 있어야 한다. */
  source: VerificationStatus,
})
export type VerificationCoverage = z.infer<typeof VerificationCoverage>

/**
 * 요청 생성 당시의 분석. ApprovalRequest 원본에서 그대로 온 불변 값이다 (C-01 §6-A).
 * 조회 시점의 현재 사실처럼 제시하면 안 된다.
 */
export const StoredPacket = z.object({
  status: RequestStatus,
  type: EventType,
  priority: Priority,
  title: z.string(),
  detectedAt: Timestamp,
  source: z.string(), // 사람이 읽는 참조 — "Issue #19"
  situation: z.string(),
  context: z.string(),
  interruptRequired: z.boolean(),
  affectedSessions: z.array(SessionId),
  rationale: z.string(),
  recommendation: z.string(),
  draft: z.string().optional(),
  snapshot: z.array(CanonicalSnapshot),
  threadLastEventId: z.string().optional(),
})
export type StoredPacket = z.infer<typeof StoredPacket>

/**
 * 조회 시점에 state·controller·Active Session·Canonical을 다시 읽어 만든 파생 정보
 * (C-01 §6-B). Derived View다 — 원본을 덮어쓰지 않고 History도 건드리지 않는다.
 * 조회 환경이 이 정보를 만들 수 없으면 통째로 생략한다 (undefined).
 */
export const CurrentContextOverlay = z.object({
  observedAt: Timestamp,
  activeSessions: z.array(SessionId),
  /** 생성 당시 판단과 달라졌는가 — Stored의 interruptRequired와 대비해 보여준다. */
  affectsCurrentWork: z.boolean(),
  /** source별 baseline 변화. before가 없으면 요청이 그 source를 기록하지 않은 것이다. */
  canonicalChanges: z.array(
    z.object({ sourceId: z.string(), before: z.string().optional(), after: z.string() }),
  ),
  notes: z.array(z.string()),
})
export type CurrentContextOverlay = z.infer<typeof CurrentContextOverlay>

/**
 * 전 채널 공통 view. `reference`는 어느 표현에서도 숨기지 않는다 — 사용자가 MM에서 본
 * 요청을 로컬에서 그대로 지목할 수 있어야 하기 때문이다 (C-01 §2).
 */
export const DecisionView = z.object({
  requestId: RequestId,
  /** 복사 가능한 표시용 참조 — "ASC · P0 · REQ-0042 · Issue #19". */
  reference: z.string().min(1),
  version: Version, // 결정 제출 시 expectedVersion으로 되돌아온다
  stored: StoredPacket,
  current: CurrentContextOverlay.optional(),
  freshness: Freshness,
  verification: VerificationCoverage,
  allowedDecisions: z.array(DecisionKind).nonempty(),
  authorizedApprover: z.string(),
  expiresAt: Timestamp.optional(),
  /** 이미 결정된 요청이면 그 사실과 결과를 표시한다. */
  decided: z
    .object({ kind: DecisionKind, actor: z.string(), channel: z.string(), decidedAt: Timestamp })
    .optional(),
  resultRef: z.string().optional(),
})
export type DecisionView = z.infer<typeof DecisionView>

/** 목록 표시용 축약형. 복수 후보를 나열할 때 쓴다 (C-01 §11). */
export const DecisionSummary = DecisionView.pick({
  requestId: true,
  reference: true,
  version: true,
  freshness: true,
}).extend({
  status: RequestStatus,
  priority: Priority,
  title: z.string(),
  detectedAt: Timestamp,
})
export type DecisionSummary = z.infer<typeof DecisionSummary>
