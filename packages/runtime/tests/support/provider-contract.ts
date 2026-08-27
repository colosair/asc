// Provider Swap Contract — 같은 Core 시나리오를 여러 adapter에 물려 돌린다 (C-09 §9.1).
//
// 이 파일이 존재하는 이유: "Core가 provider를 모른다"는 주장은 문서로 확인되지 않는다.
// 같은 검사를 서로 다른 adapter에 물려 **둘 다 통과하고 Core 파일은 그대로**여야 증명된다.
//
// 그래서 시나리오는 provider가 아니라 **Core의 행동**을 본다: 목록을 세고, 달라진 것만
// 올리고, 관련성으로 가르고, 조사 단계를 밟는가. adapter가 무엇이든 답은 같아야 한다.
//
// state-store-contract.ts 와 같은 방식이다 — 계약을 한 번 적고 구현마다 돌린다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../../adapters/memory/state-store.ts'
import { MonitorEngine } from '../../core/monitor/engine.ts'
import { investigate } from '../../core/monitor/investigation.ts'
import type { MonitorConfig } from '../../core/monitor/signals.ts'
import type { ChangeContextPort } from '../../ports/change-context.ts'
import type { EventSource } from '../../ports/event-source.ts'
import type { InventoryPort } from '../../ports/inventory.ts'
import type { ResourceContextPort } from '../../ports/resource-context.ts'

const NOW = '2026-08-26T10:00:00+09:00'

/**
 * adapter 하나가 준비해야 할 것. **fixture 데이터는 provider마다 다르다** — 다른 것은
 * 그것뿐이어야 한다.
 */
export type ProviderFixture = {
  name: string
  /** 이 provider의 참조 문법으로 쓴 대상 하나. */
  reference: string
  /** 목록에 이 하나가 있고, marker는 'r1' 이다. */
  inventory: InventoryPort
  /** 같은 대상의 marker를 'r2' 로 바꾼 목록. */
  changedInventory: InventoryPort
  resource: ResourceContextPort
  change: ChangeContextPort
  /** 알림 하나를 주는 통로. 신호는 config가 매핑한다. */
  events: EventSource
  /** 이 provider의 알림 사유 → Generic Signal. */
  config: MonitorConfig
}

/** 같은 검사를 adapter마다 돌린다. Core 파일은 이 함수 안에서 한 줄도 다르게 불리지 않는다. */
export function describeProviderContract(fixture: ProviderFixture): void {
  describe(`Provider Swap — ${fixture.name}`, () => {
    const engineOn = (inventory: InventoryPort, store = new MemoryStateStore()) => ({
      store,
      engine: new MonitorEngine({
        store,
        source: fixture.events,
        inventory,
        config: fixture.config,
        authorizedApprover: 'controller-a',
        investigation: { resource: fixture.resource, change: fixture.change },
        now: () => NOW,
      }),
    })

    it('빠른 경로가 알림을 신호로 옮긴다', async () => {
      const { store, engine } = engineOn(fixture.inventory)
      const outcome = await engine.scan()
      assert.equal(outcome.detected, 1)
      assert.equal(outcome.logged, 1)
      // 신호가 섰다는 것은 Profile 매핑이 통했다는 뜻이다 — Core는 provider 어휘를 모른다
      const event = (await store.list('event'))[0]!
      assert.equal(event.inboxCandidate, true)
    })

    it('목록을 세고 달라진 것만 올린다', async () => {
      const { engine } = engineOn(fixture.inventory)
      const first = await engine.reconcile()
      assert.equal(first.seen, 1)
      assert.equal(first.changed, 1)
      assert.equal(first.complete, true)

      const second = await engine.reconcile()
      assert.equal(second.changed, 0) // 같은 것은 다시 올리지 않는다
    })

    it('marker가 바뀌면 다시 올린다', async () => {
      const store = new MemoryStateStore()
      await engineOn(fixture.inventory, store).engine.reconcile()
      const { engine } = engineOn(fixture.changedInventory, store)
      assert.equal((await engine.reconcile()).changed, 1)
    })

    it('조사 단계가 이 provider의 통로로 돈다', async () => {
      const result = await investigate(
        { reference: fixture.reference },
        { resource: fixture.resource, change: fixture.change },
      )
      const byId = new Map(result.steps.map((s) => [s.id, s]))
      assert.equal(byId.get('resource')?.kind, 'DONE')
      assert.equal(byId.get('thread')?.kind, 'DONE')
      assert.notEqual(byId.get('change')?.kind, 'UNDECIDABLE')
      // 정본 통로는 주지 않았다 — 그 단계만 판정 불성립이어야 한다
      assert.equal(byId.get('canonical')?.kind, 'UNDECIDABLE')
    })

    it('참조 문법이 달라도 Core는 문자열로만 다룬다', async () => {
      const { store, engine } = engineOn(fixture.inventory)
      await engine.reconcile()
      const event = (await store.list('event'))[0]!
      assert.ok(event.replay?.reference === fixture.reference || event.eventKey.includes(fixture.reference))
    })
  })
}
