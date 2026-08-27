// Event Source Port — 외부 이벤트를 가져오는 경계. Monitor Engine이 특정 provider의
// polling 구현에 묶이지 않게 한다 (OM §10.1).
//
// webhook·scheduled·manual scan도 같은 인터페이스로 노출한다: push형 Adapter는 수신분을
// 내부 버퍼에 쌓아 두고 drain에서 돌려준다. Core가 두 가지 흐름 제어를 알 필요가 없다.

import type { EventType, Priority } from '../core/model/entities.ts'

/**
 * 아직 분류되지 않은 원본 이벤트. eventKey는 provider가 만들고, dedupe는 log 훑기가
 * 아니라 이 key의 exact lookup으로 한다 (OM §10.4).
 */
export type RawEvent = {
  eventKey: string
  detectedAt: string
  reference: string // 'Issue #19'
  /** Adapter가 아는 만큼의 힌트. 최종 분류·우선순위는 Monitor가 Profile 기준으로 정한다. */
  hints?: { type?: EventType; priority?: Priority; labels?: readonly string[]; actors?: readonly string[] }
  /** provider 원본. Phase B가 필요할 때만 들여다본다. */
  raw?: unknown
}

/** 다음 조회 시작점. 형태는 provider마다 다르므로 Core는 문자열로만 다룬다. */
export type Cursor = string | null

export type EventBatch = {
  events: RawEvent[]
  cursor: Cursor
  /** 이번 회차에 더 남은 것이 있는가 — 폭주 시 나눠 가져오기 위함. */
  hasMore?: boolean
}

export interface EventSource {
  readonly id: string // 'github-poll' | 'github-webhook' | 'manual' ...

  /**
   * "지금부터 보겠다"는 뜻의 cursor. 처음 붙인 저장소의 과거를 통째로 긁으면 그 자체가
   * 잡음이 되므로, 시작점을 정해 두고 출발할 수 있어야 한다 (OM §18).
   * 구현하지 않은 Adapter는 늘 처음부터 본다.
   */
  cursorFrom?(since: string): Cursor

  /**
   * cursor 이후의 이벤트를 가져온다. 중간 실패 시 cursor를 전진시키지 않아도 되도록
   * cursor 갱신 책임은 호출자(Monitor)에게 있다 — 누락보다 중복이 안전하고, 중복은
   * dedupe가 거른다 (OM §10.5).
   */
  drain(cursor: Cursor): Promise<EventBatch>
}
