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
import type { EventObservation } from '../core/monitor/engine.ts'
import type { ChangeContextPort } from '../ports/change-context.ts'
import type { RawEvent } from '../ports/event-source.ts'

export type ObservationDeps = {
  /** 무엇이 어디서 바뀌었는가. 이 통로가 없으면 관련성 판정 자체가 서지 않는다. */
  change: ChangeContextPort
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
export function buildEventObservation(deps: ObservationDeps): (event: RawEvent) => Promise<EventObservation> {
  const owned = ownedPaths(deps.ownership, deps.myRoles)
  const canonicalPaths = deps.canonicalPaths?.length ? deps.canonicalPaths : undefined

  return async (event: RawEvent): Promise<EventObservation> => {
    let change
    try {
      change = await deps.change.getChange(event.reference)
    } catch {
      // 못 읽은 것을 "안 바뀌었다"로 쓰지 않는다.
      return {}
    }

    // 변경요청이 아니거나 못 읽었다. 둘 다 "모른다"이므로 마커도 만들지 않는다 —
    // 없는 마커를 지어내면 다음 회차가 그것과 대조해 실질 변화를 잘못 판정한다.
    if (change.missing) return {}

    const revisionMarker = change.revisionMarker || undefined

    // 경로를 일부만 봤다면 "내 영역은 안 바뀌었다"고 말할 수 없다. 관련성도 신호도
    // 만들지 않되, 유효한 실질 변화 마커까지 버리지는 않는다 (중복 억제는 계속 선다).
    if (change.truncated) return revisionMarker ? { revisionMarker } : {}

    const changedPaths = change.changedPaths
    if (changedPaths.length === 0) return revisionMarker ? { revisionMarker } : {}

    // 구조적 판정 근거가 최소 하나 성립할 때만 관련성을 만든다.
    //   A. ownership — 역할 선언이 실제 경로로 풀린다
    //   B. contract  — 정본 경로가 있어 접촉 여부를 판정할 수 있다
    // 둘 다 없으면 관련성을 만들지 않는다 (신호만으로 판정 = 기존 동작).
    const canJudge = owned.length > 0 || canonicalPaths !== undefined

    return {
      ...(revisionMarker ? { revisionMarker } : {}),
      signal: { changedPaths, ...(canonicalPaths ? { canonicalPaths } : {}) },
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
}
