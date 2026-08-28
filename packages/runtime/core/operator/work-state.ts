// 실제 작업 상태 판정 (P0-B).
//
// 존재 이유는 한 문장이다. **tracker 상태는 실제 작업 상태가 아니다.** 추적 항목이 "진행 중"
// 이라고 말할 때 구현은 이미 정본 가지에 병합돼 있을 수 있고, "해야 할 일"인 항목이
// 자격증명 대기로 아무도 손댈 수 없는 상태일 수 있다. 그 차이를 tracker 한 곳만 보고
// 판단하면 이미 끝난 일을 다시 시키는 추천이 나간다.
//
// 이 모듈은 순수 판정이다. 읽지 않고, 쓰지 않고, 어떤 Port 도 부르지 않는다. 증거는
// 호출측이 모아서 넘긴다 — 무엇을 못 모았는지까지 함께.
//
// 여기서 만든 상태는 **파생 뷰**다. 어디에도 저장하지 않고 Session/Request 상태 enum
// (OM §11.2, 동결)을 건드리지 않는다.

import type { ChangeSummary } from '../../ports/change-context.ts'
import type { RepoObservation } from '../../ports/local-repo.ts'
import type { ContextComment, ResourceSnapshot } from '../../ports/resource-context.ts'

export type WorkState =
  /** 지금 착수할 수 있다. */
  | 'ACTIONABLE'
  /** 구현은 정본에 있는데 tracker 가 따라오지 않았다 — 할 일은 상태 정리지 구현이 아니다. */
  | 'IMPLEMENTED_STALE_TRACKER'
  /** 구현은 끝났고 남은 것은 검증인데, 그 검증이 외부 사정으로 막혀 있다. */
  | 'IMPLEMENTATION_COMPLETE_BLOCKED_VERIFICATION'
  /** 선행 작업이 열려 있어 이 작업만으로 끝낼 수 없다. */
  | 'BLOCKED_DEPENDENCY'
  /** 남의 검토에 답하는 것이 다음 행동이다. */
  | 'REVIEW_RESPONSE_REQUIRED'
  /** 못 본 것이 있지만 판정을 뒤집을 정도는 아니다 — 무엇에 기울었는지 `leaning` 이 말한다. */
  | 'DECIDABLE_WITH_LIMITATION'
  /** 결론 요건이 채워지지 않았다. 추천하지 않는다. */
  | 'UNDECIDABLE'

/** 결정을 내릴 수 있는 상태들 — DECIDABLE_WITH_LIMITATION 의 `leaning` 이 가리키는 값. */
export type DecidedState = Exclude<WorkState, 'DECIDABLE_WITH_LIMITATION' | 'UNDECIDABLE'>

/**
 * 보지 못한 것을 두 가지로 나눠 받는다. `'UNAVAILABLE'` 은 보려 했으나 막힌 것이고,
 * 필드 자체가 없으면 이 사건에 해당하지 않는 것이다. **저장소는 예외다** —
 * `'MISSING'`(아예 안 봤다)이면 어떤 추천도 하지 않는다.
 */
export type WorkStateInput = {
  workItem?: ResourceSnapshot
  /**
   * tracker 가 "끝났다"고 말하는가. provider 어휘(한국어 상태명 등) 해석은 호출측 몫이다 —
   * Core 가 특정 tracker 의 상태 문자열을 알면 다른 tracker 를 붙일 수 없다. 모르면 undefined.
   */
  trackerDone?: boolean
  comments?: readonly ContextComment[] | 'UNAVAILABLE'
  /** 저장소 관측. `'MISSING'` 은 "조사하지 않았다" 이며 결론 요건 미달이다. */
  repo: RepoObservation | 'MISSING'
  /** MR/PR 검토 상태. 원격 provider 가 막혀 있으면 `'UNAVAILABLE'`. */
  change?: ChangeSummary | 'UNAVAILABLE'
  dependencies?: readonly { reference: string; state?: string; open?: boolean }[]
}

export type WorkStateResult = {
  state: WorkState
  leaning?: DecidedState
  /** 판정의 근거. 사람이 그대로 읽는다. */
  evidence: string[]
  /** 보려 했으나 못 본 것. 판정을 뒤집지는 않지만 숨기지도 않는다. */
  limitations: string[]
  /** 결론 요건 중 비어 있는 칸. 비어 있지 않으면 UNDECIDABLE 이다. */
  missing: string[]
}

/**
 * 결론 `ACTIONABILITY_RECOMMENDATION` 의 필수 증거.
 *
 * 원격 API 가 막혀 있다는 사실은 저장소를 안 본 사유가 되지 않는다 — ref·병합·파일 존재는
 * 로컬 git 으로 읽힌다. 그래서 repository 는 'UNAVAILABLE' 이라는 선택지 없이 필수다.
 */
const REQUIRED = ['work-item', 'repository'] as const

export function judgeWorkState(input: WorkStateInput): WorkStateResult {
  const evidence: string[] = []
  const limitations: string[] = []
  const missing: string[] = []

  if (!input.workItem || input.workItem.missing) missing.push(REQUIRED[0])
  if (input.repo === 'MISSING') missing.push(REQUIRED[1])
  else if (input.repo.unavailable) limitations.push(`저장소 관측 실패: ${input.repo.unavailable}`)

  if (missing.length > 0) {
    return {
      state: 'UNDECIDABLE',
      evidence,
      limitations,
      missing,
    }
  }

  const repo = input.repo as RepoObservation
  const item = input.workItem!

  evidence.push(`작업 항목: ${item.reference} — ${item.title} (${item.state})`)
  if (input.trackerDone !== undefined) evidence.push(`tracker 완료 표기: ${input.trackerDone ? '예' : '아니오'}`)

  if (input.comments === 'UNAVAILABLE') limitations.push('논의를 읽지 못했다 — 합의 여부는 이 판정의 근거가 아니다')
  if (input.change === 'UNAVAILABLE') limitations.push('MR·리뷰 상태를 읽지 못했다 (원격 provider 미인증/불가)')

  const onCanonical = Object.entries(repo.pathsOnCanonical ?? {}).filter(([, exists]) => exists)
  const merged = repo.mergedIntoCanonical === true || onCanonical.length > 0
  const hasBranch = repo.refs.length > 0
  const artifacts = Object.entries(repo.pathsExist).filter(([, exists]) => exists)

  if (repo.canonicalRef) evidence.push(`정본 대조 기준: ${repo.canonicalRef}`)
  if (hasBranch) evidence.push(`작업 가지: ${repo.refs.join(', ')}`)
  if (repo.mergedIntoCanonical === true) evidence.push('작업 가지가 정본에 병합돼 있다')
  if (onCanonical.length > 0) evidence.push(`정본에 산출물이 있다: ${onCanonical.map(([p]) => p).join(', ')}`)
  if (artifacts.length > 0) evidence.push(`작업 트리 산출물: ${artifacts.map(([p]) => p).join(', ')}`)

  const openDependencies = (input.dependencies ?? []).filter((d) => d.open === true)
  if (openDependencies.length > 0) {
    evidence.push(`열린 선행 작업: ${openDependencies.map((d) => d.reference).join(', ')}`)
  }
  const unknownDependencies = (input.dependencies ?? []).filter((d) => d.open === undefined)
  if (unknownDependencies.length > 0) {
    limitations.push(`선행 작업 상태를 확인하지 못했다: ${unknownDependencies.map((d) => d.reference).join(', ')}`)
  }

  const implemented = merged || artifacts.length > 0

  // ① 구현은 정본에 있는데 tracker 가 안 따라왔다. 여기서만 tracker 를 본다 — 그것도
  //    "끝났다고 말하지 않는다"는 사실로만. tracker 가 결론을 만드는 자리는 없다.
  if (merged && input.trackerDone === false) {
    return decided('IMPLEMENTED_STALE_TRACKER', evidence, limitations, { demote: false })
  }

  // ② 구현 증거는 있는데 남은 검증 경로가 막혔다.
  if (implemented && input.change === 'UNAVAILABLE' && !merged) {
    return decided('IMPLEMENTATION_COMPLETE_BLOCKED_VERIFICATION', evidence, limitations, { demote: true })
  }

  // ③ 가지는 있는데 병합 전이고 선행 작업이 열려 있다.
  if (hasBranch && !merged && openDependencies.length > 0) {
    return decided('BLOCKED_DEPENDENCY', evidence, limitations, { demote: false })
  }
  if (!implemented && openDependencies.length > 0) {
    return decided('BLOCKED_DEPENDENCY', evidence, limitations, { demote: false })
  }

  // ④ 검토가 답을 기다린다.
  if (typeof input.change === 'object' && requestsResponse(input.change, input.comments)) {
    return decided('REVIEW_RESPONSE_REQUIRED', evidence, limitations, { demote: true })
  }

  // ⑤ 구현 증거도 없고 막힌 것도 없다.
  if (!implemented) {
    evidence.push('정본·작업 트리 어디에도 구현 증거가 없다')
    return decided('ACTIONABLE', evidence, limitations, { demote: true })
  }

  // 구현 증거는 있는데 위 어디에도 안 걸린다 — 남은 것은 검증이고, 무엇이 막혔는지는 모른다.
  return decided('IMPLEMENTATION_COMPLETE_BLOCKED_VERIFICATION', evidence, limitations, { demote: true })
}

/** 검토가 응답을 요구하는가. provider 어휘를 해석하지 않고 두 가지 표시만 본다. */
function requestsResponse(
  change: ChangeSummary,
  comments: readonly ContextComment[] | 'UNAVAILABLE' | undefined,
): boolean {
  const state = change.reviewState?.toUpperCase() ?? ''
  if (state.includes('CHANGES_REQUESTED') || state.includes('REQUESTED_CHANGES')) return true
  if (comments && comments !== 'UNAVAILABLE') return comments.some((c) => c.unresolved === true)
  return false
}

/**
 * 한계가 있으면 DECIDABLE_WITH_LIMITATION 으로 내리되, 판정의 근거가 로컬 사실뿐인
 * 상태(①③)는 내리지 않는다 — 못 본 원격 정보가 그 결론을 바꾸지 못하기 때문이다.
 */
function decided(
  state: DecidedState,
  evidence: string[],
  limitations: string[],
  options: { demote: boolean },
): WorkStateResult {
  if (options.demote && limitations.length > 0) {
    return { state: 'DECIDABLE_WITH_LIMITATION', leaning: state, evidence, limitations, missing: [] }
  }
  return { state, evidence, limitations, missing: [] }
}
