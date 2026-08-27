// B-31 Gate — 빠른 경로가 놓친 것을 회수하는지, 그리고 확인하지 못한 것을 확인했다고
// 말하지 않는지.
//
// 두 번째가 더 중요하다. 놓치는 것은 다음 회차가 줍지만, "다 봤다"는 거짓말은 아무도
// 고쳐 주지 않는다.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { FixtureEventSource, FixtureInventory } from '../adapters/memory/mocks.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { CoverageLedger, renderHealth } from '../core/monitor/coverage.ts'
import { MonitorEngine } from '../core/monitor/engine.ts'
import type { MonitorConfig } from '../core/monitor/signals.ts'
import type { InventoryItem } from '../ports/inventory.ts'

const NOW = '2026-08-26T10:00:00+09:00'

const CONFIG: MonitorConfig = {
  identities: ['me'],
  reasonSignals: { assign: 'assigned_to_me', mention: 'mentioned_me' },
}

const item = (over: Partial<InventoryItem> & { reference: string }): InventoryItem => ({
  state: 'open',
  updatedAt: '2026-08-26T09:00:00Z',
  revisionMarker: 'r1',
  assignees: ['me'],
  ...over,
})

function engineOn(store: MemoryStateStore, inventory: FixtureInventory, now = () => NOW) {
  return new MonitorEngine({
    store,
    source: new FixtureEventSource([]),
    inventory,
    config: CONFIG,
    authorizedApprover: 'controller-a',
    // 목록에서 온 것은 assignee가 나이므로 신호가 선다 — 회수가 실제 패킷까지 가는지 본다
    observe: () => ({ signal: {} }),
    now,
  })
}

describe('B-31 Gate — Reconcile (C-07 §1.2)', () => {
  it('빠른 경로가 놓친 것을 목록에서 회수한다', async () => {
    const store = new MemoryStateStore()
    const inventory = new FixtureInventory([item({ reference: 'o/r#19', assignees: ['me'] })])
    // 알림은 아무것도 오지 않았다 — 지정이 빠졌거나 전달이 유실된 상황
    const engine = engineOn(store, inventory)

    const scan = await engine.scan()
    assert.equal(scan.detected, 0)

    const sweep = await engine.reconcile()
    assert.equal(sweep.seen, 1)
    assert.equal(sweep.changed, 1)
    assert.equal(sweep.packets.length, 1)
    assert.equal((await store.list('request')).length, 1)
  })

  it('닫힌 것도 센다 — 닫힌 뒤에 달린 변경이 정확히 놓치는 경우다', async () => {
    const store = new MemoryStateStore()
    const inventory = new FixtureInventory([item({ reference: 'o/r#7', state: 'closed' })])
    const sweep = await engineOn(store, inventory).reconcile()
    assert.equal(sweep.seen, 1)
    assert.equal(sweep.changed, 1)
  })

  it('달라지지 않은 것은 다시 올리지 않는다 — 재조회 멱등', async () => {
    const store = new MemoryStateStore()
    const inventory = new FixtureInventory([item({ reference: 'o/r#19' })])
    const engine = engineOn(store, inventory)

    assert.equal((await engine.reconcile()).packets.length, 1)
    const second = await engine.reconcile()
    assert.equal(second.changed, 0)
    assert.equal(second.packets.length, 0)
    assert.equal((await store.list('request')).length, 1)
  })

  it('marker가 바뀌면 다시 올린다', async () => {
    const store = new MemoryStateStore()
    const inventory = new FixtureInventory([item({ reference: 'o/r#19' })])
    const engine = engineOn(store, inventory)
    await engine.reconcile()

    inventory.items = [item({ reference: 'o/r#19', revisionMarker: 'r2' })]
    assert.equal((await engine.reconcile()).changed, 1)
  })

  it('빠른 경로가 본 것을 회수 경로가 또 올리지 않는다 (C-07 §1.7)', async () => {
    const store = new MemoryStateStore()
    const inventory = new FixtureInventory([item({ reference: 'o/r#19', revisionMarker: 'r9' })])
    const engine = new MonitorEngine({
      store,
      source: new FixtureEventSource([
        [
          {
            eventKey: 'notification:1:2026-08-26T09:00:00Z',
            detectedAt: '2026-08-26T09:00:00Z',
            reference: 'o/r#19',
            raw: { kind: 'notification', reason: 'assign' },
          },
        ],
      ]),
      inventory,
      config: CONFIG,
      authorizedApprover: 'controller-a',
      // 빠른 경로도 같은 marker를 알고 있다
      observe: () => ({ revisionMarker: 'r9' }),
      now: () => NOW,
    })

    assert.equal((await engine.scan()).packets.length, 1)
    const sweep = await engine.reconcile()
    assert.equal(sweep.changed, 0)
    assert.equal((await store.list('request')).length, 1)
  })

  it('늦게 발견했다고 우선순위를 낮추지 않는다 (C-07 §1.6)', async () => {
    const store = new MemoryStateStore()
    const inventory = new FixtureInventory([item({ reference: 'o/r#19', assignees: ['me'] })])
    await engineOn(store, inventory).reconcile()

    // 목록에서 배정을 알아냈다. assigned_to_me 기본 우선순위 그대로 — 회수 경로라고 깎지 않는다.
    const event = (await store.list('event'))[0]!
    assert.equal(event.suggestedPriority, 'P0')
    assert.equal((await store.list('request'))[0]?.priority, 'P0')
  })
})

describe('B-31 Gate — Census (C-07 §1.3·§1.5)', () => {
  it('알던 것이 이번 목록에 없으면 사실만 남긴다 — 삭제로 단정하지 않는다', async () => {
    const store = new MemoryStateStore()
    const inventory = new FixtureInventory([item({ reference: 'o/r#19' }), item({ reference: 'o/r#20' })])
    const engine = engineOn(store, inventory)
    await engine.census()

    inventory.items = [item({ reference: 'o/r#19' })]
    const second = await engine.census()
    assert.deepEqual(second.missing, ['o/r#20'])

    const history = await store.readHistory()
    const anomaly = history.find((h) => h.kind === 'coverage_anomaly')
    assert.match(anomaly?.detail ?? '', /RESOURCE_MISSING/)
    assert.match(anomaly?.detail ?? '', /무엇인지는 모른다/)
    assert.doesNotMatch(anomaly?.detail ?? '', /삭제됐다|DELETED/)
  })

  it('목록을 다 보지 못하면 상실을 판정하지 않는다', async () => {
    const store = new MemoryStateStore()
    const inventory = new FixtureInventory([item({ reference: 'o/r#19' }), item({ reference: 'o/r#20' })])
    const engine = engineOn(store, inventory)
    await engine.census()

    inventory.items = [item({ reference: 'o/r#19' })]
    inventory.incomplete = true
    const second = await engine.census()
    assert.deepEqual(second.missing, []) // 없는 상실을 만들어내지 않는다
    assert.equal(second.complete, false)
  })

  it('reconcile은 상실을 판정하지 않는다 — 기준선 이후만 보기 때문이다', async () => {
    const store = new MemoryStateStore()
    const inventory = new FixtureInventory([item({ reference: 'o/r#19' }), item({ reference: 'o/r#20' })])
    const engine = engineOn(store, inventory)
    await engine.census()

    inventory.items = [item({ reference: 'o/r#19' })]
    assert.deepEqual((await engine.reconcile()).missing, [])
  })

  it('페이지를 끝까지 돈다', async () => {
    const store = new MemoryStateStore()
    const many = Array.from({ length: 5 }, (_, i) => item({ reference: `o/r#${i}` }))
    const inventory = new FixtureInventory(many, { pageSize: 2 })
    const sweep = await engineOn(store, inventory).census()
    assert.equal(sweep.seen, 5)
    assert.equal(sweep.complete, true)
  })
})

describe('B-31 Gate — Completeness (C-07 §8)', () => {
  it('조회가 실패하면 확인했다고 말하지 않는다', async () => {
    const store = new MemoryStateStore()
    const inventory = new FixtureInventory([item({ reference: 'o/r#19' })])
    inventory.failWith = '연결할 수 없다'

    const engine = engineOn(store, inventory)
    const sweep = await engine.census()
    assert.equal(sweep.complete, false)
    assert.match(sweep.detail ?? '', /연결할 수 없다/)

    const health = await engine.health()
    assert.equal(health.sourceHealthy, false)
    assert.equal(health.paginationComplete, false)
    assert.equal(health.coverageWatermark, undefined) // 실패한 회차로 기준선을 옮기지 않는다
  })

  it('완주한 회차만 기준선을 옮긴다', async () => {
    const store = new MemoryStateStore()
    const inventory = new FixtureInventory([item({ reference: 'o/r#19' })])
    const engine = engineOn(store, inventory)
    await engine.reconcile()

    const health = await engine.health()
    // 기준선은 우리 시계가 아니라 provider가 말한 시각이다
    assert.equal(health.coverageWatermark, '2026-08-26T09:00:00Z')
    assert.equal(health.lastReconcileAt, NOW)
    assert.equal(health.lastCensusAt, undefined)
  })

  it('상태 표시는 100% 보장을 말하지 않는다', async () => {
    const store = new MemoryStateStore()
    const ledger = new CoverageLedger(store.scope('monitor:fixture'), () => NOW)
    const text = renderHealth('fixture', await ledger.health()).join('\n')
    assert.doesNotMatch(text, /100%|보장/)
    assert.match(text, /목록 완주/)
    assert.match(text, /이 상태로는 상실을 판정하지 않는다/)
  })

  it('목록을 셀 통로가 없으면 회수가 성립하지 않는다고 말한다', async () => {
    const store = new MemoryStateStore()
    const engine = new MonitorEngine({
      store,
      source: new FixtureEventSource([]),
      config: CONFIG,
      authorizedApprover: 'controller-a',
      now: () => NOW,
    })
    const sweep = await engine.reconcile()
    assert.equal(sweep.complete, false)
    assert.match(sweep.detail ?? '', /목록을 셀 통로가 없다/)
  })
})

describe('Core 독립성 — coverage', () => {
  it('provider 어휘가 새지 않는다', async () => {
    const source = await readFile(new URL('../core/monitor/coverage.ts', import.meta.url), 'utf8')
    for (const word of ['github', 'gitlab', 'jira', 'mattermost']) {
      assert.doesNotMatch(source.toLowerCase(), new RegExp(word))
    }
  })
})
