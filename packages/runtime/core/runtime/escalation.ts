// Escalation — 사람에게 올릴 자격이 있는가 (C-13).
//
// 지금까지 ASC에는 승인 통로가 다 있었는데 그 통로에 들어갈 자격 조건이 없었다.
// 그래서 "확신이 안 서서" 올린 것과 "내 권한 밖이라" 올린 것이 같은 모양으로 도착했고,
// 사람은 둘 다 읽어야 했다.
//
// 이 파일이 하는 일은 하나다: **자격 없는 상신을 ApprovalRequest 앞에서 막는다.**
//
//   predicate ≥ 1   → 기존 Approval 경로로 보낸다 (C-01 무수정, 결정 표면은 그대로)
//   predicate 0     → 만들지 않는다. 그리고 **막았다는 사실을 남긴다**
//
// 마지막 줄이 중요하다. 조용히 거절하면 Gate가 제 일을 하는지 아무도 못 본다 —
// Bounded Query가 막힌 시도를 violation으로 남기는 것과 같은 이유다 (C-04 §5.2).
//
// **판정 입력은 여기 적힌 구조뿐이다.** Checkpoint.blockers 같은 서술 문자열을 읽어
// 자동 판정하지 않는다 (C-13 불변식 ⑤) — 문구를 바꾸는 것이 곧 권한 변경이 되면 안 된다.

import { createHash } from 'node:crypto'

import { z } from 'zod'

import { SessionId } from '../model/ids.ts'
import type { ScopedStore } from '../../ports/state-store.ts'

/**
 * 올릴 자격이 되는 사유 (C-13 §1.1). **이 목록 밖으로는 올리지 않는다.**
 *
 * 불확실성(uncertain·multiple_options·want_confirmation 계열)은 여기 없다. 그것은
 * 경계가 아니라 상태이며, 올려 봐야 사람은 Agent보다 적은 근거로 결정하게 된다.
 */
export const EscalationPredicate = z.enum([
  'ownership_boundary',
  'shared_contract_change',
  'acceptance_change',
  'secret_or_permission',
  'irreversible_action',
  'explicit_rule_requires_approval',
  'canonical_conflict',
])
export type EscalationPredicate = z.infer<typeof EscalationPredicate>

export const ESCALATION_ID = /^ESC-\d{8}-\d{2}$/

export const EscalationRecord = z.object({
  escalationId: z.string().regex(ESCALATION_ID),
  sessionId: SessionId,
  /** 올린 주체. 누가 올렸는지 모르는 상신은 감사 대상이 아니다. */
  openedBy: z.string().min(1),
  predicates: z.array(EscalationPredicate).nonempty(),
  /** 사람이 답할 한 문장. */
  question: z.string().min(1),
  /** 근거 없는 상신은 상신이 아니다. */
  evidenceRefs: z.array(z.string().min(1)).nonempty(),
  affectedNodes: z.array(z.string()).default([]),
  /**
   * 이것 때문에 **지금 못 하는 작업 노드** (Done Criteria 항목).
   * 경계 영역(blockedScope)과 다른 축이다 (C-13 §2.1).
   */
  blockedNodes: z.array(z.string().min(1)).nonempty(),
  /** 경계의 실체 — 경로·영역 범위. 노드 목록이 아니다. */
  blockedScope: z.array(z.string()).default([]),
  /** 계속 갈 수 있는 노드. **자동 계산이며 올리는 쪽이 적지 않는다** (불변식 ③). */
  stillRunnableNodes: z.array(z.string()).default([]),
  boundaryFingerprint: z.string().min(1),
  previousEscalationId: z.string().optional(),
  whyPreviousDecisionDoesNotCoverThis: z.string().optional(),
  /** 이 상신으로 만들어진 ApprovalRequest. 결정은 기존 inbox 경로가 한다. */
  requestId: z.string().min(1),
  openedAt: z.string().min(1),
})
export type EscalationRecord = z.infer<typeof EscalationRecord>

/** 막힌 상신. 무엇을 올리려 했는지가 남아야 Gate를 검증할 수 있다. */
export const RejectedEscalation = z.object({
  sessionId: z.string().min(1),
  openedBy: z.string().min(1),
  question: z.string().min(1),
  /** 올린 쪽이 사유라고 적은 것. predicate가 아니어서 막혔다. */
  claimedReasons: z.array(z.string()).default([]),
  reason: z.enum(['APPROVAL_NOT_JUSTIFIED', 'DUPLICATE_EPISODE', 'RESUBMIT_NOT_JUSTIFIED']),
  detail: z.string().min(1),
  at: z.string().min(1),
})
export type RejectedEscalation = z.infer<typeof RejectedEscalation>

export type OpenInput = {
  escalationId: string
  sessionId: string
  openedBy: string
  /** 자유 문자열로 받는다 — 유효하지 않은 사유도 **무엇을 적었는지 남기기 위해** 받는다. */
  predicates: readonly string[]
  question: string
  evidenceRefs?: readonly string[]
  affectedNodes?: readonly string[]
  blockedNodes: readonly string[]
  blockedScope?: readonly string[]
  /** 이 세션의 완료 조건 전부. stillRunnableNodes를 여기서 뺀다. */
  doneCriteria?: readonly string[]
  previousEscalationId?: string
  whyPreviousDecisionDoesNotCoverThis?: string
  openedAt?: string
}

export type OpenOutcome =
  | { ok: true; record: EscalationRecord }
  | {
      ok: false
      reason: 'APPROVAL_NOT_JUSTIFIED' | 'DUPLICATE_EPISODE' | 'RESUBMIT_NOT_JUSTIFIED' | 'INVALID_INPUT'
      detail: string
      /** 이미 열려 있는 같은 경계. 사람이 그것을 보면 된다. */
      existing?: EscalationRecord
    }

export type ResolveOutcome =
  | { ok: true; record: EscalationRecord }
  | { ok: false; reason: 'NOT_FOUND' | 'ALREADY_RESOLVED'; detail: string }

const recordKey = (id: string) => `escalation:rec:${id}`
const RECORD_PREFIX = 'escalation:rec:'
const resolvedKey = (id: string) => `escalation:res:${id}`
const rejectedKey = (seq: number) => `escalation:vio:${String(seq).padStart(6, '0')}`
const REJECTED_PREFIX = 'escalation:vio:'

/**
 * 같은 경계인가 (C-13 §5).
 *
 * **evidence는 넣지 않는다** (불변식 ⑦). 넣으면 근거 한 줄만 더 붙여 같은 질문을 다시
 * 올릴 수 있고, 그게 정확히 Approval Budget이 막으려는 것이다.
 */
export function boundaryFingerprint(input: {
  predicates: readonly string[]
  blockedNodes: readonly string[]
  blockedScope?: readonly string[]
}): string {
  const canonical = JSON.stringify({
    predicates: [...input.predicates].sort(),
    blockedNodes: [...input.blockedNodes].sort(),
    blockedScope: [...(input.blockedScope ?? [])].sort(),
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

export class EscalationLedger {
  #scope: ScopedStore
  #now: () => string

  constructor(scope: ScopedStore, now: () => string = () => new Date().toISOString()) {
    this.#scope = scope
    this.#now = now
  }

  /**
   * 상신을 연다 — **이 함수가 Gate다.**
   *
   * 통과하면 record를 남기고 호출자가 ApprovalRequest를 만든다. 막히면 request는
   * 만들어지지 않고 막힌 사실이 남는다.
   */
  async open(input: OpenInput): Promise<OpenOutcome> {
    const at = input.openedAt ?? this.#now()
    const valid = input.predicates.filter(
      (candidate): candidate is EscalationPredicate => EscalationPredicate.safeParse(candidate).success,
    )

    if (valid.length === 0) {
      // 불확실성은 경계가 아니다 (C-13 §1.2). 막되, 무엇을 올리려 했는지 남긴다.
      const detail =
        input.predicates.length > 0
          ? `올릴 자격이 되는 사유가 없다 (받은 사유: ${input.predicates.join(', ')})`
          : '올릴 자격이 되는 사유가 하나도 없다'
      await this.#reject(input, 'APPROVAL_NOT_JUSTIFIED', detail, at)
      return { ok: false, reason: 'APPROVAL_NOT_JUSTIFIED', detail }
    }
    if (input.evidenceRefs === undefined || input.evidenceRefs.length === 0) {
      const detail = '근거 없는 상신은 상신이 아니다 — evidence를 최소 하나 대라'
      await this.#reject(input, 'APPROVAL_NOT_JUSTIFIED', detail, at)
      return { ok: false, reason: 'APPROVAL_NOT_JUSTIFIED', detail }
    }
    if (input.blockedNodes.length === 0) {
      return { ok: false, reason: 'INVALID_INPUT', detail: '무엇이 막혔는지(blockedNodes)가 없다' }
    }

    const fingerprint = boundaryFingerprint({
      predicates: valid,
      blockedNodes: input.blockedNodes,
      ...(input.blockedScope ? { blockedScope: input.blockedScope } : {}),
    })

    const open = (await this.pending()).filter((record) => record.sessionId === input.sessionId)
    const sameBoundary = open.find((record) => record.boundaryFingerprint === fingerprint)
    if (sameBoundary) {
      const detail = `같은 경계가 이미 열려 있다 (${sameBoundary.escalationId}) — 표현을 바꿔 다시 올리지 않는다`
      await this.#reject(input, 'DUPLICATE_EPISODE', detail, at)
      return { ok: false, reason: 'DUPLICATE_EPISODE', detail, existing: sameBoundary }
    }

    if (input.previousEscalationId) {
      const refused = await this.#judgeResubmit(input, valid, fingerprint)
      if (refused) {
        await this.#reject(input, 'RESUBMIT_NOT_JUSTIFIED', refused, at)
        return { ok: false, reason: 'RESUBMIT_NOT_JUSTIFIED', detail: refused }
      }
    }

    const blocked = new Set(input.blockedNodes)
    const record = EscalationRecord.parse({
      escalationId: input.escalationId,
      sessionId: input.sessionId,
      openedBy: input.openedBy,
      predicates: valid,
      question: input.question,
      evidenceRefs: input.evidenceRefs,
      affectedNodes: input.affectedNodes ?? [],
      blockedNodes: input.blockedNodes,
      blockedScope: input.blockedScope ?? [],
      // 자동 계산이다 — 올리는 쪽이 "다 막혔다"고 적어 전체를 세우는 길을 두지 않는다
      stillRunnableNodes: (input.doneCriteria ?? []).filter((node) => !blocked.has(node)),
      boundaryFingerprint: fingerprint,
      ...(input.previousEscalationId ? { previousEscalationId: input.previousEscalationId } : {}),
      ...(input.whyPreviousDecisionDoesNotCoverThis
        ? { whyPreviousDecisionDoesNotCoverThis: input.whyPreviousDecisionDoesNotCoverThis }
        : {}),
      // 결정 표면은 기존 Approval이다. 여기서는 그 참조만 든다.
      requestId: 'pending',
      openedAt: at,
    })
    if (!(await this.#scope.setIfAbsent(recordKey(record.escalationId), JSON.stringify(record)))) {
      return { ok: false, reason: 'INVALID_INPUT', detail: `${record.escalationId} 는 이미 있다` }
    }
    return { ok: true, record }
  }

  /** 만들어진 ApprovalRequest를 잇는다. record는 이미 확정됐고 참조만 채운다. */
  async attachRequest(escalationId: string, requestId: string): Promise<boolean> {
    const record = await this.#read(recordKey(escalationId))
    if (!record) return false
    await this.#scope.set(recordKey(escalationId), JSON.stringify({ ...record, requestId }))
    return true
  }

  /**
   * 사람이 결정해 닫혔다. **여기서 결정을 대신하지 않는다** — 결정은 기존 Approval
   * 경로에서 일어나고, 이 마커는 "그 결정이 이 경계를 덮었다"는 사실만 남긴다.
   */
  async resolve(escalationId: string, decidedBy: string, decisionRef: string, at?: string): Promise<ResolveOutcome> {
    const record = await this.#read(recordKey(escalationId))
    if (!record) return { ok: false, reason: 'NOT_FOUND', detail: `${escalationId} 를 찾지 못했다` }

    const marker = { decidedBy, decisionRef, resolvedAt: at ?? this.#now() }
    if (!(await this.#scope.setIfAbsent(resolvedKey(escalationId), JSON.stringify(marker)))) {
      return { ok: false, reason: 'ALREADY_RESOLVED', detail: `${escalationId} 는 이미 닫혔다` }
    }
    return { ok: true, record }
  }

  /** 아직 사람이 결정하지 않은 상신. 이것이 곧 "무엇을 기다리는가"다. */
  async pending(): Promise<EscalationRecord[]> {
    const out: EscalationRecord[] = []
    for (const record of await this.all()) {
      if (!(await this.#scope.get(resolvedKey(record.escalationId)))) out.push(record)
    }
    return out
  }

  async all(): Promise<EscalationRecord[]> {
    const keys = (await this.#scope.keys(RECORD_PREFIX)).sort()
    const out: EscalationRecord[] = []
    for (const key of keys) {
      const record = await this.#read(key)
      if (record) out.push(record)
    }
    return out
  }

  async get(escalationId: string): Promise<EscalationRecord | null> {
    return this.#read(recordKey(escalationId))
  }

  /** 막힌 상신들. Gate가 실제로 무엇을 막았는지 사람이 볼 수 있어야 한다. */
  async rejected(): Promise<RejectedEscalation[]> {
    const keys = (await this.#scope.keys(REJECTED_PREFIX)).sort()
    const out: RejectedEscalation[] = []
    for (const key of keys) {
      const raw = await this.#scope.get(key)
      if (!raw) continue
      const parsed = RejectedEscalation.safeParse(JSON.parse(raw))
      if (parsed.success) out.push(parsed.data)
    }
    return out
  }

  /**
   * 재상신이 정당한가 (C-13 §5.1). 정당하면 null, 아니면 거절 사유.
   *
   * **전부 필요하다.** evidence 하나 더 붙이는 것은 같은 질문을 더 잘 설명한 것이지
   * 새 질문이 아니다 (불변식 ⑧).
   */
  async #judgeResubmit(
    input: OpenInput,
    valid: readonly EscalationPredicate[],
    fingerprint: string,
  ): Promise<string | null> {
    const previous = await this.#read(recordKey(input.previousEscalationId!))
    if (!previous) return `${input.previousEscalationId} 를 찾지 못했다 — 잇는 대상이 없다`

    if (previous.boundaryFingerprint === fingerprint) {
      return '경계가 앞선 상신과 같다 — 근거만 더해서는 다시 올리지 않는다'
    }
    const newPredicate = valid.some((predicate) => !previous.predicates.includes(predicate))
    const newBoundary =
      input.blockedNodes.some((node) => !previous.blockedNodes.includes(node)) ||
      (input.blockedScope ?? []).some((scope) => !previous.blockedScope.includes(scope))
    if (!newPredicate && !newBoundary) {
      return '새 predicate도 새 경계도 없다 — 같은 사안이다'
    }
    const newEvidence = (input.evidenceRefs ?? []).some((ref) => !previous.evidenceRefs.includes(ref))
    if (!newEvidence) return '이전에 없던 근거가 없다'
    if (!input.whyPreviousDecisionDoesNotCoverThis) {
      return '앞선 결정이 왜 이걸 덮지 못하는지 적지 않았다'
    }
    return null
  }

  async #reject(
    input: OpenInput,
    reason: RejectedEscalation['reason'],
    detail: string,
    at: string,
  ): Promise<void> {
    const record = RejectedEscalation.parse({
      sessionId: input.sessionId,
      openedBy: input.openedBy,
      question: input.question,
      claimedReasons: [...input.predicates],
      reason,
      detail,
      at,
    })
    let seq = (await this.#scope.keys(REJECTED_PREFIX)).length + 1
    while (!(await this.#scope.setIfAbsent(rejectedKey(seq), JSON.stringify(record)))) seq += 1
  }

  async #read(key: string): Promise<EscalationRecord | null> {
    const raw = await this.#scope.get(key)
    if (!raw) return null
    const parsed = EscalationRecord.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  }
}

/**
 * 지금 무엇이 막혔고 무엇이 갈 수 있는가 (C-13 §6).
 *
 * **입력은 상신 기록뿐이다.** Checkpoint.blockers 같은 서술 문자열을 읽지 않는다
 * (불변식 ⑤) — 문구를 바꾸는 것이 곧 권한 변경이 되면 안 된다.
 *
 * 결과는 `deriveExecutionState`(C-10 §7)가 그대로 소비한다. 새 상태 enum도, 새 그래프도
 * 만들지 않는다: node는 Done Criteria 항목이고 막힌 것만 빠진다.
 */
export function proceedGateFacts(
  pending: readonly EscalationRecord[],
  doneCriteria: readonly string[],
): { waitingOn: string[]; conditions: string[]; runnable: string[] } {
  const blocked = new Set(pending.flatMap((record) => record.blockedNodes))
  const runnable = doneCriteria.filter((node) => !blocked.has(node))

  return {
    // 무엇을 왜 기다리는지 — 사유 없이 "대기"만 있으면 사람이 할 일을 모른다
    waitingOn: pending.map(
      (record) => `${record.escalationId} [${record.predicates.join(', ')}] ${record.blockedNodes.join(', ')}`,
    ),
    // 일부만 막혔으면 제한된 범위에서 계속 간다 (Conditional의 근거)
    conditions: blocked.size > 0 && runnable.length > 0 ? [`still runnable: ${runnable.join(', ')}`] : [],
    runnable,
  }
}

/**
 * 사람이 읽는 줄. **왜 이것이 Human Boundary인지가 먼저 온다** (C-13 §7).
 * "어떻게 할까요"가 아니라 "이 경계라서 당신 몫이다"가 상신의 형태다.
 */
export function escalationLines(records: readonly EscalationRecord[]): string[] {
  if (records.length === 0) return []
  const lines = ['Needs an outside decision:']
  for (const record of records) {
    lines.push(`  ${record.escalationId} — ${record.question}`)
    for (const predicate of record.predicates) lines.push(`    · ${predicate}`)
    lines.push(`    blocked: ${record.blockedNodes.join(', ')}`)
    // 무엇이 막혔는지(node)와 어느 경계에서 막혔는지(scope)는 다른 사실이다.
    // scope가 안 보이면 결정하는 사람이 "어디까지가 남의 것인가"를 다시 물어야 한다.
    if (record.blockedScope.length > 0) lines.push(`    boundary: ${record.blockedScope.join(', ')}`)
    if (record.stillRunnableNodes.length > 0) {
      // 무엇이 계속 가는지 같이 보여야 "전부 멈췄다"로 읽히지 않는다
      lines.push(`    still running: ${record.stillRunnableNodes.join(', ')}`)
    }
    lines.push(`    evidence: ${record.evidenceRefs.join(', ')}`)
  }
  return lines
}
