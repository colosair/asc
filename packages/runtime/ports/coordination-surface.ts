// Coordination Surface — 밖에 무언가를 게시하고, 그것을 다시 찾고, 다시 읽는 통로.
//
// 기존 `ScmPort.execute` 로는 이 일을 할 수 없다. 그쪽은 성공을 문자열 하나로 돌려주고
// (`resultRef`), 만들기 전에 이미 있는지 찾는 경로도, 만든 뒤 정말 있는지 되읽는 경로도
// 없다. 실 프로젝트에서 그 구조가 같은 것을 두 번 만들게 했다:
//
//   생성 성공 → 돌아온 주소 모양이 예상과 다름 → 실패로 판정 → 다시 생성
//
// 대조할 값이 계약에 없으면 그 판정을 막을 방법이 없다. 그래서 이 Port 는 세 가지를
// 요구한다 — **찾기 · 만들기 · 되읽기**. 그리고 성공의 정본은 주소가 아니라 그 시스템이
// 준 안정적인 id 다.
//
// **공개될 것만 지나간다.** `PublicPayload` 밖의 값은 이 경계에 올 수 없다 — 내부 메모와
// 공개 본문을 한 문자열에 담았다가 나중에 가르는 구조가 유출을 만들었고, 관례로 가르면
// 언젠가 갈리지 않는다 (F4).

import type { RemoteIdentity } from '../core/runtime/coordination.ts'

/**
 * 밖으로 나가는 내용 **전부**.
 *
 * 상관 관계·근거 출처·라우팅·사적 메모는 여기 없다. 그것들은 호출자 쪽 내부 값이며
 * 이 타입으로 들어올 자리가 없다 — 그것이 이 분리의 요점이다.
 */
export type PublicPayload = {
  title: string
  body: string
  labels?: readonly string[]
}

/**
 * 이미 있는 것을 찾기 위한 질의.
 *
 * **제목 유사도로 찾지 않는다.** 제목은 사람이 바꾸고, 비슷한 제목은 다른 것일 수 있다.
 * 여기서 주는 것은 안정적인 관계 근거다 — 무엇에 대한 조율인지, 어떤 작업 항목에
 * 걸려 있는지, 우리가 이미 아는 게시물이 있는지.
 */
export type SurfaceQuery = {
  /** 이 조율이 어느 기대에 대한 것인가. adapter 는 이것을 자기 방식으로 심을 수 있다. */
  correlation: string
  /** 관련된 작업 항목의 신원. adapter 어휘 그대로이며 Core 는 해석하지 않는다. */
  workReference?: string
  /** 이미 아는 게시물. 있으면 그것부터 확인한다. */
  known?: readonly Pick<RemoteIdentity, 'objectType' | 'objectId'>[]
}

/** 찾아진 후보 하나. */
export type SurfaceCandidate = {
  identity: RemoteIdentity
  title: string
  /**
   * 왜 후보인가. **판정 근거를 값으로 든다** — 산문으로 적으면 호출자가 그것으로
   * 판단할 수 없다.
   */
  matchedBy: 'known-identity' | 'correlation' | 'work-reference' | 'weak'
  /** 닫힌 것인가. 닫힌 곳에 이어 붙일지는 호출자가 정한다. */
  closed?: boolean
}

/** 되읽기 결과. 없으면 `null` — "만들었다고 했는데 없다"는 별개의 사실이다. */
export type SurfaceSnapshot = {
  identity: RemoteIdentity
  title: string
  closed?: boolean
}

/**
 * 조율 표면 하나. adapter 가 구현한다.
 *
 * Core 는 이 인터페이스만 알고 provider 를 모른다 (C-09 §6).
 */
export interface CoordinationSurfacePort {
  readonly id: string

  /** 이미 있는가. 없으면 빈 배열 — 못 찾은 것과 없는 것을 호출자가 구분하려면 throw 한다. */
  find(query: SurfaceQuery): Promise<SurfaceCandidate[]>

  /** 만든다. 돌려주는 것은 주소가 아니라 **안정 신원**이다. */
  create(payload: PublicPayload, query: SurfaceQuery): Promise<RemoteIdentity>

  /** 지금도 있는가. 만든 직후 이것으로 확인한다 — 만들었다는 주장만으로 끝내지 않는다. */
  read(identity: Pick<RemoteIdentity, 'objectType' | 'objectId'>): Promise<SurfaceSnapshot | null>
}
