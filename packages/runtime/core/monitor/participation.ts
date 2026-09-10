// Participation — 이 스레드에서 **누가 마지막으로 말했는가** (0.8.5).
//
// 고친 것은 후보 자체가 만들어지지 않던 자리다. `SignalContext.replyToMe` 는 0.7 부터
// 있었고 `direct_reply` 신호로 이어져 있었고 테스트까지 있었는데, **production 에서 그
// 칸을 채우는 호출자가 한 곳도 없었다.** 회수 경로가 채우는 것은 `assignedToMe` 하나뿐이라
// (engine.ts 의 sweep), 배정도 라벨도 없는 스레드는 신호가 0 이 되고 informational 로
// 접혀 수신함에 오르지 못했다.
//
// 실기계에서 그렇게 세 건이 사라졌다:
//
//   ① 내가 물었고 상대가 답했다 — 알림 없음, 배정 없음 → 신호 0
//   ② 같은 모양. 아직 아무 데서도 쓰이지 않은 답
//   ③ 상대가 나에게 직접 요청 — 내 발언 0
//
// 여기서 하는 일은 판정 하나뿐이다. 읽는 것은 호출자가 하고, 이 파일은 provider 도
// 계정 체계도 모른다 — 신원 목록을 받아 문자열로만 견준다.

/** 스레드에서 읽어 온 사실. **사람이 쓴 것만** 넘긴다 — 시스템 자국은 답이 아니다. */
export type ThreadFacts = {
  /** 이 자원을 연 사람. 모르면 없다. */
  author?: string
  /** 지금 배정된 사람들. 목록 조회로 아는 사실이다. */
  assignees?: readonly string[]
  /** 시간순 발언. 순서를 호출자가 보장한다 — 여기서 정렬하지 않는다. */
  comments: readonly { author: string; at: string; system?: boolean }[]
}

/**
 * 이 스레드에서 나의 자리.
 *
 * **소유권도 결정권도 아니다.** 누가 언제 말했는가라는 구조적 사실뿐이고, 그것으로
 * ownership 을 세우지 않는다 — 남의 이슈에 내가 댓글 하나 달았다는 사실은 그 일이 내
 * 것이라는 뜻이 아니다.
 */
export type Participation = {
  /** 내가 이 스레드에서 말한 적이 있는가 (연 사람이거나 댓글을 남겼다). */
  participated: boolean
  /** 마지막 사람 발언이 누구 것인가. 사람 발언이 없으면 없다. */
  lastHumanActor?: 'me' | 'other'
  /**
   * **내 마지막 발언 뒤에 남이 말했는가.** 이것이 `direct_reply` 의 관측 근거다.
   *
   * 내가 한 번도 말하지 않았으면 false 다 — 그것은 "답이 왔다" 가 아니라 다른 사건이고,
   * 배정·호명 같은 다른 신호가 답할 몫이다.
   */
  replyAfterMine: boolean
  /** 남이 마지막으로 말한 시각. 소비 판정의 기준선이 된다. */
  lastOtherAt?: string
  /** 내가 마지막으로 말한 시각. */
  lastMineAt?: string
}

const isMine = (author: string, identities: readonly string[]): boolean =>
  identities.some((id) => id.replace(/^@/, '') === author.replace(/^@/, ''))

/**
 * 스레드 사실을 나의 자리로 옮긴다.
 *
 * 시스템 자국은 세지 않는다. 실측한 한 스레드는 발언 20 개 중 13 개가 그 시스템이 스스로
 * 남긴 자국이었다 — 그것을 사람의 답으로 세면 "답이 왔다" 가 저절로 성립한다.
 */
export function readParticipation(facts: ThreadFacts, identities: readonly string[]): Participation {
  const human = facts.comments.filter((comment) => comment.system !== true)
  const authoredByMe = facts.author !== undefined && isMine(facts.author, identities)

  let lastMineAt: string | undefined
  let lastOtherAt: string | undefined
  let lastHumanActor: 'me' | 'other' | undefined

  for (const comment of human) {
    if (isMine(comment.author, identities)) {
      lastMineAt = comment.at
      lastHumanActor = 'me'
    } else {
      lastOtherAt = comment.at
      lastHumanActor = 'other'
    }
  }

  const spokeHere = lastMineAt !== undefined || authoredByMe
  // 내가 연 이슈는 첫 발언이 나다 — 댓글이 없어도 "내가 물어 놓은 것" 이 성립한다.
  const replyAfterMine =
    spokeHere && lastOtherAt !== undefined && (lastMineAt === undefined || after(lastOtherAt, lastMineAt))

  return {
    participated: spokeHere,
    ...(lastHumanActor ? { lastHumanActor } : {}),
    replyAfterMine,
    ...(lastOtherAt ? { lastOtherAt } : {}),
    ...(lastMineAt ? { lastMineAt } : {}),
  }
}

/** 시간 비교. 해석되지 않는 값은 비교하지 않고 **뒤라고 말하지 않는다.** */
function after(a: string, b: string): boolean {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false
  return ta > tb
}

/**
 * 이 의무가 어느 방향인가 (0.8.5 · B).
 *
 * ```text
 * INBOUND   내 차례로 보인다 — 남이 나중에 말했거나, 나에게 배정돼 있고 남이 마지막이다
 * OUTBOUND  상대 차례다 — 내가 마지막으로 말했다
 * UNKNOWN   가를 근거가 없다
 * ```
 *
 * **Direction ≠ Ownership ≠ Authority ≠ Decision.** 여기서 나오는 값은 "누가 다음에 말할
 * 차례로 보이는가" 하나이고, 그것으로 이 일이 누구 것인지, 누가 결정할 수 있는지는
 * 말하지 않는다. UNKNOWN 을 내 차례로 바꾸지 않는다 — 모르는 것을 의무로 바꾸는 것이
 * 이 축에서 할 수 있는 가장 나쁜 일이다.
 */
export type Direction = 'INBOUND' | 'OUTBOUND' | 'UNKNOWN'

export function directionOf(
  participation: Participation,
  context: { assignedToMe?: boolean } = {},
): Direction {
  if (participation.replyAfterMine) return 'INBOUND'
  if (participation.participated && participation.lastHumanActor === 'me') return 'OUTBOUND'
  if (context.assignedToMe && participation.lastHumanActor === 'other') return 'INBOUND'
  return 'UNKNOWN'
}
