// B-62 Gate — Checkpoint는 허가가 아니라 증거다 (C-13 §3).
//
// 지키는 문장 셋:
//   checkpoint를 발행했다는 이유로 멈추지 않는다
//   멈추는 근거는 미해소 상신뿐이고, 그것도 막힌 node에 한한다
//   blocker 서술은 판정에 쓰지 않는다 — 표면화까지다

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { Checkpoint, Session } from '../core/model/entities.ts'
import { Operator } from '../core/operator/proceed.ts'
import { collectSessions } from '../core/runtime/controller.ts'
import { EscalationLedger, proceedGateFacts } from '../core/runtime/escalation.ts'
import { SessionRuntime } from '../core/runtime/session.ts'

const NOW = '2026-08-26T21:00:00+09:00'
const SESSION = 'S-20260826-02'
const NODES = ['N1 렌더 구현', 'N2 외부 API 연동', 'N3 스키마']

const ledgerOn = (store: MemoryStateStore) => new EscalationLedger(store.scope('escalation'), () => NOW)

async function pausedSession(store: MemoryStateStore, blockers: string[] = []): Promise<void> {
  await store.create(
    'session',
    Session.parse({
      id: SESSION,
      version: 0,
      status: 'PAUSED',
      role: 'implementer',
      goal: '세 가지를 끝낸다',
      doneCriteria: NODES,
      checkpoint: Checkpoint.parse({
        position: 'N1 절반',
        nextAction: 'N1 마저',
        blockers,
        recordedAt: NOW,
      }),
    }),
  )
}

const operatorOn = (store: MemoryStateStore, escalations?: EscalationLedger) =>
  new Operator({
    store,
    sessions: new SessionRuntime(store, null, {}),
    ...(escalations ? { escalations } : {}),
    guard: async () => ({ ok: true }),
  })

const escalate = (ledger: EscalationLedger, blockedNodes: string[], id = 'ESC-20260826-01') =>
  ledger.open({
    escalationId: id,
    sessionId: SESSION,
    openedBy: 'impl-agent',
    predicates: ['secret_or_permission'],
    question: 'credential이 필요하다',
    evidenceRefs: ['docs/auth.md'],
    blockedNodes,
    doneCriteria: NODES,
  })

describe('B-62 Gate — checkpoint는 멈추는 근거가 아니다 (C-13 불변식 ④)', () => {
  it('상신이 없으면 checkpoint가 있어도 이어간다', async () => {
    const store = new MemoryStateStore()
    await pausedSession(store)

    const outcome = await operatorOn(store, ledgerOn(store)).proceed({ sessionId: SESSION })
    assert.equal(outcome.kind, 'RESUMED')
  })

  it('blocker 서술이 있어도 그것만으로는 멈추지 않는다 — 판정 입력이 아니다', async () => {
    const store = new MemoryStateStore()
    // 사람이 읽는 문장이다. 이걸 policy key로 해석해 자동 판정하면 문구를 바꾸는 것이
    // 곧 권한 변경이 된다 (C-13 불변식 ⑤).
    await pausedSession(store, ['git push 가 필요할 것 같다', '실서버 자격이 없다'])

    const outcome = await operatorOn(store, ledgerOn(store)).proceed({ sessionId: SESSION })
    assert.equal(outcome.kind, 'RESUMED')
  })

  it('원장을 주지 않으면 예전처럼 상태만 보고 간다', async () => {
    const store = new MemoryStateStore()
    await pausedSession(store)

    const outcome = await operatorOn(store).proceed({ sessionId: SESSION })
    assert.equal(outcome.kind, 'RESUMED')
    assert.equal('gate' in outcome && outcome.gate !== undefined, false)
  })
})

describe('B-62 Gate — 막힌 node만 멈춘다 (C-13 §6)', () => {
  it('일부만 막히면 계속 가고 Conditional로 보인다', async () => {
    const store = new MemoryStateStore()
    await pausedSession(store)
    const ledger = ledgerOn(store)
    await escalate(ledger, ['N2 외부 API 연동'])

    const outcome = await operatorOn(store, ledger).proceed({ sessionId: SESSION })
    assert.equal(outcome.kind, 'RESUMED', '전체 세션을 세우지 않는다')
    assert.equal('gate' in outcome && outcome.gate?.state, 'Conditional')
    assert.match(
      ('gate' in outcome ? (outcome.gate?.reasons ?? []) : []).join(' '),
      /N1 렌더 구현/,
      '무엇이 계속 가는지 이유에 남는다',
    )
  })

  it('실행 가능한 것이 하나도 없을 때만 멈춘다', async () => {
    const store = new MemoryStateStore()
    await pausedSession(store)
    const ledger = ledgerOn(store)
    await escalate(ledger, NODES)

    const outcome = await operatorOn(store, ledger).proceed({ sessionId: SESSION })
    assert.equal(outcome.kind, 'HELD')
    if (outcome.kind !== 'HELD') return
    assert.deepEqual(outcome.escalations, ['ESC-20260826-01'])
    assert.equal(outcome.verdict.state, 'Waiting')
  })

  it('멈춰도 전이를 일으키지 않는다 — 실패가 아니라 대기다', async () => {
    const store = new MemoryStateStore()
    await pausedSession(store)
    const ledger = ledgerOn(store)
    await escalate(ledger, NODES)

    await operatorOn(store, ledger).proceed({ sessionId: SESSION })
    const after = await store.get('session', SESSION)
    assert.equal(after!.status, 'PAUSED', '경계가 풀리면 그대로 이어진다')
    assert.equal(after!.version, 0)
  })

  it('상신이 닫히면 다시 간다', async () => {
    const store = new MemoryStateStore()
    await pausedSession(store)
    const ledger = ledgerOn(store)
    await escalate(ledger, NODES)
    await ledger.resolve('ESC-20260826-01', 'controller-a', 'REQ-0001:approve')

    const outcome = await operatorOn(store, ledger).proceed({ sessionId: SESSION })
    assert.equal(outcome.kind, 'RESUMED')
  })
})

describe('B-62 Gate — proceedGateFacts는 상신만 본다', () => {
  it('막힌 것과 계속 가는 것을 가른다', () => {
    const facts = proceedGateFacts(
      [
        {
          escalationId: 'ESC-1',
          sessionId: SESSION,
          openedBy: 'a',
          predicates: ['secret_or_permission'],
          question: 'q',
          evidenceRefs: ['e'],
          affectedNodes: [],
          blockedNodes: ['N2 외부 API 연동'],
          blockedScope: [],
          stillRunnableNodes: [],
          boundaryFingerprint: 'x',
          requestId: 'REQ-0001',
          openedAt: NOW,
        },
      ],
      NODES,
    )
    assert.deepEqual(facts.runnable, ['N1 렌더 구현', 'N3 스키마'])
    assert.match(facts.waitingOn[0]!, /secret_or_permission/)
    assert.match(facts.conditions[0]!, /still runnable/)
  })

  it('막힌 것이 없으면 조건도 없다', () => {
    const facts = proceedGateFacts([], NODES)
    assert.deepEqual(facts.runnable, NODES)
    assert.deepEqual(facts.waitingOn, [])
    assert.deepEqual(facts.conditions, [])
  })
})

describe('B-62 Gate — 상신과 blocker가 사람 화면에 뜬다', () => {
  it('미해소 상신이 Controller 화면에 올라온다', async () => {
    const store = new MemoryStateStore()
    await pausedSession(store)
    const ledger = ledgerOn(store)
    await escalate(ledger, ['N2 외부 API 연동'])

    const outcome = await collectSessions(store, NOW, { reclaimedBy: 'alice', escalationLedger: ledger })
    const awaiting = outcome.awaiting.join('\n')
    assert.match(awaiting, /ESC-20260826-01/)
    assert.match(awaiting, /secret_or_permission/)
    assert.match(awaiting, /계속 N1 렌더 구현/, '전부 멈춘 것처럼 읽히지 않는다')
  })

  it('멈춰 있는 세션의 blocker 서술도 표면화된다', async () => {
    const store = new MemoryStateStore()
    await pausedSession(store, ['실서버 자격이 없다'])

    const outcome = await collectSessions(store, NOW, { reclaimedBy: 'alice' })
    assert.match(outcome.awaiting.join('\n'), /진행 중 막힌 것 — 실서버 자격이 없다/)
  })
})

// B-64 Gate — 막힌 node만 멈춘다 (C-13 §6).
describe('B-64 Gate — Dependency-local Progress', () => {
  it('상신이 여럿이면 막힌 것이 합쳐지고 나머지는 간다', async () => {
    const store = new MemoryStateStore()
    await pausedSession(store)
    const ledger = ledgerOn(store)
    await escalate(ledger, ['N2 외부 API 연동'], 'ESC-20260826-01')
    await ledger.open({
      escalationId: 'ESC-20260826-02',
      sessionId: SESSION,
      openedBy: 'impl-agent',
      predicates: ['ownership_boundary'],
      question: 'api 스키마는 backend 소관이다',
      evidenceRefs: ['profile ownership'],
      blockedNodes: ['N3 스키마'],
      blockedScope: ['api/**'],
      doneCriteria: NODES,
    })

    const outcome = await operatorOn(store, ledgerOn(store)).proceed({ sessionId: SESSION })
    assert.equal(outcome.kind, 'RESUMED', 'N1이 남아 있으므로 계속 간다')
    assert.equal('gate' in outcome && outcome.gate?.state, 'Conditional')

    const facts = proceedGateFacts(await ledgerOn(store).pending(), NODES)
    assert.deepEqual(facts.runnable, ['N1 렌더 구현'])
    assert.equal(facts.waitingOn.length, 2, '두 상신이 각각 이유로 남는다')
  })

  it('마지막 하나까지 막히면 그때 멈춘다', async () => {
    const store = new MemoryStateStore()
    await pausedSession(store)
    const ledger = ledgerOn(store)
    await escalate(ledger, ['N1 렌더 구현', 'N2 외부 API 연동'], 'ESC-20260826-01')

    const partial = await operatorOn(store, ledgerOn(store)).proceed({ sessionId: SESSION })
    assert.equal(partial.kind, 'RESUMED', 'N3이 남아 있다')

    await ledger.open({
      escalationId: 'ESC-20260826-02',
      sessionId: SESSION,
      openedBy: 'impl-agent',
      predicates: ['ownership_boundary'],
      question: 'N3도 남의 영역이다',
      evidenceRefs: ['profile ownership'],
      blockedNodes: ['N3 스키마'],
      doneCriteria: NODES,
    })

    const held = await operatorOn(store, ledgerOn(store)).proceed({ sessionId: SESSION })
    assert.equal(held.kind, 'HELD')
    if (held.kind !== 'HELD') return
    assert.equal(held.escalations.length, 2)
  })

  it('하나가 풀리면 그 node만 다시 살아난다', async () => {
    const store = new MemoryStateStore()
    await pausedSession(store)
    const ledger = ledgerOn(store)
    await escalate(ledger, ['N1 렌더 구현', 'N2 외부 API 연동'], 'ESC-20260826-01')
    await ledger.open({
      escalationId: 'ESC-20260826-02',
      sessionId: SESSION,
      openedBy: 'impl-agent',
      predicates: ['ownership_boundary'],
      question: 'N3',
      evidenceRefs: ['e'],
      blockedNodes: ['N3 스키마'],
      doneCriteria: NODES,
    })
    await ledger.resolve('ESC-20260826-02', 'alice', 'REQ-0002:approve')

    const facts = proceedGateFacts(await ledgerOn(store).pending(), NODES)
    assert.deepEqual(facts.runnable, ['N3 스키마'], '닫힌 상신의 node만 살아난다')
  })

  it('다른 세션의 상신은 이 세션을 막지 않는다', async () => {
    const store = new MemoryStateStore()
    await pausedSession(store)
    const ledger = ledgerOn(store)
    await ledger.open({
      escalationId: 'ESC-20260826-09',
      sessionId: 'S-20260826-09',
      openedBy: 'other-agent',
      predicates: ['secret_or_permission'],
      question: '남의 세션 사정',
      evidenceRefs: ['e'],
      blockedNodes: NODES,
      doneCriteria: NODES,
    })

    const outcome = await operatorOn(store, ledgerOn(store)).proceed({ sessionId: SESSION })
    assert.equal(outcome.kind, 'RESUMED')
  })
})
