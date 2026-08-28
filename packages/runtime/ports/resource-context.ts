// Resource Context Port — 리소스 하나의 현재 내용을 읽는다 (C-09 §2).
//
// 기존 ScmPort.getThread는 **변경 마커만** 돌려준다(Drift Guard가 대조할 값). 조사는
// 실제 내용을 읽어야 하므로 같은 Port에 얹을 수 없다 — 마커를 얻으려던 호출이 매번
// 스레드 전문을 끌고 오게 된다.
//
// 여기 있는 것은 읽기뿐이다. 무엇이 중요한 댓글인지, 무엇을 해야 하는지는 판정이고
// Core가 한다.

/** 논의 한 조각. 전문을 통째로 넘기지 않기 위해 조사 단계가 개수를 정한다. */
export type ContextComment = {
  id: string
  author: string
  at: string
  body: string
  /** 아직 닫히지 않은 논의인가. provider가 알려주지 않으면 생략한다 — 추측하지 않는다. */
  unresolved?: boolean
}

export type ResourceSnapshot = {
  reference: string
  state: string
  title: string
  body?: string
  author?: string
  assignees?: readonly string[]
  labels?: readonly string[]
  updatedAt: string
  revisionMarker: string
  /** 연결된 다른 리소스. 문법은 adapter 소관이고 Core는 식별자로만 다룬다. */
  related?: readonly string[]
  /**
   * 이 일을 **막는다고 선언된** 것들. `related` 의 부분집합이다.
   *
   * 따로 두는 이유: 부모·하위 작업도 연결이지만 선행이 아니다. 그것을 선행으로 세면
   * 거의 모든 작업이 "막혔다"가 되고, 그 판정은 아무 말도 하지 않는 것과 같다.
   */
  blockedBy?: readonly string[]
  /** 사라졌거나 접근할 수 없다. 없는 것과 못 읽는 것을 구분해야 판정이 성립한다. */
  missing?: boolean
}

export type CommentQuery = {
  /** 최근 몇 개까지. 조사 depth가 정한다 — Port가 기본값을 강요하지 않는다. */
  limit?: number
  /** 이 시각 이후만. 직전 관측 이후의 변화를 볼 때 쓴다. */
  since?: string
}

export interface ResourceContextPort {
  readonly id: string
  getResource(reference: string): Promise<ResourceSnapshot>
  getComments(reference: string, query?: CommentQuery): Promise<ContextComment[]>
}

/**
 * 경위 조회 (capability `context.history`). 별도 인터페이스인 이유는 제공하지 못하는
 * adapter가 흔하기 때문이다 — 하나로 묶으면 이력을 모르는 adapter가 전체를 구현하지
 * 못하거나 빈 배열로 거짓말을 하게 된다.
 */
export type HistoryEvent = {
  at: string
  actor: string
  /** provider의 사건 어휘를 그대로. Core는 표시하고 나열할 뿐 해석하지 않는다. */
  kind: string
  detail?: string
}

export interface HistoryPort {
  readonly id: string
  getHistory(reference: string, limit?: number): Promise<HistoryEvent[]>
}
