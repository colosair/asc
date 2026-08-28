// 조사 결과 → 계약 초안 (P0-C).
//
// contract-draft.ts 는 "초안을 만들지 않는다"고 선언한다. 맞는 선언이지만, 그러면 초안을
// 만드는 자리가 어디에도 없어서 사람이 goal·boundary·criteria 를 손으로 채우거나 agent 가
// 지어냈다. 이 모듈이 그 빈 칸이다 — **읽어 온 사실로 채울 수 있는 만큼만 채우고, 나머지는
// 비운 채로 넘긴다.**
//
// 판정은 하지 않는다. 범위가 맞는지, 책임자가 누구인지, 사람이 정해야 하는지는 전부
// planSessionContract 가 이미 잰다. 여기서 같은 것을 또 재면 두 판정이 갈라진다.
//
// 순수 함수다. 날짜조차 주입받는다.

import type { RepoObservation } from '../../ports/local-repo.ts'
import type { ResourceSnapshot } from '../../ports/resource-context.ts'
import type { OwnershipMap } from '../policy/ownership.ts'
import type { ResolvedPolicy, RoleName } from '../policy/policy.ts'
import type { DraftField, SessionContractDraft } from './contract-draft.ts'
import type { WorkStateResult } from './work-state.ts'

export type DeriveInput = {
  intent: {
    /** 사람이 지목한 작업 항목 키. */
    workRef: string
    /** 사람이 직접 말한 목표가 있으면. 없으면 작업 항목에서 읽는다. */
    goal?: string
    role?: string
  }
  workItem: ResourceSnapshot
  workState: WorkStateResult
  repo: RepoObservation | 'MISSING'
  policy?: ResolvedPolicy
  ownership?: OwnershipMap
  existingIds?: readonly string[]
  /** YYYYMMDD. 세션 id 는 날짜를 담는다 (S-YYYYMMDD-NN). */
  today: string
  /** 저장소가 이미 돌리는 검사들 (예: 'npm test'). 검증 기준의 근거가 된다. */
  repoChecks?: readonly string[]
}

/**
 * 완료 조건으로 읽을 만한 줄. 헤딩 아래 불릿·체크박스만 본다 — 문장을 해석하지 않는다.
 * 못 찾으면 **비운다**. 없는 인수 조건을 만들어 넣는 것이 이 함수가 할 수 있는 최악이다.
 */
const ACCEPTANCE_HEADING = /(완료\s*조건|인수\s*조건|acceptance|done\s*criteria)/i
const BULLET = /^\s*(?:[-*+]\s*(?:\[[ xX]\]\s*)?|\d+[.)]\s*)(.+?)\s*$/
const HEADING = /^\s{0,3}#{1,6}\s|^\s*###/

export function deriveSessionContractDraft(input: DeriveInput): SessionContractDraft {
  const provenance: DraftField[] = []
  const draft: SessionContractDraft = {}

  // ── id ── 작업 항목 키는 세션 id 가 될 수 없다 (SessionId 는 S-YYYYMMDD-NN). 키는
  //          goal 과 provenance 에 남고, 세션 id 는 오늘 날짜로 새로 뽑는다.
  draft.id = nextSessionId(input.today, input.existingIds ?? [])
  provenance.push({
    field: 'id',
    status: 'PROPOSAL',
    source: 'agent_proposal',
    reason: `${input.intent.workRef} 작업을 위해 오늘 날짜로 뽑은 세션 id`,
  })

  // ── role ──
  if (input.intent.role) {
    draft.role = input.intent.role
    provenance.push({ field: 'role', status: 'FACT', source: 'user', reason: '사람이 역할을 지정했다' })
  } else {
    draft.role = 'implementer'
    provenance.push({
      field: 'role',
      status: 'PROPOSAL',
      source: 'agent_proposal',
      reason: `${input.intent.workRef} 착수 요청이라 구현 역할로 제안한다`,
    })
  }

  // ── goal ── 작업 항목이 말하는 것을 옮긴다. 다시 쓰지 않는다.
  if (input.intent.goal && input.intent.goal.trim() !== '') {
    draft.goal = input.intent.goal.trim()
    provenance.push({ field: 'goal', status: 'FACT', source: 'user', reason: '사람이 목표를 직접 말했다' })
  } else {
    draft.goal = `${input.workItem.reference}: ${input.workItem.title}`
    provenance.push({
      field: 'goal',
      status: 'FACT',
      source: 'work_item',
      reason: '작업 항목의 제목을 그대로 옮겼다',
    })
  }

  // ── boundary ── 역할의 최대 범위를 넘지 않는다. 저장소에서 확인된 경로가 있으면 그만큼
  //                좁힌다. **절대 FACT 가 아니다** — 범위는 재어야 하는 제안이다.
  const roleScopes = input.policy?.roleScopes?.[draft.role as RoleName] ?? []
  const narrowed = narrowByRepo(roleScopes, input.repo)
  if (narrowed.length > 0) {
    draft.boundary = narrowed
    provenance.push({
      field: 'boundary',
      status: 'PROPOSAL',
      source: 'repository',
      reason:
        narrowed.length === roleScopes.length
          ? '역할의 최대 범위를 그대로 제안한다 — 저장소에서 더 좁힐 근거를 찾지 못했다'
          : '저장소에서 확인된 경로로 역할 범위를 좁혔다',
    })
  }

  // ── criteria ── 작업 항목의 완료 조건은 사실이고, 저장소가 이미 돌리는 검사는 제안이다.
  //                둘 다 없으면 비운다. planSessionContract 가 사람에게 묻게 두는 편이,
  //                없는 인수 조건을 지어내는 것보다 낫다.
  const fromItem = acceptanceLines(input.workItem.body)
  const fromRepo = (input.repoChecks ?? []).map((check) => `저장소 기존 검사 통과: ${check}`)
  const criteria = [...fromItem, ...fromRepo]
  if (criteria.length > 0) {
    draft.criteria = criteria
    provenance.push({
      field: 'criteria',
      status: fromItem.length > 0 ? 'FACT' : 'PROPOSAL',
      source: fromItem.length > 0 ? 'work_item' : 'repository',
      reason:
        fromItem.length > 0
          ? '작업 항목이 적어 둔 완료 조건을 옮겼다'
          : '작업 항목에 완료 조건이 없어 저장소가 이미 돌리는 검사를 제안한다',
    })
  }

  // owner 는 여기서 정하지 않는다 — planSessionContract 의 lookupOwnerByPaths 가 이미 한다.

  draft.provenance = provenance
  return draft
}

/** 다음 세션 id. 같은 날 이미 쓴 번호는 건너뛴다. */
function nextSessionId(today: string, existing: readonly string[]): string {
  const used = new Set(
    existing
      .map((id) => /^S-(\d{8})-(\d{2})$/.exec(id))
      .filter((m): m is RegExpExecArray => m !== null && m[1] === today)
      .map((m) => Number(m[2])),
  )
  let n = 1
  while (used.has(n)) n += 1
  return `S-${today}-${String(n).padStart(2, '0')}`
}

/**
 * 저장소에서 실제로 확인된 경로가 있는 역할 범위만 남긴다. 하나도 안 걸리면 좁히지 않는다 —
 * 좁힐 근거가 없는데 좁히면 정작 고쳐야 할 파일이 범위 밖으로 떨어진다.
 */
function narrowByRepo(roleScopes: readonly string[], repo: RepoObservation | 'MISSING'): string[] {
  const scopes = [...roleScopes]
  if (repo === 'MISSING' || scopes.length === 0) return scopes
  const seen = Object.entries(repo.pathsExist)
    .filter(([, exists]) => exists)
    .map(([path]) => path)
  if (seen.length === 0) return scopes
  const matched = scopes.filter((scope) => seen.some((path) => path.startsWith(stripGlob(scope))))
  return matched.length > 0 ? matched : scopes
}

const stripGlob = (scope: string): string => scope.replace(/\*.*$/, '')

function acceptanceLines(body?: string): string[] {
  if (!body) return []
  const lines = body.split('\n')
  const found: string[] = []
  let inside = false
  for (const line of lines) {
    if (HEADING.test(line) || /^\s*\*\*/.test(line)) {
      inside = ACCEPTANCE_HEADING.test(line)
      continue
    }
    if (!inside) continue
    const bullet = BULLET.exec(line)
    if (bullet?.[1]) found.push(bullet[1].trim())
    else if (line.trim() === '') continue
  }
  return found
}
