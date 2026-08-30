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
  /**
   * 구현 존재 증거의 등급. direct 는 정본 자체가 말하는 것(조상·정본 경로·내용 등가),
   * proxy 는 키를 경유한 추정(언급 grep·작업 트리 잔재), none 은 아무것도 없다.
   * "이 키 기준으로 못 찾았다"와 "구현이 없다"를 가르는 것이 이 칸이다.
   */
  evidenceGrade: 'direct' | 'proxy' | 'none'
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
      evidenceGrade: 'none',
    }
  }

  const repo = input.repo as RepoObservation
  const item = input.workItem!

  evidence.push(`작업 항목: ${item.reference} — ${item.title} (${item.state})`)
  if (input.trackerDone !== undefined) evidence.push(`tracker 완료 표기: ${input.trackerDone ? '예' : '아니오'}`)

  if (input.comments === 'UNAVAILABLE') limitations.push('논의를 읽지 못했다 — 합의 여부는 이 판정의 근거가 아니다')
  if (input.change === 'UNAVAILABLE') limitations.push('MR·리뷰 상태를 읽지 못했다 (원격 provider 미인증/불가)')

  const onCanonical = Object.entries(repo.pathsOnCanonical ?? {}).filter(([, exists]) => exists)
  const mentioned = repo.mentionedOnCanonical ?? []
  // 언급은 그 자체로 증거가 아니다. 되돌리기만 있는 이력도 이 작업을 "언급"하고, 뒤이어
  // 걷혀 나간 변경도 그렇다. 살아남은 것이 있어야 정본에 있다고 말할 수 있다.
  const mentionSurvives = mentioned.length > 0 && repo.mentionedOnlyReverts !== true && repo.mentionedArtifactsPresent === true
  const directEvidence =
    repo.mergedIntoCanonical === true || onCanonical.length > 0 || repo.contentEquivalent === true
  const merged = directEvidence || mentionSurvives
  const hasBranch = repo.refs.length > 0
  const artifacts = Object.entries(repo.pathsExist).filter(([, exists]) => exists)

  if (repo.canonicalRef) evidence.push(`정본 대조 기준: ${repo.canonicalRef}`)
  if (hasBranch) evidence.push(`작업 가지: ${repo.refs.join(', ')}`)
  if (repo.mergedIntoCanonical === true) evidence.push('작업 가지가 정본에 병합돼 있다')
  if (repo.contentEquivalent === true) {
    evidence.push('작업 가지의 내용이 전부 정본에 반영돼 있다 (조상은 아니다 — rebase·squash 등가)')
  }
  if (onCanonical.length > 0) evidence.push(`정본에 산출물이 있다: ${onCanonical.map(([p]) => p).join(', ')}`)
  if (artifacts.length > 0) evidence.push(`작업 트리 산출물: ${artifacts.map(([p]) => p).join(', ')}`)
  if (mentioned.length > 0) evidence.push(`정본 이력이 이 작업을 언급한다: ${mentioned.join(' / ')}`)
  if (repo.mentionedOnlyReverts === true) {
    evidence.push('그 언급은 전부 되돌리기다 — 구현이 정본에 남아 있다는 증거가 아니다')
  }
  if (repo.mentionedArtifactsPresent === true) {
    evidence.push('그 변경이 건드린 파일이 정본에 아직 있다 (생존 증거 — 인수 조건 충족의 증명은 아니다)')
  }
  if (repo.mentionedArtifactsPresent === false) {
    evidence.push('그 변경이 건드린 파일이 정본에 하나도 남아 있지 않다')
  }
  if (mentioned.length > 0 && repo.mentionedArtifactsPresent === undefined) {
    limitations.push('언급된 커밋이 무엇을 건드렸는지 읽지 못했다 — 구현이 지금도 남아 있는지 확인하지 못했다')
  }

  const openDependencies = (input.dependencies ?? []).filter((d) => d.open === true)
  if (openDependencies.length > 0) {
    evidence.push(`열린 선행 작업: ${openDependencies.map((d) => d.reference).join(', ')}`)
  }
  const unknownDependencies = (input.dependencies ?? []).filter((d) => d.open === undefined)
  if (unknownDependencies.length > 0) {
    limitations.push(`선행 작업 상태를 확인하지 못했다: ${unknownDependencies.map((d) => d.reference).join(', ')}`)
  }

  const implemented = merged || artifacts.length > 0
  const evidenceGrade: WorkStateResult['evidenceGrade'] = directEvidence
    ? 'direct'
    : mentionSurvives || artifacts.length > 0
      ? 'proxy'
      : 'none'

  // ① 구현은 정본에 있는데 tracker 가 안 따라왔다. 여기서만 tracker 를 본다 — 그것도
  //    "끝났다고 말하지 않는다"는 사실로만. tracker 가 결론을 만드는 자리는 없다.
  //    확정하려면 **살아 있는 산출물**이 있어야 한다: 병합 흔적만으로는 부분 병합·스캐폴드·
  //    되돌리기를 가려낼 수 없다. 확인하지 못했으면 확정하지 않는다.
  //    가지가 정본의 조상이라는 것은 그 커밋들이 지금 정본 이력에 그대로 있다는 뜻이라
  //    그 자체가 생존 증거다. 언급(grep)만 있는 경우와 다르다.
  const artifactSurvives =
    repo.mergedIntoCanonical === true || onCanonical.length > 0 || repo.mentionedArtifactsPresent === true
  if (merged && input.trackerDone === false && artifactSurvives && repo.mentionedOnlyReverts !== true) {
    limitations.push('인수 조건 전체가 지금도 충족되는지는 확인하지 않았다 — 여기서 말하는 것은 구현의 생존까지다')
    // 측정된 반증은 언급-생존보다 무겁다: cherry 가 "가지에 정본 미반영 커밋이 남아
    // 있다"고 말했으면, 언급 grep 만으로 "할 일은 상태 정리"를 확정하지 않는다.
    if (repo.contentEquivalent === false) {
      limitations.push('작업 가지에 정본에 반영되지 않은 커밋이 남아 있다 (patch 대조) — 상태 정리만 남았다고 확정하지 않는다')
      return decided('IMPLEMENTED_STALE_TRACKER', evidence, limitations, { demote: true, grade: evidenceGrade })
    }
    return decided('IMPLEMENTED_STALE_TRACKER', evidence, limitations, { demote: false, grade: evidenceGrade })
  }
  if (merged && input.trackerDone === false) {
    // 병합 흔적은 있는데 생존을 확인하지 못했다 — 새 구현을 시키지도, 끝났다고 하지도 않는다.
    limitations.push('정본에 병합 흔적은 있으나 구현이 지금도 남아 있는지 확인하지 못했다')
    return decided('IMPLEMENTATION_COMPLETE_BLOCKED_VERIFICATION', evidence, limitations, { demote: true, grade: evidenceGrade })
  }

  // ② 구현 증거는 있는데 남은 검증 경로가 막혔다.
  if (implemented && input.change === 'UNAVAILABLE' && !merged) {
    return decided('IMPLEMENTATION_COMPLETE_BLOCKED_VERIFICATION', evidence, limitations, { demote: true, grade: evidenceGrade })
  }

  // ③ 가지는 있는데 병합 전이고 선행 작업이 열려 있다.
  if (hasBranch && !merged && openDependencies.length > 0) {
    return decided('BLOCKED_DEPENDENCY', evidence, limitations, { demote: false, grade: evidenceGrade })
  }
  if (!implemented && openDependencies.length > 0) {
    return decided('BLOCKED_DEPENDENCY', evidence, limitations, { demote: false, grade: evidenceGrade })
  }

  // ④ 검토가 답을 기다린다.
  if (typeof input.change === 'object' && requestsResponse(input.change, input.comments)) {
    return decided('REVIEW_RESPONSE_REQUIRED', evidence, limitations, { demote: true, grade: evidenceGrade })
  }

  // ⑤ 구현 증거도 없고 막힌 것도 없다.
  //
  //    "없다"는 신선한 정본에서만 성립한다. 당겨 오지 못한 관측 위의 "없음"은 원격이
  //    이미 품고 있는 구현을 못 본 것일 수 있다 — 그때는 착수를 추천하지 않는다.
  //    fetch 실패는 저장소 부재가 아니다: missing 은 freshness 를 따로 가리킨다.
  if (!implemented) {
    if (repo.freshness?.state !== 'FRESH') {
      limitations.push(
        `정본을 원격에서 당겨 오지 못한 관측이다 (${repo.freshness?.state ?? 'UNKNOWN'}${repo.freshness?.detail ? ` — ${repo.freshness.detail}` : ''}) — 이 위에서 "구현이 없다"를 확정하지 않는다`,
      )
      return { state: 'UNDECIDABLE', evidence, limitations, missing: ['canonical-freshness'], evidenceGrade }
    }
    evidence.push('이 작업 키를 직접 가리키는 증거를 확인하지 못했다')
    const result = decided('ACTIONABLE', evidence, limitations, { demote: true, grade: evidenceGrade })
    // 구조적 한계 — 키 대조는 proxy 다. 다른 키의 커밋이 이 작업의 인수 조건을 이미
    // 충족했을 가능성은 여기서 대조하지 않았다. 표기는 하되 이 한 줄로 판정을 되돌리지는
    // 않는다 (모든 관측에 항상 붙는 한계라, demote 재료로 쓰면 ACTIONABLE 이 사라진다).
    result.limitations.push('다른 키·경로로 이미 충족됐을 가능성은 대조하지 않았다 — 키 기준 관측의 구조적 한계')
    return result
  }

  // 구현 증거는 있는데 위 어디에도 안 걸린다 — 남은 것은 검증이고, 무엇이 막혔는지는 모른다.
  return decided('IMPLEMENTATION_COMPLETE_BLOCKED_VERIFICATION', evidence, limitations, { demote: true, grade: evidenceGrade })
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
  options: { demote: boolean; grade: WorkStateResult['evidenceGrade'] },
): WorkStateResult {
  if (options.demote && limitations.length > 0) {
    return {
      state: 'DECIDABLE_WITH_LIMITATION',
      leaning: state,
      evidence,
      limitations,
      missing: [],
      evidenceGrade: options.grade,
    }
  }
  return { state, evidence, limitations, missing: [], evidenceGrade: options.grade }
}
