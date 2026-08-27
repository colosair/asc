// Relevance Evaluator — "나를 불렀는가"와 "실제로 내 일인가"를 따로 판정한다 (C-07 §2·§3).
//
// 신호(Signal)는 사건에 대한 관찰이고, 관련성(Relevance)은 그 사건과 지금 나·이 프로젝트의
// 관계다. 둘을 한 층에 두면 태깅 난사와 태깅 누락을 동시에 틀린다:
//
//   나를 불렀다  → 내 일이다     ❌ 무관한 곳에 부른 것까지 판단 대기로 올라온다
//   안 불렀다   → 내 일이 아니다 ❌ 지정이 빠진 실제 내 일을 놓친다
//
// 그래서 두 축을 따로 세우고, 낮은 쪽은 버리지 않고 Shadow로 내린다.
//
// 판정 근거는 **구조적 사실을 먼저** 본다. 의미 판단(제목이 내 영역 같다)은 보조다 —
// 그것 하나로 올리기 시작하면 왜 올라왔는지 아무도 설명할 수 없게 된다.

import { isWithinScopes } from '../policy/scope.ts'
import type { OwnershipMap } from '../policy/ownership.ts'
import type { GenericSignal } from './signals.ts'

/** 나를 직접 겨눈 신호. 이것들이 explicit targeting의 전부다. */
const EXPLICIT: ReadonlySet<GenericSignal> = new Set([
  'assigned_to_me',
  'mentioned_me',
  'direct_reply',
  'review_requested',
])

export type RelevanceLevel = 'HIGH' | 'LOW'

/** 근거의 갈래. 우선순위 순서이며, 마지막(semantic)은 보조다 (C-07 §3.2). */
export type EvidenceKind = 'ownership' | 'work' | 'contract' | 'participation' | 'semantic' | 'targeting'

export type RelevanceEvidence = {
  kind: EvidenceKind
  /** 사람이 읽는 한 줄. 왜 그렇게 봤는지가 여기 남는다. */
  detail: string
  /** 관련성을 올리는 근거인가, 내리는 근거인가. 반대 근거도 적는다. */
  supports: boolean
}

export type Disposition = 'INBOX' | 'SHADOW'

export type Relevance = {
  explicit: RelevanceLevel
  actual: RelevanceLevel
  evidence: RelevanceEvidence[]
  disposition: Disposition
}

export type RelevanceContext = {
  /** Profile이 선언한 책임 지도 (C-04 §6). */
  ownership?: OwnershipMap
  /** 이 사람이 맡은 역할들. 비어 있으면 ownership 근거는 성립하지 않는다. */
  myRoles?: readonly string[]
  /** 이번 변경이 건드린 실제 경로. 모르면 생략한다 — 빈 배열과 다르다. */
  changedPaths?: readonly string[]
  /** 지금 돌고 있는 세션들의 쓰기 범위. */
  activeBoundaries?: readonly { sessionId: string; paths: readonly string[] }[]
  /** 정본이 사는 경로. contract 근거의 기준이다. */
  canonicalPaths?: readonly string[]
  /** 내가 전에 이 스레드에 참여했는가. */
  participated?: boolean
  /** 제목·본문이 내 영역과 연관된다고 볼 근거(보조). Surface가 판단해 넘긴다. */
  semanticHint?: string
}

/**
 * 두 축을 판정한다.
 *
 * **숫자를 내지 않는다** (C-07 §3.3). 0.82 같은 값은 사람이 검증할 수 없고, 틀렸을 때 어디가
 * 틀렸는지도 말해주지 않는다. 대신 근거 문장을 남겨 사람이 뒤집을 수 있게 한다.
 */
export function evaluateRelevance(
  signals: readonly GenericSignal[],
  context: RelevanceContext = {},
): Relevance {
  const evidence: RelevanceEvidence[] = []

  const explicitSignals = signals.filter((s) => EXPLICIT.has(s))
  const explicit: RelevanceLevel = explicitSignals.length > 0 ? 'HIGH' : 'LOW'
  evidence.push(
    explicit === 'HIGH'
      ? { kind: 'targeting', detail: `나를 지목한 신호: ${explicitSignals.join(', ')}`, supports: true }
      : { kind: 'targeting', detail: '나를 지목한 신호가 없다', supports: false },
  )

  // ① Ownership — 바뀐 경로가 내 영역인가. changed×ownership은 신호가 아니라 근거다 (C-07 §2.4).
  const myPaths = ownedPaths(context.ownership, context.myRoles)
  if (context.changedPaths && myPaths.length > 0) {
    const hits = context.changedPaths.filter((path) => isWithinScopes(path, myPaths))
    evidence.push(
      hits.length > 0
        ? { kind: 'ownership', detail: `내 영역 변경: ${hits.slice(0, 3).join(', ')}`, supports: true }
        : { kind: 'ownership', detail: '바뀐 경로가 전부 내 영역 밖이다', supports: false },
    )
  }

  // ② Work — 지금 돌고 있는 세션의 쓰기 범위를 건드리는가.
  if (context.changedPaths && context.activeBoundaries?.length) {
    for (const active of context.activeBoundaries) {
      const hits = context.changedPaths.filter((path) => isWithinScopes(path, active.paths))
      if (hits.length > 0) {
        evidence.push({ kind: 'work', detail: `${active.sessionId} 와 같은 경로를 건드린다`, supports: true })
      }
    }
  }

  // ③ Contract — 정본 영역을 건드리는가. 신호(open_change_touches_active_canonical)와 같은
  //    대조를 쓰지만 여기서는 관련성 근거로 다시 든다 — 신호는 "무슨 일이 있었나"이고
  //    근거는 "그래서 내 일인가"다.
  if (context.changedPaths && context.canonicalPaths?.length) {
    const hits = context.changedPaths.filter((path) => isWithinScopes(path, context.canonicalPaths!))
    if (hits.length > 0) {
      evidence.push({ kind: 'contract', detail: `정본 영역 변경: ${hits.slice(0, 3).join(', ')}`, supports: true })
    }
  }
  if (signals.includes('active_canonical_changed')) {
    evidence.push({ kind: 'contract', detail: '정본 baseline이 실제로 움직였다', supports: true })
  }

  // ④ Participation — 내가 이미 들어가 있던 자리인가.
  if (context.participated) {
    evidence.push({ kind: 'participation', detail: '전에 이 스레드에 참여했다', supports: true })
  } else if (signals.includes('my_pr_reviewed')) {
    evidence.push({ kind: 'participation', detail: '내가 만든 변경에 대한 반응이다', supports: true })
  }

  // ⑤ Semantic — 보조. 이것 하나로는 올리지 않는다.
  if (context.semanticHint) {
    evidence.push({ kind: 'semantic', detail: context.semanticHint, supports: true })
  }

  const structural = evidence.filter((e) => e.supports && e.kind !== 'targeting' && e.kind !== 'semantic')
  const actual: RelevanceLevel = structural.length > 0 ? 'HIGH' : 'LOW'

  return {
    explicit,
    actual,
    evidence,
    // 실제로 관련되면 올린다. 관련 근거가 없으면 나를 불렀더라도 Shadow로 내린다 —
    // 다만 버리지 않는다 (C-07 §5).
    disposition: actual === 'HIGH' ? 'INBOX' : 'SHADOW',
  }
}

/** 이 사람이 맡은 역할들의 쓰기 영역. 역할 선언이 없으면 빈 목록이다 — 추론하지 않는다. */
function ownedPaths(map: OwnershipMap | undefined, roles: readonly string[] | undefined): string[] {
  if (!map || !roles?.length) return []
  return roles.flatMap((role) => map[role]?.paths ?? [])
}

/** 사람이 읽는 근거 블록. 근거 없이 결론만 보여주지 않는다. */
export function renderRelevance(relevance: Relevance): string[] {
  const lines = [`Relevance: ${relevance.actual} (지목 ${relevance.explicit})`]
  for (const item of relevance.evidence) lines.push(`  ${item.supports ? '+' : '-'} ${item.detail}`)
  if (relevance.disposition === 'SHADOW') {
    lines.push('  → Shadow Watch (숨김. 변화가 생기면 다시 본다)')
  }
  return lines
}
