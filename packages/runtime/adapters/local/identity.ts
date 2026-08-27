// Local Identity Binding — 어떤 actor가 승인 권한자인지 판정한다 (OM §11.6).
//
// **이 계층이 하는 일과 하지 않는 일**
//   한다:    주어진 `채널:actor` 가 그 요청의 승인 권한자로 지정돼 있는지 확인한다.
//            로컬이라는 이유만으로 통과시키지 않고, 매핑에 없는 이름은 거절한다.
//   안 한다: 지금 명령을 낸 주체가 사람이라는 증명. 셸을 쓸 수 있는 Agent는 매핑된
//            이름을 그대로 댈 수 있다. 이 매핑은 신원 확인이지 현장 인증이 아니다.
//
// 강한 local authentication(OS 사용자 확인·서명·대화형 확인)은 별도 후속 범위다.
// 그전까지 결정 표면은 "사람이 조작하는 표면"이라는 계약 위에서 동작한다.
//
// Identity는 Credential이 아니다. 여기에는 누가 누구인지만 있고 비밀은 없다 (OM §4.5).
// Profile/Override에서 매핑을 읽어오는 경로는 B-10에서 붙인다.

import type { IdentityBinding } from '../../ports/approval.ts'

export type IdentityMap = Readonly<Record<string, readonly string[]>>

/**
 * `controller identity → [채널:actor, ...]` 매핑으로 판정한다.
 *
 * @example
 * new LocalIdentityBinding({ 'controller-a': ['local:colosair', 'mattermost:@colosair'] })
 */
export class LocalIdentityBinding implements IdentityBinding {
  #allowed: Map<string, Set<string>>

  constructor(map: IdentityMap) {
    this.#allowed = new Map(Object.entries(map).map(([approver, ids]) => [approver, new Set(ids)]))
  }

  async verify({
    channel,
    actor,
    authorizedApprover,
  }: {
    channel: string
    actor: string
    authorizedApprover: string
  }): Promise<boolean> {
    return this.#allowed.get(authorizedApprover)?.has(`${channel}:${actor}`) ?? false
  }
}

/**
 * **테스트와 명시적 opt-in 전용. 정상 경로에서 쓰지 말 것.**
 * 켜는 순간 승인자 검증이 사라져 어떤 이름으로 부르든 통과한다.
 * 실제 운용에서 이걸 고르는 것은 승인 계층을 없애는 결정이며, 그렇게 고른 코드는
 * 그 사실을 사람에게 보여야 한다.
 */
export class UnverifiedIdentityBinding implements IdentityBinding {
  readonly unverified = true
  async verify(): Promise<boolean> {
    return true
  }
}
