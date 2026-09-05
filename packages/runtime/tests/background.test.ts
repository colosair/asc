// C-12 §0·§1.1 — 상시성은 대화를 켜 두는 것으로 얻지 않는다.
//
// 지키는 문장 셋:
//   루프는 하나만 돈다. 늦게 온 쪽은 조용히 물러난다 (불변식 ⑥)
//   죽은 프로세스가 남긴 lease는 시간이 지나면 회수된다 (§1.1 recovery)
//   "안 돌고 있다"와 "돌았는데 변화가 없다"를 합치지 않는다 (불변식 ⑫)

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  LAST_RUN_KEY,
  MIN_STALE_MS,
  RUNTIME_LEASE_KEY,
  RuntimeLease,
  readBackground,
  renderBackground,
  staleAfter,
} from '../core/runtime/background.ts'
import type { ScopedStore } from '../ports/state-store.ts'

/** 파일 없는 ScopedStore. setIfAbsent 의 원자성만 흉내내면 이 계약은 전부 검증된다. */
function memoryScope(): ScopedStore & { dump: () => Record<string, string> } {
  const data = new Map<string, string>()
  return {
    async get(key) {
      return data.get(key) ?? null
    },
    async set(key, value) {
      data.set(key, value)
    },
    async delete(key) {
      data.delete(key)
    },
    async keys(prefix) {
      return [...data.keys()].filter((key) => (prefix ? key.startsWith(prefix) : true))
    },
    async setIfAbsent(key, value) {
      if (data.has(key)) return false
      data.set(key, value)
      return true
    },
    dump: () => Object.fromEntries(data),
  }
}

const clock = (start: string) => {
  let at = new Date(start).getTime()
  return {
    now: () => new Date(at).toISOString(),
    advance: (ms: number) => {
      at += ms
    },
  }
}

const T0 = '2026-09-05T00:00:00.000Z'

describe('RuntimeLease — 루프 하나만 돈다 (C-12 불변식 ⑥)', () => {
  it('먼저 잡은 쪽이 이기고, 늦게 온 쪽은 실패로 물러난다', async () => {
    const scope = memoryScope()
    const first = new RuntimeLease({ scope, owner: 'first', pid: 11 })
    const second = new RuntimeLease({ scope, owner: 'second', pid: 22 })

    assert.equal(await first.acquire(), true)
    assert.equal(await second.acquire(), false, '두 번째는 조용히 물러난다')

    const state = await second.read()
    // 누가 잡고 있는지 사람이 볼 수 있어야 한다 — 죽일 대상을 알아야 하기 때문이다
    assert.equal(state.kind, 'HELD')
    assert.equal(state.kind === 'HELD' && state.record.pid, 11)
  })

  it('놓으면 다음 프로세스가 잡는다', async () => {
    const scope = memoryScope()
    const first = new RuntimeLease({ scope, owner: 'first' })
    await first.acquire()
    await first.release()
    assert.equal(await new RuntimeLease({ scope, owner: 'second' }).acquire(), true)
  })

  it('남의 lease는 놓지 않는다', async () => {
    const scope = memoryScope()
    await new RuntimeLease({ scope, owner: 'holder' }).acquire()
    await new RuntimeLease({ scope, owner: 'stranger' }).release()
    assert.ok(scope.dump()[RUNTIME_LEASE_KEY], '남의 것을 치우지 않았다')
  })

  it('오래 조용한 lease는 회수된다 — 한 번 죽었다고 영영 못 켜지지 않는다', async () => {
    const scope = memoryScope()
    const time = clock(T0)
    await new RuntimeLease({ scope, owner: 'dead', pid: 99, now: time.now }).acquire()

    time.advance(MIN_STALE_MS + 1_000)
    const next = new RuntimeLease({ scope, owner: 'fresh', pid: 100, now: time.now })
    assert.equal((await next.read()).kind, 'STALE')
    assert.equal(await next.acquire(), true)
  })

  it('만료 기준은 주기가 정한다 — 주기가 만료보다 길면 자기 lease를 죽은 것으로 읽는다', () => {
    // 10분 주기에 5분 만료를 걸면 회차 사이에 자기 lease가 stale로 보인다
    assert.equal(staleAfter(10 * 60_000), 30 * 60_000)
    // 아주 짧은 주기라도 바닥 아래로는 내려가지 않는다
    assert.equal(staleAfter(1_000), MIN_STALE_MS)
  })

  it('회차마다 갱신하면 주기가 만료보다 길어도 뺏기지 않는다', async () => {
    const scope = memoryScope()
    const time = clock(T0)
    const interval = 20 * 60_000
    const staleMs = staleAfter(interval)
    const mine = new RuntimeLease({ scope, owner: 'loop', staleMs, now: time.now })
    await mine.acquire()

    // 한 주기가 지났다. 갱신하지 않았다면 MIN_STALE_MS(5분)를 훨씬 넘겼을 시간이다.
    time.advance(interval)
    assert.equal(await mine.renew(), true)
    assert.equal((await mine.read()).kind, 'HELD')
  })

  it('밀려난 쪽의 갱신은 실패한다 — 남의 lease를 덮어쓰지 않는다', async () => {
    const scope = memoryScope()
    const time = clock(T0)
    const mine = new RuntimeLease({ scope, owner: 'mine', now: time.now })
    await mine.acquire()

    time.advance(MIN_STALE_MS + 1_000)
    await new RuntimeLease({ scope, owner: 'theirs', pid: 77, now: time.now }).acquire()

    assert.equal(await mine.renew(), false)
    const state = await mine.read()
    assert.equal(state.kind === 'HELD' && state.record.owner, 'theirs')
  })

  it('시계가 뒤로 가면 살아 있는 쪽으로 읽는다 — 남의 lease를 뺏지 않는다', async () => {
    const scope = memoryScope()
    const time = clock(T0)
    await new RuntimeLease({ scope, owner: 'holder', now: time.now }).acquire()
    time.advance(-60_000)
    assert.equal((await new RuntimeLease({ scope, owner: 'other', now: time.now }).read()).kind, 'HELD')
  })

  it('읽을 수 없는 lease는 죽은 것으로 본다', async () => {
    const scope = memoryScope()
    await scope.set(RUNTIME_LEASE_KEY, 'not json')
    const lease = new RuntimeLease({ scope, owner: 'fresh' })
    assert.equal((await lease.read()).kind, 'STALE')
    assert.equal(await lease.acquire(), true)
  })
})

describe('background status — 안 돌고 있음과 변화 없음을 합치지 않는다 (C-12 불변식 ⑫)', () => {
  it('한 번도 돌지 않았으면 그렇게 말한다', async () => {
    const status = await readBackground(memoryScope(), MIN_STALE_MS)
    assert.equal(status.lease.kind, 'FREE')
    const lines = renderBackground(status).join('\n')
    assert.match(lines, /not running/)
    assert.match(lines, /no pass has run yet/)
  })

  it('돌고 있으면 pid와 마지막 heartbeat를 말한다', async () => {
    const scope = memoryScope()
    await new RuntimeLease({ scope, owner: 'loop', pid: 4242, now: () => T0 }).acquire()
    const lines = renderBackground(await readBackground(scope, MIN_STALE_MS, () => T0)).join('\n')
    assert.match(lines, /running \(pid 4242/)
  })

  it('죽은 lease는 "돌고 있다"로 그리지 않는다 — 얼마나 조용했는지까지 말한다', async () => {
    const scope = memoryScope()
    const time = clock(T0)
    await new RuntimeLease({ scope, owner: 'gone', pid: 5, now: time.now }).acquire()
    time.advance(30 * 60_000)

    const lines = renderBackground(await readBackground(scope, MIN_STALE_MS, time.now)).join('\n')
    assert.match(lines, /not running/)
    assert.match(lines, /silent for 30 min/)
  })

  it('갈래별 마지막 회차 시각을 각각 든다 — 한 갈래만 도는 상태가 보여야 한다', async () => {
    const scope = memoryScope()
    await scope.set(LAST_RUN_KEY, JSON.stringify({ delta: T0 }))
    const lines = renderBackground(await readBackground(scope, MIN_STALE_MS)).join('\n')
    assert.match(lines, new RegExp(`delta: ${T0}`))
    // 돌지 않은 갈래를 조용히 빼면 "전부 돌고 있다"로 읽힌다
    assert.match(lines, /census: never run/)
  })

  it('깨진 last-run 기록을 값으로 읽지 않는다', async () => {
    const scope = memoryScope()
    await scope.set(LAST_RUN_KEY, '{ broken')
    const status = await readBackground(scope, MIN_STALE_MS)
    assert.deepEqual(status.lastRun, {})
  })
})
