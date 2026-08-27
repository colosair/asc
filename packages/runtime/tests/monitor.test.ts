// B-09 Gate — fixture 이벤트로 Phase A/B가 도는지, 중복이 걸리는지, 실패가 다음 회차로
// 넘어가는지, 그리고 Core에 프로젝트 고유값이 새지 않았는지.

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { FakeScm, FixtureEventSource } from '../adapters/memory/mocks.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { ObservationLedger } from '../core/monitor/observation.ts'
import { MonitorEngine, type EventObservation, packetDepth } from '../core/monitor/engine.ts'
import { GENERIC_SIGNALS, classify, detectSignals, type MonitorConfig } from '../core/monitor/signals.ts'
import type { RawEvent } from '../ports/event-source.ts'
import type { StateStore } from '../ports/state-store.ts'

const NOW = '2026-08-23T10:00:00+09:00'

/** 프로젝트 사정은 전부 여기 있다 — Core가 아니라 설정이 안다. */
const CONFIG: MonitorConfig = {
  identities: ['colosair'],
  // provider 어휘는 Core가 아니라 Adapter가 내놓고 설정이 고른다
  reasonSignals: {
    assign: 'assigned_to_me',
    mention: 'mentioned_me',
    review_requested: 'review_requested',
    subscribed: 'participated_thread_changed',
  },
  priorityLabels: { front: 'P1', urgent: 'P0' },
  escalationLabels: ['blocker'],
}

const notification = (over: Partial<RawEvent> & { reason?: string } = {}): RawEvent => {
  const { reason = 'mention', ...rest } = over
  return {
    eventKey: 'notification:9001:2026-08-23T09:00:00Z',
    detectedAt: '2026-08-23T09:00:00Z',
    reference: 'o/r#19',
    raw: { kind: 'notification', reason, title: 'Issue #19 계약 해석', body: '@colosair 확인 부탁드립니다' },
    ...rest,
  }
}

const comment = (over: Partial<RawEvent> = {}): RawEvent => ({
  eventKey: 'comment:531245',
  detectedAt: '2026-08-23T09:05:00Z',
  reference: 'o/r#19',
  hints: { actors: ['strdeok'] },
  raw: { kind: 'issue_comment', body: '이 부분 계약 해석이 궁금합니다' },
  ...over,
})

function engineOn(store: StateStore, batches: RawEvent[][], scm?: FakeScm) {
  return new MonitorEngine({
    store,
    source: new FixtureEventSource(batches),
    config: CONFIG,
    ...(scm ? { scm } : {}),
    authorizedApprover: 'controller-a',
    canonicalSources: ['shared-spec'],
    now: () => NOW,
  })
}

describe('Generic Signal — Core는 이름만 안다', () => {
  it('누가 나인지는 설정이 정한다', () => {
    const event = notification({ reason: 'assign' })
    assert.deepEqual(detectSignals(event, CONFIG), ['assigned_to_me', 'mentioned_me'])
    // 같은 이벤트라도 내가 아니면 본문 멘션은 걸리지 않는다
    assert.deepEqual(detectSignals(event, { ...CONFIG, identities: ['someone-else'] }), ['assigned_to_me'])
  })

  it('내가 쓴 글은 나에게 알릴 일이 아니다', () => {
    const mine = comment({ hints: { actors: ['colosair'] }, raw: { kind: 'issue_comment', body: '제가 답합니다' } })
    assert.deepEqual(detectSignals(mine, CONFIG), [])
  })

  it('내 글이라도 다른 신호가 있으면 지나치지 않는다', () => {
    const mine = comment({
      hints: { actors: ['colosair'], labels: ['urgent'] },
      raw: { kind: 'issue_comment', body: '제가 답합니다' },
    })
    assert.deepEqual(detectSignals(mine, CONFIG), ['priority_labels'])
  })

  it('provider 어휘는 설정으로 갈아끼운다', () => {
    const gitlab = { ...CONFIG, reasonSignals: { assigned: 'assigned_to_me' as const } }
    assert.deepEqual(detectSignals(notification({ reason: 'assigned' }), gitlab), ['assigned_to_me', 'mentioned_me'])
    // 매핑에 없는 사유는 신호가 아니다
    assert.deepEqual(detectSignals(notification({ reason: 'mention', raw: { reason: 'mention' } }), gitlab), [])
  })

  it('Core에는 provider 어휘가 아예 없다 — 매핑을 안 주면 사유는 무시된다', () => {
    const bare = { identities: ['colosair'] }
    assert.deepEqual(detectSignals(notification({ reason: 'assign', raw: { reason: 'assign' } }), bare), [])
  })
})

describe('분류 — 유형과 우선순위', () => {
  it('답이 필요한 것과 작업이 필요한 것을 가른다', () => {
    assert.equal(classify(notification({ reason: 'mention' }), CONFIG).type, 'actionable')
    assert.equal(classify(notification({ reason: 'assign' }), CONFIG).type, 'work')
    assert.equal(
      classify(notification({ reason: 'subscribed', raw: { reason: 'subscribed' } }), CONFIG).type,
      'informational',
    )
  })

  it('라벨이 우선순위를 올린다', () => {
    const plain = comment({ hints: { actors: ['strdeok'], labels: [] }, raw: { kind: 'issue_comment', body: '@colosair' } })
    const labeled = comment({
      hints: { actors: ['strdeok'], labels: ['front'] },
      raw: { kind: 'issue_comment', body: '참고만 하세요' },
    })
    assert.equal(classify(plain, CONFIG).priority, 'P0') // 멘션
    assert.equal(classify(labeled, CONFIG).priority, 'P1') // 라벨
  })

  it('escalation 라벨은 한 단계 더 올린다', () => {
    const escalated = comment({
      hints: { actors: ['strdeok'], labels: ['front', 'blocker'] },
      raw: { kind: 'issue_comment', body: '참고' },
    })
    assert.equal(classify(escalated, CONFIG).priority, 'P0')
  })

  it('신호가 없으면 수신함에 올리지 않는다 — log는 남는다', () => {
    const noise = comment({ hints: { actors: ['ci-bot'] }, raw: { kind: 'issue_comment', body: '빌드 통과' } })
    const verdict = classify(noise, CONFIG)
    assert.deepEqual(verdict.signals, [])
    assert.equal(verdict.inboxCandidate, false)
  })

  it('올릴 신호를 좁힐 수 있다', () => {
    const narrow = { ...CONFIG, inboxSignals: ['assigned_to_me' as const] }
    assert.equal(classify(notification({ reason: 'mention' }), narrow).inboxCandidate, false)
    assert.equal(classify(notification({ reason: 'assign' }), narrow).inboxCandidate, true)
  })

  it('조사 깊이는 유형이 정한다 (OM §10.3)', () => {
    assert.equal(packetDepth('actionable', 'P2'), 'full')
    assert.equal(packetDepth('work', 'P2'), 'full')
    assert.equal(packetDepth('informational', 'P0'), 'compact')
    assert.equal(packetDepth('informational', 'P2'), 'brief')
  })
})

describe('Phase A — 전부, 싸게', () => {
  it('전 이벤트를 기록하고 행동할 것만 골라낸다', async () => {
    const store = new MemoryStateStore()
    const noise = comment({ eventKey: 'comment:1', hints: { actors: ['ci-bot'] }, raw: { kind: 'issue_comment', body: '빌드 통과' } })
    const outcome = await engineOn(store, [[notification(), noise]]).scan()

    assert.equal(outcome.detected, 2)
    assert.equal(outcome.logged, 2)
    assert.equal(outcome.packets.length, 1) // 잡음은 보고서가 되지 않는다

    // log에는 둘 다 남는다 (OM §10.2)
    const history = await store.readHistory()
    assert.equal(history.filter((h) => h.kind === 'monitor_event').length, 2)
    assert.equal((await store.list('event')).length, 2)
    assert.equal((await store.list('request')).length, 1)
  })

  it('같은 이벤트가 다시 와도 보고서는 하나다', async () => {
    const store = new MemoryStateStore()
    const engine = engineOn(store, [[notification()], [notification()]])

    const first = await engine.scan()
    assert.equal(first.duplicates, 0)
    assert.equal(first.packets.length, 1)

    const second = await engine.scan()
    assert.equal(second.detected, 1)
    assert.equal(second.duplicates, 1) // key 하나로 걸렸다
    assert.equal(second.packets.length, 0)
    assert.equal((await store.list('request')).length, 1)
  })

  it('cursor는 Phase B까지 끝난 뒤에 옮긴다', async () => {
    const store = new MemoryStateStore()
    const engine = engineOn(store, [[notification()], [comment()]])

    await engine.scan()
    const saved = await store.scope('monitor:fixture').get('cursor')
    assert.equal(saved, '1')

    await engine.scan()
    assert.equal(await store.scope('monitor:fixture').get('cursor'), '2')
  })
})

describe('Phase B — 고른 것만, 깊게', () => {
  it('대응형은 전체 보고서, 정보형 P2는 세 줄짜리다', async () => {
    const store = new MemoryStateStore()
    const informational = comment({
      eventKey: 'comment:2',
      hints: { actors: ['strdeok'], labels: ['front'] },
      raw: { kind: 'issue_comment', reason: 'subscribed', body: '참고 사항' },
    })
    await engineOn(store, [[notification(), informational]]).scan()

    const requests = await store.list('request')
    const actionable = requests.find((r) => r.type === 'actionable')!
    assert.ok(actionable.context.length > 0)
    assert.ok(actionable.impact.rationale.length > 0)
    assert.deepEqual(actionable.allowedDecisions, ['approve', 'revise', 'defer', 'dismiss'])

    const info = requests.find((r) => r.type === 'informational')
    if (info) assert.equal(info.context, '')
  })

  it('작업형은 답변이 아니라 작업 큐로 간다', async () => {
    const store = new MemoryStateStore()
    await engineOn(store, [[notification({ reason: 'assign' })]]).scan()
    const request = (await store.list('request'))[0]!
    assert.equal(request.type, 'work')
    assert.deepEqual(request.allowedDecisions, ['queue', 'defer', 'dismiss'])
  })

  it('초안은 지어내지 않는다 — 사람이 승인할 내용이다', async () => {
    const store = new MemoryStateStore()
    await engineOn(store, [[notification()]]).scan()
    assert.equal((await store.list('request'))[0]!.draft, undefined)
  })

  it('정본과 스레드 상태를 보고서에 박아 둔다', async () => {
    const store = new MemoryStateStore()
    const scm = new FakeScm()
    scm.setBaseline('shared-spec', 'abc123')
    scm.setThread('o/r#19', 'evt-7')

    await engineOn(store, [[notification()]], scm).scan()
    const request = (await store.list('request'))[0]!
    assert.deepEqual(request.snapshot, [{ sourceId: 'shared-spec', baseline: 'abc123' }])
    assert.equal(request.source.threadLastEventId, 'evt-7')
  })

  it('외부 연결이 없어도 얕은 보고서는 만든다', async () => {
    const store = new MemoryStateStore()
    await engineOn(store, [[notification()]]).scan()
    const request = (await store.list('request'))[0]!
    assert.deepEqual(request.snapshot, [])
    assert.equal(request.source.threadLastEventId, undefined)
  })

  it('P0 대응형만 작업 중단을 제안한다', async () => {
    const store = new MemoryStateStore()
    await engineOn(store, [[notification()]]).scan()
    assert.equal((await store.list('request'))[0]!.impact.interruptRequired, true)

    const quiet = new MemoryStateStore()
    const low = comment({ hints: { actors: ['strdeok'], labels: ['front'] }, raw: { kind: 'issue_comment', body: '참고' } })
    await engineOn(quiet, [[low]]).scan()
    const request = (await quiet.list('request'))[0]
    if (request) assert.equal(request.impact.interruptRequired, false)
  })
})

describe('부분 실패와 재시도', () => {
  it('조사에 실패한 이벤트는 PENDING_RETRY로 남는다', async () => {
    const store = new MemoryStateStore()
    // 정본 조회가 던지면 그 한 건의 조사만 실패한다
    const broken = new FakeScm()
    broken.getBaselines = async () => {
      throw new Error('네트워크 끊김')
    }

    const outcome = await engineOn(store, [[notification()]], broken).scan()
    assert.equal(outcome.packets.length, 0)
    assert.deepEqual(outcome.retries, ['notification:9001:2026-08-23T09:00:00Z'])

    // 이벤트는 남아 있고 상태가 재시도 대기다 — 다음 회차가 다시 본다
    const event = (await store.get('event', 'notification:9001:2026-08-23T09:00:00Z'))!
    assert.equal(event.processing, 'PENDING_RETRY')
    assert.equal((await store.list('request')).length, 0)
  })

  it('한 건이 실패해도 나머지는 보고서가 된다', async () => {
    const store = new MemoryStateStore()
    const scm = new FakeScm()
    let calls = 0
    const original = scm.getBaselines.bind(scm)
    scm.getBaselines = async (queries) => {
      if (++calls === 1) throw new Error('첫 건만 실패')
      return original(queries)
    }

    const second = notification({ eventKey: 'notification:9002:2026-08-23T09:10:00Z', detectedAt: '2026-08-23T09:10:00Z' })
    const outcome = await engineOn(store, [[notification(), second]], scm).scan()
    assert.equal(outcome.packets.length, 1)
    assert.equal(outcome.retries.length, 1)
  })

  it('다음 회차가 저장된 원본으로 조사를 실제로 다시 한다', async () => {
    const store = new MemoryStateStore()
    const scm = new FakeScm()
    scm.setBaseline('shared-spec', 'abc123')
    let failFirst = true
    const original = scm.getBaselines.bind(scm)
    scm.getBaselines = async (queries) => {
      if (failFirst) {
        failFirst = false
        throw new Error('네트워크 끊김')
      }
      return original(queries)
    }

    // 2회차의 EventSource는 빈 배치를 준다 — 되살릴 재료는 저장된 이벤트뿐이다
    const engine = engineOn(store, [[notification()], []], scm)

    const first = await engine.scan()
    assert.equal(first.packets.length, 0)
    assert.equal((await store.get('event', 'notification:9001:2026-08-23T09:00:00Z'))!.processing, 'PENDING_RETRY')
    // cursor는 전진한다 — 재시도는 cursor가 아니라 저장된 원본에 기댄다
    assert.equal(await store.scope('monitor:fixture').get('cursor'), '1')

    const second = await engine.scan()
    assert.equal(second.detected, 0)
    assert.equal(second.packets.length, 1)
    assert.deepEqual(second.retries, [])

    const event = (await store.get('event', 'notification:9001:2026-08-23T09:00:00Z'))!
    assert.equal(event.processing, 'PROCESSED')
    assert.equal(event.requestId, second.packets[0])
    assert.equal((await store.list('request')).length, 1)
  })

  it('되살릴 재료가 없으면 재시도 목록에만 남는다', async () => {
    const store = new MemoryStateStore()
    // replay 없이 저장된 옛 이벤트
    await store.create('event', {
      eventKey: 'comment:999',
      version: 0,
      detectedAt: '2026-08-23T08:00:00Z',
      type: 'actionable',
      suggestedPriority: 'P0',
      processing: 'PENDING_RETRY',
      inboxCandidate: true,
    })
    const outcome = await engineOn(store, [[]]).scan()
    assert.deepEqual(outcome.retries, ['comment:999'])
    assert.equal((await store.list('request')).length, 0)
  })

  it('다시 실패하면 재시도 상태로 남는다', async () => {
    const store = new MemoryStateStore()
    const broken = new FakeScm()
    broken.getBaselines = async () => {
      throw new Error('계속 끊김')
    }
    const engine = engineOn(store, [[notification()], []], broken)

    await engine.scan()
    const second = await engine.scan()
    assert.deepEqual(second.retries, ['notification:9001:2026-08-23T09:00:00Z'])
    assert.equal((await store.get('event', 'notification:9001:2026-08-23T09:00:00Z'))!.processing, 'PENDING_RETRY')
  })
})

describe('Run 직렬화', () => {
  it('같은 객체를 겹쳐 불러도 하나만 돈다', async () => {
    const store = new MemoryStateStore()
    const engine = engineOn(store, [[notification()], [notification()]])

    const [a, b] = await Promise.all([engine.scan(), engine.scan()])
    assert.equal([a, b].filter((o) => o.skipped).length, 1)
    assert.equal((await store.list('request')).length, 1)
  })

  it('서로 다른 Engine이어도 프로젝트 하나에 Run 하나다', async () => {
    // CLI를 두 번 띄우면 프로세스가 둘이고, 둘 다 자기 안에서는 첫 Run이다.
    // 잠금이 객체 안에만 있으면 여기서 둘 다 통과해 요청이 두 개 생긴다.
    const store = new MemoryStateStore()
    const a = engineOn(store, [[notification()]])
    const b = engineOn(store, [[notification()]])

    const outcomes = await Promise.all([a.scan(), b.scan()])
    assert.equal(outcomes.filter((o) => o.skipped).length, 1)
    assert.equal((await store.list('request')).length, 1)
  })

  it('끝나면 다음 Run이 들어올 수 있다', async () => {
    const store = new MemoryStateStore()
    const engine = engineOn(store, [[notification()], [comment()]])
    assert.equal((await engine.scan()).skipped, undefined)
    assert.equal((await engine.scan()).skipped, undefined)
  })

  it('죽은 Run이 남긴 잠금은 시간이 지나면 회수된다', async () => {
    const store = new MemoryStateStore()
    // 오래전에 죽은 프로세스가 남긴 lease
    await store
      .scope('monitor:fixture')
      .set('scan-lease', JSON.stringify({ owner: 'dead-run', at: '2020-01-01T00:00:00Z' }))

    const outcome = await engineOn(store, [[notification()]]).scan()
    assert.equal(outcome.skipped, undefined)
    assert.equal(outcome.packets.length, 1)
  })
})

describe('Core 독립성', () => {
  it('Monitor 코드에 프로젝트 고유값이 없다', async () => {
    const sources = await Promise.all([
      readFile('core/monitor/engine.ts', 'utf8'),
      readFile('core/monitor/signals.ts', 'utf8'),
    ])
    const text = sources.join('\n')
    // 계정·라벨·저장소 이름이 코드에 박히면 다른 프로젝트에 붙을 수 없다 (OM §10.6).
    // 검사할 이름을 **여기 적지 않고 Profile에서 읽는다** — 테스트 자체가 특정 계정·
    // 저장소 이름을 들고 있으면 그 이름이 공개되는 것도, 새 Profile을 놓치는 것도 같다.
    // 설치 경로에 있는 **모든** Profile에서 이름을 모은다 — 하나를 지목하면 새 Profile을
    // 놓치고, 그 이름을 여기 적으면 테스트 자신이 그 이름을 들고 있는 셈이 된다.
    const profilesDir = new URL('../profiles/', import.meta.url)
    const ids = (await readdir(profilesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    const leaks: string[] = []
    for (const id of ids) {
      const shipped = JSON.parse(
        await readFile(new URL(`${id}/profile.json`, profilesDir), 'utf8'),
      ) as { id: string; project: { repository: string } }
      leaks.push(...[shipped.id, ...shipped.project.repository.split('/')])
    }
    for (const leak of [...new Set(leaks.filter((name) => name.length > 2)), 'blocker']) {
      assert.doesNotMatch(text, new RegExp(leak, 'i'), `${leak} 가 Core에 새어 들어갔다`)
    }
  })

  it('신호 목록은 정본이 정한 열 가지뿐이다', () => {
    assert.equal(GENERIC_SIGNALS.length, 10)
    assert.ok(GENERIC_SIGNALS.includes('assigned_to_me'))
    assert.ok(GENERIC_SIGNALS.includes('open_change_touches_active_canonical'))
  })
})

// B-30 Gate — 관련성 판정과 억제가 실제 scan 경로에서 도는지.
// 단위 판정은 tests/relevance.test.ts, 여기서는 Phase A에 실제로 물렸는지를 본다.
describe('B-30 Gate — Relevance in scan (C-07 §3·§4)', () => {
  const OWNERSHIP = {
    frontend: { paths: ['web-frontend/**'], authorities: ['client-ui'] },
    backend: { paths: ['backend/**'], authorities: ['api-contract'] },
  }

  function withRelevance(
    store: MemoryStateStore,
    batches: RawEvent[][],
    observation: (event: RawEvent) => EventObservation,
  ) {
    return new MonitorEngine({
      store,
      source: new FixtureEventSource(batches),
      config: CONFIG,
      authorizedApprover: 'controller-a',
      observe: observation,
      observations: new ObservationLedger(store.scope('monitor:fixture'), () => NOW),
      now: () => NOW,
    })
  }

  const mine = (paths: string[]): EventObservation => ({
    relevance: { ownership: OWNERSHIP, myRoles: ['frontend'], changedPaths: paths },
    revisionMarker: paths.join(','),
  })

  it('나를 불렀어도 내 영역이 아니면 판단 대기함에 올리지 않는다', async () => {
    const store = new MemoryStateStore()
    const outcome = await withRelevance(store, [[notification()]], () => mine(['backend/src/auth.ts'])).scan()

    assert.equal(outcome.logged, 1) // log에는 남는다 — 숨김은 폐기가 아니다
    assert.equal(outcome.packets.length, 0)
    assert.equal((await store.list('request')).length, 0)

    const event = (await store.list('event'))[0]!
    assert.equal(event.inboxCandidate, false)
    assert.equal(event.relevance?.explicit, 'HIGH')
    assert.equal(event.relevance?.actual, 'LOW')
    assert.equal(event.relevance?.disposition, 'SHADOW')
    assert.ok(event.relevance?.evidence.some((e) => e.includes('내 영역 밖')))
  })

  it('내 영역이면 올린다 — 근거가 event에 남는다', async () => {
    const store = new MemoryStateStore()
    const outcome = await withRelevance(store, [[notification()]], () =>
      mine(['web-frontend/src/auth.ts']),
    ).scan()

    assert.equal(outcome.packets.length, 1)
    const event = (await store.list('event'))[0]!
    assert.equal(event.relevance?.actual, 'HIGH')
    assert.ok(event.relevance?.evidence.some((e) => e.startsWith('+') && e.includes('내 영역 변경')))
  })

  it('같은 스레드를 실질 변화 없이 다시 부르면 두 번째는 억제된다', async () => {
    const store = new MemoryStateStore()
    // 같은 reference, 다른 event key — dedupe로는 걸리지 않는 반복이다
    const engine = withRelevance(
      store,
      [[notification()], [notification({ eventKey: 'notification:9001:2026-08-23T09:30:00Z' })]],
      () => mine(['web-frontend/src/auth.ts']),
    )

    assert.equal((await engine.scan()).packets.length, 1)
    const second = await engine.scan()
    assert.equal(second.duplicates, 0) // 새 key다
    assert.equal(second.packets.length, 0) // 그런데 실질 변화가 없다
    assert.equal((await store.list('request')).length, 1)
  })

  it('변경이 내 영역까지 넓어지면 다시 올라온다 — Shadow 승격', async () => {
    const store = new MemoryStateStore()
    let paths = ['backend/src/auth.ts']
    const engine = new MonitorEngine({
      store,
      source: new FixtureEventSource([
        [notification()],
        [notification({ eventKey: 'notification:9001:2026-08-23T09:30:00Z' })],
      ]),
      config: CONFIG,
      authorizedApprover: 'controller-a',
      observe: () => mine(paths),
      observations: new ObservationLedger(store.scope('monitor:fixture'), () => NOW),
      now: () => NOW,
    })

    assert.equal((await engine.scan()).packets.length, 0) // 처음엔 남의 영역
    paths = ['backend/src/auth.ts', 'web-frontend/src/types.ts']
    assert.equal((await engine.scan()).packets.length, 1) // 내 영역까지 넓어졌다
  })

  it('관측 기록이 없으면 예전 동작 그대로다 — 근거 없이 숨기지 않는다', async () => {
    const store = new MemoryStateStore()
    const outcome = await engineOn(store, [[notification()]]).scan()
    assert.equal(outcome.packets.length, 1)
    assert.equal((await store.list('event'))[0]?.relevance, undefined)
  })
})
