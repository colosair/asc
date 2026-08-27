// B-52 Gate — Webhook은 Delta의 구현이지 새 개념이 아니다 (C-07 §1.1 · C-12 §2).
//
// 지키는 문장:
//   서명 검증은 생략할 수 없고, 튕긴 것도 기록에 남는다
//   Engine은 push인지 pull인지 모른다 — 같은 Phase A를 지난다
//   같은 변경을 회수 경로가 다시 봐도 중복 Packet 0

import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { describe, it } from 'node:test'

import { FixtureInventory } from '../adapters/memory/mocks.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { IngressEventSource, WebhookIngress, verifySignature } from '../adapters/webhook/ingress.ts'
import { MonitorEngine } from '../core/monitor/engine.ts'
import type { MonitorConfig } from '../core/monitor/signals.ts'
import type { RawEvent } from '../ports/event-source.ts'

const SECRET = 'shhh'
const NOW = '2026-08-26T21:00:00+09:00'

const CONFIG: MonitorConfig = {
  identities: ['colosair'],
  reasonSignals: { mention: 'mentioned_me' },
  priorityLabels: { urgent: 'P0' },
  escalationLabels: ['blocker'],
}

const sign = (payload: string) => `sha256=${createHmac('sha256', SECRET).update(payload).digest('hex')}`

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'notification',
    reason: 'mention',
    number: 19,
    body: '@colosair 확인 부탁드립니다',
    updatedAt: '2026-08-26T11:00:00Z',
    ...over,
  })

/** provider payload → RawEvent. adapter의 몫이며 Core는 이 형태를 모른다. */
const toEvent = (parsed: unknown): RawEvent | null => {
  const payload = parsed as { number?: number; updatedAt?: string; reason?: string; body?: string }
  if (!payload.number || !payload.updatedAt) return null
  return {
    eventKey: `webhook:${payload.number}:${payload.updatedAt}`,
    detectedAt: payload.updatedAt,
    reference: `o/r#${payload.number}`,
    raw: { kind: 'notification', reason: payload.reason, body: payload.body },
  }
}

const ingressOn = (store: MemoryStateStore) => new WebhookIngress(store.scope('webhook'), SECRET, () => NOW)

describe('B-52 Gate — 서명 검증은 생략할 수 없다 (C-12 불변식 ⑧)', () => {
  it('서명이 없으면 받지 않는다', async () => {
    const store = new MemoryStateStore()
    const ingress = ingressOn(store)

    const outcome = await ingress.accept(body(), undefined, toEvent)
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.reason, 'NO_SIGNATURE')
    assert.equal(await ingress.pending(), 0)
  })

  it('서명이 틀리면 받지 않는다', async () => {
    const store = new MemoryStateStore()
    const ingress = ingressOn(store)

    const outcome = await ingress.accept(body(), 'sha256=deadbeef', toEvent)
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.reason, 'BAD_SIGNATURE')
  })

  it('본문이 한 글자만 바뀌어도 서명이 깨진다', () => {
    const payload = body()
    assert.equal(verifySignature(payload, sign(payload), SECRET).ok, true)
    assert.equal(verifySignature(`${payload} `, sign(payload), SECRET).ok, false)
  })

  it('튕긴 것도 기록에 남는다 — 안 오는 것과 다 튕기는 것은 다르다', async () => {
    const store = new MemoryStateStore()
    const ingress = ingressOn(store)

    await ingress.accept(body(), 'sha256=deadbeef', toEvent)
    await ingress.accept(body(), undefined, toEvent)
    assert.deepEqual(await ingress.rejected(), { BAD_SIGNATURE: 1, NO_SIGNATURE: 1 })
  })

  it('읽을 수 없는 사건은 지어내지 않는다', async () => {
    const store = new MemoryStateStore()
    const ingress = ingressOn(store)
    const payload = JSON.stringify({ 알수없는: '형태' })

    const outcome = await ingress.accept(payload, sign(payload), toEvent)
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.reason, 'UNREADABLE')
    assert.equal(await ingress.pending(), 0)
  })
})

describe('B-52 Gate — 버퍼는 도착 순서를 지킨다', () => {
  it('쌓은 순서대로 꺼내고 꺼낸 것은 남기지 않는다', async () => {
    const store = new MemoryStateStore()
    const ingress = ingressOn(store)

    for (const number of [1, 2, 3]) {
      const payload = body({ number, updatedAt: `2026-08-26T11:0${number}:00Z` })
      await ingress.accept(payload, sign(payload), toEvent)
    }
    assert.equal(await ingress.pending(), 3)

    const drained = await ingress.drain()
    assert.deepEqual(
      drained.map((e) => e.reference),
      ['o/r#1', 'o/r#2', 'o/r#3'],
    )
    assert.equal(await ingress.pending(), 0)
  })

  it('한 번에 다 꺼내지 않아도 남은 것이 있다고 말한다', async () => {
    const store = new MemoryStateStore()
    const ingress = ingressOn(store)
    for (const number of [1, 2, 3]) {
      const payload = body({ number, updatedAt: `2026-08-26T11:0${number}:00Z` })
      await ingress.accept(payload, sign(payload), toEvent)
    }

    const source = new IngressEventSource({ ingress, limit: 2 })
    const batch = await source.drain(null)
    assert.equal(batch.events.length, 2)
    assert.equal(batch.hasMore, true)
  })
})

describe('B-52 Gate — Engine은 push인지 pull인지 모른다', () => {
  function engineOn(store: MemoryStateStore, ingress: WebhookIngress, inventory?: FixtureInventory) {
    return new MonitorEngine({
      store,
      source: new IngressEventSource({ ingress }),
      config: CONFIG,
      authorizedApprover: 'controller-a',
      ...(inventory ? { inventory } : {}),
      now: () => NOW,
    })
  }

  it('webhook 사건이 그대로 Phase A를 지나 보고서가 된다', async () => {
    const store = new MemoryStateStore()
    const ingress = ingressOn(store)
    const payload = body()
    await ingress.accept(payload, sign(payload), toEvent)

    const outcome = await engineOn(store, ingress).scan()
    assert.equal(outcome.detected, 1)
    assert.equal(outcome.logged, 1)
    assert.equal(outcome.packets.length, 1, 'MonitorEngine은 한 줄도 바뀌지 않았다')
  })

  it('같은 변경이 두 번 밀려와도 사건은 하나다', async () => {
    const store = new MemoryStateStore()
    const ingress = ingressOn(store)
    const payload = body()
    await ingress.accept(payload, sign(payload), toEvent)
    await ingress.accept(payload, sign(payload), toEvent)

    const outcome = await engineOn(store, ingress).scan()
    assert.equal(outcome.detected, 2, '두 번 받은 것은 사실이다')
    assert.equal(outcome.duplicates, 1, '같은 eventKey는 한 번만 기록된다')
    assert.equal((await store.list('event')).length, 1)
  })

  it('빠른 경로가 본 것을 회수 경로가 다시 봐도 보고서는 하나다', async () => {
    const store = new MemoryStateStore()
    const ingress = ingressOn(store)
    const payload = body()
    await ingress.accept(payload, sign(payload), toEvent)

    // 같은 reference·같은 marker를 회수 경로가 다시 열거한다
    const inventory = new FixtureInventory([
      { reference: 'o/r#19', state: 'open', revisionMarker: '2026-08-26T11:00:00Z', updatedAt: '2026-08-26T11:00:00Z' },
    ])
    const engine = engineOn(store, ingress, inventory)

    const scan = await engine.scan()
    assert.equal(scan.packets.length, 1)

    const sweep = await engine.reconcile()
    assert.equal(sweep.packets.length, 0, '중복 Decision Packet 0')
  })
})
