// Orchestration Audit — 무슨 일이 실제로 있었는가 (C-10).
//
// 두 사실을 따로 적는다. 합치면 둘 중 하나가 다른 하나의 증거인 척하게 된다:
//
//   Delegation   누가 누구에게 무엇을 맡겼다고 **선언**했는가   (의도)
//   Execution    실제로 어떤 실행 주체가 그것을 **집었는가**     (사실)
//
// 위임만 있고 실행이 없으면 "발급됐으나 아무도 수행하지 않았다"이고, 그건 결함이 아니라
// 정확히 그 상태다 (C-10 §1.1). 그렇게 보이게 두는 것이 이 모듈의 목적이다.
//
// 왜 Progress가 아닌가 (C-10 §0.2): Progress는 살아 있는 표시라 최신 1건만 남고 회수 때
// 정리된다. 여기는 회수 후에도 남아야 하는 기록이다. 수명이 다르면 같은 자리에 두지 않는다.
//
// 왜 Session entity가 아닌가 (C-10 §0.1): OM §7.0 Entity 목록과 §11.2 상태 enum은 동결이다.
// Closure Ledger·Bounded Query·Observation Ledger와 같은 adapter-scope 레코드로 산다.
//
// 저장은 **전부 setIfAbsent 위에 선다.** ScopedStore가 원자성을 약속한 것은 그것뿐이고,
// 잃는 것이 표시값이 아니라 "그때 그 실행이 있었다"는 사실이기 때문이다. 그래서 바뀌는
// 값(실행 종료)도 갱신이 아니라 **끝 마커를 따로 append**해 읽을 때 합친다 —
// Closure Ledger가 항목별 확인 마커를 따로 두는 것과 같은 이유다.

import { z } from 'zod'

import { SessionId } from '../model/ids.ts'
import type { ScopedStore } from '../../ports/state-store.ts'

/**
 * principal 신고 수준 (C-10 §3).
 *
 * ASC는 신고를 검증할 수단이 없다. Host attestation이 없는 상태에서 "검증했다"고 쓰는 것이
 * 검증하지 않는 것보다 나쁘므로, 검증 대신 **신고 수준을 기록**한다.
 */
export const PrincipalSource = z.enum(['declared', 'derived'])
export type PrincipalSource = z.infer<typeof PrincipalSource>

export const ExecutionStatus = z.enum(['RUNNING', 'RELEASED', 'SUPERSEDED'])
export type ExecutionStatus = z.infer<typeof ExecutionStatus>

export const DelegationRecord = z.object({
  delegationId: z.string().min(1),
  /** 위임한 세션. 없으면 최상위 발급이다 — 없는 부모를 지어내지 않는다. */
  parentSessionId: SessionId.optional(),
  childSessionId: SessionId,
  role: z.string().min(1),
  goal: z.string().min(1),
  /** 세션 계약의 사본이 아니라 발급 시점 요약. 정본은 Session entity다. */
  scope: z.array(z.string()).default([]),
  doneCriteria: z.array(z.string()).default([]),
  issuedBy: z.string().min(1),
  issuedAt: z.string().min(1),
  /** 결과를 누구에게 돌려야 하는가. 보통 parentSessionId. */
  expectedReturnTo: z.string().optional(),
})
export type DelegationRecord = z.infer<typeof DelegationRecord>

export const ExecutionEvidence = z.object({
  executionId: z.string().min(1),
  logicalSessionId: SessionId,
  /** 어느 Host가 관찰했는가. provider 이름이 아니라 adapter id다. */
  hostAdapter: z.string().min(1),
  principal: z.string().min(1),
  principalSource: PrincipalSource,
  /** Host가 아는 실행 참조(physical session id 등). 같은 사람이 여럿 가질 수 있다. */
  physicalReference: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().optional(),
  status: ExecutionStatus,
  /** 이 사실이 어디서 왔는가 — 선언인가 관찰인가. */
  evidenceSource: z.string().min(1),
})
export type ExecutionEvidence = z.infer<typeof ExecutionEvidence>

/** 저장형. status·finishedAt은 여기 없다 — 끝 마커가 따로 산다. */
const StoredExecution = ExecutionEvidence.omit({ status: true, finishedAt: true })
type StoredExecution = z.infer<typeof StoredExecution>

const ExecutionEnd = z.object({
  finishedAt: z.string().min(1),
  status: z.enum(['RELEASED', 'SUPERSEDED']),
})
type ExecutionEnd = z.infer<typeof ExecutionEnd>

export const ReclaimEvidence = z.object({
  sessionId: SessionId,
  /** 회수 주체. 모르면 기록하지 않는다 — 익명 회수는 감사 공백이다 (C-10 §2.4 불변식 ⑥). */
  reclaimedBy: z.string().min(1),
  reclaimedAt: z.string().min(1),
  /** 무엇을 받았는가. Handoff 시각으로 가리킨다 — 본문을 복제하지 않는다. */
  handoffRef: z.string().optional(),
  /** 회수 시점에 살아 있던 실행들. archive 뒤에는 세션에서 복원되지 않는다. */
  executionRefs: z.array(z.string()).default([]),
})
export type ReclaimEvidence = z.infer<typeof ReclaimEvidence>

/**
 * 독립성 등급 (C-10 §4.2).
 *
 * ASC는 principal 신고를 검증하지 못한다. 그래서 "다르다"고 말할 수 있는 조건을
 * 좁게 잡는다 — 양쪽 모두 선언됐고 실제로 다를 때만 독립이다.
 */
export const Independence = z.enum(['INDEPENDENT', 'SELF_REPORTED', 'UNVERIFIED'])
export type Independence = z.infer<typeof Independence>

export const ValidationRecord = z.object({
  validationId: z.string().min(1),
  validatorSessionId: SessionId,
  /** 그 검증을 실제로 수행한 실행. 없으면 검증 세션이 있다는 주장뿐이다. */
  validatorExecutionId: z.string().min(1),
  principal: z.string().min(1),
  principalSource: PrincipalSource,
  targetSessionId: SessionId,
  /** 무엇을 보고 판정했는가. Handoff 시각·리비전으로 가리킨다. */
  targetHandoffRef: z.string().optional(),
  targetRevision: z.string().optional(),
  result: z.enum(['PASS', 'FAIL']),
  /** 무엇을 봤는가. 결과만 남기면 다음 사람이 다시 볼 수 없다. */
  findings: z.array(z.string()).default([]),
  verifiedAt: z.string().min(1),
  independence: Independence,
  /** 왜 그 등급인가. 등급만 있으면 뒤집을 근거가 없다. */
  independenceDetail: z.string().min(1),
})
export type ValidationRecord = z.infer<typeof ValidationRecord>

/**
 * 승인 없이 내린 결정의 갈래 (C-13 §4.1).
 *
 * 앞 넷은 자율 판단의 자리이고, 뒤 다섯은 escalation predicate와 짝을 이룬다 —
 * 뒤쪽 class로 결정을 내렸는데 상신이 없으면 그 자체가 이상 신호다.
 */
export const DecisionClass = z.enum([
  'implementation_detail',
  'owned_contract_consumption',
  'local_test_strategy',
  'local_refactor',
  'external_boundary',
  'shared_contract',
  'acceptance',
  'permission',
  'irreversible',
])
export type DecisionClass = z.infer<typeof DecisionClass>

/**
 * 승인 없이 갔다는 것이 기록이 없어도 된다는 뜻은 아니다 (C-13 §4).
 *
 * **부여받은 authority 안에서의 자율 판단임을 감사 가능하게** 남긴다. 무엇과 견줬는지
 * (alternatives)가 없으면 비교 없이 고른 것과 구분되지 않는다.
 */
export const DecisionEvidence = z.object({
  decisionId: z.string().min(1),
  sessionId: SessionId,
  actor: z.string().min(1),
  /** 어느 권한 안에서 내렸는가. 비어 있으면 권한을 대지 못한 결정이다. */
  ownership: z.array(z.string()).default([]),
  class: DecisionClass,
  evidenceRefs: z.array(z.string().min(1)).nonempty(),
  selectedOption: z.string().min(1),
  alternatives: z.array(z.string()).default([]),
  /** 왜 경계가 아니었는가. 이것이 없으면 자율 판단이 아니라 그냥 안 물어본 것이다. */
  whyNoApproval: z.array(z.string().min(1)).nonempty(),
  verification: z.array(z.string()).default([]),
  decidedAt: z.string().min(1),
})
export type DecisionEvidence = z.infer<typeof DecisionEvidence>

export type DecisionOutcome = { ok: true; decision: DecisionEvidence }

export type DelegationOutcome =
  | { ok: true; record: DelegationRecord }
  | { ok: false; reason: 'ALREADY_RECORDED'; detail: string; existing: DelegationRecord }

export type ExecutionOutcome = { ok: true; evidence: ExecutionEvidence }

export type EndOutcome =
  | { ok: true; evidence: ExecutionEvidence }
  | { ok: false; reason: 'NOT_FOUND' | 'ALREADY_ENDED'; detail: string }

export type ValidationOutcome =
  | { ok: true; record: ValidationRecord }
  | { ok: false; reason: 'NO_VALIDATOR_EXECUTION'; detail: string }
  | { ok: false; reason: 'ALREADY_RECORDED'; detail: string }

export type ReclaimOutcome =
  | { ok: true; record: ReclaimEvidence }
  | { ok: false; reason: 'ALREADY_RECLAIMED'; detail: string }

/** 한 child session은 한 번 위임된다 — 그래서 id 자체가 키다. */
const delegationKey = (childSessionId: string) => `audit:del:${childSessionId}`
const delegationPrefix = 'audit:del:'
const executionKey = (sessionId: string, seq: number) => `audit:exec:${sessionId}:${seq}`
const executionPrefix = (sessionId?: string) =>
  sessionId ? `audit:exec:${sessionId}:` : 'audit:exec:'
const executionEndKey = (executionId: string) => `audit:exec-end:${executionId}`
const reclaimKey = (sessionId: string) => `audit:rec:${sessionId}`
const decisionKey = (sessionId: string, seq: number) => `audit:dec:${sessionId}:${seq}`
const decisionPrefix = (sessionId: string) => `audit:dec:${sessionId}:`
const validationKey = (targetSessionId: string, seq: number) => `audit:val:${targetSessionId}:${seq}`
const validationPrefix = (targetSessionId: string) => `audit:val:${targetSessionId}:`

/** `E-S-20260826-01-2` — 실행 참조가 아니라 이 기록의 이름이다. */
const executionIdOf = (sessionId: string, seq: number) => `E-${sessionId}-${seq}`
const seqOfKey = (key: string) => Number(key.slice(key.lastIndexOf(':') + 1))

export class AuditLedger {
  #scope: ScopedStore
  #now: () => string

  constructor(scope: ScopedStore, now: () => string = () => new Date().toISOString()) {
    this.#scope = scope
    this.#now = now
  }

  /**
   * 위임을 선언으로 기록한다.
   *
   * **상태 전이를 일으키지 않는다** (C-10 §1.2 불변식 ②). 전이는 전이표만 한다.
   * 두 번째 위임 선언은 조용히 덮지 않고 거부한다 — 같은 세션을 두 번 맡겼다면
   * 그건 기록이 아니라 사고이므로 사람이 봐야 한다.
   */
  async delegate(input: Omit<DelegationRecord, 'delegationId' | 'issuedAt'> & { issuedAt?: string }): Promise<DelegationOutcome> {
    const record = DelegationRecord.parse({
      ...input,
      delegationId: `D-${input.childSessionId}`,
      issuedAt: input.issuedAt ?? this.#now(),
    })
    const key = delegationKey(record.childSessionId)
    if (await this.#scope.setIfAbsent(key, JSON.stringify(record))) return { ok: true, record }

    const existing = await this.#read(key, DelegationRecord)
    return {
      ok: false,
      reason: 'ALREADY_RECORDED',
      detail: `${record.childSessionId} 는 이미 위임 기록이 있다`,
      ...(existing ? { existing } : { existing: record }),
    }
  }

  async delegationOf(childSessionId: string): Promise<DelegationRecord | null> {
    return this.#read(delegationKey(childSessionId), DelegationRecord)
  }

  /** 이 세션이 위임한 것들. parent 축으로 본다. */
  async delegationsFrom(parentSessionId: string): Promise<DelegationRecord[]> {
    const all = await this.#list(delegationPrefix, DelegationRecord)
    return all.filter((d) => d.parentSessionId === parentSessionId)
  }

  /**
   * 실행이 실제로 시작됐다는 사실을 남긴다.
   *
   * 순번은 setIfAbsent가 성공할 때까지 올린다 — 읽고-고쳐-쓰기를 하면 두 실행이 동시에
   * 붙을 때 하나가 조용히 사라진다. 실패는 경쟁이지 오류가 아니므로 다음 번호로 간다.
   */
  async execute(
    input: Omit<ExecutionEvidence, 'executionId' | 'status' | 'finishedAt' | 'startedAt'> & { startedAt?: string },
  ): Promise<ExecutionOutcome> {
    const startedAt = input.startedAt ?? this.#now()
    const existing = await this.#scope.keys(executionPrefix(input.logicalSessionId))
    let seq = existing.reduce((max, key) => Math.max(max, seqOfKey(key) || 0), 0) + 1

    for (;;) {
      const stored = StoredExecution.parse({
        ...input,
        executionId: executionIdOf(input.logicalSessionId, seq),
        startedAt,
      })
      if (await this.#scope.setIfAbsent(executionKey(input.logicalSessionId, seq), JSON.stringify(stored))) {
        return { ok: true, evidence: { ...stored, status: 'RUNNING' } }
      }
      seq += 1
    }
  }

  /**
   * 실행이 끝났다. **시작 기록을 고치지 않고 끝 마커를 따로 남긴다** —
   * 현재 소유권(Runtime Binding)은 사라져도 "그때 그 실행이 있었다"는 사실은 남아야 한다
   * (C-10 §1.3 불변식 ④).
   */
  async endExecution(executionId: string, status: ExecutionEnd['status'], at?: string): Promise<EndOutcome> {
    const found = await this.#findExecution(executionId)
    if (!found) return { ok: false, reason: 'NOT_FOUND', detail: `${executionId} 실행 기록이 없다` }

    const end = ExecutionEnd.parse({ finishedAt: at ?? this.#now(), status })
    if (!(await this.#scope.setIfAbsent(executionEndKey(executionId), JSON.stringify(end)))) {
      return { ok: false, reason: 'ALREADY_ENDED', detail: `${executionId} 는 이미 끝났다고 기록돼 있다` }
    }
    return { ok: true, evidence: { ...found, ...end } }
  }

  /** 이 세션을 거쳐 간 실행 전부. 순서는 순번 순 — 회수 후에도 남는다. */
  async executionsOf(logicalSessionId: string): Promise<ExecutionEvidence[]> {
    const keys = (await this.#scope.keys(executionPrefix(logicalSessionId))).sort(
      (a, b) => (seqOfKey(a) || 0) - (seqOfKey(b) || 0),
    )
    const out: ExecutionEvidence[] = []
    for (const key of keys) {
      const stored = await this.#read(key, StoredExecution)
      if (stored) out.push(await this.#compose(stored))
    }
    return out
  }

  /**
   * Controller가 실제로 회수했다는 별도 증거.
   *
   * 회수 시점에 살아 있던 실행을 함께 붙인다 — archive 이후에는 세션에서 그것을
   * 되찾을 수 없기 때문이다 (C-10 §2.4).
   */
  async reclaim(input: Omit<ReclaimEvidence, 'executionRefs'>): Promise<ReclaimOutcome> {
    const running = (await this.executionsOf(input.sessionId)).filter((e) => e.status === 'RUNNING')
    const record = ReclaimEvidence.parse({ ...input, executionRefs: running.map((e) => e.executionId) })
    if (await this.#scope.setIfAbsent(reclaimKey(record.sessionId), JSON.stringify(record))) {
      return { ok: true, record }
    }
    return { ok: false, reason: 'ALREADY_RECLAIMED', detail: `${record.sessionId} 는 이미 회수 기록이 있다` }
  }

  async reclaimOf(sessionId: string): Promise<ReclaimEvidence | null> {
    return this.#read(reclaimKey(sessionId), ReclaimEvidence)
  }

  /**
   * 검증 결과를 기록한다.
   *
   * **검증자의 실행 증거가 없으면 기록하지 않는다** (C-10 §4). 세션 id만 만들어 두고
   * "검증했다"고 적는 것이 정확히 이 계약이 막는 것이다.
   *
   * 독립성은 주장이 아니라 판정이다 — 여기서 계산해 넣고, 호출자가 정하지 못한다.
   */
  async validate(input: {
    validatorSessionId: string
    targetSessionId: string
    result: 'PASS' | 'FAIL'
    findings?: readonly string[]
    targetHandoffRef?: string
    targetRevision?: string
    verifiedAt?: string
  }): Promise<ValidationOutcome> {
    const validatorRuns = await this.executionsOf(input.validatorSessionId)
    const run = validatorRuns.at(-1)
    if (!run) {
      return {
        ok: false,
        reason: 'NO_VALIDATOR_EXECUTION',
        detail: `${input.validatorSessionId} 에 실행 증거가 없다 — 세션 id만으로는 검증을 기록하지 않는다`,
      }
    }

    const judged = judgeIndependence(run, await this.executionsOf(input.targetSessionId))
    const existing = await this.#scope.keys(validationPrefix(input.targetSessionId))
    let seq = existing.reduce((max, key) => Math.max(max, seqOfKey(key) || 0), 0) + 1

    for (;;) {
      const record = ValidationRecord.parse({
        validationId: `V-${input.targetSessionId}-${seq}`,
        validatorSessionId: input.validatorSessionId,
        validatorExecutionId: run.executionId,
        principal: run.principal,
        principalSource: run.principalSource,
        targetSessionId: input.targetSessionId,
        ...(input.targetHandoffRef ? { targetHandoffRef: input.targetHandoffRef } : {}),
        ...(input.targetRevision ? { targetRevision: input.targetRevision } : {}),
        result: input.result,
        findings: input.findings ?? [],
        verifiedAt: input.verifiedAt ?? this.#now(),
        independence: judged.independence,
        independenceDetail: judged.detail,
      })
      if (await this.#scope.setIfAbsent(validationKey(input.targetSessionId, seq), JSON.stringify(record))) {
        return { ok: true, record }
      }
      seq += 1
    }
  }

  /** 이 세션에 대한 검증들. 없으면 빈 배열 — "검증 없음"도 사실이다. */
  async validationsOf(targetSessionId: string): Promise<ValidationRecord[]> {
    const keys = (await this.#scope.keys(validationPrefix(targetSessionId))).sort(
      (a, b) => (seqOfKey(a) || 0) - (seqOfKey(b) || 0),
    )
    const out: ValidationRecord[] = []
    for (const key of keys) {
      const record = await this.#read(key, ValidationRecord)
      if (record) out.push(record)
    }
    return out
  }

  /**
   * 승인 없이 내린 결정을 남긴다.
   *
   * 순번은 setIfAbsent가 성공할 때까지 올린다 — 같은 세션의 두 결정이 겹쳐도 하나가
   * 조용히 사라지지 않는다 (execute와 같은 형태).
   */
  async decide(
    input: Omit<DecisionEvidence, 'decisionId' | 'decidedAt'> & { decidedAt?: string },
  ): Promise<DecisionOutcome> {
    const decidedAt = input.decidedAt ?? this.#now()
    const existing = await this.#scope.keys(decisionPrefix(input.sessionId))
    let seq = existing.reduce((max, key) => Math.max(max, seqOfKey(key) || 0), 0) + 1

    for (;;) {
      const decision = DecisionEvidence.parse({
        ...input,
        decisionId: `D-${input.sessionId}-${seq}`,
        decidedAt,
      })
      if (await this.#scope.setIfAbsent(decisionKey(input.sessionId, seq), JSON.stringify(decision))) {
        return { ok: true, decision }
      }
      seq += 1
    }
  }

  /** 이 세션이 스스로 정한 것들. 승인 기록과 나란히 놓고 보는 것이 목적이다. */
  async decisionsOf(sessionId: string): Promise<DecisionEvidence[]> {
    const keys = (await this.#scope.keys(decisionPrefix(sessionId))).sort(
      (a, b) => (seqOfKey(a) || 0) - (seqOfKey(b) || 0),
    )
    const out: DecisionEvidence[] = []
    for (const key of keys) {
      const decision = await this.#read(key, DecisionEvidence)
      if (decision) out.push(decision)
    }
    return out
  }

  async #findExecution(executionId: string): Promise<StoredExecution | null> {
    for (const key of await this.#scope.keys(executionPrefix())) {
      const stored = await this.#read(key, StoredExecution)
      if (stored?.executionId === executionId) return stored
    }
    return null
  }

  async #compose(stored: StoredExecution): Promise<ExecutionEvidence> {
    const end = await this.#read(executionEndKey(stored.executionId), ExecutionEnd)
    return end ? { ...stored, ...end } : { ...stored, status: 'RUNNING' }
  }

  async #read<T extends z.ZodTypeAny>(key: string, schema: T): Promise<z.infer<T> | null> {
    const raw = await this.#scope.get(key)
    if (!raw) return null
    const parsed = schema.safeParse(JSON.parse(raw))
    // 깨진 기록은 판단 근거가 못 된다 — 그 항목만 건너뛴다 (guard·closure와 같은 태도)
    return parsed.success ? parsed.data : null
  }

  async #list<T extends z.ZodTypeAny>(prefix: string, schema: T): Promise<z.infer<T>[]> {
    const out: z.infer<T>[] = []
    for (const key of (await this.#scope.keys(prefix)).sort()) {
      const record = await this.#read(key, schema)
      if (record) out.push(record)
    }
    return out
  }
}

/**
 * 사람이 읽는 줄. **없는 단계를 비워 두지 않고 없다고 적는다** (C-10 §5 불변식 ⑩).
 * "실행 증거 없음"은 감춰야 할 결함이 아니라 정상 출력이다.
 */
export function executionLines(evidence: readonly ExecutionEvidence[]): string[] {
  if (evidence.length === 0) return ['  실행 증거 없음 — 발급됐으나 아무도 집지 않았다']
  return evidence.map((e) => {
    const span = e.finishedAt ? `${e.startedAt} ~ ${e.finishedAt}` : `${e.startedAt} ~ (진행 중)`
    const source = e.principalSource === 'declared' ? '선언' : '유추'
    return `  ${e.executionId} · ${e.principal}(${source}) · ${e.hostAdapter} · ${e.status} · ${span}`
  })
}

/**
 * 검증자와 피검증자가 실제로 다른 주체인가 (C-10 §4.2).
 *
 * 대상 쪽 실행이 하나도 없으면 비교할 상대가 없다 — 그것도 UNVERIFIED다.
 * "다른 실행이 없으니 독립이다"는 가장 위험한 오판이다.
 */
export function judgeIndependence(
  validator: ExecutionEvidence,
  targetRuns: readonly ExecutionEvidence[],
): { independence: Independence; detail: string } {
  const others = targetRuns.filter((e) => e.executionId !== validator.executionId)
  if (others.length === 0) {
    return { independence: 'UNVERIFIED', detail: '대상 세션에 실행 증거가 없어 비교할 주체가 없다' }
  }
  if (others.some((e) => e.principal === validator.principal)) {
    return {
      independence: 'SELF_REPORTED',
      detail: `검증자와 대상이 같은 주체다 (${validator.principal})`,
    }
  }
  const derived = [validator, ...others].filter((e) => e.principalSource === 'derived')
  if (derived.length > 0) {
    return {
      independence: 'UNVERIFIED',
      detail: `주체가 선언되지 않아 다르다고 말할 근거가 없다 (${derived.map((e) => e.executionId).join(', ')})`,
    }
  }
  return {
    independence: 'INDEPENDENT',
    detail: `검증자 ${validator.principal} 와 대상 ${others.map((e) => e.principal).join(', ')} 가 다른 선언 주체다`,
  }
}

/** 사람이 읽는 검증 줄. **등급만 적고 이유를 빼지 않는다.** */
export function validationLines(records: readonly ValidationRecord[]): string[] {
  if (records.length === 0) return ['  검증 없음']
  return records.map(
    (v) =>
      `  ${v.validationId} · ${v.result} · ${v.independence} (${v.independenceDetail})` +
      `
    검증자 ${v.validatorSessionId}/${v.validatorExecutionId} · ${v.verifiedAt}` +
      (v.findings.length > 0 ? `
    확인: ${v.findings.join(' · ')}` : ''),
  )
}

/**
 * 사람이 읽는 결정 줄. **왜 승인이 필요 없었는지가 함께 온다** — 그 이유가 빠지면
 * "그냥 안 물어봤다"와 구분되지 않는다.
 */
export function decisionLines(decisions: readonly DecisionEvidence[]): string[] {
  if (decisions.length === 0) return ['  자율 결정 기록 없음']
  return decisions.map((decision) => {
    const alternatives = decision.alternatives.length > 0 ? ` (견준 것: ${decision.alternatives.join(', ')})` : ''
    return (
      `  ${decision.decisionId} [${decision.class}] ${decision.selectedOption}${alternatives}` +
      `\n    권한: ${decision.ownership.join(', ') || '(미기재)'}` +
      `\n    승인 불필요 근거: ${decision.whyNoApproval.join(' · ')}` +
      `\n    확인: ${decision.verification.join(' · ') || '(없음)'}`
    )
  })
}

export function reclaimLine(record: ReclaimEvidence | null, sessionId: string): string {
  if (!record) return `${sessionId} — 회수 기록 없음`
  const refs = record.executionRefs.length > 0 ? ` · 회수 시점 실행 ${record.executionRefs.join(', ')}` : ''
  return `${sessionId} 회수: ${record.reclaimedBy} ${record.reclaimedAt}${refs}`
}

export function delegationLine(record: DelegationRecord | null, childSessionId: string): string {
  if (!record) return `${childSessionId} — 위임 기록 없음 (최상위 발급이거나 기록되지 않았다)`
  const from = record.parentSessionId ?? '(최상위)'
  return `${from} → ${record.childSessionId} [${record.role}] ${record.goal} · 발급 ${record.issuedBy} ${record.issuedAt}`
}
