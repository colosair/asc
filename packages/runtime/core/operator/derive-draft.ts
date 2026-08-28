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
import { isWithinScopes } from '../policy/scope.ts'
import type { OwnershipMap } from '../policy/ownership.ts'
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
  /**
   * 이 역할이 **가질 수 있는 최대 범위** (Profile roleScopes).
   *
   * 여기서 boundary 를 만들지 않는다 — 상한과 이번 작업의 쓰기 범위는 다른 것이다.
   * "전체까지 허용될 수 있다"가 "이번 작업이 전체를 고친다"를 뜻하지 않는다. 이 값은
   * 도출한 후보가 상한을 넘지 않는지 **재는 데만** 쓴다.
   */
  maxScopes?: readonly string[]
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
// 불릿·번호·체크박스 어느 형태든 항목으로 본다. 추적 도구마다 본문을 다르게 눌러 담는다 —
// 마크다운을 그대로 주는 곳도 있고, 헤딩·불릿 기호를 떼고 평문으로 주는 곳도 있다.
const BULLET = /^\s*(?:[-*+]\s*)?(?:\[[ xX]\]\s*)(.+?)\s*$|^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/
/** 짧고 항목이 아닌 줄은 구획 이름으로 읽는다 (`### 완료 조건` 도, 평문 `완료 조건` 도). */
const SECTION_LABEL = /^\s{0,3}(?:#{1,6}\s*|\*\*)?([^\n]{1,30}?)(?:\*\*)?\s*$/

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

  // ── boundary ── **이번 작업이 쓸 범위**를 작업 근거에서 만든다. 역할의 최대 범위를
  //                복사하지 않는다 — 정책이 없다는 것은 전체를 써도 된다는 뜻이 아니고,
  //                정책이 `**` 를 허용한다는 것도 이번 작업이 전체를 고친다는 뜻이 아니다.
  //                근거가 끝까지 없으면 **비운다** — planSessionContract 가 사람에게 묻는다.
  const boundary = deriveBoundary(input)
  if (boundary) {
    draft.boundary = boundary.scopes
    provenance.push({ field: 'boundary', status: 'PROPOSAL', source: 'repository', reason: boundary.reason })
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
 * 참고로 읽는 곳이지 고치는 곳이 아닌 경로. 작업 항목이 spec 을 가리킨다고 해서 그 spec 을
 * 고치라는 뜻이 아니다 — 읽기 근거를 쓰기 범위로 승격하면 계약이 조용히 넓어진다.
 */
const READ_ONLY_PREFIXES = ['specs/', 'docs/', 'reference/']

const isReadOnlyReference = (path: string): boolean =>
  READ_ONLY_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix))

/** 경로처럼 생긴 토큰. 문장을 해석하지 않는다 — `a/b`, `a/b/c.ts` 만 줍는다. */
const PATH_TOKEN = /(?<![\w/@])([\w.-]+(?:\/[\w.*-]+)+)/g

/** 작업 항목이 가리키는 경로 후보. 실존 여부는 저장소가 답한다 — 여기서는 줍기만 한다. */
export function extractPathHints(workItem: { title?: string; body?: string }): string[] {
  const text = `${workItem.title ?? ''}\n${workItem.body ?? ''}`
  const found = new Set<string>()
  for (const [, token] of text.matchAll(PATH_TOKEN)) {
    if (!token) continue
    const cleaned = token.replace(/[.,)\]]+$/, '')
    // URL 조각과 버전 표기는 경로가 아니다.
    if (/^https?:/.test(cleaned) || /^\d+\/\d+$/.test(cleaned)) continue
    if (isReadOnlyReference(cleaned)) continue
    found.add(cleaned)
  }
  return [...found]
}

type BoundaryProposal = { scopes: string[]; reason: string }

/**
 * 근거의 순서가 곧 좁은 정도의 순서다: 작업 항목이 지목한 것 → 저장소에서 확인된 구현
 * 영역 → 이름이 유일하게 맞아떨어지는 모듈. 어느 단계든 **상한(maxScopes) 밖이면 버린다.**
 */
function deriveBoundary(input: DeriveInput): BoundaryProposal | null {
  if (input.repo === 'MISSING') return null
  const repo = input.repo
  const within = (scope: string): boolean =>
    (input.maxScopes?.length ?? 0) === 0 ? true : isWithinScopes(scope, [...(input.maxScopes ?? [])])

  const present = Object.entries(repo.pathsExist)
    .filter(([, exists]) => exists)
    .map(([path]) => path)
  // 모듈 목록은 범위를 좁히는 재료다 — 판정의 증거가 아니므로 여기서만 본다.
  const modules = Object.entries(repo.modulesPresent ?? {})
    .filter(([, exists]) => exists)
    .map(([path]) => path)

  // ① 작업 항목이 지목했고 저장소에 실제로 있는 경로.
  const named = extractPathHints(input.workItem).filter((hint) => present.includes(hint))
  const fromItem = [...new Set(named.map(toScope))].filter(within)
  if (fromItem.length > 0) {
    return { scopes: fromItem, reason: '작업 항목이 지목했고 저장소에 실재하는 경로로 좁혔다' }
  }

  // ② 분류 이름이 **유일하게** 맞아떨어지는 모듈. 후보가 둘 이상이면 고르지 않는다.
  const module = uniqueModule(input.workItem.labels ?? [], [...present, ...modules])
  if (module && within(module)) {
    return { scopes: [module], reason: '작업 항목의 분류와 이름이 유일하게 맞는 모듈로 좁혔다' }
  }

  // ③ 저장소에서 확인된 구현 경로. 최상위 디렉터리는 쓰지 않는다 — 그 깊이는 "이 저장소"와
  //    거의 같은 말이고, 조회 목록이 곧 권한이 되는 것을 막는다. 갈래가 많으면 좁힌 것이
  //    아니므로 그때도 비운다.
  const deep = [
    ...new Set(
      present.filter((path) => path.split('/').length >= 2 && !isReadOnlyReference(path)).map(toScope),
    ),
  ].filter(within)
  if (deep.length > 0 && deep.length <= 3) {
    return { scopes: deep, reason: '저장소에서 확인된 구현 경로로 좁혔다' }
  }

  return null
}

const toScope = (path: string): string => {
  if (path.endsWith('/**')) return path
  // 파일이면 그 파일이 사는 자리까지. 디렉터리면 그 아래.
  const isFile = /\.[A-Za-z0-9]+$/.test(path)
  const base = isFile ? path.slice(0, path.lastIndexOf('/')) : path.replace(/\/$/, '')
  return base === '' ? path : `${base}/**`
}

const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * 분류 이름 하나가 저장소의 어느 자리 하나에만 맞을 때만 답한다. 범용 유사도 매칭을
 * 만들지 않는다 — 여러 곳에 걸리면 고르는 것은 사람의 일이다.
 */
function uniqueModule(labels: readonly string[], present: readonly string[]): string | null {
  const roots = [...new Set(present.map((path) => path.split('/')[0]).filter((root): root is string => Boolean(root)))]
  for (const label of labels) {
    const needle = normalize(label)
    if (needle.length < 3) continue
    const hits = roots.filter((root) => normalize(root).includes(needle))
    if (hits.length !== 1) continue
    const root = hits[0]!
    const src = present.find((path) => path === `${root}/src` || path.startsWith(`${root}/src/`))
    return src ? `${root}/src/**` : `${root}/**`
  }
  return null
}

function acceptanceLines(body?: string): string[] {
  if (!body) return []
  const found: string[] = []
  let inside = false
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue

    const bullet = BULLET.exec(line)
    const item = bullet?.[1] ?? bullet?.[2]
    if (item) {
      if (inside) found.push(item.trim())
      continue
    }

    // 항목이 아닌 줄은 구획 이름이거나 설명이다. 구획 이름이면 여기서 들고 나간다.
    const label = SECTION_LABEL.exec(line)
    if (label) inside = ACCEPTANCE_HEADING.test(label[1] ?? '')
  }
  return found
}
