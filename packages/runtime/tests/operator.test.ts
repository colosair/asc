// B-05 Gate — list → show → freshness 조회, Stored/Overlay 구분, 복수 후보 나열.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { FakeScm } from '../adapters/memory/mocks.ts'
import { TextRenderer } from '../adapters/text/renderer.ts'
import { LocalOperator } from '../core/operator/local-operator.ts'
import { referenceOf } from '../core/view/build-view.ts'
import { ApprovalRequest } from '../core/model/entities.ts'
import { transitionRequest } from '../core/model/transitions.ts'
import type { StateStore } from '../ports/state-store.ts'

const NOW = '2026-08-22T14:00:00+09:00'
const DETECTED = '2026-08-22T10:00:00+09:00'

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest =>
  ApprovalRequest.parse({
    id: 'REQ-0042',
    version: 0,
    status: 'AWAITING_APPROVAL',
    type: 'actionable',
    priority: 'P0',
    title: 'Issue #19 답변 승인 필요',
    detectedAt: DETECTED,
    source: { eventKey: 'comment:531245', reference: 'Issue #19', threadLastEventId: 'evt-7' },
    situation: '오류 봉투 계약 해석을 물어왔다',
    impact: { interruptRequired: false, affectedSessions: ['S-20260822-01'] },
    recommendation: '답변 필요',
    draft: 'C안으로 확정하겠습니다',
    snapshot: [{ sourceId: 'shared-spec', baseline: 'abc123' }],
    authorizedApprover: 'controller-a',
    allowedDecisions: ['approve', 'revise', 'defer', 'dismiss'],
    ...over,
  })

async function withActiveSessions(store: StateStore, ids: string[]): Promise<void> {
  const state = await store.getControlState()
  await store.setControlState(state.version, { ...state, version: state.version + 1, activeSessions: ids })
}

const operatorOn = (store: StateStore, scm?: FakeScm) =>
  new LocalOperator({ store, ...(scm ? { scm } : {}), now: () => NOW })

describe('조회 표면', () => {
  it('목록은 판단 대기만 보이고 최근 감지 순이다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    await store.create('request', request({ id: 'REQ-0043', detectedAt: '2026-08-22T11:00:00+09:00', priority: 'P1' }))
    await store.create('request', request({ id: 'REQ-0044', status: 'DISMISSED', priority: 'P2' }))

    const pending = await operatorOn(store).list()
    assert.deepEqual(pending.map((i) => i.requestId), ['REQ-0043', 'REQ-0042'])

    const all = await operatorOn(store).list({ all: true })
    assert.equal(all.length, 3)
    assert.deepEqual((await operatorOn(store).list({ priority: 'P1' })).map((i) => i.requestId), ['REQ-0043'])
  })

  it('reference는 채널 간 지목 수단이라 목록에도 붙는다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    const [item] = await operatorOn(store).list()
    assert.equal(item!.reference, 'ASC · P0 · REQ-0042 · Issue #19')
    assert.equal(referenceOf(request()), item!.reference)
  })

  it('없는 요청 조회는 이유를 밝힌다', async () => {
    const outcome = await operatorOn(new MemoryStateStore()).get('REQ-9999')
    assert.ok(!outcome.ok && outcome.reason === 'NOT_FOUND')
  })
})

describe('Stored Packet과 Current Context Overlay', () => {
  it('알림 당시 분석은 그대로 두고 지금 사실을 따로 붙인다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    await withActiveSessions(store, ['S-20260822-03'])

    const scm = new FakeScm()
    scm.setThread('Issue #19', 'evt-7')
    scm.setBaseline('shared-spec', 'def456')

    const outcome = await operatorOn(store, scm).get('REQ-0042')
    assert.ok(outcome.ok)
    const view = outcome.view

    // 알림 당시 판단은 손대지 않는다
    assert.equal(view.stored.interruptRequired, false)
    assert.deepEqual(view.stored.affectedSessions, ['S-20260822-01'])
    assert.deepEqual(view.stored.snapshot, [{ sourceId: 'shared-spec', baseline: 'abc123' }])

    // 지금 사실은 따로 계산된다
    assert.equal(view.current?.observedAt, NOW)
    assert.deepEqual(view.current?.activeSessions, ['S-20260822-03'])
    assert.equal(view.current?.affectsCurrentWork, false)
    assert.deepEqual(view.current?.canonicalChanges, [
      { sourceId: 'shared-spec', before: 'abc123', after: 'def456' },
    ])

    // 원본 entity는 조회로 바뀌지 않는다
    const stored = (await store.get('request', 'REQ-0042'))!
    assert.equal(stored.version, 0)
    assert.deepEqual(stored.snapshot, [{ sourceId: 'shared-spec', baseline: 'abc123' }])
  })

  it('현재 활성 세션이 요청이 지목한 세션이면 영향 있음이다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    await withActiveSessions(store, ['S-20260822-01'])

    const outcome = await operatorOn(store).get('REQ-0042')
    assert.ok(outcome.ok)
    assert.equal(outcome.view.current?.affectsCurrentWork, true)
  })

  it('판단할 근거가 없으면 확인 범위에 없다고 적는다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request({ impact: { interruptRequired: false, affectedSessions: [], rationale: '' } }))

    const outcome = await operatorOn(store).get('REQ-0042')
    assert.ok(outcome.ok)
    assert.equal(outcome.view.current?.affectsCurrentWork, false)
    assert.equal(outcome.view.verification.localContext, 'NOT_APPLICABLE')
  })
})

describe('freshness와 확인 범위', () => {
  it('외부 연결이 없으면 CURRENT여도 원본 미검증임을 밝힌다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    await withActiveSessions(store, ['S-20260822-01'])

    const outcome = await operatorOn(store).get('REQ-0042')
    assert.ok(outcome.ok)
    // 확인할 수 있었던 범위에서는 변화가 없다 — 그러나 그 범위가 어디까지였는지 드러나야 한다
    assert.equal(outcome.view.freshness, 'CURRENT')
    assert.deepEqual(outcome.view.verification, { localContext: 'VERIFIED', source: 'UNAVAILABLE' })
    assert.deepEqual(outcome.view.current?.canonicalChanges, [])

    const text = new TextRenderer().renderDecision(outcome.view, 'full').text
    assert.match(text, /달라진 것 없음 \(로컬 기준\)/)
    assert.match(text, /원본 변경 여부 미확인/)
  })

  it('확인할 원본이 없는 요청은 미검증이 아니다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request({ source: { eventKey: 'comment:1', reference: 'Issue #19' }, snapshot: [] }))

    const outcome = await operatorOn(store).get('REQ-0042')
    assert.ok(outcome.ok)
    assert.equal(outcome.view.verification.source, 'NOT_APPLICABLE')
    assert.doesNotMatch(new TextRenderer().renderDecision(outcome.view, 'full').text, /미확인/)
  })

  it('달라진 것이 없으면 CURRENT', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    await withActiveSessions(store, ['S-20260822-01'])
    const scm = new FakeScm()
    scm.setThread('Issue #19', 'evt-7')
    scm.setBaseline('shared-spec', 'abc123')

    const outcome = await operatorOn(store, scm).get('REQ-0042')
    assert.ok(outcome.ok)
    assert.equal(outcome.view.freshness, 'CURRENT')
    assert.deepEqual(outcome.view.verification, { localContext: 'VERIFIED', source: 'VERIFIED' })
    assert.doesNotMatch(new TextRenderer().renderDecision(outcome.view, 'full').text, /미확인|로컬 기준/)
  })

  it('정본이 바뀌었으면 SOURCE_CHANGED', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    const scm = new FakeScm()
    scm.setThread('Issue #19', 'evt-7')
    scm.setBaseline('shared-spec', 'def456')

    const outcome = await operatorOn(store, scm).get('REQ-0042')
    assert.ok(outcome.ok)
    assert.equal(outcome.view.freshness, 'SOURCE_CHANGED')
    assert.equal(outcome.view.verification.source, 'VERIFIED')
  })

  it('스레드에 새 이벤트가 있어도 SOURCE_CHANGED', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    const scm = new FakeScm()
    scm.setThread('Issue #19', 'evt-9')
    scm.setBaseline('shared-spec', 'abc123')

    const outcome = await operatorOn(store, scm).get('REQ-0042')
    assert.ok(outcome.ok && outcome.view.freshness === 'SOURCE_CHANGED')
  })

  it('작업 맥락만 달라졌으면 STALE_CONTEXT', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    await withActiveSessions(store, ['S-20260822-03'])
    const scm = new FakeScm()
    scm.setThread('Issue #19', 'evt-7')
    scm.setBaseline('shared-spec', 'abc123')

    const outcome = await operatorOn(store, scm).get('REQ-0042')
    assert.ok(outcome.ok && outcome.view.freshness === 'STALE_CONTEXT')
  })

  it('이미 결정된 요청은 다른 변화보다 그 사실이 먼저다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    const current = (await store.get('request', 'REQ-0042'))!
    await store.compareAndSet(
      'request',
      'REQ-0042',
      current.version,
      transitionRequest(current, 'APPROVED', 'controller', {
        decision: { kind: 'approve', actor: 'controller-a', channel: 'mattermost', decidedAt: NOW },
      }),
    )

    const scm = new FakeScm()
    scm.setBaseline('shared-spec', 'def456') // 정본도 바뀌었지만
    const outcome = await operatorOn(store, scm).get('REQ-0042')
    assert.ok(outcome.ok)
    assert.equal(outcome.view.freshness, 'ALREADY_DECIDED')
    assert.equal(outcome.view.decided?.channel, 'mattermost')
  })
})

describe('request_id 없이 찾기 (C-01 §11)', () => {
  it('후보가 하나뿐이면 바로 보여준다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    const outcome = await operatorOn(store).resolveLatest()
    assert.equal(outcome.kind, 'resolved')
  })

  it('후보가 여럿이면 고르지 않고 나열한다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    await store.create('request', request({ id: 'REQ-0043', priority: 'P1', detectedAt: '2026-08-22T11:00:00+09:00' }))

    const outcome = await operatorOn(store).resolveLatest()
    assert.equal(outcome.kind, 'ambiguous')
    assert.ok(outcome.kind === 'ambiguous' && outcome.candidates.length === 2)
  })

  it('조건을 주면 좁혀진다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    await store.create('request', request({ id: 'REQ-0043', priority: 'P1', detectedAt: '2026-08-22T11:00:00+09:00' }))

    const outcome = await operatorOn(store).resolveLatest({ priority: 'P0' })
    assert.ok(outcome.kind === 'resolved' && outcome.view.requestId === 'REQ-0042')
  })

  it('대기 중인 것이 없으면 없다고 한다', async () => {
    assert.equal((await operatorOn(new MemoryStateStore()).resolveLatest()).kind, 'none')
  })
})

describe('텍스트 표현', () => {
  const renderer = new TextRenderer()

  it('두 시점을 다른 제목 아래 놓고 순서를 지킨다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    await withActiveSessions(store, ['S-20260822-03'])
    const scm = new FakeScm()
    scm.setThread('Issue #19', 'evt-7')
    scm.setBaseline('shared-spec', 'def456')

    const outcome = await operatorOn(store, scm).get('REQ-0042')
    assert.ok(outcome.ok)
    const text = renderer.renderDecision(outcome.view, 'full').text

    assert.equal(text.split('\n')[0], 'ASC · P0 · REQ-0042 · Issue #19')
    assert.ok(text.indexOf('[알림 당시 분석]') < text.indexOf('[현재 작업 기준]'))
    assert.match(text, /정본 변경: shared-spec abc123 → def456/)
    assert.match(text, /원본\(스레드·정본\)이 바뀌었다/)
    assert.match(text, /선택: approve \/ revise \/ defer \/ dismiss/)
  })

  it('요약은 접어도 참조와 선택지는 남긴다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    const outcome = await operatorOn(store).get('REQ-0042')
    assert.ok(outcome.ok)
    const text = renderer.renderDecision(outcome.view, 'summary').text

    assert.equal(text.split('\n')[0], 'ASC · P0 · REQ-0042 · Issue #19')
    assert.doesNotMatch(text, /알림 당시 분석/)
    assert.match(text, /선택: approve/)
  })

  it('빈 목록도 말이 되게 나온다', () => {
    assert.equal(renderer.renderList([]).text, '대기 중인 요청 없음')
  })
})
