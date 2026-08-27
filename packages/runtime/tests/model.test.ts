// B-01 Gate — Entity 상태머신이 설계 정본과 1:1 대응하는지, schema가 잘못된 값을
// 거절하는지 검증한다. 정본에 없는 전이가 코드에 몰래 생기면 여기서 깨진다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ApprovalRequest,
  Checkpoint,
  ExecutionGrant,
  Handoff,
  MonitorEvent,
  QueueItem,
  Session,
} from '../core/model/entities.ts'
import { EventKey, RequestId, SessionId, nextId } from '../core/model/ids.ts'
import {
  EVENT_TRANSITIONS,
  GRANT_TRANSITIONS,
  QUEUE_TRANSITIONS,
  REQUEST_TRANSITIONS,
  SESSION_TRANSITIONS,
  TransitionError,
  terminalStates,
  transitionEvent,
  transitionGrant,
  transitionQueueItem,
  transitionRequest,
  transitionSession,
} from '../core/model/transitions.ts'
import type { TransitionRule } from '../core/model/transitions.ts'

const NOW = '2026-08-22T10:00:00+09:00'

const edges = <S extends string>(table: readonly TransitionRule<S>[]) =>
  new Set(table.map((r) => `${r.from}->${r.to}`))

// ── 전이표 ↔ 정본 대조 ──────────────────────────────────────────────────────
// 각 EXPECTED 집합은 설계 정본에서 그대로 옮긴 것이다. 코드 표를 바꾸려면 정본이
// 먼저 바뀌어야 한다는 뜻이고, 그 순서를 이 테스트가 강제한다.

describe('전이표는 설계 정본과 1:1 대응한다', () => {
  it('Session — OM §6.2', () => {
    assert.deepEqual(
      edges(SESSION_TRANSITIONS),
      new Set([
        'READY->ACTIVE',
        'ACTIVE->PAUSED',
        'ACTIVE->BLOCKED',
        'ACTIVE->DONE',
        'ACTIVE->FAILED',
        'PAUSED->ACTIVE',
        'PAUSED->FAILED',
        'BLOCKED->ACTIVE',
        'BLOCKED->FAILED',
      ]),
    )
    assert.deepEqual(
      terminalStates(SESSION_TRANSITIONS, ['READY', 'ACTIVE', 'PAUSED', 'BLOCKED', 'DONE', 'FAILED']),
      ['DONE', 'FAILED'],
    )
  })

  it('ApprovalRequest — OM §11.2', () => {
    assert.deepEqual(
      edges(REQUEST_TRANSITIONS),
      new Set([
        'AWAITING_APPROVAL->APPROVED',
        'AWAITING_APPROVAL->QUEUED',
        'AWAITING_APPROVAL->DEFERRED',
        'AWAITING_APPROVAL->DISMISSED',
        'DEFERRED->APPROVED',
        'DEFERRED->QUEUED',
        'DEFERRED->DISMISSED',
        'APPROVED->DONE',
      ]),
    )
    // 승인 상태에서 외부 반영 없이 곧장 끝나는 경로는 없다 — DONE은 Executor 결과가 있어야 한다.
    assert.deepEqual(
      terminalStates(REQUEST_TRANSITIONS, [
        'AWAITING_APPROVAL',
        'APPROVED',
        'QUEUED',
        'DEFERRED',
        'DISMISSED',
        'DONE',
      ]),
      ['QUEUED', 'DISMISSED', 'DONE'],
    )
  })

  it('ExecutionGrant — OM §11.5·§11.9', () => {
    assert.deepEqual(
      edges(GRANT_TRANSITIONS),
      new Set([
        'READY->CLAIMED',
        'READY->INVALIDATED',
        'READY->EXPIRED',
        'CLAIMED->EXECUTED',
        'CLAIMED->INVALIDATED',
      ]),
    )
    assert.deepEqual(
      terminalStates(GRANT_TRANSITIONS, ['READY', 'CLAIMED', 'EXECUTED', 'INVALIDATED', 'EXPIRED']),
      ['EXECUTED', 'INVALIDATED', 'EXPIRED'],
    )
  })

  it('QueueItem — OM §4.8', () => {
    assert.deepEqual(
      edges(QUEUE_TRANSITIONS),
      new Set(['READY->ACTIVE', 'READY->BLOCKED', 'ACTIVE->BLOCKED', 'ACTIVE->DONE', 'BLOCKED->READY', 'BLOCKED->ACTIVE']),
    )
    assert.deepEqual(terminalStates(QUEUE_TRANSITIONS, ['READY', 'ACTIVE', 'BLOCKED', 'DONE']), ['DONE'])
  })

  it('MonitorEvent — OM §10.5', () => {
    assert.deepEqual(
      edges(EVENT_TRANSITIONS),
      new Set(['LOGGED->PROCESSED', 'LOGGED->PENDING_RETRY', 'PENDING_RETRY->PROCESSED', 'PENDING_RETRY->PENDING_RETRY']),
    )
  })

  it('모든 전이에 수행 가능한 actor가 지정되어 있다', () => {
    const all = [
      ...SESSION_TRANSITIONS,
      ...REQUEST_TRANSITIONS,
      ...GRANT_TRANSITIONS,
      ...QUEUE_TRANSITIONS,
      ...EVENT_TRANSITIONS,
    ]
    for (const rule of all) {
      assert.ok(rule.actors.length > 0, `${rule.from}->${rule.to} has no actor`)
    }
  })
})

// ── 전이 실행 ───────────────────────────────────────────────────────────────

const session = (over: Partial<Session> = {}): Session =>
  Session.parse({
    id: 'S-20260822-01',
    version: 0,
    status: 'READY',
    role: 'implementer',
    goal: 'B-01 entity model',
    ...over,
  })

const checkpoint = Checkpoint.parse({ position: 'transitions.ts 작성 중', nextAction: '테스트 작성', recordedAt: NOW })
const handoff = Handoff.parse({ verified: 'self-check: node --test 통과', next: 'B-02 착수', recordedAt: NOW })

describe('Session lifecycle', () => {
  it('READY → ACTIVE → PAUSED(+CHECKPOINT) → ACTIVE → DONE(+HANDOFF)', () => {
    let s = transitionSession(session(), 'ACTIVE', 'session')
    assert.equal(s.version, 1)

    s = transitionSession(s, 'PAUSED', 'session', { checkpoint })
    assert.equal(s.status, 'PAUSED')
    assert.equal(s.checkpoint?.nextAction, '테스트 작성')

    // 다른 Physical Run이 같은 Logical Session을 이어받는 지점
    s = transitionSession(s, 'ACTIVE', 'session')
    s = transitionSession(s, 'DONE', 'session', { handoff })
    assert.equal(s.status, 'DONE')
    assert.equal(s.version, 4)
  })

  it('Checkpoint 없이 PAUSED, Handoff 없이 DONE으로 갈 수 없다', () => {
    const active = transitionSession(session(), 'ACTIVE', 'session')
    assert.throws(() => transitionSession(active, 'PAUSED', 'session'), (e: TransitionError) => e.reason === 'MISSING_REQUIREMENT')
    assert.throws(() => transitionSession(active, 'DONE', 'session'), (e: TransitionError) => e.reason === 'MISSING_REQUIREMENT')
  })

  it('BLOCKED 해소는 Controller만 한다', () => {
    const blocked = transitionSession(transitionSession(session(), 'ACTIVE', 'session'), 'BLOCKED', 'session')
    assert.throws(() => transitionSession(blocked, 'ACTIVE', 'session'), (e: TransitionError) => e.reason === 'FORBIDDEN_ACTOR')
    assert.equal(transitionSession(blocked, 'ACTIVE', 'controller').status, 'ACTIVE')
  })

  it('종료된 세션은 되살릴 수 없다', () => {
    const done = transitionSession(transitionSession(session(), 'ACTIVE', 'session'), 'DONE', 'session', { handoff })
    assert.throws(() => transitionSession(done, 'ACTIVE', 'controller'), (e: TransitionError) => e.reason === 'ILLEGAL_TRANSITION')
  })
})

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest =>
  ApprovalRequest.parse({
    id: 'REQ-0042',
    version: 0,
    status: 'AWAITING_APPROVAL',
    type: 'actionable',
    priority: 'P0',
    title: 'Issue #19 답변 승인 필요',
    detectedAt: NOW,
    source: { eventKey: 'comment:531245', reference: 'Issue #19' },
    situation: '상대방이 계약 해석을 물었다',
    impact: { interruptRequired: false },
    authorizedApprover: 'controller-a',
    allowedDecisions: ['approve', 'revise', 'defer', 'dismiss'],
    ...over,
  })

const decision = { kind: 'approve' as const, actor: 'controller-a', channel: 'local', decidedAt: NOW }

describe('ApprovalRequest lifecycle', () => {
  it('처분은 Controller만, DONE 전환은 Executor만 한다', () => {
    const pending = request()
    assert.throws(() => transitionRequest(pending, 'APPROVED', 'monitor', { decision }), (e: TransitionError) => e.reason === 'FORBIDDEN_ACTOR')

    const approved = transitionRequest(pending, 'APPROVED', 'controller', { decision })
    assert.equal(approved.version, 1)

    // APPROVED는 승인 상태일 뿐 외부 write 권한이 아니다 — Controller가 직접 DONE으로 못 넘긴다.
    assert.throws(
      () => transitionRequest(approved, 'DONE', 'controller', { resultRef: 'https://example/c/1' }),
      (e: TransitionError) => e.reason === 'FORBIDDEN_ACTOR',
    )
    const done = transitionRequest(approved, 'DONE', 'executor', { resultRef: 'https://example/c/1' })
    assert.equal(done.status, 'DONE')
  })

  it('결정 기록 없는 처분과 결과 없는 DONE은 거절된다', () => {
    assert.throws(() => transitionRequest(request(), 'APPROVED', 'controller'), (e: TransitionError) => e.reason === 'MISSING_REQUIREMENT')
    const approved = transitionRequest(request(), 'APPROVED', 'controller', { decision })
    assert.throws(() => transitionRequest(approved, 'DONE', 'executor'), (e: TransitionError) => e.reason === 'MISSING_REQUIREMENT')
  })

  it('보류한 요청은 다시 처분할 수 있고, 기각된 요청은 끝이다', () => {
    const deferred = transitionRequest(request(), 'DEFERRED', 'controller', { decision: { ...decision, kind: 'defer' } })
    assert.equal(transitionRequest(deferred, 'QUEUED', 'controller', { decision: { ...decision, kind: 'queue' } }).status, 'QUEUED')

    const dismissed = transitionRequest(request(), 'DISMISSED', 'controller', { decision: { ...decision, kind: 'dismiss' } })
    assert.throws(() => transitionRequest(dismissed, 'APPROVED', 'controller', { decision }), (e: TransitionError) => e.reason === 'ILLEGAL_TRANSITION')
  })
})

const grant = (over: Partial<ExecutionGrant> = {}): ExecutionGrant =>
  ExecutionGrant.parse({
    id: 'G-0001',
    version: 0,
    requestId: 'REQ-0042',
    status: 'READY',
    issuedBy: 'controller-a',
    issuedAt: NOW,
    action: 'github.issue_comment.create',
    target: 'owner/repo#19',
    payload: '승인된 초안 본문',
    ...over,
  })

describe('ExecutionGrant lifecycle', () => {
  it('READY → CLAIMED → EXECUTED, 그리고 재소비 불가', () => {
    const claimed = transitionGrant(grant(), 'CLAIMED', 'executor', { claimedBy: 'run-1' })
    const executed = transitionGrant(claimed, 'EXECUTED', 'executor', { resultRef: 'https://example/c/1', consumedAt: NOW })
    assert.equal(executed.status, 'EXECUTED')
    assert.throws(() => transitionGrant(executed, 'CLAIMED', 'executor'), (e: TransitionError) => e.reason === 'ILLEGAL_TRANSITION')
  })

  it('CLAIM 이후 무효화는 Drift Guard를 돌린 Executor만 한다', () => {
    const claimed = transitionGrant(grant(), 'CLAIMED', 'executor', { claimedBy: 'run-1' })
    assert.equal(transitionGrant(claimed, 'INVALIDATED', 'executor').status, 'INVALIDATED')
    // Controller는 발급 전(READY)에만 철회할 수 있다 — 진행 중인 Grant를 가로채지 않는다
    assert.throws(() => transitionGrant(claimed, 'INVALIDATED', 'controller'), (e: TransitionError) => e.reason === 'FORBIDDEN_ACTOR')
    assert.equal(transitionGrant(grant(), 'INVALIDATED', 'controller').status, 'INVALIDATED')
  })

  it('결과 참조 없이 EXECUTED로 갈 수 없다', () => {
    const claimed = transitionGrant(grant(), 'CLAIMED', 'executor')
    assert.throws(() => transitionGrant(claimed, 'EXECUTED', 'executor'), (e: TransitionError) => e.reason === 'MISSING_REQUIREMENT')
  })

  it('Session은 Grant를 소비할 수 없다 — 외부 write는 Executor 전용이다', () => {
    assert.throws(() => transitionGrant(grant(), 'CLAIMED', 'session'), (e: TransitionError) => e.reason === 'FORBIDDEN_ACTOR')
  })
})

describe('QueueItem·MonitorEvent', () => {
  it('Queue 전이는 Controller 전용이다', () => {
    const item = QueueItem.parse({ id: 'Q-0001', version: 0, state: 'READY', title: 'PR #44 리뷰 영향 확인' })
    assert.throws(() => transitionQueueItem(item, 'ACTIVE', 'session'), (e: TransitionError) => e.reason === 'FORBIDDEN_ACTOR')
    assert.equal(transitionQueueItem(item, 'ACTIVE', 'controller', { sessionId: 'S-20260822-01' }).sessionId, 'S-20260822-01')
  })

  it('Phase B 실패는 그 이벤트만 PENDING_RETRY로 남고 재시도된다', () => {
    const event = MonitorEvent.parse({
      eventKey: 'notification:t-1:2026-08-22T09:00:00Z',
      version: 0,
      detectedAt: NOW,
      type: 'informational',
      suggestedPriority: 'P2',
      processing: 'LOGGED',
      inboxCandidate: false,
    })
    const retry = transitionEvent(event, 'PENDING_RETRY', 'monitor')
    const retriedAgain = transitionEvent(retry, 'PENDING_RETRY', 'monitor')
    assert.equal(transitionEvent(retriedAgain, 'PROCESSED', 'monitor', { requestId: 'REQ-0042' }).requestId, 'REQ-0042')
  })
})

// ── Schema ──────────────────────────────────────────────────────────────────

describe('schema는 형식 위반을 거절한다', () => {
  it('identity 형식', () => {
    assert.equal(RequestId.parse('REQ-0042'), 'REQ-0042')
    for (const bad of ['REQ-42', 'req-0042', 'I-0042', 'REQ0042']) {
      assert.equal(RequestId.safeParse(bad).success, false, `${bad} should be rejected`)
    }
    assert.equal(SessionId.safeParse('S-2026-08-22-01').success, false)
    assert.equal(SessionId.parse('S-20260822-01'), 'S-20260822-01')
  })

  it('event key는 <kind>:<opaque> 다 — kind는 adapter가 정한다 (C-07 §9)', () => {
    // 기존 4종은 그대로 통과한다 (하위호환)
    for (const ok of ['notification:t-1:2026-08-22T09:00:00Z', 'comment:531245', 'review:99', 'review_comment:7']) {
      assert.equal(EventKey.safeParse(ok).success, true, `${ok} should be accepted`)
    }
    // 새 adapter와 회수 경로가 자기 kind를 만든다 — Core가 provider 사건 어휘를 열거하지 않는다
    for (const ok of ['issue:19', 'census:owner/repo#19:2026-08-26T00:00:00Z', 'note:a-1']) {
      assert.equal(EventKey.safeParse(ok).success, true, `${ok} should be accepted`)
    }
    // 문법 자체가 아닌 것은 여전히 막는다. 대문자 kind를 막는 이유는 파일명 변환이
    // 대소문자를 뭉개는 저장소에서 서로 다른 키가 같은 파일이 되기 때문이다.
    for (const bad of ['issue', 'issue:', ':19', 'Issue:19', '9issue:1']) {
      assert.equal(EventKey.safeParse(bad).success, false, `${bad} should be rejected`)
    }
  })

  it('필수 필드 누락과 잘못된 enum을 거절한다', () => {
    assert.equal(ApprovalRequest.safeParse({ id: 'REQ-0042' }).success, false)
    assert.equal(Session.safeParse({ ...session(), status: 'SLEEPING' }).success, false)
    // 결정 가능한 선택지가 하나도 없는 요청은 만들 수 없다
    assert.equal(ApprovalRequest.safeParse({ ...request(), allowedDecisions: [] }).success, false)
  })

  it('nextId는 기존 최대 순번 다음을 준다', () => {
    assert.equal(nextId('REQ', ['REQ-0001', 'REQ-0042', 'G-0099']), 'REQ-0043')
    assert.equal(nextId('REQ', []), 'REQ-0001')
    assert.equal(nextId('G', ['G-0009']), 'G-0010')
  })
})
