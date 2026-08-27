// B-51 Gate — 실행 계기를 갖는 자리 (C-12 §1).
//
// 지키는 문장:
//   같은 함수를 사람이 부르든 Runtime이 부르든 결과가 같다 (여기는 계기만 갖는다)
//   회차 하나가 터져도 루프는 계속하되 실패를 삼키지 않는다
//   재기동해도 간격 기록에서 이어진다

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { Orchestrator, renderTick, type TickKind } from '../core/runtime/orchestrator.ts'

const MINUTE = 60_000
const START = new Date('2026-08-26T09:00:00Z')

const schedule = { deltaMs: 5 * MINUTE, reconcileMs: 60 * MINUTE, censusMs: 24 * 60 * MINUTE, digestMs: 60 * MINUTE }

/** 저장 기반 간격 기록. 실제 CLI가 쓰는 것과 같은 모양(ScopedStore 한 키)이다. */
function ledgerOn(store: MemoryStateStore) {
  const scope = store.scope('runtime')
  return {
    read: async () => {
      const raw = await scope.get('last-run')
      return raw ? (JSON.parse(raw) as Partial<Record<TickKind, string>>) : {}
    },
    write: async (kind: TickKind, at: string) => {
      const raw = await scope.get('last-run')
      const current = raw ? (JSON.parse(raw) as Record<string, string>) : {}
      await scope.set('last-run', JSON.stringify({ ...current, [kind]: at }))
    },
  }
}

const clockFrom = (start: Date) => {
  let at = start.getTime()
  return {
    now: () => new Date(at).toISOString(),
    advance: (ms: number) => {
      at += ms
    },
  }
}

describe('B-51 Gate — 계기만 갖는다 (C-12 §1)', () => {
  it('첫 회차는 전부 돈다 — 기록이 없으면 처음이다', async () => {
    const store = new MemoryStateStore()
    const ran: TickKind[] = []
    const clock = clockFrom(START)
    const orchestrator = new Orchestrator({
      schedule,
      lastRunAt: ledgerOn(store),
      now: clock.now,
      actions: {
        delta: async () => void ran.push('delta'),
        reconcile: async () => void ran.push('reconcile'),
        census: async () => void ran.push('census'),
        digest: async () => void ran.push('digest'),
      },
    })

    const outcome = await orchestrator.tick()
    assert.deepEqual(ran, ['delta', 'reconcile', 'census', 'digest'])
    assert.deepEqual(outcome.skipped, [])
  })

  it('간격이 안 찼으면 건너뛰고, 건너뛴 것도 남긴다', async () => {
    const store = new MemoryStateStore()
    const ran: TickKind[] = []
    const clock = clockFrom(START)
    const orchestrator = new Orchestrator({
      schedule,
      lastRunAt: ledgerOn(store),
      now: clock.now,
      actions: {
        delta: async () => void ran.push('delta'),
        reconcile: async () => void ran.push('reconcile'),
      },
    })

    await orchestrator.tick()
    clock.advance(6 * MINUTE)
    const second = await orchestrator.tick()

    assert.deepEqual(ran, ['delta', 'reconcile', 'delta'], 'delta만 다시 돈다')
    assert.deepEqual(second.ran, ['delta'])
    assert.deepEqual(second.skipped, ['reconcile'], '"돌았는데 없었다"와 "안 돌았다"는 다르다')
  })

  it('없는 갈래는 아예 돌리지 않는다 — 없는 것을 있는 척하지 않는다', async () => {
    const store = new MemoryStateStore()
    const orchestrator = new Orchestrator({
      schedule,
      lastRunAt: ledgerOn(store),
      now: clockFrom(START).now,
      actions: { delta: async () => {} },
    })

    const outcome = await orchestrator.tick()
    assert.deepEqual(outcome.ran, ['delta'])
    assert.deepEqual(outcome.skipped, [])
  })
})

describe('B-51 Gate — 실패를 삼키지 않는다', () => {
  it('한 갈래가 터져도 나머지는 돈다', async () => {
    const store = new MemoryStateStore()
    const ran: TickKind[] = []
    const orchestrator = new Orchestrator({
      schedule,
      lastRunAt: ledgerOn(store),
      now: clockFrom(START).now,
      actions: {
        delta: async () => {
          throw new Error('외부가 죽었다')
        },
        reconcile: async () => void ran.push('reconcile'),
      },
    })

    const outcome = await orchestrator.tick()
    assert.deepEqual(ran, ['reconcile'])
    assert.deepEqual(outcome.failures, [{ kind: 'delta', detail: '외부가 죽었다' }])
    assert.match(renderTick(outcome), /실패 delta/)
  })

  it('실패한 회차를 "했다"로 적지 않는다 — 다음 회차가 다시 시도한다', async () => {
    const store = new MemoryStateStore()
    let attempts = 0
    const clock = clockFrom(START)
    const orchestrator = new Orchestrator({
      schedule,
      lastRunAt: ledgerOn(store),
      now: clock.now,
      actions: {
        delta: async () => {
          attempts += 1
          if (attempts === 1) throw new Error('한 번 실패')
        },
      },
    })

    await orchestrator.tick()
    // 간격을 채우지 않았지만 실패는 기록되지 않았으므로 다시 돈다
    const second = await orchestrator.tick()
    assert.equal(attempts, 2)
    assert.deepEqual(second.ran, ['delta'])
  })
})

describe('B-51 Gate — 재기동해도 이어진다 (C-12 §1.1)', () => {
  it('간격 기록이 저장소에 남아 새 인스턴스가 이어받는다', async () => {
    const store = new MemoryStateStore()
    const clock = clockFrom(START)
    const make = (ran: TickKind[]) =>
      new Orchestrator({
        schedule,
        lastRunAt: ledgerOn(store),
        now: clock.now,
        actions: { delta: async () => void ran.push('delta') },
      })

    const first: TickKind[] = []
    await make(first).tick()
    assert.deepEqual(first, ['delta'])

    // 프로세스가 죽고 새로 떴다 — 간격은 저장소가 기억한다
    const second: TickKind[] = []
    clock.advance(MINUTE)
    const outcome = await make(second).tick()
    assert.deepEqual(second, [], '재기동이 간격을 초기화하지 않는다')
    assert.deepEqual(outcome.skipped, ['delta'])

    clock.advance(5 * MINUTE)
    const third: TickKind[] = []
    await make(third).tick()
    assert.deepEqual(third, ['delta'])
  })

  it('기록이 깨졌으면 멈추지 않고 돈다 — 멈춰 있는 쪽이 더 나쁘다', async () => {
    const store = new MemoryStateStore()
    await store.scope('runtime').set('last-run', JSON.stringify({ delta: '이건 시각이 아니다' }))
    const ran: TickKind[] = []
    const orchestrator = new Orchestrator({
      schedule,
      lastRunAt: ledgerOn(store),
      now: clockFrom(START).now,
      actions: { delta: async () => void ran.push('delta') },
    })

    await orchestrator.tick()
    assert.deepEqual(ran, ['delta'])
  })
})

describe('B-51 Gate — 루프', () => {
  it('멈추라고 하면 멈춘다', async () => {
    const store = new MemoryStateStore()
    let ticks = 0
    const clock = clockFrom(START)
    const orchestrator = new Orchestrator({
      schedule: { deltaMs: 0, reconcileMs: 0, censusMs: 0, digestMs: 0 },
      lastRunAt: ledgerOn(store),
      now: clock.now,
      actions: {
        delta: async () => {
          ticks += 1
          if (ticks === 3) orchestrator.stop()
        },
      },
    })

    await orchestrator.run(1, async () => {
      clock.advance(MINUTE)
    })
    assert.equal(ticks, 3, '멈춘 뒤 한 회차 더 돌지 않는다')
  })
})
