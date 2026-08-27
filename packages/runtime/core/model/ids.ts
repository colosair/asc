// ASC의 모든 Logical Entity가 쓰는 식별자 형식을 한곳에 고정하는 파일.
// 정본: docs/contracts/C-01_approval-port.md §1 (Core identity = request_id,
// 파일명·채널 표시는 전부 projection), §14 (exact 형식은 구현 단계 확정 — 여기가 그 지점).

import { z } from 'zod'

/** REQ-0042 — 전 채널(MM/Local/Web)이 공유하는 ApprovalRequest identity. */
export const RequestId = z.string().regex(/^REQ-\d{4,}$/)
/** G-0007 — Execution Grant. */
export const GrantId = z.string().regex(/^G-\d{4,}$/)
/** S-20260822-01 — Logical Session (날짜 + 당일 순번). */
export const SessionId = z.string().regex(/^S-\d{8}-\d{2}$/)
/** B-05 — Block. */
export const BlockId = z.string().regex(/^B-\d{2,}$/)
/**
 * X-20260826-04 — Bounded Query (날짜 + 당일 순번). 세션 id와 같은 모양으로 읽힌다.
 * 정규식을 따로 내보내는 이유: 이 id는 entity가 아니라 Adapter scope의 키가 되므로
 * (C-04 §0.1) 파일명 변환 전에 문법을 확인하는 자리가 zod 밖에도 필요하다.
 */
export const QUERY_ID = /^X-\d{8}-\d{2}$/
export const QueryId = z.string().regex(QUERY_ID)
/** Q-0003 — Queue item. */
export const QueueItemId = z.string().regex(/^Q-\d{4,}$/)

/**
 * Monitor event key — dedupe는 log tail 대조가 아니라 이 key의 exact lookup으로 한다
 * (OM §10.4). 문법은 `<kind>:<opaque>` 이며 **kind는 adapter가 정한다** (C-07 §9).
 *
 * 처음에는 provider 4종(notification·comment·review·review_comment)을 열거했는데, 그러면
 * 새 adapter의 키도 회수 경로가 만든 키도 통과하지 못한다 — Core가 provider의 사건 어휘를
 * 아는 셈이기도 하다. 요구는 둘뿐이다: **같은 외부 변화는 같은 키, 다른 변화는 다른 키.**
 * 기존 4종은 이 문법 안에 그대로 든다.
 *
 * kind를 소문자 토큰으로 좁히는 이유는 Markdown Adapter의 파일명 변환 때문이다 —
 * 대소문자만 다른 키가 같은 파일이 되면 dedupe가 조용히 오판한다.
 */
export const EVENT_KEY = /^[a-z][a-z0-9_-]*:.+$/
export const EventKey = z.string().regex(EVENT_KEY)

/**
 * entity 낙관적 동시성 토큰. 결정·전이는 expectedVersion CAS로만 수행한다 (C-01 §8).
 * 단조 증가 정수 — 전이 1회당 +1.
 */
export const Version = z.number().int().nonnegative()

/** ISO8601 시각 문자열. */
export const Timestamp = z.string().datetime({ offset: true })

const counterOf = (id: string) => Number(id.slice(id.lastIndexOf('-') + 1))

/** `REQ-0042` → `REQ-0043`. 순번 폭이 넘치면 자리수를 늘린다. */
export function nextId(prefix: string, existing: readonly string[], width = 4): string {
  const max = existing
    .filter((id) => id.startsWith(`${prefix}-`))
    .reduce((acc, id) => Math.max(acc, counterOf(id) || 0), 0)
  return `${prefix}-${String(max + 1).padStart(width, '0')}`
}
