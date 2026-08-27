// Webhook Ingress — 밀려 들어오는 사건을 받아 두는 자리 (C-12 §2).
//
// Webhook은 새 개념이 아니다. C-07 §1.1이 Delta를 "webhook / incremental polling /
// provider notification / updated-since" 로 이미 정의했고, `ports/event-source.ts` 는
// **push형 Adapter는 수신분을 버퍼에 쌓아 두고 drain에서 돌려준다** 고 예고해 뒀다.
// 이 파일은 그 예고를 실제로 구현할 뿐이며 MonitorEngine은 한 줄도 바뀌지 않는다.
//
// 책임을 둘로 나눈다 (C-12 불변식 ⑦):
//
//   Ingress     받는다 · 검증한다 · 쌓는다        ← 이 파일
//   Orchestrator 언제 처리할지 정한다              ← core/runtime/orchestrator.ts
//
// 지금은 같은 프로세스에 둘 수 있지만 Core는 그 배치를 모른다. 나중에 receiver만
// 떼어내도 계약은 그대로다.
//
// **서명 검증은 생략할 수 없다** (불변식 ⑧). 검증 실패는 조용한 무시가 아니라 거부이며,
// 거부한 사실도 기록에 남는다 — 아무도 안 오는 것과 오는데 다 튕기는 것은 다른 상태다.

import { createHmac, timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

import type { ScopedStore } from '../../ports/state-store.ts'
import type { Cursor, EventBatch, EventSource, RawEvent } from '../../ports/event-source.ts'

export const IngressRecord = z.object({
  /** 수신 순번. drain은 이 순서로 돌려준다 — 도착 순서가 곧 관측 순서다. */
  seq: z.number().int().positive(),
  receivedAt: z.string().min(1),
  event: z.object({
    eventKey: z.string().min(1),
    detectedAt: z.string().min(1),
    reference: z.string().min(1),
    hints: z.record(z.unknown()).optional(),
    raw: z.unknown().optional(),
  }),
})
export type IngressRecord = z.infer<typeof IngressRecord>

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; reason: 'NO_SIGNATURE' | 'BAD_SIGNATURE'; detail: string }

const bufferKey = (seq: number) => `ingress:${String(seq).padStart(12, '0')}`
const BUFFER_PREFIX = 'ingress:'
const REJECTED_KEY = 'ingress-rejected'

/**
 * HMAC 서명 확인 (C-12 불변식 ⑧).
 *
 * 길이가 달라도 같은 시간을 쓰도록 비교 전에 맞춘다 — 길이로 새는 정보도 정보다.
 */
export function verifySignature(payload: string, signature: string | undefined, secret: string): VerifyOutcome {
  if (!signature) return { ok: false, reason: 'NO_SIGNATURE', detail: '서명 헤더가 없다' }

  const expected = createHmac('sha256', secret).update(payload).digest('hex')
  // provider마다 `sha256=` 같은 접두어를 붙인다. 값만 본다.
  const given = signature.includes('=') ? signature.slice(signature.indexOf('=') + 1) : signature
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(given, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'BAD_SIGNATURE', detail: '서명이 맞지 않는다' }
  }
  return { ok: true }
}

export type AcceptOutcome =
  | { ok: true; seq: number }
  | { ok: false; reason: 'NO_SIGNATURE' | 'BAD_SIGNATURE' | 'UNREADABLE'; detail: string }

/**
 * 받은 것을 쌓는다. **여기서 판정하지 않는다** — 분류·관련성·억제는 전부 기존 Phase A가 한다.
 *
 * 저장은 순번마다 다른 키에 setIfAbsent다. 읽고-고쳐-쓰면 동시에 도착한 둘 중 하나가
 * 조용히 사라지는데, 그건 "변경 없음"으로 보인다.
 */
export class WebhookIngress {
  #scope: ScopedStore
  #secret: string
  #now: () => string

  constructor(scope: ScopedStore, secret: string, now: () => string = () => new Date().toISOString()) {
    this.#scope = scope
    this.#secret = secret
    this.#now = now
  }

  async accept(
    payload: string,
    signature: string | undefined,
    toEvent: (parsed: unknown) => RawEvent | null,
  ): Promise<AcceptOutcome> {
    const verified = verifySignature(payload, signature, this.#secret)
    if (!verified.ok) {
      // 튕긴 것도 사실이다. 아무도 안 오는 것과 오는데 다 튕기는 것을 구분해야 한다.
      await this.#countRejected(verified.reason)
      return { ok: false, reason: verified.reason, detail: verified.detail }
    }

    let event: RawEvent | null
    try {
      event = toEvent(JSON.parse(payload))
    } catch (error) {
      await this.#countRejected('UNREADABLE')
      return { ok: false, reason: 'UNREADABLE', detail: error instanceof Error ? error.message : String(error) }
    }
    if (!event) {
      // 이 provider 사건은 우리가 아는 형태가 아니다 — 지어내지 않는다
      await this.#countRejected('UNREADABLE')
      return { ok: false, reason: 'UNREADABLE', detail: '읽을 수 있는 사건이 아니다' }
    }

    let seq = (await this.#lastSeq()) + 1
    for (;;) {
      const record = IngressRecord.parse({ seq, receivedAt: this.#now(), event })
      if (await this.#scope.setIfAbsent(bufferKey(seq), JSON.stringify(record))) return { ok: true, seq }
      seq += 1
    }
  }

  /** 쌓인 것을 순서대로 꺼내고 지운다. 꺼낸 것은 Engine이 지고, 여기 남기지 않는다. */
  async drain(limit = 100): Promise<RawEvent[]> {
    const keys = (await this.#scope.keys(BUFFER_PREFIX)).sort().slice(0, limit)
    const events: RawEvent[] = []
    for (const key of keys) {
      const raw = await this.#scope.get(key)
      if (!raw) continue
      const parsed = IngressRecord.safeParse(JSON.parse(raw))
      // 깨진 항목은 판정 근거가 못 된다 — 그 항목만 버린다
      if (parsed.success) events.push(parsed.data.event as RawEvent)
      await this.#scope.delete(key)
    }
    return events
  }

  async pending(): Promise<number> {
    return (await this.#scope.keys(BUFFER_PREFIX)).length
  }

  /** 튕긴 수. 0이 아니면 무언가 잘못 설정돼 있다는 뜻이고, 그건 감지 공백이다. */
  async rejected(): Promise<Record<string, number>> {
    const raw = await this.#scope.get(REJECTED_KEY)
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  }

  async #countRejected(reason: string): Promise<void> {
    const current = await this.rejected()
    await this.#scope.set(REJECTED_KEY, JSON.stringify({ ...current, [reason]: (current[reason] ?? 0) + 1 }))
  }

  async #lastSeq(): Promise<number> {
    const keys = await this.#scope.keys(BUFFER_PREFIX)
    return keys.reduce((max, key) => Math.max(max, Number(key.slice(BUFFER_PREFIX.length)) || 0), 0)
  }
}

/**
 * 버퍼를 비우는 EventSource. **Engine은 이것이 push인지 pull인지 모른다** —
 * `ports/event-source.ts` 가 예고한 바로 그 형태다.
 *
 * cursor를 쓰지 않는다: 꺼낸 것은 지워지므로 다음 회차는 남은 것부터 본다. 중복은
 * 기존 dedupe(eventKey exact lookup)가 거른다 — 같은 변경을 회수 경로가 다시 봐도
 * 패킷이 둘이 되지 않는 이유와 같다.
 */
export class IngressEventSource implements EventSource {
  readonly id: string
  #ingress: WebhookIngress
  #limit: number

  constructor(deps: { id?: string; ingress: WebhookIngress; limit?: number }) {
    this.id = deps.id ?? 'webhook-ingress'
    this.#ingress = deps.ingress
    this.#limit = deps.limit ?? 100
  }

  async drain(_cursor: Cursor): Promise<EventBatch> {
    const events = await this.#ingress.drain(this.#limit)
    return { events, cursor: null, hasMore: (await this.#ingress.pending()) > 0 }
  }
}
