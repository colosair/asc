// B-38 Gate — 관찰 조립(composition)이 실제로 물렸는지.
//
// B-30에서 만든 Relevance·Shadow·Material Change는 Engine이 `observe`/`observations`를
// 받았을 때만 돈다. 그 dependency를 production 조립이 채우지 않으면 코드는 있는데
// 실행 경로에는 없는 상태가 된다 — 그것이 이 Gate가 막는 결함이다.
//
// 그래서 여기서는 fixture 관찰 함수를 쓰지 않는다. `buildEventObservation`(production
// builder)을 그대로 세우고, 그 위에서 억제·승격이 서는지를 본다.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { FixtureEventSource } from '../adapters/memory/mocks.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { buildEventObservation } from '../composition/observe.ts'
import { MonitorEngine } from '../core/monitor/engine.ts'
import { ObservationLedger } from '../core/monitor/observation.ts'
import { classify, type MonitorConfig } from '../core/monitor/signals.ts'
import { digest } from '../core/resolver/load.ts'
import { UserOverride } from '../schemas/profile.ts'
import type { ChangeContextPort, ChangeSummary } from '../ports/change-context.ts'
import type { RawEvent } from '../ports/event-source.ts'

const NOW = '2026-08-26T10:00:00+09:00'

const CONFIG: MonitorConfig = {
  identities: ['colosair'],
  reasonSignals: { mention: 'mentioned_me', review_requested: 'review_requested' },
  priorityLabels: { front: 'P1' },
  escalationLabels: ['blocker'],
}

const OWNERSHIP = {
  frontend: { paths: ['web-frontend/**'], authorities: ['client-ui'] },
  backend: { paths: ['backend/**'], authorities: ['api-contract'] },
}

const CANONICAL = ['specs/**']

const pull = (over: Partial<RawEvent> = {}): RawEvent => ({
  eventKey: 'notification:9001:2026-08-26T09:00:00Z',
  detectedAt: '2026-08-26T09:00:00Z',
  reference: 'o/r#19',
  raw: { kind: 'notification', reason: 'mention', body: '@colosair 확인 부탁드립니다' },
  ...over,
})

/** 대본대로 답하는 변경 통로. reference 하나에 회차별 응답을 준다. */
class ScriptedChange implements ChangeContextPort {
  readonly id = 'scripted-change'
  #script: Partial<ChangeSummary>[]
  #calls = 0

  constructor(script: Partial<ChangeSummary>[]) {
    this.#script = script
  }

  get calls(): number {
    return this.#calls
  }

  async getChange(reference: string): Promise<ChangeSummary> {
    const step = this.#script[Math.min(this.#calls, this.#script.length - 1)] ?? {}
    this.#calls += 1
    if (step instanceof Error) throw step
    return { reference, changedPaths: [], revisionMarker: '', ...step }
  }
}

class ThrowingChange implements ChangeContextPort {
  readonly id = 'throwing-change'
  async getChange(): Promise<ChangeSummary> {
    throw new Error('502 Bad Gateway')
  }
}

describe('B-38 Gate — Observation Builder (C-07 §2~§4)', () => {
  it('내 영역 밖의 완결된 변경은 관련성이 서고 Shadow로 내려간다', async () => {
    const observe = buildEventObservation({
      change: new ScriptedChange([{ changedPaths: ['backend/src/auth.ts'], revisionMarker: 'r1' }]),
      ownership: OWNERSHIP,
      myRoles: ['frontend'],
    })

    const observation = await observe(pull())
    assert.equal(observation.revisionMarker, 'r1')
    assert.deepEqual(observation.signal?.changedPaths, ['backend/src/auth.ts'])
    assert.ok(observation.relevance, '판정 근거가 있으므로 관련성을 만든다')
    assert.deepEqual(observation.relevance?.myRoles, ['frontend'])
  })

  it('변경을 못 읽으면 아무것도 만들지 않는다 — 마커도 짓지 않는다', async () => {
    const observe = buildEventObservation({
      change: new ScriptedChange([{ missing: true, revisionMarker: 'r-should-be-ignored' }]),
      ownership: OWNERSHIP,
      myRoles: ['frontend'],
    })

    assert.deepEqual(await observe(pull()), {})
  })

  it('조회가 터져도 감지를 막지 않는다 — 모른다로 접는다', async () => {
    const observe = buildEventObservation({ change: new ThrowingChange(), ownership: OWNERSHIP, myRoles: ['frontend'] })
    assert.deepEqual(await observe(pull()), {})
  })

  it('경로를 일부만 봤으면 판정하지 않되 실질 변화 마커는 살린다', async () => {
    const observe = buildEventObservation({
      change: new ScriptedChange([
        { changedPaths: ['backend/src/auth.ts'], truncated: true, revisionMarker: 'r1' },
      ]),
      ownership: OWNERSHIP,
      myRoles: ['frontend'],
      canonicalPaths: CANONICAL,
    })

    const observation = await observe(pull())
    // "내 영역은 안 바뀌었다"고 말할 수 없다 — 나머지 경로를 못 봤기 때문이다
    assert.equal(observation.relevance, undefined)
    assert.equal(observation.signal, undefined)
    assert.equal(observation.revisionMarker, 'r1')
  })

  it('역할 선언이 없으면 ownership 근거를 만들지 않는다', async () => {
    const observe = buildEventObservation({
      change: new ScriptedChange([{ changedPaths: ['backend/src/auth.ts'], revisionMarker: 'r1' }]),
      ownership: OWNERSHIP,
      myRoles: [],
    })

    const observation = await observe(pull())
    assert.equal(observation.relevance, undefined, '근거 없이 숨기지 않는다')
    // 신호는 별개다 — 경로를 알았다는 사실 자체는 남는다
    assert.deepEqual(observation.signal?.changedPaths, ['backend/src/auth.ts'])
  })

  it('ownership에 풀리지 않는 역할은 근거가 아니다 — 오타로 전부 숨지 않는다', async () => {
    const observe = buildEventObservation({
      change: new ScriptedChange([{ changedPaths: ['backend/src/auth.ts'], revisionMarker: 'r1' }]),
      ownership: OWNERSHIP,
      myRoles: ['frontned'], // 선언에 없는 이름
    })

    assert.equal((await observe(pull())).relevance, undefined)
  })

  it('ownership이 없어도 정본 경로가 있으면 contract 근거로 판정한다', async () => {
    const observe = buildEventObservation({
      change: new ScriptedChange([{ changedPaths: ['specs/001/spec.md'], revisionMarker: 'r1' }]),
      canonicalPaths: CANONICAL,
    })

    const observation = await observe(pull())
    assert.ok(observation.relevance, 'canonical hit은 구조적 근거다')
    assert.deepEqual(observation.relevance?.canonicalPaths, CANONICAL)
  })

  it('정본 경로를 건드리면 canonical 신호가 실제로 선다', async () => {
    const observe = buildEventObservation({
      change: new ScriptedChange([{ changedPaths: ['specs/001/spec.md'], revisionMarker: 'r1' }]),
      canonicalPaths: CANONICAL,
    })

    const observation = await observe(pull())
    const verdict = classify(pull(), CONFIG, observation.signal ?? {})
    assert.ok(
      verdict.signals.includes('open_change_touches_active_canonical'),
      'signal.changedPaths·canonicalPaths가 실제로 전달돼야 이 신호가 선다',
    )
  })

  it('판정 근거가 하나도 없으면 관련성을 만들지 않는다', async () => {
    const observe = buildEventObservation({
      change: new ScriptedChange([{ changedPaths: ['backend/src/auth.ts'], revisionMarker: 'r1' }]),
    })

    assert.equal((await observe(pull())).relevance, undefined)
  })
})

// production builder를 세운 채로 B-30 핵심 시나리오를 재현한다. fixture 관찰 함수로
// 통과시키면 이 Gate는 아무것도 지키지 않는다.
describe('B-38 Gate — production 조립에서 억제·승격이 선다', () => {
  function engineWith(store: MemoryStateStore, batches: RawEvent[][], change: ChangeContextPort) {
    return new MonitorEngine({
      store,
      source: new FixtureEventSource(batches),
      config: CONFIG,
      authorizedApprover: 'controller-a',
      observe: buildEventObservation({
        change,
        ownership: OWNERSHIP,
        myRoles: ['frontend'],
        canonicalPaths: CANONICAL,
      }),
      observations: new ObservationLedger(store.scope('monitor:github-poll'), () => NOW),
      now: () => NOW,
    })
  }

  it('나를 불렀어도 내 영역이 아니면 판단 대기함에 올리지 않는다', async () => {
    const store = new MemoryStateStore()
    const change = new ScriptedChange([{ changedPaths: ['backend/src/auth.ts'], revisionMarker: 'r1' }])
    const outcome = await engineWith(store, [[pull()]], change).scan()

    assert.equal(outcome.logged, 1, '숨김은 폐기가 아니다 — log에는 남는다')
    assert.equal(outcome.packets.length, 0)
    const event = (await store.list('event'))[0]!
    assert.equal(event.relevance?.disposition, 'SHADOW')
    assert.equal(event.inboxCandidate, false)
  })

  it('같은 변화가 다시 와도 새 보고서를 만들지 않는다', async () => {
    const store = new MemoryStateStore()
    const change = new ScriptedChange([{ changedPaths: ['web-frontend/src/app.ts'], revisionMarker: 'r1' }])
    const engine = engineWith(
      store,
      [[pull()], [pull({ eventKey: 'notification:9001:second' })]],
      change,
    )

    const first = await engine.scan()
    assert.equal(first.packets.length, 1, '처음 본 것은 올린다')

    const second = await engine.scan()
    assert.equal(second.packets.length, 0, '실질 변화가 없으면 같은 판단을 또 요구하지 않는다')
  })

  it('숨겼던 것이 내 영역을 건드리면 다시 올린다', async () => {
    const store = new MemoryStateStore()
    const change = new ScriptedChange([
      { changedPaths: ['backend/src/auth.ts'], revisionMarker: 'r1' },
      { changedPaths: ['backend/src/auth.ts', 'web-frontend/src/app.ts'], revisionMarker: 'r2' },
    ])
    const engine = engineWith(store, [[pull()], [pull({ eventKey: 'notification:9001:second' })]], change)

    const first = await engine.scan()
    assert.equal(first.packets.length, 0)

    const second = await engine.scan()
    assert.equal(second.packets.length, 1, 'Shadow는 폐기가 아니다 — 관계가 생기면 올라온다')
  })

  it('숨긴 것은 이유와 함께 남아 나중에 왜 안 보였는지 답할 수 있다', async () => {
    const store = new MemoryStateStore()
    const change = new ScriptedChange([{ changedPaths: ['backend/src/auth.ts'], revisionMarker: 'r1' }])
    await engineWith(store, [[pull()]], change).scan()

    // CLI의 digest가 shadow를 읽는 자리와 같은 scope다 (B-49에서 일반화 예정)
    const shadowed = await new ObservationLedger(store.scope('monitor:github-poll')).shadowed()
    assert.equal(shadowed.length, 1)
    assert.equal(shadowed[0]!.reference, 'o/r#19')
  })
})

describe('B-38 Gate — 배선 회귀', () => {
  it('production Monitor 조립이 observe·observations를 넘긴다', async () => {
    const source = await readFile('cli/asc.ts', 'utf8')
    const start = source.indexOf('const engine = new MonitorEngine({')
    assert.ok(start > 0, 'Monitor 조립 지점을 찾지 못했다')
    const block = source.slice(start, source.indexOf('\n  })', start))

    // 문자열 검사만으로 이 Block을 통과시키지 않는다 — 위 시나리오가 본 Gate이고,
    // 이건 "조립에서 다시 빠지는 것"을 잡는 회귀 그물이다.
    assert.match(block, /observe:\s*buildEventObservation\(/)
    assert.match(block, /observations:\s*new ObservationLedger\(/)
  })
})

// 스키마를 넓힌 대가로 기존 사용자가 LOCK_DRIFT를 보면 안 된다. 새 필드를 `.optional()`로
// 둔 이유가 이것이고, 그 이유를 코드가 아니라 테스트가 지킨다.
describe('B-38 Gate — 기존 override 호환', () => {
  const legacy = {
    schemaVersion: 1,
    identity: { github: 'colosair' },
    monitorIdentities: ['colosair'],
    controller: { identities: { 'controller-a': ['local:colosair'] } },
  }

  it('roles를 선언하지 않은 override는 parse 결과가 달라지지 않는다', () => {
    const parsed = UserOverride.parse(legacy)
    assert.equal('roles' in parsed.monitor, false, '없던 키가 생기면 digest가 흔들린다')
    // 못 박은 값이다. 이 줄이 깨지면 overrideDigest·configurationDigest가 함께 움직여
    // 아무것도 고치지 않은 사용자에게 LOCK_DRIFT가 뜬다.
    assert.equal(digest(parsed), '683e7f5ee4d3d590')
  })

  it('roles를 선언하면 그때는 실제로 달라진다 — 읽히지 않는 필드가 아니다', () => {
    const declared = UserOverride.parse({ ...legacy, monitor: { roles: ['frontend'] } })
    assert.deepEqual(declared.monitor.roles, ['frontend'])
    assert.notEqual(digest(declared), digest(UserOverride.parse(legacy)))
  })
})
