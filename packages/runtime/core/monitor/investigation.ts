// Typed Investigation — "AI가 알아서 확인"을 단계 계약으로 바꾼다 (C-07 §6).
//
// 조사를 자유 서술로 두면 무엇을 봤고 무엇을 못 봤는지가 남지 않는다. 그러면 못 본 것이
// 조용히 "문제 없음"이 되고, 사람은 확인되지 않은 것을 확인된 것으로 읽는다.
//
// 단계마다 두 가지가 분명해야 한다:
//   무엇을 필요로 하는가  — 그 단계가 요청하는 Port. provider 이름으로 갈라지지 않는다
//   못 했으면 왜 못 했는가 — 판정 불성립은 통과가 아니다. 다른 단계 결과로 대신하지 않는다

import type { ChangeContextPort } from '../../ports/change-context.ts'
import type { HistoryEvent, HistoryPort, ResourceContextPort } from '../../ports/resource-context.ts'
import type { CanonicalSnapshot } from '../model/entities.ts'
import { isWithinScopes } from '../policy/scope.ts'
import { lookupAuthority, type OwnershipMap } from '../policy/ownership.ts'
import type { Relevance } from './relevance.ts'

export const STEPS = [
  'resource', // ① 사건 자체 재확인 — 요약을 믿지 않는다
  'delta', // ② 직전 관측 대비 무엇이 달라졌나
  'responsibility', // ③ 누가 끌고 가고 누가 결정하는가
  'work', // ④ 지금 돌고 있는 것과의 관계
  'thread', // ⑤ 논의
  'change', // ⑥ 변경 경로·요약
  'work-context', // ⑦ 작업 항목의 상태·연결 (다른 Binding일 수 있다)
  'canonical', // ⑧ 정본 대조
  'relevance', // ⑨ 관련성과 영향
  'recommendation', // ⑩ 무엇을 하면 되는가
  'draft', // ⑪ 초안 (조건을 만족할 때만)
] as const
export type StepId = (typeof STEPS)[number]

/**
 * 확인하지 못한 이유. "안 봤다"와 "볼 수 없다"가 같은 결과로 뭉개지면, 조사 누락이
 * 접근 불가처럼 보이고 그 상태로 추천이 나간다.
 *
 * - `MISSING`        — 통로 자체가 없어 **보지 않았다** (Port 미배선)
 * - `UNAVAILABLE`    — 보려 했으나 실패했다 (조회 오류·접근 거부·사라짐)
 * - `NOT_APPLICABLE` — 이 사건에 해당하지 않는다
 *
 * 이전 판의 결과가 `done` 으로 되돌아오면 이 필드가 없다. 그때는 MISSING 으로 읽는다 —
 * 모르는 쪽을 "확인했다"로 읽는 것보다 "안 봤다"로 읽는 편이 안전하다.
 */
export type StepReason = 'MISSING' | 'UNAVAILABLE' | 'NOT_APPLICABLE'

export type StepResult =
  | { id: StepId; kind: 'DONE'; findings: string[] }
  /** 필요한 Port가 없거나 조회가 실패했다. **통과가 아니다.** */
  | { id: StepId; kind: 'UNDECIDABLE'; detail: string; reason?: Extract<StepReason, 'MISSING' | 'UNAVAILABLE'> }
  /** 이 사건에는 해당하지 않는다 (변경이 없는 사건의 change 단계 등). */
  | { id: StepId; kind: 'SKIPPED'; detail: string; reason?: Extract<StepReason, 'NOT_APPLICABLE'> }

/** 단계 결과를 세 상태로 읽는다. reason 이 없는 옛 결과는 보수적으로 읽는다. */
export function stepReason(step: StepResult): 'DONE' | StepReason {
  if (step.kind === 'DONE') return 'DONE'
  if (step.kind === 'SKIPPED') return step.reason ?? 'NOT_APPLICABLE'
  return step.reason ?? 'MISSING'
}

export type Investigation = {
  steps: StepResult[]
  /** 사람이 읽는 상황. 단계 산출을 이어 붙인 것이며 요약하지 않는다. */
  situation: string[]
  recommendation: string
  /** 확인하지 못한 것. 비어 있지 않으면 draft를 만들지 않는다. */
  undecidable: string[]
  draft?: string
  /** draft를 만들지 않은 이유. 만들었으면 없다. */
  draftBlocked?: string
}

export type InvestigationInput = {
  reference: string
  /** Phase A가 이미 낸 판정. 여기서 다시 계산하지 않는다. */
  relevance?: Relevance
  /** 지난 관측 — ② delta 단계의 기준. */
  previous?: { revisionMarker: string; state?: string }
  /** 이 사건에 걸린 결정 영역. 없으면 responsibility 단계는 owner 확인까지다. */
  decisionDomains?: readonly string[]
  ownership?: OwnershipMap
  owner?: string
  activeSessions?: readonly string[]
  canonicalPaths?: readonly string[]
  /** 조사 예산. inspect는 최근 것만, trace는 더 넓게 본다 (C-05 §3). */
  commentLimit?: number
  /**
   * 이 사건에 연결된 작업 항목 (⑦). 코드 쪽 reference와 **다른 Binding일 수 있다** —
   * 코드가 한 곳, 작업 항목이 다른 곳인 것이 정상이다 (C-09 §3.1).
   * 선언되지 않으면 그 단계는 해당 없음이다.
   */
  workReference?: string
  /** 경위를 어디까지 볼지. trace가 아니면 굳이 넓히지 않는다. */
  historyLimit?: number
}

export type InvestigationPorts = {
  resource?: ResourceContextPort
  change?: ChangeContextPort
  /**
   * 작업 항목 쪽 통로 (⑦). 코드 쪽과 **다른 adapter일 수 있다** — 같은 것을 쓰라고
   * 강요하면 두 시스템을 동시에 붙일 수 없다.
   */
  work?: ResourceContextPort
  /** 경위 조회. 제공하지 못하는 adapter가 흔하므로 따로 받는다 (C-09 §2.1). */
  history?: HistoryPort
  /** 정본 baseline 조회. 없으면 canonical 단계가 성립하지 않는다. */
  baselines?: () => Promise<CanonicalSnapshot[]>
}

const missingPort = (id: StepId, what: string): StepResult => ({
  id,
  kind: 'UNDECIDABLE',
  detail: `${what} 를 제공하는 binding이 없다 — 이 단계는 확인하지 못했다`,
  reason: 'MISSING',
})

/**
 * 단계를 순서대로 밟는다. **각 단계는 자기가 필요한 Port만 요청한다** — 어떤 외부 시스템이
 * 그것을 제공하는지는 Binding이 정한다 (C-09 §4).
 *
 * 이미 끝난 단계가 있으면 그 자리는 건너뛴다. 재시도가 조사를 처음부터 다시 하면 실패
 * 지점이 비쌀수록 영영 넘지 못한다 (C-07 §6.3).
 */
export async function investigate(
  input: InvestigationInput,
  ports: InvestigationPorts,
  done: readonly StepResult[] = [],
): Promise<Investigation> {
  const steps: StepResult[] = [...done]
  const already = new Set(done.map((s) => s.id))
  const put = (result: StepResult) => {
    if (!already.has(result.id)) steps.push(result)
  }

  // ① 사건 자체 — 알림 요약을 그대로 믿지 않는다.
  const resource = ports.resource ? await ports.resource.getResource(input.reference).catch(() => null) : null
  if (!ports.resource) put(missingPort('resource', '리소스 조회'))
  else if (!resource || resource.missing) {
    put({ id: 'resource', kind: 'UNDECIDABLE', detail: '리소스를 읽지 못했다 (사라졌거나 접근 불가)', reason: 'UNAVAILABLE' })
  } else {
    put({
      id: 'resource',
      kind: 'DONE',
      findings: [
        `${resource.title} — ${resource.state}`,
        ...(resource.assignees?.length ? [`배정: ${resource.assignees.join(', ')}`] : []),
        ...(resource.labels?.length ? [`라벨: ${resource.labels.join(', ')}`] : []),
      ],
    })
  }

  // ② Delta — 현재 모습만 보면 무엇이 새로운지 알 수 없다.
  if (!input.previous) {
    put({ id: 'delta', kind: 'SKIPPED', detail: '지난 관측이 없다 — 처음 보는 사건이다', reason: 'NOT_APPLICABLE' })
  } else if (!resource) {
    put(missingPort('delta', '리소스 조회'))
  } else {
    const changes: string[] = []
    if (input.previous.revisionMarker !== resource.revisionMarker) changes.push('실질 변화 있음')
    if (input.previous.state && input.previous.state !== resource.state) {
      changes.push(`상태 ${input.previous.state} → ${resource.state}`)
    }
    put({ id: 'delta', kind: 'DONE', findings: changes.length > 0 ? changes : ['지난 관측과 같다'] })
  }

  // ③ Responsibility — B-23~B-25를 실제로 쓴다 (C-04).
  const responsibility: string[] = []
  if (input.owner) responsibility.push(`Owner: ${input.owner}`)
  for (const domain of input.decisionDomains ?? []) {
    const found = lookupAuthority(input.ownership, domain)
    responsibility.push(
      found.kind === 'RESOLVED'
        ? `${domain} → ${found.role}`
        : found.kind === 'AMBIGUOUS'
          ? `${domain} → 갈림 (${found.candidates.join(', ')})`
          : `${domain} → 결정권자 미선언`,
    )
  }
  put(
    responsibility.length > 0
      ? { id: 'responsibility', kind: 'DONE', findings: responsibility }
      : { id: 'responsibility', kind: 'SKIPPED', detail: 'owner·결정 영역이 선언되지 않았다', reason: 'NOT_APPLICABLE' },
  )

  // ④ 지금 돌고 있는 것과의 관계.
  put(
    input.activeSessions?.length
      ? { id: 'work', kind: 'DONE', findings: [`활성 세션: ${input.activeSessions.join(', ')}`] }
      : { id: 'work', kind: 'SKIPPED', detail: '지금 돌고 있는 세션이 없다', reason: 'NOT_APPLICABLE' },
  )

  // ⑤ Thread — 전부 읽지 않는다. 판단에 필요한 만큼만 (C-05 §3).
  if (!ports.resource) put(missingPort('thread', '스레드 조회'))
  else {
    const comments = await ports.resource
      .getComments(input.reference, { limit: input.commentLimit ?? 5 })
      .catch(() => null)
    put(
      comments === null
        ? { id: 'thread', kind: 'UNDECIDABLE', detail: '논의를 읽지 못했다', reason: 'UNAVAILABLE' }
        : {
            id: 'thread',
            kind: 'DONE',
            findings: comments.slice(0, 3).map((c) => `${c.author}: ${c.body.slice(0, 80)}`),
          },
    )
  }

  // ⑥ Change — 실제 변경 내용으로 본다. reviewer 지정 여부가 아니다.
  const change = ports.change ? await ports.change.getChange(input.reference).catch(() => null) : null
  if (!ports.change) put(missingPort('change', '변경 조회'))
  else if (!change || change.missing) {
    put({ id: 'change', kind: 'SKIPPED', detail: '변경이 딸린 사건이 아니거나 읽지 못했다' })
  } else {
    put({
      id: 'change',
      kind: 'DONE',
      findings: [
        `변경 경로 ${change.changedPaths.length}건${change.truncated ? ' (일부만 받았다)' : ''}`,
        ...change.changedPaths.slice(0, 5),
        ...(change.reviewState ? [`검토: ${change.reviewState}`] : []),
      ],
    })
  }

  // ⑦ Work Context — 작업 항목의 상태·연결. 코드 쪽과 다른 Binding일 수 있다.
  if (!input.workReference) {
    put({ id: 'work-context', kind: 'SKIPPED', detail: '연결된 작업 항목이 선언되지 않았다', reason: 'NOT_APPLICABLE' })
  } else if (!ports.work) {
    put(missingPort('work-context', '작업 항목 조회'))
  } else {
    const item = await ports.work.getResource(input.workReference).catch(() => null)
    if (!item || item.missing) {
      put({ id: 'work-context', kind: 'UNDECIDABLE', detail: '작업 항목을 읽지 못했다', reason: 'UNAVAILABLE' })
    } else {
      // 경위는 있으면 더한다. 없다고 이 단계 전체가 무너지지는 않는다 —
      // 이력을 모르는 도구가 흔하고, 그것과 "못 읽었다"는 다르다.
      const history = ports.history
        ? await ports.history.getHistory(input.workReference, input.historyLimit ?? 3).catch(() => [])
        : []
      put({
        id: 'work-context',
        kind: 'DONE',
        findings: [
          `${item.title} — ${item.state}`,
          ...(item.assignees?.length ? [`담당: ${item.assignees.join(', ')}`] : []),
          ...(item.related?.length ? [`연결: ${item.related.join(', ')}`] : []),
          ...history.map((event: HistoryEvent) => `${event.at} ${event.actor} ${event.kind}`),
        ],
      })
    }
  }

  // ⑧ Canonical — 계약이 고정한 것과 이번 변경을 견준다.
  let canonicalConflict = false
  if (!ports.baselines) put(missingPort('canonical', '정본 조회'))
  else {
    const snapshots = await ports.baselines().catch(() => null)
    if (!snapshots) put({ id: 'canonical', kind: 'UNDECIDABLE', detail: '정본을 읽지 못했다', reason: 'UNAVAILABLE' })
    else {
      const touched = (change?.changedPaths ?? []).filter(
        (path) => input.canonicalPaths?.length && isWithinScopes(path, input.canonicalPaths),
      )
      canonicalConflict = touched.length > 0
      put({
        id: 'canonical',
        kind: 'DONE',
        findings: [
          `정본 ${snapshots.length}갈래 기준`,
          ...(canonicalConflict ? [`contract drift 후보 — 정본 영역 변경: ${touched.join(', ')}`] : []),
        ],
      })
    }
  }

  // ⑨ Relevance — Phase A 판정을 근거와 함께 옮긴다. 여기서 다시 계산하지 않는다.
  put(
    input.relevance
      ? {
          id: 'relevance',
          kind: 'DONE',
          findings: input.relevance.evidence.map((e) => `${e.supports ? '+' : '-'} ${e.detail}`),
        }
      : { id: 'relevance', kind: 'SKIPPED', detail: '관련성 판정을 받지 못했다', reason: 'NOT_APPLICABLE' },
  )

  const undecidable = steps
    .filter((s): s is Extract<StepResult, { kind: 'UNDECIDABLE' }> => s.kind === 'UNDECIDABLE')
    .map((s) => `${s.id}: ${s.detail}`)

  // ⑩ Recommendation — 못 본 것이 있으면 그것부터 말한다.
  const recommendation =
    undecidable.length > 0
      ? '확인하지 못한 것이 있다. 아래를 먼저 채우고 다시 본다.'
      : canonicalConflict
        ? '정본 영역이 바뀌었다. 계약 영향을 확인한 뒤 대응한다.'
        : input.relevance?.actual === 'HIGH'
          ? '관련이 확인됐다. 대응 여부를 정한다.'
          : '지금은 행동이 필요해 보이지 않는다.'
  put({ id: 'recommendation', kind: 'DONE', findings: [recommendation] })

  // ⑪ Draft — 조건을 만족할 때만 (C-07 §7).
  const blocked = draftBlocker(input, undecidable, canonicalConflict)
  put(
    blocked
      ? { id: 'draft', kind: 'SKIPPED', detail: blocked }
      : { id: 'draft', kind: 'DONE', findings: ['초안 작성 조건을 만족한다'] },
  )

  return {
    steps,
    situation: steps.flatMap((s) => (s.kind === 'DONE' ? s.findings : [`${s.id}: 확인 못 함 — ${s.detail}`])),
    recommendation,
    undecidable,
    ...(blocked ? { draftBlocked: blocked } : {}),
  }
}

/**
 * 초안을 만들면 안 되는 이유. 단정적인 초안은 그 자체로 판단을 실어 나르고, 사람은 초안을
 * 검토하는 대신 승인하게 된다 (C-07 §7).
 */
function draftBlocker(
  input: InvestigationInput,
  undecidable: readonly string[],
  canonicalConflict: boolean,
): string | undefined {
  if (undecidable.length > 0) return `확인하지 못한 단계가 있다 (${undecidable.length}건)`
  if (canonicalConflict) return '정본과 충돌 가능성이 있다 — 사람이 먼저 정한다'
  if (!input.relevance) return '관련성 판정이 없다'
  if (input.relevance.actual !== 'HIGH') return '관련 근거가 약하다'

  for (const domain of input.decisionDomains ?? []) {
    const found = lookupAuthority(input.ownership, domain)
    if (found.kind !== 'RESOLVED') return `'${domain}' 의 결정권자가 정해지지 않았다`
  }
  return undefined
}
