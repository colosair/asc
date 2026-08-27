// Inventory Port — provider가 지금 들고 있는 목록을 상태 무관하게 열거한다 (C-09 §2).
//
// EventSource와 답하는 질문이 다르다:
//   EventSource  "그 사이에 무슨 일이 있었나"  — 증분. 놓치면 그대로 놓친다
//   Inventory    "지금 무엇이 있나"            — 전수. 놓친 것을 찾아낸다
//
// 그래서 **닫힌 것도 포함한다.** 닫힌 Issue에 새 댓글이 달리고, 병합된 변경에 논의가
// 이어지고, 끝난 작업의 설명이 고쳐진다. open만 세는 열거는 그 전부를 놓친다.
//
// 여기서 목록을 받아 무엇이 달라졌는지 판정하는 것은 Monitor의 몫이다 — 이 Port는
// 비교하지 않고, 우선순위를 매기지 않고, 무엇이 중요한지도 모른다.

/**
 * provider가 아는 리소스 하나의 현재 모습. 필드는 **비교에 필요한 만큼만** 둔다 —
 * 본문·댓글·변경 내용은 ResourceContext / ChangeContext의 몫이고, 여기에 끌어오면
 * 전수 열거 한 번이 통째로 비싸진다.
 */
export type InventoryItem = {
  /** provider-neutral 식별자. 문법은 adapter가 정하고 Core는 문자열로만 다룬다. */
  reference: string
  /**
   * provider의 상태 어휘를 그대로 둔다. Core는 이 값으로 분기하지 않고 비교만 한다 —
   * 상태 이름을 Core가 해석하기 시작하면 provider 도메인이 Core로 올라온다.
   */
  state: string
  updatedAt: string
  /**
   * 실질 변화 마커 (C-07 §4). adapter가 만들고 **Core는 같은지 다른지만 본다.**
   * 무엇을 넣을지는 adapter가 정한다 — 갱신 시각 하나로는 댓글 외의 변화를 놓친다.
   */
  revisionMarker: string
  title?: string
  assignees?: readonly string[]
  labels?: readonly string[]
}

export type InventoryQuery = {
  /**
   * 이 시각 이후 변한 것만. 생략하면 전부 — Census가 그렇게 쓴다.
   * 상태로 거르지 않는다는 것이 이 Port의 계약이므로 state 필터는 두지 않는다.
   */
  updatedSince?: string
  /** adapter가 아는 리소스 갈래(이슈·변경요청·작업항목 등). 생략하면 adapter 기본값. */
  kinds?: readonly string[]
}

export type InventoryPage = {
  items: InventoryItem[]
  /**
   * 다음 페이지 시작점. 없으면 끝이다.
   * 페이지를 다 돌지 못했는데 끝인 척하면 Census가 "사라졌다"를 잘못 만들어낸다.
   */
  next?: string
  /**
   * **마지막 페이지에서만 true가 될 수 있다** — "여기까지 오는 동안 빠짐이 없었다"는 뜻이다.
   * 중간 페이지는 아직 알 수 없으므로 false다. 모르면 false다 (C-07 §8.2).
   *
   * 이 값이 false인 열거로 missing reference를 판정해서는 안 된다 — 페이지를 다 돌지
   * 못한 목록으로 비교하면 멀쩡한 리소스가 사라졌다고 나온다.
   */
  complete: boolean
}

export interface InventoryPort {
  readonly id: string
  /** 한 페이지씩. 전부 도는 것은 호출자의 몫이다 — 중단·재개 지점을 Core가 쥔다. */
  enumerate(query: InventoryQuery, cursor?: string): Promise<InventoryPage>
}
