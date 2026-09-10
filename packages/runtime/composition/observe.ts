// Observation Builder — Monitor가 사건마다 "밖에서 알아 올" 사실을 조립한다 (C-07 §2~§4).
//
// Engine은 `observe`를 받으면 신호·관련성·억제를 켜고, 받지 않으면 예전처럼 신호만으로
// 판정한다. 그 dependency를 **production 조립에서 실제로 채우는 것**이 이 파일의 전부다.
// 판정 자체는 Core(evaluateRelevance·ObservationLedger)가 하고 여기서는 하지 않는다.
//
// 가장 중요한 규칙은 **모르면 만들지 않는다**이다:
//
//   change를 못 읽음        → 아무것도 만들지 않는다 (신호만으로 판정)
//   경로를 일부만 읽음      → 관련성·신호 금지, 실질 변화 마커만 살린다
//   구조적 판정 근거 없음   → 관련성 자체를 만들지 않는다
//
// 마지막 줄이 핵심이다. evaluateRelevance는 구조적 근거가 하나도 없으면 actual=LOW를
// 내고 그건 Shadow(숨김)가 된다. 그러니 근거를 댈 수 없는 상태에서 관련성을 만들어
// 넘기면 **모든 사건이 조용히 숨는다** — 근거 없이 숨기는 것이 가장 나쁜 결과다.

import type { OwnershipMap } from '../core/policy/ownership.ts'
import type { EventObservation, KnownFacts, ObserveFn } from '../core/monitor/engine.ts'
import { readParticipation } from '../core/monitor/participation.ts'
import type { ChangeContextPort } from '../ports/change-context.ts'
import type { RawEvent } from '../ports/event-source.ts'
import type { ResourceContextPort } from '../ports/resource-context.ts'

export type ObservationDeps = {
  /**
   * 무엇이 어디서 바뀌었는가. 이 통로가 없으면 **관련성** 판정이 서지 않는다.
   *
   * 0.8.5 부터 선택이다: 작업 항목 채널처럼 변경 개념이 없는 통로에도 스레드 관측은
   * 성립한다. 예전에는 이 하나가 없으면 관측 전체를 만들지 않았고, 그래서 그 채널의
   * 사건은 신호가 0 인 채로 지나갔다.
   */
  change?: ChangeContextPort
  /**
   * 스레드를 읽는 통로 (0.8.5). 없으면 방향 판정은 서지 않고, 예전처럼 신호만으로 간다.
   *
   * 이 통로가 없던 것이 실기계에서 후보 자체가 만들어지지 않던 이유다 — `replyToMe` 는
   * 0.7 부터 있었는데 production 에서 채우는 곳이 한 곳도 없었다.
   */
  resource?: ResourceContextPort
  /** "나" 로 인정할 계정들. 없으면 누가 말했는지 견줄 수 없어 방향을 만들지 않는다. */
  identities?: readonly string[]
  /** 한 사건에서 읽을 발언 수 상한. 스레드 전문을 끌어오지 않기 위한 예산이다. */
  commentLimit?: number
  /**
   * 한 회차에 스레드를 몇 개까지 읽을 것인가 (0.8.5).
   *
   * **무제한 조회를 기본값으로 두지 않는다.** 처음 붙인 저장소의 첫 전수는 모든 항목이
   * 새 것이라 그대로 두면 열거 한 번이 프로젝트 전체 스레드 조회가 된다. 예산을 넘긴
   * 항목은 "아직 보지 않았다" 로 표시돼 다음 회차가 같은 자리에서 다시 본다 — 본 것으로
   * 적고 넘어가면 그 항목은 영영 다시 걸리지 않는다.
   *
   * 기본값은 실측으로 정했다. 200 으로 두고 실제 저장소(항목 685개)의 첫 회차를 재니
   * API 호출이 16 에서 422 로, 71초가 364초가 됐다. 40 이면 같은 자리에서 회차당 40 회를
   * 더 쓰고, 나머지는 다음 회차가 이어 본다 — 놓치는 것은 없고 늦게 볼 뿐이다.
   */
  threadBudget?: number
  /** Profile이 선언한 책임 지도 (C-04 §6). */
  ownership?: OwnershipMap
  /** 이 사람이 맡은 역할들 (User Override). 선언이 없으면 ownership 근거는 성립하지 않는다. */
  myRoles?: readonly string[]
  /** 정본이 사는 경로. contract 근거와 canonical 신호의 기준이다. */
  canonicalPaths?: readonly string[]
}

/** 역할 선언이 실제 ownership으로 풀리는가. 오타·미선언 역할은 근거가 아니다. */
function ownedPaths(map: OwnershipMap | undefined, roles: readonly string[] | undefined): string[] {
  if (!map || !roles?.length) return []
  return roles.flatMap((role) => map[role]?.paths ?? [])
}

/**
 * 사건 하나에 대한 관찰을 만든다.
 *
 * 실패는 전부 "모른다"로 접는다 — 관찰이 감지를 막지 않는다. 외부 조회가 흔들려서
 * 판단 대기함이 비면 그건 조회 실패가 아니라 **감지 실패**로 보이기 때문이다.
 */
export function buildEventObservation(deps: ObservationDeps): ObserveFn {
  const owned = ownedPaths(deps.ownership, deps.myRoles)
  const canonicalPaths = deps.canonicalPaths?.length ? deps.canonicalPaths : undefined
  // 예산은 **회차마다** 새로 선다. 한 builder 가 여러 회차를 담당하기 때문이다 — 한
  // 프로세스가 빠른 경로·회수·전수를 연달아 돌고, 예산이 그 셋에 걸쳐 하나면 앞의 회차가
  // 다 쓰고 전수는 언제나 0 에서 시작한다.
  const allowance = deps.threadBudget ?? 40
  let budget = allowance

  const observe = async (event: RawEvent, known?: KnownFacts): Promise<EventObservation> => {
    // ── 누가 마지막으로 말했는가 (0.8.5) ──────────────────────────────────
    //
    // change 보다 먼저 본다. 이슈에는 변경이 없고, `getChange` 가 missing 을 돌려주는
    // 순간 예전 코드는 아무것도 만들지 않고 나갔다 — 그래서 "내가 묻고 상대가 답한"
    // 이슈 스레드는 신호가 0 이 되어 수신함에 오르지 못했다. 그 자리가 여기다.
    const thread = await readThread(deps, event.reference, () => budget-- > 0, known)

    if (!deps.change) return thread

    let change
    try {
      change = await deps.change.getChange(event.reference)
    } catch {
      // 못 읽은 것을 "안 바뀌었다"로 쓰지 않는다.
      return thread
    }

    // 변경요청이 아니거나 못 읽었다. 둘 다 "모른다"이므로 마커도 만들지 않는다 —
    // 없는 마커를 지어내면 다음 회차가 그것과 대조해 실질 변화를 잘못 판정한다.
    if (change.missing) return thread

    const revisionMarker = change.revisionMarker || undefined

    // 경로를 일부만 봤다면 "내 영역은 안 바뀌었다"고 말할 수 없다. 관련성도 신호도
    // 만들지 않되, 유효한 실질 변화 마커까지 버리지는 않는다 (중복 억제는 계속 선다).
    if (change.truncated) return revisionMarker ? { ...thread, revisionMarker } : thread

    const changedPaths = change.changedPaths
    if (changedPaths.length === 0) return revisionMarker ? { ...thread, revisionMarker } : thread

    // 구조적 판정 근거가 최소 하나 성립할 때만 관련성을 만든다.
    //   A. ownership — 역할 선언이 실제 경로로 풀린다
    //   B. contract  — 정본 경로가 있어 접촉 여부를 판정할 수 있다
    // 둘 다 없으면 관련성을 만들지 않는다 (신호만으로 판정 = 기존 동작).
    const canJudge = owned.length > 0 || canonicalPaths !== undefined

    return {
      ...thread,
      ...(revisionMarker ? { revisionMarker } : {}),
      signal: { ...thread.signal, changedPaths, ...(canonicalPaths ? { canonicalPaths } : {}) },
      ...(canJudge
        ? {
            relevance: {
              ...(deps.ownership ? { ownership: deps.ownership } : {}),
              ...(deps.myRoles?.length ? { myRoles: deps.myRoles } : {}),
              changedPaths,
              ...(canonicalPaths ? { canonicalPaths } : {}),
            },
          }
        : {}),
    }
  }

  observe.startPass = () => {
    budget = allowance
  }
  return observe
}

/**
 * 스레드를 읽어 "누가 마지막으로 말했는가" 를 만든다.
 *
 * 실패는 전부 빈 관측으로 접는다 — 조회가 흔들려서 후보가 사라지면 그것은 조회 실패가
 * 아니라 감지 실패로 보인다. 신원 목록이 없으면 애초에 견줄 수 없으므로 만들지 않는다.
 */
async function readThread(
  deps: ObservationDeps,
  reference: string,
  spend: () => boolean,
  known?: KnownFacts,
): Promise<EventObservation> {
  if (!deps.resource || !deps.identities?.length) return {}
  // 예산을 넘겼으면 **읽지 않았다고 말한다.** 읽지 않은 것을 "관측 없음" 으로 접으면
  // 호출자가 그것을 본 것으로 기록하고 다음 회차에서 사라진다.
  if (!spend()) return { deferred: true }
  const comments = await deps.resource
    .getComments(reference, { limit: deps.commentLimit ?? 20 })
    .catch(() => null)
  if (!comments) return {}

  // 열거가 이미 말해 준 것은 다시 묻지 않는다. 이 두 값을 위해 항목마다 단건 조회를
  // 한 번 더 하던 것이 실측에서 회차 비용의 절반이었다.
  const snapshot = known ?? (await deps.resource.getResource(reference).catch(() => null))
  const participation = readParticipation(
    {
      ...(snapshot?.author ? { author: snapshot.author } : {}),
      ...(snapshot?.assignees ? { assignees: snapshot.assignees } : {}),
      // **순서를 adapter 에 맡기지 않는다.** 어떤 provider 는 최신순으로 준다 — 그 배열의
      // 끝을 "마지막 발언" 으로 읽으면 가장 오래된 것을 집는다. 실측으로 그렇게 판정이
      // 통째로 뒤집힌 적이 있다. 여기서 시간순으로 세운다.
      comments: [...comments]
        .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
        .map((comment) => ({
          author: comment.author,
          at: comment.at,
          ...(comment.system ? { system: true } : {}),
        })),
    },
    deps.identities,
  )

  return {
    participation,
    // 내 마지막 발언 뒤에 남이 말했다 — 0.7 부터 있었으나 아무도 채우지 않던 그 칸이다.
    ...(participation.replyAfterMine ? { signal: { replyToMe: true } } : {}),
  }
}
