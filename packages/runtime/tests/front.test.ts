// B-55 Gate — 새 대화가 붙으면 지금 상태를 되찾는다 (C-12 §4).
//
// 가장 중요한 검사: **복원이 아무것도 바꾸지 않는다.** 화면을 여는 것이 상태를 건드리면
// 사람이 확인하는 것조차 조심스러워진다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { Checkpoint, Handoff, Session } from '../core/model/entities.ts'
import type { HealthAlert } from '../core/monitor/health-alerts.ts'
import { renderFront, restoreFront } from '../core/runtime/front.ts'
import type { DecisionSummary } from '../core/view/decision-view.ts'

const NOW = '2026-08-26T21:00:00+09:00'

const session = (over: Record<string, unknown>) =>
  Session.parse({
    id: 'S-20260826-01',
    version: 0,
    status: 'READY',
    role: 'implementer',
    goal: '관찰 조립을 닫는다',
    ...over,
  })

const decision = (over: Partial<DecisionSummary> = {}): DecisionSummary => ({
  requestId: 'REQ-0001',
  reference: 'o/r#19',
  title: '계약 해석 확인',
  priority: 'P1',
  status: 'AWAITING_APPROVAL',
  freshness: 'CURRENT',
  detectedAt: NOW,
  version: 0,
  ...over,
})

const alert: HealthAlert = { kind: 'SOURCE_UNHEALTHY', detail: '401 Unauthorized' }

// L-4 closure — --physical 을 요구하는 명령이 여럿인데 그 값을 되찾을 곳은
// `asc session audit <S-ID>` 뿐이었다. 지금 무엇이 도는지 보는 화면이 같이 말한다.
describe('L-4 — 지금 누가 집고 있는가', () => {
  const bindingsOf = (owners: Record<string, string>) => ({
    async get(sessionId: string) {
      const physical = owners[sessionId]
      return physical ? { physicalSessionId: physical } : null
    },
  })

  it('집은 실행 id가 진행 중 목록에 함께 온다', async () => {
    const store = new MemoryStateStore()
    await store.create('session', session({ status: 'ACTIVE' }))

    const state = await restoreFront({
      store,
      pending: [],
      bindings: bindingsOf({ 'S-20260826-01': 'impl-run-1' }),
    })
    assert.equal(state.active[0]?.physical, 'impl-run-1')
    assert.match(renderFront(state).join('\n'), /held by: impl-run-1/)
  })

  it('아무도 안 집었으면 없는 대로 둔다 — "없음"을 그리지 않는다', async () => {
    const store = new MemoryStateStore()
    await store.create('session', session({ status: 'ACTIVE' }))

    const state = await restoreFront({ store, pending: [], bindings: bindingsOf({}) })
    assert.equal(state.active[0]?.physical, undefined)
    assert.doesNotMatch(renderFront(state).join('\n'), /held by/)
  })

  it('binding을 넘기지 않으면 이 축 자체가 없다 (기존 호출부 회귀)', async () => {
    const store = new MemoryStateStore()
    await store.create('session', session({ status: 'ACTIVE' }))

    const state = await restoreFront({ store, pending: [] })
    assert.equal(state.active.length, 1)
    assert.equal(state.active[0]?.physical, undefined)
  })
})

describe('B-55 Gate — 복원은 읽기다 (C-12 불변식 ⑮)', () => {
  it('복원해도 세션 상태가 바뀌지 않는다', async () => {
    const store = new MemoryStateStore()
    await store.create('session', session({ status: 'ACTIVE' }))
    const before = await store.get('session', 'S-20260826-01')

    await restoreFront({ store, pending: [] })

    const after = await store.get('session', 'S-20260826-01')
    assert.deepEqual(after, before, '읽기가 version을 올리지 않는다')
  })

  it('판단 대기를 소비하지 않는다', async () => {
    const store = new MemoryStateStore()
    const pending = [decision(), decision({ requestId: 'REQ-0002' })]

    const state = await restoreFront({ store, pending })
    assert.equal(state.pendingDecisions.length, 2)
    // 같은 목록을 다시 물어도 그대로다 — 복원이 목록을 비우지 않는다
    assert.equal((await restoreFront({ store, pending })).pendingDecisions.length, 2)
  })
})

describe('B-55 Gate — 지금 걸린 것을 한 화면으로', () => {
  it('돌고 있는 것·집지 않은 것·회수 대기를 나눠 든다', async () => {
    const store = new MemoryStateStore()
    await store.create('session', session({ id: 'S-20260826-01', status: 'ACTIVE' }))
    await store.create('session', session({ id: 'S-20260826-02', status: 'READY', role: 'verifier' }))
    await store.create(
      'session',
      session({
        id: 'S-20260826-03',
        status: 'DONE',
        handoff: Handoff.parse({
          done: [],
          changed: [],
          verified: 'self-check',
          unresolved: [],
          next: '회수 요청',
          recordedAt: NOW,
        }),
      }),
    )

    const state = await restoreFront({ store, pending: [] })
    assert.deepEqual(state.active.map((s) => s.id), ['S-20260826-01'])
    assert.deepEqual(state.unclaimed.map((s) => s.id), ['S-20260826-02'])
    assert.deepEqual(state.awaitingCollect.map((s) => s.id), ['S-20260826-03'])
  })

  it('이어받을 지점이 있으면 그것까지 든다', async () => {
    const store = new MemoryStateStore()
    await store.create(
      'session',
      session({
        status: 'PAUSED',
        checkpoint: Checkpoint.parse({ position: '절반', nextAction: '이어서', recordedAt: NOW }),
      }),
    )

    const state = await restoreFront({ store, pending: [] })
    assert.equal(state.active[0]!.position, '절반')
  })

  it('발급만 되고 아무도 집지 않은 것이 보인다 — 위임이 조용히 증발하지 않는다', async () => {
    const store = new MemoryStateStore()
    await store.create('session', session({ status: 'READY' }))

    const rendered = renderFront(await restoreFront({ store, pending: [] })).join('\n')
    assert.match(rendered, /nobody has picked them up/)
  })
})

describe('B-55 Gate — 믿을 수 없는 목록을 조용히 보여주지 않는다', () => {
  it('감시가 고장 났으면 목록보다 먼저 말한다', async () => {
    const store = new MemoryStateStore()
    const lines = renderFront(await restoreFront({ store, pending: [], health: [alert] }))

    assert.match(lines[0]!, /monitoring state/)
    assert.match(lines.join('\n'), /401 Unauthorized/)
  })

  it('걸린 것이 없어도 경고가 있으면 그렇게 말한다', async () => {
    const store = new MemoryStateStore()
    const rendered = renderFront(await restoreFront({ store, pending: [], health: [alert] })).join('\n')
    assert.match(rendered, /read the monitoring state above first/)
  })

  it('경고가 없으면 조용히 끝난다', async () => {
    const store = new MemoryStateStore()
    const rendered = renderFront(await restoreFront({ store, pending: [] })).join('\n')
    assert.match(rendered, /Nothing is pending/)
  })

  it('어느 workspace에 붙었는지 함께 보인다', async () => {
    const store = new MemoryStateStore()
    const state = await restoreFront({
      store,
      pending: [],
      workspace: { workspaceId: 'W-1', locator: '/home/me/proj' },
    })
    assert.match(renderFront(state)[0]!, /W-1/)
  })
})
