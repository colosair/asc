// 0.8.5 — 후보가 **실제로** 만들어지는가 (production 조립으로).
//
// `inbox-discovery.test.ts` 는 판정 하나하나를 고정한다. 이 파일은 그 판정들이 실행 경로에
// 물려 있는지를 본다 — 0.8.4 까지 `replyToMe` 가 정확히 그 자리에서 끊겨 있었기 때문이다.
// 그래서 fixture 관찰 함수를 쓰지 않고 `buildEventObservation`(production builder)을 세운다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FixtureInventory } from '../adapters/memory/mocks.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { buildEventObservation } from '../composition/observe.ts'
import { MonitorEngine } from '../core/monitor/engine.ts'
import { CoverageLedger } from '../core/monitor/coverage.ts'
import type { EventBatch, EventSource } from '../ports/event-source.ts'
import type { InventoryItem } from '../ports/inventory.ts'
import type {
  CommentQuery,
  ContextComment,
  ResourceContextPort,
  ResourceSnapshot,
} from '../ports/resource-context.ts'

const ME = 'colosair'
const EARLY = '2026-09-09T01:00:00.000Z'
const LATE = '2026-09-09T05:00:00.000Z'

/** 알림이 하나도 오지 않는 통로. 실기계의 세 건이 정확히 이 상태였다. */
class SilentSource implements EventSource {
  readonly id = 'silent'
  async drain(): Promise<EventBatch> {
    return { events: [], cursor: null }
  }
}

class ScriptedResource implements ResourceContextPort {
  readonly id = 'scripted-resource'
  comments: ContextComment[]
  author: string
  constructor(author: string, comments: ContextComment[]) {
    this.author = author
    this.comments = comments
  }
  async getResource(reference: string): Promise<ResourceSnapshot> {
    return {
      reference,
      state: 'closed',
      title: 'license 근거 질문',
      author: this.author,
      updatedAt: LATE,
      revisionMarker: 'm2',
      settled: true,
    }
  }
  async getComments(_reference: string, _query?: CommentQuery): Promise<ContextComment[]> {
    // **최신순으로 준다.** 실제 provider 가 그렇게 준다 — 배열 끝을 마지막 발언으로 읽으면
    // 가장 오래된 것을 집는다. 조립이 그것을 바로잡는지 여기서 확인한다.
    return [...this.comments].reverse()
  }
}

const item = (reference: string, marker: string): InventoryItem => ({
  reference,
  state: 'closed',
  updatedAt: LATE,
  revisionMarker: marker,
  title: 'license 근거 질문',
  assignees: ['someone-else'],
})

function engineWith(resource: ResourceContextPort, inventory: FixtureInventory, store = new MemoryStateStore()) {
  return {
    store,
    engine: new MonitorEngine({
      store,
      source: new SilentSource(),
      inventory,
      config: { identities: [ME] },
      authorizedApprover: ME,
      // production builder — fixture 관찰 함수가 아니다.
      observe: buildEventObservation({ resource, identities: [ME] }),
      investigation: { resource },
      now: () => LATE,
    }),
  }
}

describe('A1 — 알림 없는 답이 회수 경로에서 후보가 된다', () => {
  it('내가 묻고 상대가 답한 스레드가 판단 대기함에 오른다', async () => {
    const resource = new ScriptedResource(ME, [
      { id: '1', author: ME, at: EARLY, body: 'license 근거를 알려 주세요' },
      { id: '2', author: 'other', at: LATE, body: '여기 있습니다' },
    ])
    const { store, engine } = engineWith(resource, new FixtureInventory([item('group/project#148', 'm2')]))

    const outcome = await engine.reconcile()
    assert.equal(outcome.packets.length, 1, '0.8.4 까지 이 자리에서 0 이었다')

    const request = (await store.list('request'))[0]!
    assert.equal(request.source.reference, 'group/project#148')
    assert.equal(request.type, 'actionable', 'informational 로 접히지 않는다')
    assert.equal(request.source.direction, 'INBOUND')
    assert.equal(request.source.lastOtherAt, LATE)
  })

  it('두 번 돌아도 후보는 하나다 — 같은 사건이 중복 전달돼도', async () => {
    const resource = new ScriptedResource(ME, [
      { id: '1', author: ME, at: EARLY, body: 'q' },
      { id: '2', author: 'other', at: LATE, body: 'a' },
    ])
    const inventory = new FixtureInventory([item('group/project#148', 'm2')])
    const { store, engine } = engineWith(resource, inventory)
    await engine.reconcile()
    await engine.reconcile()
    assert.equal((await store.list('request')).length, 1)
  })
})

describe('B — 내가 마지막으로 말한 스레드는 후보가 아니고, 대신 기다림으로 남는다', () => {
  it('요청은 만들지 않는다', async () => {
    const resource = new ScriptedResource(ME, [
      { id: '1', author: 'other', at: EARLY, body: 'a' },
      { id: '2', author: ME, at: LATE, body: '그럼 이렇게 갑니다' },
    ])
    const { store, engine } = engineWith(resource, new FixtureInventory([item('group/project#146', 'm2')]))
    const outcome = await engine.reconcile()
    assert.equal(outcome.packets.length, 0, '상대 차례를 내 수신함에 올리지 않는다')
    assert.equal((await store.list('request')).length, 0)
  })

  it('그래도 관측은 남는다 — 등록되지 않은 외부 대기를 찾을 근거다', async () => {
    const resource = new ScriptedResource(ME, [
      { id: '1', author: 'other', at: EARLY, body: 'a' },
      { id: '2', author: ME, at: LATE, body: 'q' },
    ])
    const { store, engine } = engineWith(resource, new FixtureInventory([item('group/project#146', 'm2')]))
    await engine.reconcile()

    const records = await new CoverageLedger(store.scope('monitor:silent')).list()
    const record = records.find((row) => row.reference === 'group/project#146')
    assert.ok(record, '기다림이 어디에도 남지 않으면 그 사람이 잊는 순간 사라진다')
    assert.equal(record.direction, 'OUTBOUND')
    assert.equal(record.lastMineAt, LATE)
  })
})

describe('D — 내가 말한 적 없는 스레드는 조용히 지나간다', () => {
  it('후보가 되지 않는다', async () => {
    const resource = new ScriptedResource('other', [{ id: '1', author: 'other', at: LATE, body: '잡담' }])
    const { store, engine } = engineWith(resource, new FixtureInventory([item('group/project#900', 'm2')]))
    const outcome = await engine.reconcile()
    assert.equal(outcome.packets.length, 0)
    assert.equal((await store.list('request')).length, 0)
  })

  it('방향은 UNKNOWN 으로 남고 내 차례로 바뀌지 않는다', async () => {
    const resource = new ScriptedResource('other', [{ id: '1', author: 'other', at: LATE, body: '잡담' }])
    const { store, engine } = engineWith(resource, new FixtureInventory([item('group/project#900', 'm2')]))
    await engine.reconcile()
    const record = (await new CoverageLedger(store.scope('monitor:silent')).list()).find(
      (row) => row.reference === 'group/project#900',
    )
    assert.equal(record?.direction, 'UNKNOWN')
  })
})

describe('스레드를 읽을 통로가 없으면 예전 그대로 돈다', () => {
  it('관측 없이도 회수 경로가 서고, 없는 방향을 지어내지 않는다', async () => {
    const store = new MemoryStateStore()
    const engine = new MonitorEngine({
      store,
      source: new SilentSource(),
      inventory: new FixtureInventory([item('group/project#148', 'm2')]),
      config: { identities: [ME] },
      authorizedApprover: ME,
      now: () => LATE,
    })
    const outcome = await engine.reconcile()
    assert.equal(outcome.packets.length, 0)
    const record = (await new CoverageLedger(store.scope('monitor:silent')).list())[0]
    assert.equal(record?.direction, undefined, '모르는 것을 UNKNOWN 으로도 적지 않는다')
  })
})

describe('예산 — 무제한 조회를 기본값으로 두지 않는다', () => {
  it('예산을 넘긴 항목은 "본 것" 으로 기록되지 않고 다음 회차에 다시 온다', async () => {
    const resource = new ScriptedResource(ME, [
      { id: '1', author: ME, at: EARLY, body: 'q' },
      { id: '2', author: 'other', at: LATE, body: 'a' },
    ])
    const inventory = new FixtureInventory([
      item('group/project#1', 'm2'),
      item('group/project#2', 'm2'),
      item('group/project#3', 'm2'),
    ])
    const store = new MemoryStateStore()
    const engine = new MonitorEngine({
      store,
      source: new SilentSource(),
      inventory,
      config: { identities: [ME] },
      authorizedApprover: ME,
      observe: buildEventObservation({ resource, identities: [ME], threadBudget: 1 }),
      investigation: { resource },
      now: () => LATE,
    })

    await engine.reconcile()
    const seen = await new CoverageLedger(store.scope('monitor:silent')).list()
    assert.equal(seen.length, 1, '보지 않은 것을 본 것으로 적으면 다음 diff 에서 영영 빠진다')

    // 다음 회차는 같은 자리에서 나머지를 본다.
    const next = new MonitorEngine({
      store,
      source: new SilentSource(),
      inventory,
      config: { identities: [ME] },
      authorizedApprover: ME,
      observe: buildEventObservation({ resource, identities: [ME], threadBudget: 10 }),
      investigation: { resource },
      now: () => LATE,
    })
    await next.reconcile()
    assert.equal((await new CoverageLedger(store.scope('monitor:silent')).list()).length, 3)
  })

  it('미룬 것이 있으면 기록에 남는다 — 전부 본 것처럼 읽히지 않는다', async () => {
    const resource = new ScriptedResource(ME, [{ id: '1', author: ME, at: EARLY, body: 'q' }])
    const store = new MemoryStateStore()
    const engine = new MonitorEngine({
      store,
      source: new SilentSource(),
      inventory: new FixtureInventory([item('group/project#1', 'm2'), item('group/project#2', 'm2')]),
      config: { identities: [ME] },
      authorizedApprover: ME,
      observe: buildEventObservation({ resource, identities: [ME], threadBudget: 1 }),
      investigation: { resource },
      now: () => LATE,
    })
    await engine.reconcile()
    const history = await store.readHistory()
    assert.ok(
      history.some((entry) => entry.kind === 'monitor_deferred'),
      '조용히 미루면 그 회차는 완주한 것처럼 보인다',
    )
  })
})
