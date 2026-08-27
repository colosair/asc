// Change Context Port — 무엇이 어디서 바뀌었는가 (C-09 §2.3).
//
// 이 Port가 따로 있는 이유는 relevance 판정 때문이다. "나를 불렀는가"가 아니라
// "내 영역이 바뀌었는가"로 관련성을 보려면 변경 경로를 실제로 읽어야 한다 (C-07 §3.2).
//
// diff 전문을 다루지 않는다. Core는 경로와 요약까지만 필요하고, 그 이상은 사람이
// provider에서 본다 — 전문을 끌어오면 조사 한 건이 통째로 비싸진다.

export type ChangeSummary = {
  reference: string
  /**
   * 바뀐 경로들. ASC scope 문법과 대조 가능한 실제 경로여야 한다 (패턴이 아니다).
   * provider가 일부만 주면 `truncated`로 그 사실을 알린다 — 없는 것을 없다고 하면
   * "내 영역은 안 바뀌었다"는 틀린 판정이 나온다.
   */
  changedPaths: readonly string[]
  truncated?: boolean
  /** 사람이 읽는 한두 줄. Core는 그대로 옮기고 요약하지 않는다. */
  summary?: string
  /** 변경 묶음 식별자(커밋·리비전 등). adapter 소관 문자열. */
  revisions?: readonly string[]
  revisionMarker: string
  /** 검토·승인 상태. provider가 알려주는 만큼만. */
  reviewState?: string
  missing?: boolean
}

export interface ChangeContextPort {
  readonly id: string
  getChange(reference: string): Promise<ChangeSummary>
}
