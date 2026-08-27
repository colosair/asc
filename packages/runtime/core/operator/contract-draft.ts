// Session Contract Drafting — 자연어 업무 요청과 세션 계약 사이의 빈 칸 (C-04 · C-13).
//
// **왜 필요한가**: ASC는 완성된 계약을 실행·통제하는 데는 강한데, 사람이 "ABC-123 구현해"
// 라고 말한 것을 계약으로 바꾸는 자리에 규약이 없었다. 그래서 두 가지 중 하나가 일어났다 —
// agent가 goal·boundary·criteria를 통째로 지어내거나(fail-closed 위반), 아니면 넷을 전부
// 사람에게 입력하라고 되물었다(자율성 포기). 둘 다 틀렸다.
//
// **여기서 하는 일과 하지 않는 일**:
//   한다   — agent가 만든 초안을 **검증**한다. 무엇이 사실이고 무엇이 추론인지 갈라 두고,
//            사람만 정할 수 있는 것이 남았는지 판정한다.
//   안 한다 — 초안을 만들지 않는다. 계약을 발급하지 않는다. LLM을 품지 않는다.
//            해석은 coding agent가 하고, 이 모듈은 그 결과를 구조·정책으로 잰다.
//
// 판정 로직을 새로 만들지 않는다. 경로 축은 preflight, 책임 축은 ownership, 문법은 scope,
// 사람에게 넘길 사유는 escalation predicate — 전부 이미 있는 것을 부른다.

import { z } from 'zod'

import { EscalationPredicate } from '../runtime/escalation.ts'
import { SessionRole } from '../model/entities.ts'
import { SessionId } from '../model/ids.ts'
import { isWithinScopes, parseScope } from '../policy/scope.ts'
import { lookupOwnerByPaths, type OwnershipMap } from '../policy/ownership.ts'
import { preflight, type PreflightResult } from './preflight.ts'
import type { ResolvedPolicy, RoleName } from '../policy/policy.ts'

/**
 * 이 값이 어디서 왔는가. **claims.ts의 CONFIRMED/INFERRED/PENDING과 같은 축이다** —
 * 이름만 계약 초안의 어휘로 부른다 (agent가 읽는 문서에서 "추론"보다 "PROPOSAL"이
 * 무엇을 해야 하는지 더 곧게 말한다).
 */
export type DraftStatus =
  /** 사용자·정본·work item·Profile에서 직접 확인된 값. 뒤집으려면 그 출처를 봐야 한다. */
  | 'FACT'
  /** agent가 근거를 갖고 제안한 값. 근거가 충분하고 경계 안이면 그대로 진행해도 된다. */
  | 'PROPOSAL'
  /** agent가 확정해서는 안 되는 값. 사람의 경계다. */
  | 'DECISION_REQUIRED'

/** 값이 어디서 왔는지. 지어낸 것과 읽어 온 것을 문자열 하나로 구분한다. */
// provider 이름을 적지 않는다 (C-09 §6.1). 어느 tracker의 항목인지는 Adapter가 알고,
// 계약 초안이 아는 것은 "추적 항목에서 읽었다"까지다.
export const DRAFT_SOURCES = ['user', 'work_item', 'profile', 'repository', 'canonical', 'agent_proposal'] as const
export type DraftSource = (typeof DRAFT_SOURCES)[number]

/** 초안의 출처 한 줄. CLI가 받는 문자열도 이 스키마로 통과시켜야 들어온다. */
export const DraftProvenance = z.object({
  field: z.enum(['id', 'role', 'goal', 'boundary', 'criteria', 'owner']),
  status: z.enum(['FACT', 'PROPOSAL', 'DECISION_REQUIRED']),
  source: z.enum(DRAFT_SOURCES),
  /** 왜 이 값인가. PROPOSAL이면 반드시 있어야 한다 — 근거 없는 제안은 추측이다. */
  reason: z.string().min(1).optional(),
})

export type DraftField = z.infer<typeof DraftProvenance>

/** agent가 만들어 오는 것. 완성된 계약이 아니라 **초안**이다. */
export type SessionContractDraft = {
  id?: string
  role?: string
  goal?: string
  boundary?: readonly string[]
  criteria?: readonly string[]
  owner?: string
  decisionDomains?: readonly string[]
  decisionAuthority?: Readonly<Record<string, string>>
  /** 각 값의 출처. 없는 필드는 `agent_proposal` 로 간주하지 않고 **출처 미상**으로 본다. */
  provenance?: readonly DraftField[]
}

/**
 * 사람이 답해야 하는 것 하나. **빠진 정보 전부가 아니라 결정 지점 하나씩** 든다 —
 * 목록이 길면 사람은 그것을 질문이 아니라 서식으로 읽는다.
 */
export type UnresolvedDecision = {
  field: DraftField['field']
  /** 왜 사람인가. escalation predicate와 같은 어휘를 쓴다 (C-13). */
  reason: (typeof EscalationPredicate)['_type'] | 'missing_input' | 'multiple_options'
  detail: string
  /** 고를 수 있는 것들. 하나뿐이면 질문이 아니라 제안이다. */
  options?: string[]
  /** 추천 인덱스. 추천 없이 선택지만 주는 것은 판단을 떠넘기는 것이다. */
  recommended?: number
}

/**
 * 발급 권한은 **사람의 것이다** (OM §450). 다만 그 문장이 "매번 사람이 직접 쳐야 한다"는
 * 뜻은 아니다 — Controller가 **범위를 정해 위임**할 수 있고, 그 범위 안에서만 agent가
 * 스스로 발급한다. 위임이 없으면 계약이 완성돼도 발급하지 않고 사람에게 넘긴다.
 *
 * 위임은 Profile/Override의 `policy.unionLists.issuanceDelegation` 에 **역할 이름**으로
 * 적는다 (closureChecklist와 같은 관례 키 자리). 경로 범위는 이미 `roleScopes` 가 좁히고
 * 있으므로 여기서 다시 정의하지 않는다 — 권한을 두 곳에 적으면 둘이 갈라진다.
 */
export const ISSUANCE_DELEGATION_KEY = 'issuanceDelegation'

export type IssuanceAuthority = {
  /** `controller` = 사람이 발급한다. `delegated` = 이 역할에 한해 agent가 발급해도 된다. */
  authority: 'controller' | 'delegated'
  /** Controller가 위임한 역할들. 비어 있으면 위임이 없다는 뜻이다. */
  delegatedRoles: string[]
  detail: string
}

export type ContractPlanStatus =
  /** 지금 발급해도 된다. 사람에게 물을 것이 없다. */
  | 'READY_TO_ISSUE'
  /** 구조는 맞는데 사람만 정할 수 있는 것이 남았다. */
  | 'NEEDS_DECISION'
  /** 이 초안으로는 계약이 성립하지 않는다 — 문법·범위가 틀렸다. */
  | 'INVALID'

export type SessionContractPlan = {
  status: ContractPlanStatus
  draft: SessionContractDraft
  /** 출처가 확인된 값들. */
  facts: DraftField[]
  /** 근거를 갖고 제안된 값들. */
  proposals: DraftField[]
  unresolved: UnresolvedDecision[]
  /** 계약이 완성돼도 **발급해도 되는가**는 별개다 (OM §450). */
  issuance: IssuanceAuthority
  /** 구조가 깨진 지점. 있으면 status는 INVALID다. */
  invalid: { field: string; detail: string }[]
  /** 경로·책임 축 판정 원본. 있는 그대로 실어 agent가 다시 계산하지 않게 한다. */
  preflight?: PreflightResult
}

export type ContractPlanInput = {
  draft: SessionContractDraft
  policy?: ResolvedPolicy
  ownership?: OwnershipMap
  /** 이미 있는 세션 id들. 겹치면 발급이 실패하므로 미리 말한다. */
  existingIds?: readonly string[]
}

const provenanceOf = (draft: SessionContractDraft, field: DraftField['field']): DraftField | undefined =>
  draft.provenance?.find((entry) => entry.field === field)

/**
 * 초안을 잰다. **아무것도 쓰지 않는다** — 순수 함수이고, 같은 입력이면 같은 답이다.
 *
 * 판정 순서에 뜻이 있다: 먼저 구조(문법·필수값)를 보고, 그 다음 경계(범위·책임)를 본다.
 * 구조가 깨진 초안의 경계를 논하는 것은 의미가 없고, 사람에게 두 번 묻게 만든다.
 */
export function planSessionContract(input: ContractPlanInput): SessionContractPlan {
  const { draft, policy, ownership, existingIds } = input
  const facts: DraftField[] = []
  const proposals: DraftField[] = []
  const unresolved: UnresolvedDecision[] = []
  const invalid: { field: string; detail: string }[] = []

  const classify = (field: DraftField['field'], present: boolean): void => {
    if (!present) return
    const entry = provenanceOf(draft, field)
    if (!entry) {
      // 출처를 적지 않은 값은 사실로 세지 않는다. 어디서 왔는지 모르는 값이
      // 계약에 박히면, 나중에 그것이 틀렸을 때 무엇을 되짚어야 하는지 아무도 모른다.
      proposals.push({ field, status: 'PROPOSAL', source: 'agent_proposal', reason: 'source not declared' })
      return
    }
    if (entry.status === 'FACT') facts.push(entry)
    else if (entry.status === 'PROPOSAL') proposals.push(entry)
    else
      unresolved.push({
        field,
        reason: 'explicit_rule_requires_approval',
        detail: entry.reason ?? `${field} is marked as a decision for a person`,
      })
  }

  // ── 구조 ────────────────────────────────────────────────────────────────
  if (draft.id === undefined) {
    unresolved.push({
      field: 'id',
      reason: 'missing_input',
      detail:
        'No session id. Use the work item key the person named, or the task id the canonical source ties to' +
        ' this work. Do not spend a real issue key on a setup check.',
    })
  } else if (!SessionId.safeParse(draft.id).success) {
    invalid.push({ field: 'id', detail: `'${draft.id}' is not a session id — expected S-YYYYMMDD-NN` })
  } else if (existingIds?.includes(draft.id)) {
    invalid.push({ field: 'id', detail: `session ${draft.id} already exists` })
  }
  classify('id', draft.id !== undefined)

  if (draft.role === undefined) {
    unresolved.push({ field: 'role', reason: 'missing_input', detail: 'No role. Which part of the work is this?' })
  } else if (!SessionRole.safeParse(draft.role).success) {
    invalid.push({ field: 'role', detail: `'${draft.role}' is not a role — expected one of ${SessionRole.options.join(', ')}` })
  }
  classify('role', draft.role !== undefined)

  if (!draft.goal || draft.goal.trim() === '') {
    unresolved.push({
      field: 'goal',
      reason: 'missing_input',
      detail: 'No goal. Take it from what the person asked for, or from the requirement the work item states.',
    })
  }
  classify('goal', Boolean(draft.goal && draft.goal.trim() !== ''))

  for (const entry of draft.boundary ?? []) {
    if (parseScope(entry) === null) invalid.push({ field: 'boundary', detail: `'${entry}' is not valid ASC scope grammar` })
  }
  if ((draft.boundary ?? []).length === 0) {
    unresolved.push({
      field: 'boundary',
      reason: 'missing_input',
      detail:
        'No write boundary. Propose the narrowest set that covers the work — a boundary is what the session may' +
        ' write, not what it may read.',
    })
  }
  classify('boundary', (draft.boundary ?? []).length > 0)

  if ((draft.criteria ?? []).length === 0) {
    unresolved.push({
      field: 'criteria',
      reason: 'missing_input',
      detail:
        'No done-criteria. Collect them from the acceptance the work item states, the canonical spec, or the' +
        ' checks this repository already runs. Do not invent new product acceptance.',
    })
  }
  classify('criteria', (draft.criteria ?? []).length > 0)
  classify('owner', draft.owner !== undefined)

  // ── 경계 ────────────────────────────────────────────────────────────────
  // 구조가 깨졌으면 여기서 멈춘다. 틀린 초안의 범위를 따져도 답이 두 번 바뀔 뿐이다.
  const role = draft.role !== undefined && SessionRole.safeParse(draft.role).success ? (draft.role as RoleName) : undefined
  const boundary = draft.boundary ?? []
  let report: PreflightResult | undefined

  if (invalid.length === 0 && role && boundary.length > 0) {
    const maxScope = policy?.roleScopes[role]
    for (const entry of boundary) {
      if (maxScope && !isWithinScopes(entry, maxScope)) {
        // 범위를 넓혀 해소하지 않는다 (preflight와 같은 자세). 이건 사람의 경계다.
        unresolved.push({
          field: 'boundary',
          reason: 'ownership_boundary',
          detail: `${role} may not write '${entry}' — outside ${maxScope.join(', ')}`,
          options: [`narrow the boundary to ${maxScope.join(', ')}`, 'hand this part to the role that owns it', 'ask for the scope to be widened'],
          recommended: 0,
        })
      }
    }

    report = preflight({
      paths: boundary,
      target: {
        kind: 'session',
        // 아직 발급하지 않았다. preflight는 이 id를 조회하지 않고 문장에만 쓴다.
        sessionId: draft.id ?? '(draft)',
        role,
        writeBoundary: boundary,
        ...(draft.owner ? { owner: draft.owner } : {}),
        ...(draft.decisionDomains ? { decisionDomains: draft.decisionDomains } : {}),
        ...(draft.decisionAuthority ? { decisionAuthority: draft.decisionAuthority } : {}),
      },
      ...(policy ? { policy } : {}),
      ...(ownership ? { ownership } : {}),
    })

    for (const mismatch of report.mismatches) {
      if (mismatch.verdict !== 'OWNERSHIP_MISMATCH') continue
      unresolved.push({
        field: 'boundary',
        reason: 'ownership_boundary',
        detail: `'${mismatch.path}' is inside the boundary but outside ${draft.owner}'s declared paths`,
      })
    }

    for (const gap of report.authorityGaps) {
      unresolved.push({
        field: 'owner',
        reason: 'ownership_boundary',
        detail:
          gap.lookup.kind === 'AMBIGUOUS'
            ? `more than one part claims '${gap.domain}': ${gap.lookup.candidates.join(', ')}`
            : `no part declares authority over '${gap.domain}'`,
        ...(gap.lookup.kind === 'AMBIGUOUS'
          ? { options: [...gap.lookup.candidates], recommended: undefined }
          : {}),
      })
    }

    // owner를 적지 않았는데 경계로 주인을 특정할 수 있으면, 그것은 질문이 아니라 제안이다.
    if (!draft.owner && ownership) {
      const owner = lookupOwnerByPaths(ownership, boundary)
      if (owner.kind === 'RESOLVED') {
        proposals.push({ field: 'owner', status: 'PROPOSAL', source: 'profile', reason: `boundary falls inside ${owner.role}` })
      } else if (owner.kind === 'AMBIGUOUS') {
        unresolved.push({
          field: 'owner',
          reason: 'multiple_options',
          detail: 'more than one part covers this boundary',
          options: [...owner.candidates],
          recommended: 0,
        })
      }
    }
  }

  const status: ContractPlanStatus =
    invalid.length > 0 ? 'INVALID' : unresolved.length > 0 ? 'NEEDS_DECISION' : 'READY_TO_ISSUE'

  // Profile은 `policy.unionLists` 로 선언하고, 계층 병합이 끝나면 `lists` 로 온다.
  const delegatedRoles = [...(policy?.lists?.[ISSUANCE_DELEGATION_KEY] ?? [])]
  const delegated = role !== undefined && delegatedRoles.includes(role)
  const issuance: IssuanceAuthority = {
    authority: delegated ? 'delegated' : 'controller',
    delegatedRoles,
    detail: delegated
      ? `the Controller delegated issuance for ${role}`
      : delegatedRoles.length > 0
        ? `issuance is delegated for ${delegatedRoles.join(', ')} — not for ${role ?? '(no role)'}`
        : 'issuance belongs to the Controller; no role has been delegated',
  }

  return { status, draft, facts, proposals, unresolved, issuance, invalid, ...(report ? { preflight: report } : {}) }
}

/** 발급 명령의 인자. plan이 통과했을 때만 부른다 — 통과하지 않은 초안은 명령이 되지 않는다. */
export function issueArgs(draft: SessionContractDraft): string[] {
  const args = ['session', 'issue', draft.id ?? '<ID>', '--role', draft.role ?? '<role>', '--goal', draft.goal ?? '<goal>']
  for (const entry of draft.boundary ?? []) args.push('--boundary', entry)
  for (const entry of draft.criteria ?? []) args.push('--criteria', entry)
  if (draft.owner) args.push('--owner', draft.owner)
  for (const domain of draft.decisionDomains ?? []) args.push('--domain', domain)
  for (const [domain, holder] of Object.entries(draft.decisionAuthority ?? {})) args.push('--authority', `${domain}=${holder}`)
  return args
}
