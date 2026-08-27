// B-25 Gate — 결정이 Agent 사이를 도는 것을 구조로 막는지.
//
// 가장 중요한 검사 둘: ① 되던지기가 발행 시점에 걸리는가 ② DECIDE를 받아도 아무 권한이
// 생기지 않는가. 후자가 무너지면 이 모듈은 승인 우회로가 된다 (C-03 §4).

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { Session } from '../core/model/entities.ts'
import { collectSessions } from '../core/runtime/controller.ts'
import { QueryLedger } from '../core/runtime/query.ts'

const NOW = '2026-08-26T10:00:00+09:00'

const OWNERSHIP = {
  frontend: { paths: ['web-frontend/**'], authorities: ['client-ui', 'client-routing'] },
  backend: { paths: ['backend/**'], authorities: ['api-contract', 'auth-server-policy'] },
  product: { paths: [], authorities: ['product-policy'] },
}

const ledgerOn = (store: MemoryStateStore, ownership: typeof OWNERSHIP | undefined = OWNERSHIP) =>
  new QueryLedger(store.scope('query'), ownership, () => NOW)

const feAsk = {
  id: 'X-20260826-01',
  ownerSessionId: 'S-20260826-01',
  ownerRole: 'frontend',
  requestedAuthority: 'api-contract',
  question: 'callback 성공 판정은 accessToken 존재인가 session cookie 존재인가?',
  proposedDefault: 'session cookie',
  blockingScope: 'RequireAuth callback 처리',
} as const

describe('B-25 Gate — Bounded Query (C-04 §3)', () => {
  it('묻고, 그 결정의 주인이 답하면 흐름이 물은 쪽으로 돌아온다', async () => {
    const ledger = ledgerOn(new MemoryStateStore())
    const opened = await ledger.open(feAsk)
    assert.ok(opened.ok)

    const answered = await ledger.answer(feAsk.id, {
      kind: 'DECIDE',
      byRole: 'backend',
      body: 'session cookie 존재로 판정한다',
    })
    assert.ok(answered.ok)
    // 답을 받아도 물은 쪽은 그대로다 — owner는 여기서 바뀌지 않는다
    assert.equal(answered.query.ownerSessionId, 'S-20260826-01')
    assert.equal(answered.query.ownerRole, 'frontend')
  })

  it('주인이 아니면 DECIDE할 수 없다 — 무엇으로 종결해야 하는지 말해 준다', async () => {
    const ledger = ledgerOn(new MemoryStateStore())
    await ledger.open(feAsk)
    const refused = await ledger.answer(feAsk.id, {
      kind: 'DECIDE',
      byRole: 'product',
      body: '내가 정하겠다',
    })
    assert.ok(!refused.ok)
    assert.equal(refused.reason, 'FORBIDDEN_AUTHORITY')
    assert.match(refused.detail, /그 결정의 주인은 'backend' 이다/)
    assert.match(refused.detail, /ANSWER.*ESCALATE/)
  })

  it('주인이 선언되지 않은 결정은 아무도 DECIDE하지 못한다', async () => {
    const ledger = ledgerOn(new MemoryStateStore())
    await ledger.open({ ...feAsk, requestedAuthority: 'oauth-policy' })
    const refused = await ledger.answer(feAsk.id, { kind: 'DECIDE', byRole: 'backend', body: 'x' })
    assert.ok(!refused.ok)
    assert.equal(refused.reason, 'FORBIDDEN_AUTHORITY')
  })

  it('권한이 없어도 ANSWER와 ESCALATE는 할 수 있다', async () => {
    const ledger = ledgerOn(new MemoryStateStore())
    await ledger.open(feAsk)
    const answered = await ledger.answer(feAsk.id, {
      kind: 'ESCALATE',
      byRole: 'product',
      body: '제품 정책 결정이 선행한다',
      escalateTo: 'controller-a',
    })
    assert.ok(answered.ok)
    assert.equal(answered.answer.escalateTo, 'controller-a')
  })

  it('답은 한 번만 쓰인다 — 동시에 답해도 먼저 쓴 것이 남는다', async () => {
    const ledger = ledgerOn(new MemoryStateStore())
    await ledger.open(feAsk)
    const [a, b] = await Promise.all([
      ledger.answer(feAsk.id, { kind: 'ANSWER', byRole: 'backend', body: '첫 번째' }),
      ledger.answer(feAsk.id, { kind: 'ANSWER', byRole: 'backend', body: '두 번째' }),
    ])
    const outcomes = [a, b]
    assert.equal(outcomes.filter((o) => o.ok).length, 1)
    const rejected = outcomes.find((o) => !o.ok)!
    assert.equal(rejected.ok, false)
    assert.equal((rejected as { reason: string }).reason, 'ALREADY_ANSWERED')
  })

  it('질의 id 형식이 아니면 열지 않는다', async () => {
    const ledger = ledgerOn(new MemoryStateStore())
    const bad = await ledger.open({ ...feAsk, id: 'X-1' })
    assert.ok(!bad.ok)
    assert.equal(bad.reason, 'INVALID_ID')
    assert.match(bad.detail, /X-YYYYMMDD-NN/)
  })
})

describe('B-25 Gate — One-hop · Circular (C-04 §4·§5)', () => {
  it('받은 결정을 제3자에게 넘기면 발행 시점에 막힌다', async () => {
    const ledger = ledgerOn(new MemoryStateStore())
    await ledger.open(feAsk)

    // BE가 답하는 대신 product에게 같은 결정을 넘긴다
    const relayed = await ledger.open({
      id: 'X-20260826-02',
      ownerSessionId: 'S-20260826-02',
      ownerRole: 'backend',
      requestedAuthority: 'product-policy',
      question: '이건 제품 정책 아닌가요?',
      inReplyTo: feAsk.id,
    })
    assert.ok(!relayed.ok)
    assert.equal(relayed.reason, 'ONE_HOP_VIOLATION')
    assert.match(relayed.detail, /DECIDE \/ ANSWER \/ ESCALATE 뿐/)
  })

  it('같은 결정이 물은 쪽으로 되돌아오면 순환으로 잡는다', async () => {
    const ledger = ledgerOn(new MemoryStateStore())
    await ledger.open(feAsk)

    const bounced = await ledger.open({
      id: 'X-20260826-03',
      ownerSessionId: 'S-20260826-02',
      ownerRole: 'backend',
      requestedAuthority: 'client-ui', // frontend — 원래 물은 쪽이다
      question: 'FE가 정해야 하지 않나요?',
      inReplyTo: feAsk.id,
    })
    assert.ok(!bounced.ok)
    assert.equal(bounced.reason, 'CIRCULAR_DELEGATION')
    assert.match(bounced.detail, /'client-ui' 를 다시 frontend 에게 묻고 있다/)
    assert.match(bounced.detail, /원 요청 'api-contract' 을 DECIDE \/ ANSWER \/ ESCALATE 중 하나로 종결하라/)
  })

  it('물은 쪽이 답을 받고 다시 묻는 것은 여전히 1 hop이다', async () => {
    const ledger = ledgerOn(new MemoryStateStore())
    await ledger.open(feAsk)
    await ledger.answer(feAsk.id, { kind: 'DECIDE', byRole: 'backend', body: 'session cookie' })

    const followUp = await ledger.open({
      id: 'X-20260826-04',
      ownerSessionId: feAsk.ownerSessionId,
      ownerRole: 'frontend',
      requestedAuthority: 'auth-server-policy',
      question: '만료는 서버가 어떻게 처리하나?',
      inReplyTo: feAsk.id,
    })
    assert.ok(followUp.ok)
  })

  it('원 질의가 없으면 파생 질의를 열지 않는다', async () => {
    const ledger = ledgerOn(new MemoryStateStore())
    const orphan = await ledger.open({ ...feAsk, id: 'X-20260826-05', inReplyTo: 'X-20260826-99' })
    assert.ok(!orphan.ok)
    assert.equal(orphan.reason, 'ORIGIN_NOT_FOUND')
  })

  it('막힌 시도는 기록으로 남는다 — 막았다고 없던 일이 아니다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.open(feAsk)
    await ledger.open({
      id: 'X-20260826-06',
      ownerSessionId: 'S-20260826-02',
      ownerRole: 'backend',
      requestedAuthority: 'client-ui',
      question: 'FE가 정해야 하지 않나요?',
      inReplyTo: feAsk.id,
    })
    const violations = await ledger.violations()
    assert.equal(violations.length, 1)
    assert.equal(violations[0]?.kind, 'CIRCULAR_DELEGATION')
    assert.equal(violations[0]?.originId, feAsk.id)
  })
})

describe('B-25 Gate — DECIDE는 어떤 권한도 만들지 않는다 (C-04 §3.4)', () => {
  it('DECIDE를 받아도 세션·승인·Grant 어느 것도 생기거나 바뀌지 않는다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    const created = await store.create(
      'session',
      Session.parse({
        id: 'S-20260826-01',
        version: 0,
        status: 'ACTIVE',
        role: 'implementer',
        goal: 'FE callback',
        owner: 'frontend',
        writeBoundary: ['web-frontend/**'],
        decisionDomains: ['api-contract'],
      }),
    )
    assert.ok(created.ok)

    await ledger.open(feAsk)
    const answered = await ledger.answer(feAsk.id, {
      kind: 'DECIDE',
      byRole: 'backend',
      body: 'session cookie 존재로 판정한다',
    })
    assert.ok(answered.ok)

    const after = await store.get('session', 'S-20260826-01')
    assert.equal(after?.owner, 'frontend')
    assert.deepEqual(after?.writeBoundary, ['web-frontend/**'])
    assert.deepEqual(after?.policyExceptions, [])
    assert.equal(after?.version, 0) // 전이 자체가 없다
    assert.equal((await store.list('request')).length, 0)
    assert.equal((await store.list('grant')).length, 0)
  })
})

describe('B-25 Gate — 표면화 (C-04 §5.2)', () => {
  it('답을 기다리는 질의와 막힌 되던지기가 회수에 올라온다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.open(feAsk)
    await ledger.open({
      id: 'X-20260826-07',
      ownerSessionId: 'S-20260826-02',
      ownerRole: 'backend',
      requestedAuthority: 'client-ui',
      question: 'FE가 정해야 하지 않나요?',
      inReplyTo: feAsk.id,
    })

    const outcome = await collectSessions(store, NOW, { queryLedger: ledger })
    const text = outcome.awaiting.join('\n')
    assert.match(text, /답을 기다리는 질의 X-20260826-01/)
    assert.match(text, /막힘: RequireAuth callback 처리/)
    assert.match(text, /CIRCULAR_DELEGATION: X-20260826-07/)
  })

  it('순환을 잡아도 회수는 정상 종료한다 — 실행 중 세션을 끊지 않는다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.open(feAsk)
    const outcome = await collectSessions(store, NOW, { queryLedger: ledger })
    assert.deepEqual(outcome.collected, [])
    assert.equal(outcome.awaiting.length, 1)
  })

  it('답이 오면 회수에서 내려간다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.open(feAsk)
    await ledger.answer(feAsk.id, { kind: 'DECIDE', byRole: 'backend', body: 'session cookie' })
    const outcome = await collectSessions(store, NOW, { queryLedger: ledger })
    assert.deepEqual(outcome.awaiting, [])
  })

  it('질의를 쓰지 않는 프로젝트는 아무 영향도 받지 않는다', async () => {
    const outcome = await collectSessions(new MemoryStateStore(), NOW)
    assert.deepEqual(outcome.awaiting, [])
  })
})

describe('Core 독립성 — query', () => {
  it('provider 어휘가 새지 않는다', async () => {
    const source = await readFile(new URL('../core/runtime/query.ts', import.meta.url), 'utf8')
    for (const word of ['github', 'claude', 'mattermost', 'jira']) {
      assert.doesNotMatch(source.toLowerCase(), new RegExp(word))
    }
  })
})
