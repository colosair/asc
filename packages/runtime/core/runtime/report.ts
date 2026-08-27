// Compact Final Report — 보고는 증거의 projection이다 (C-10 §5 계열 · 지시 §28).
//
// 최종 보고가 길어지는 이유는 보고 자체가 저장소 역할을 하기 때문이다. 과정을 전부 옮겨
// 적으면 다음 사람이 그 글을 읽어야만 사실을 알 수 있고, 그러면 audit trail은 있으나
// 아무도 안 본다.
//
// 그래서 네 가지만 든다:
//
//   결과 · 판정 근거 · 미결/위험 · 다음 행동
//
// 나머지는 이미 남아 있는 곳에서 읽는다 — Checkpoint · Handoff · Validation · Claim History.
// **보고를 줄이려고 증거를 버리지 않는다.** 줄이는 것은 옮겨 적기이지 기록이 아니다.

import type { DecisionEvidence, ExecutionEvidence, ReclaimEvidence, ValidationRecord } from './audit.ts'
import type { EscalationRecord } from './escalation.ts'
import type { Claim } from './claims.ts'
import type { ExecutionVerdict } from './execution-state.ts'
import type { Handoff, Session } from '../model/entities.ts'

export type ReportInput = {
  session: Pick<Session, 'id' | 'role' | 'goal' | 'status' | 'doneCriteria'> & {
    handoff?: Handoff
  }
  executions?: readonly ExecutionEvidence[]
  validations?: readonly ValidationRecord[]
  reclaim?: ReclaimEvidence | null
  claims?: readonly Claim[]
  /** 승인 없이 간 결정들 (C-13 §4). 몇 건을 스스로 정했는지가 판정 근거다. */
  decisions?: readonly DecisionEvidence[]
  /** 미해소 상신 (C-13). 무엇이 막혔고 무엇이 갔는지 미결에 든다. */
  escalations?: readonly EscalationRecord[]
  /** 파생 실행 상태. 있으면 결과 줄이 이것을 따른다 — 두 개의 결론을 만들지 않는다. */
  derived?: ExecutionVerdict
}

export type FinalReport = {
  result: string
  /** 왜 그렇게 판정했는가. 근거가 **어디에 있는지**를 가리키고 본문을 복제하지 않는다. */
  basis: string[]
  /** 미결과 위험. 없으면 없다고 적는다 — 빈 칸은 "없다"가 아니라 "안 봤다"로 읽힌다. */
  open: string[]
  next: string[]
  /** 상세를 어디서 읽는가. 보고가 증거 저장소가 되지 않게 하는 장치다. */
  evidence: string[]
}

export function buildFinalReport(input: ReportInput): FinalReport {
  const { session } = input
  const executions = input.executions ?? []
  const validations = input.validations ?? []
  const claims = input.claims ?? []

  const result = input.derived
    ? `${session.id} ${input.derived.state} — ${session.goal}`
    : `${session.id} ${session.status} — ${session.goal}`

  const basis: string[] = []
  if (input.derived) basis.push(...input.derived.reasons)

  // 실행 증거: 몇 번이 아니라 **누가**가 중요하다. 같은 주체면 그 사실이 판정을 바꾼다.
  if (executions.length === 0) {
    basis.push('실행 증거 없음 — 발급됐으나 아무도 집지 않았다')
  } else {
    const principals = [...new Set(executions.map((e) => e.principal))]
    basis.push(`실행 ${executions.length}건 · 주체 ${principals.join(', ')}`)
    if (executions.some((e) => e.principalSource === 'derived')) {
      basis.push('주체 일부가 선언되지 않았다 — 독립성 주장은 UNVERIFIED를 넘지 못한다')
    }
  }

  // 검증: 등급을 빼고 결과만 적으면 자기 확인이 독립 검증처럼 보인다.
  if (validations.length === 0) {
    basis.push('독립 검증 없음')
  } else {
    for (const validation of validations) {
      basis.push(`검증 ${validation.result} (${validation.independence}) — ${validation.independenceDetail}`)
    }
  }

  // 자율 판단과 상신의 비율이 곧 "Approval은 예외인가"의 증거다 (C-13 §0)
  const decisions = input.decisions ?? []
  const escalations = input.escalations ?? []
  basis.push(
    decisions.length > 0
      ? `승인 없이 정한 것 ${decisions.length}건 (${decisions.map((d) => d.class).join(', ')})`
      : '승인 없이 정한 것 없음',
  )
  basis.push(escalations.length > 0 ? `사람에게 올린 것 ${escalations.length}건` : '사람에게 올린 것 없음')

  if (session.handoff) basis.push(`자기 확인: ${session.handoff.verified} (독립 검증 아님)`)
  basis.push(input.reclaim ? `회수: ${input.reclaim.reclaimedBy}` : '회수 기록 없음')

  const open: string[] = []
  if (session.handoff?.unresolved?.length) open.push(...session.handoff.unresolved)
  // 추론과 미확인은 결과가 아니라 미결이다 — 결과 줄에 섞으면 확정처럼 읽힌다.
  for (const claim of claims) {
    if (claim.status === 'INFERRED') open.push(`추론(확정 아님): ${claim.statement}`)
    if (claim.status === 'PENDING') open.push(`미확인: ${claim.statement}`)
  }
  for (const record of escalations) {
    open.push(
      `외부 결정 대기 ${record.escalationId} [${record.predicates.join(', ')}] — 막힘 ${record.blockedNodes.join(', ')}`,
    )
  }
  const unmet = session.doneCriteria.filter((item) => !(session.handoff?.done ?? []).includes(item))
  if (unmet.length > 0) open.push(`${unmet.length} done-criteria remaining: ${unmet.join(', ')}`)
  if (open.length === 0) open.push('없음')

  const next: string[] = []
  if (session.handoff?.next) next.push(session.handoff.next)
  if (!input.reclaim && session.status === 'DONE') next.push('Controller 회수 필요 — asc controller collect --as <주체>')
  if (validations.length === 0) next.push('독립 검증이 필요하면 별도 주체로 asc session validate')
  if (next.length === 0) next.push('없음')

  return {
    result,
    basis,
    open,
    next,
    // 본문을 옮기지 않고 어디를 볼지만 가리킨다
    evidence: [
      `asc session audit ${session.id}`,
      ...(escalations.length > 0 ? [`asc escalate list`] : []),
      ...(claims.length > 0 ? ['claim history (STALE 포함)'] : []),
    ],
  }
}

/** 사람이 읽는 최종 보고. 네 블록을 넘지 않는다. */
export function renderFinalReport(report: FinalReport): string[] {
  return [
    `## 결과`,
    `  ${report.result}`,
    `## 판정 근거`,
    ...report.basis.map((line) => `  ${line}`),
    `## 미결 / 위험`,
    ...report.open.map((line) => `  ${line}`),
    `## 다음 행동`,
    ...report.next.map((line) => `  ${line}`),
    `## 상세는 여기서 읽는다`,
    ...report.evidence.map((line) => `  ${line}`),
  ]
}
