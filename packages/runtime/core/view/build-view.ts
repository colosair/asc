// ApprovalRequest → Shared Decision View Model 조립.
//
// 여기서 지키는 것 하나: 요청이 만들어질 때의 분석(stored)과 지금 다시 읽은 사실(current)을
// 절대 한 덩어리로 섞지 않는다 (C-01 §6). 14:00에 "S-020에 영향 없음"이라고 적힌 판단은
// 14:20에도 그때의 판단일 뿐이고, 지금 무슨 일이 벌어지는지는 따로 계산해 나란히 놓는다.

import type { ApprovalRequest, ControlState } from '../model/entities.ts'
import type { ScmPort } from '../../ports/scm.ts'
import type {
  CurrentContextOverlay,
  DecisionSummary,
  DecisionView,
  Freshness,
  StoredPacket,
  VerificationCoverage,
  VerificationStatus,
} from './decision-view.ts'

/** 어느 채널에서도 이 문자열로 같은 요청을 지목할 수 있어야 한다 (C-01 §2). */
export function referenceOf(request: ApprovalRequest): string {
  return `ASC · ${request.priority} · ${request.id} · ${request.source.reference}`
}

const DECIDED_STATUSES = new Set(['APPROVED', 'QUEUED', 'DEFERRED', 'DISMISSED', 'DONE'])

export function storedPacketOf(request: ApprovalRequest): StoredPacket {
  return {
    status: request.status,
    type: request.type,
    priority: request.priority,
    title: request.title,
    detectedAt: request.detectedAt,
    source: request.source.reference,
    situation: request.situation,
    context: request.context,
    interruptRequired: request.impact.interruptRequired,
    affectedSessions: request.impact.affectedSessions,
    rationale: request.impact.rationale,
    recommendation: request.recommendation,
    ...(request.draft !== undefined ? { draft: request.draft } : {}),
    snapshot: request.snapshot,
    ...(request.source.threadLastEventId !== undefined
      ? { threadLastEventId: request.source.threadLastEventId }
      : {}),
  }
}

export function summarize(request: ApprovalRequest, freshness: Freshness): DecisionSummary {
  return {
    requestId: request.id,
    reference: referenceOf(request),
    version: request.version,
    freshness,
    status: request.status,
    priority: request.priority,
    title: request.title,
    detectedAt: request.detectedAt,
  }
}

export type OverlayInput = {
  control: ControlState
  observedAt: string
  /** 없으면 외부 상태를 확인할 수 없다 — canonical 비교와 스레드 확인을 건너뛴다. */
  scm?: ScmPort
}

/**
 * 조회 시점의 사실을 다시 읽어 만든 Derived View.
 * 원본 요청도 History도 건드리지 않는다 (C-01 §6-B).
 */
export async function buildOverlay(
  request: ApprovalRequest,
  input: OverlayInput,
): Promise<CurrentContextOverlay> {
  const notes: string[] = []
  const activeSessions = input.control.activeSessions

  // 생성 당시 "영향 있음"으로 지목된 세션과 지금 도는 세션이 겹치는가.
  // 요청이 세션을 지목하지 않았다면 판단 근거가 없다 — 없음을 없음이라고 적는다.
  const affected = request.impact.affectedSessions
  let affectsCurrentWork = false
  if (affected.length > 0) {
    affectsCurrentWork = activeSessions.some((id) => affected.includes(id))
    if (!affectsCurrentWork && activeSessions.length > 0) {
      notes.push(`알림 당시 기준 세션(${affected.join(', ')})은 지금 활성이 아니다`)
    }
  }

  const canonicalChanges: CurrentContextOverlay['canonicalChanges'] = []
  if (input.scm && request.snapshot.length > 0) {
    const current = await input.scm.getBaselines(request.snapshot.map((s) => ({ sourceId: s.sourceId })))
    for (const now of current) {
      const before = request.snapshot.find((s) => s.sourceId === now.sourceId)?.baseline
      if (before !== now.baseline) canonicalChanges.push({ sourceId: now.sourceId, before, after: now.baseline })
    }
  }
  // 확인하지 못했다는 사실은 notes가 아니라 verification이 구조적으로 말한다 (assess 참조)

  return { observedAt: input.observedAt, activeSessions, affectsCurrentWork, canonicalChanges, notes }
}

/**
 * 조회 시점의 신선도와, 그 판단이 무엇을 근거로 했는지 (C-01 §7).
 *
 * `CURRENT`는 "아무것도 안 변했다"가 아니라 "확인할 수 있었던 범위에서 안 변했다"이다.
 * 외부 연결이 없어 원본을 못 본 채 얻은 CURRENT와, 원본까지 확인하고 얻은 CURRENT는
 * 사용자에게 다른 이야기이므로 verification으로 갈라 말한다.
 *
 * 더 무거운 사실이 가벼운 사실을 덮는다: 이미 결정됨 > 원본 변함 > 맥락 변함.
 * 사용성·사전 경고용이며 게시 직전 Drift Guard를 대신하지 않는다 (OM §11.9).
 */
export async function assess(
  request: ApprovalRequest,
  overlay: CurrentContextOverlay,
  scm?: ScmPort,
): Promise<{ freshness: Freshness; verification: VerificationCoverage }> {
  const hasSourceToCheck = request.snapshot.length > 0 || request.source.threadLastEventId !== undefined
  const localContext: VerificationStatus =
    request.impact.affectedSessions.length > 0 ? 'VERIFIED' : 'NOT_APPLICABLE'

  let source: VerificationStatus = 'NOT_APPLICABLE'
  if (hasSourceToCheck) source = scm ? 'VERIFIED' : 'UNAVAILABLE'

  const verify = (freshness: Freshness) => ({ freshness, verification: { localContext, source } })

  if (DECIDED_STATUSES.has(request.status)) return verify('ALREADY_DECIDED')
  if (overlay.canonicalChanges.length > 0) return verify('SOURCE_CHANGED')

  if (scm && request.source.threadLastEventId) {
    const thread = await scm.getThread(request.source.reference)
    if (thread.missing || thread.lastEventId !== request.source.threadLastEventId) return verify('SOURCE_CHANGED')
  }

  // 알림 당시 지목된 세션이 더는 돌지 않거나 다른 세션이 도는 상황.
  // 요청 자체는 그대로지만 사용자가 읽는 맥락이 달라졌다.
  const affected = request.impact.affectedSessions
  if (affected.length > 0 && overlay.activeSessions.length > 0 && !overlay.affectsCurrentWork) {
    return verify('STALE_CONTEXT')
  }
  return verify('CURRENT')
}

export function assembleView(
  request: ApprovalRequest,
  assessment: { freshness: Freshness; verification: VerificationCoverage },
  overlay?: CurrentContextOverlay,
): DecisionView {
  return {
    requestId: request.id,
    reference: referenceOf(request),
    version: request.version,
    stored: storedPacketOf(request),
    ...(overlay ? { current: overlay } : {}),
    freshness: assessment.freshness,
    verification: assessment.verification,
    allowedDecisions: request.allowedDecisions,
    authorizedApprover: request.authorizedApprover,
    ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
    ...(request.decision
      ? {
          decided: {
            kind: request.decision.kind,
            actor: request.decision.actor,
            channel: request.decision.channel,
            decidedAt: request.decision.decidedAt,
          },
        }
      : {}),
    ...(request.resultRef !== undefined ? { resultRef: request.resultRef } : {}),
  }
}
