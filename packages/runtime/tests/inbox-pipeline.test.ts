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
import type { ChangeContextPort } from '../ports/change-context.ts'
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
  /** 단건 조회를 몇 번 했는가. 열거가 이미 말해 준 것을 다시 묻지 않는지 여기서 본다. */
  resourceReads = 0
  /** 실제로 스레드를 연 항목들. "봤다" 의 유일한 증거다 — coverage 크기는 그 대리가 못 된다. */
  opened: string[] = []
  constructor(author: string, comments: ContextComment[]) {
    this.author = author
    this.comments = comments
  }
  async getResource(reference: string): Promise<ResourceSnapshot> {
    this.resourceReads += 1
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
  async getComments(reference: string, _query?: CommentQuery): Promise<ContextComment[]> {
    this.opened.push(reference)
    // **최신순으로 준다.** 실제 provider 가 그렇게 준다 — 배열 끝을 마지막 발언으로 읽으면
    // 가장 오래된 것을 집는다. 조립이 그것을 바로잡는지 여기서 확인한다.
    return [...this.comments].reverse()
  }
}

const item = (reference: string, marker: string, author = ME): InventoryItem => ({
  reference,
  state: 'closed',
  updatedAt: LATE,
  revisionMarker: marker,
  title: 'license 근거 질문',
  author,
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
    const { store, engine } = engineWith(resource, new FixtureInventory([item('group/project#900', 'm2', 'other')]))
    const outcome = await engine.reconcile()
    assert.equal(outcome.packets.length, 0)
    assert.equal((await store.list('request')).length, 0)
  })

  it('방향은 UNKNOWN 으로 남고 내 차례로 바뀌지 않는다', async () => {
    const resource = new ScriptedResource('other', [{ id: '1', author: 'other', at: LATE, body: '잡담' }])
    const { store, engine } = engineWith(resource, new FixtureInventory([item('group/project#900', 'm2', 'other')]))
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
  it('예산을 넘긴 항목은 다음 회차가 **실제로 연다**', async () => {
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
    const build = (budget: number) =>
      new MonitorEngine({
        store,
        source: new SilentSource(),
        inventory,
        config: { identities: [ME] },
        authorizedApprover: ME,
        observe: buildEventObservation({ resource, identities: [ME], threadBudget: budget }),
        investigation: { resource },
        now: () => LATE,
      })

    await build(1).reconcile()
    // 서로 다른 항목 수로 센다 — 후보가 된 건은 조사 경로가 같은 스레드를 한 번 더 연다.
    assert.deepEqual([...new Set(resource.opened)], ['group/project#1'], '예산이 하나면 한 항목만 연다')

    // **coverage 크기로 재지 않는다.** 미룬 항목의 마커가 결국 기록되는 것과 그 항목을
    // 실제로 열어 본 것은 다른 사실이고, 예전 시험은 앞엣것을 재면서 뒤엣것을 확인했다고
    // 여겼다 — 그 사이에 결함이 살아 있었다.
    await build(10).reconcile()
    assert.deepEqual(
      [...new Set(resource.opened)].sort(),
      ['group/project#1', 'group/project#2', 'group/project#3'],
      '미룬 것을 다음 회차가 열지 않으면 그 항목은 영영 후보가 되지 않는다',
    )
    assert.equal((await new CoverageLedger(store.scope('monitor:silent')).list()).length, 3)
  })

  it('change 통로가 함께 붙어 있어도 미룬 항목의 마커를 태우지 않는다', async () => {
    // 실제 GitLab MR 채널이 이 조립이다 — resource 와 change 를 둘 다 준다. 예전에는
    // 예산을 넘긴 뒤에도 change 조회가 계속돼 revisionMarker 가 돌아왔고, 그 값 하나로
    // 관측이 그 항목을 '본 것' 으로 기록했다.
    const resource = new ScriptedResource(ME, [
      { id: '1', author: ME, at: EARLY, body: 'q' },
      { id: '2', author: 'other', at: LATE, body: 'a' },
    ])
    const change: ChangeContextPort = {
      id: 'scripted-change',
      async getChange(reference: string) {
        return { reference, missing: false, changedPaths: ['src/a.ts'], truncated: false, revisionMarker: 'chg-1' }
      },
    }
    const inventory = new FixtureInventory([item('group/project#1', 'm2'), item('group/project#2', 'm2')])
    const store = new MemoryStateStore()
    const engine = new MonitorEngine({
      store,
      source: new SilentSource(),
      inventory,
      config: { identities: [ME] },
      authorizedApprover: ME,
      observe: buildEventObservation({ resource, change, identities: [ME], threadBudget: 1 }),
      investigation: { resource },
      now: () => LATE,
    })

    const outcome = await engine.reconcile()
    assert.equal(outcome.deferred, 1, '미룬 건수가 회차 결과에 실리지 않으면 화면이 그것을 말할 수 없다')
    assert.equal(
      (await new CoverageLedger(store.scope('monitor:silent')).list()).length,
      1,
      '열어 보지도 않은 항목의 마커를 change 조회가 대신 태웠다',
    )
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

// ── 비용 — 열거가 이미 말한 것을 다시 묻지 않는다 (0.8.5) ─────────────────────
//
// 실측이 이 절을 쓰게 했다. 예산 200 으로 실제 저장소(항목 685개)의 첫 회차를 재니
// API 호출이 16 에서 422 로, 71초가 364초가 됐다. 늘어난 것의 절반은 스레드 조회였고
// 나머지 절반은 **누가 열었는지 알아내려는 단건 조회**였다 — 목록 응답이 그 값을 이미
// 싣고 오는데도.
describe('비용 — 목록이 준 사실을 단건 조회로 다시 묻지 않는다', () => {
  it('회수 경로는 스레드만 읽는다', async () => {
    // 후보가 되지 않는 항목으로 잰다. 후보가 되면 그 뒤의 조사 경로가 원본을 읽는데,
    // 그것은 9건에만 드는 비용이고 여기서 재려는 것은 **전 항목에 드는** 비용이다.
    const resource = new ScriptedResource(ME, [
      { id: '1', author: 'other', at: EARLY, body: 'a' },
      { id: '2', author: ME, at: LATE, body: '그럼 이렇게 갑니다' },
    ])
    const { engine } = engineWith(resource, new FixtureInventory([item('group/project#146', 'm2')]))
    await engine.reconcile()
    assert.equal(resource.resourceReads, 0, '항목마다 단건 조회를 한 번 더 하면 회차 비용이 두 배가 된다')
  })

  it('그래도 판정은 같다 — 목록이 준 author 로 방향이 선다', async () => {
    const resource = new ScriptedResource(ME, [
      { id: '1', author: ME, at: EARLY, body: 'q' },
      { id: '2', author: 'other', at: LATE, body: 'a' },
    ])
    const { store, engine } = engineWith(resource, new FixtureInventory([item('group/project#148', 'm2')]))
    await engine.reconcile()
    assert.equal((await store.list('request'))[0]?.source.direction, 'INBOUND')
  })

  it('내가 열었거나 내게 배정된 것을 먼저 본다', async () => {
    // 예산이 하나뿐일 때 무엇이 그 하나를 쓰는가. 남의 것이 앞줄에 있어도 내 것이 먼저다.
    const resource = new ScriptedResource(ME, [
      { id: '1', author: ME, at: EARLY, body: 'q' },
      { id: '2', author: 'other', at: LATE, body: 'a' },
    ])
    const inventory = new FixtureInventory([
      item('group/project#900', 'm2', 'someone-else'),
      item('group/project#901', 'm2', 'someone-else'),
      item('group/project#148', 'm2', ME),
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
    assert.equal(
      (await store.list('request'))[0]?.source.reference,
      'group/project#148',
      '남의 것이 예산을 먼저 쓰면 내게 온 답은 다음 회차로 밀린다',
    )
  })

  it('거르지는 않는다 — 남의 것도 예산이 남으면 같은 회차에 본다', async () => {
    const resource = new ScriptedResource(ME, [
      { id: '1', author: ME, at: EARLY, body: 'q' },
      { id: '2', author: 'other', at: LATE, body: 'a' },
    ])
    const inventory = new FixtureInventory([
      item('group/project#900', 'm2', 'someone-else'),
      item('group/project#148', 'm2', ME),
    ])
    const { store, engine } = engineWith(resource, inventory)
    await engine.reconcile()
    const seen = await new CoverageLedger(store.scope('monitor:silent')).list()
    assert.equal(seen.length, 2, '내 것만 보는 것은 다른 종류의 누락이다')
  })
})

// ── 미룬 것이 실제로 돌아오는가 (0.8.5) ──────────────────────────────────────
//
// 실기계에서 이 주장이 거짓이었다. 첫 회차가 98건 중 40건을 보고 58건을 미뤘는데, 두 번째
// 회차의 목록은 **1건**이었다. 미룬 58건은 돌아오지 않았다.
//
// 원인은 미룬 항목을 coverage 에 적지 않는 것만으로는 모자랐다는 데 있다. 다음 회차의
// 열거는 기준선(watermark) 이후만 훑는데, 그 기준선이 이번 목록의 가장 나중 시각으로
// 옮겨가 미룬 항목을 지나쳐 버렸다. 적지 않은 것이 아무 소용이 없었다.
//
// 위의 예산 시험이 이것을 못 잡은 이유는 fixture 가 매번 같은 목록을 통째로 주기
// 때문이다 — 여기서는 provider 처럼 기준선을 존중하는 목록을 쓴다.
describe('예산 — 미룬 것은 다음 회차 목록에 남아 있어야 한다', () => {
  it('기준선이 못 본 것을 넘어가지 않는다', async () => {
    const resource = new ScriptedResource(ME, [
      { id: '1', author: ME, at: EARLY, body: 'q' },
      { id: '2', author: 'other', at: LATE, body: 'a' },
    ])
    // 갱신 시각이 서로 다른 셋. 예산은 하나뿐이다.
    const inventory = new FixtureInventory([
      { ...item('group/project#1', 'm1'), updatedAt: '2026-09-09T01:00:00.000Z' },
      { ...item('group/project#2', 'm1'), updatedAt: '2026-09-09T02:00:00.000Z' },
      { ...item('group/project#3', 'm1'), updatedAt: '2026-09-09T03:00:00.000Z' },
    ])
    const store = new MemoryStateStore()
    const build = (budget: number) =>
      new MonitorEngine({
        store,
        source: new SilentSource(),
        inventory,
        config: { identities: [ME] },
        authorizedApprover: ME,
        observe: buildEventObservation({ resource, identities: [ME], threadBudget: budget }),
        investigation: { resource },
        now: () => LATE,
      })

    await build(1).reconcile()
    const health = await build(1).health()
    assert.ok(
      (health.coverageWatermark ?? '') <= '2026-09-09T02:00:00.000Z',
      `기준선이 못 본 것을 지나쳤다 (${health.coverageWatermark}) — 그 항목은 다음 목록에 나오지 않는다`,
    )

    // 예산을 풀면 남은 둘이 같은 자리에서 나온다.
    const second = await build(10).reconcile()
    assert.ok(second.seen >= 2, `다음 회차 목록이 ${second.seen}건뿐이다 — 미룬 것이 사라졌다`)
    assert.equal((await new CoverageLedger(store.scope('monitor:silent')).list()).length, 3)
  })

  it('미룬 것이 없으면 기준선은 그대로 앞으로 간다', async () => {
    const resource = new ScriptedResource(ME, [{ id: '1', author: ME, at: EARLY, body: 'q' }])
    const inventory = new FixtureInventory([
      { ...item('group/project#1', 'm1'), updatedAt: '2026-09-09T01:00:00.000Z' },
      { ...item('group/project#2', 'm1'), updatedAt: '2026-09-09T03:00:00.000Z' },
    ])
    const store = new MemoryStateStore()
    const engine = new MonitorEngine({
      store,
      source: new SilentSource(),
      inventory,
      config: { identities: [ME] },
      authorizedApprover: ME,
      observe: buildEventObservation({ resource, identities: [ME], threadBudget: 10 }),
      investigation: { resource },
      now: () => LATE,
    })
    await engine.reconcile()
    const health = await engine.health()
    assert.equal(
      health.coverageWatermark,
      '2026-09-09T03:00:00.000Z',
      '다 봤는데도 기준선을 붙들면 같은 목록을 영원히 다시 읽는다',
    )
  })
})
