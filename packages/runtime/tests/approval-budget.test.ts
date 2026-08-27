// B-63 Gate — 같은 경계를 표현만 바꿔 두 번 올리지 않는다 (C-13 §5).
//
// 그리고 승인 없이 간 결정은 기록이 남는다 — 승인이 없었다는 것이 근거가 없어도 된다는
// 뜻은 아니다 (C-13 §4).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { AuditLedger, decisionLines } from '../core/runtime/audit.ts'
import { EscalationLedger } from '../core/runtime/escalation.ts'

const NOW = '2026-08-26T21:00:00+09:00'
const SESSION = 'S-20260826-02'
const NODES = ['N1 렌더', 'N2 API 연동', 'N3 스키마']

const escalations = (store: MemoryStateStore) => new EscalationLedger(store.scope('escalation'), () => NOW)
const audit = (store: MemoryStateStore) => new AuditLedger(store.scope('audit'), () => NOW)

const first = (over: Record<string, unknown> = {}) => ({
  escalationId: 'ESC-20260826-01',
  sessionId: SESSION,
  openedBy: 'impl-agent',
  predicates: ['secret_or_permission'],
  question: 'OAuth credential이 필요하다',
  evidenceRefs: ['docs/auth.md'],
  blockedNodes: ['N2 API 연동'],
  doneCriteria: NODES,
  ...over,
})

describe('B-63 Gate — 같은 경계는 한 번만 (C-13 §5)', () => {
  it('표현을 바꿔도 같은 경계면 두 번째 request가 생기지 않는다', async () => {
    const store = new MemoryStateStore()
    const ledger = escalations(store)
    await ledger.open(first())

    const again = await ledger.open(
      first({ escalationId: 'ESC-20260826-02', question: '자격 좀 주세요 (다시 여쭙니다)' }),
    )
    assert.equal(again.ok, false)
    if (again.ok) return
    assert.equal(again.reason, 'DUPLICATE_EPISODE')
    assert.equal(again.existing?.escalationId, 'ESC-20260826-01')
    assert.equal((await ledger.pending()).length, 1, '사람에게 가는 것은 하나뿐이다')
  })

  it('근거만 더 붙인 재상신은 거절한다 (불변식 ⑧)', async () => {
    const store = new MemoryStateStore()
    const ledger = escalations(store)
    await ledger.open(first())

    const resubmit = await ledger.open(
      first({
        escalationId: 'ESC-20260826-02',
        evidenceRefs: ['docs/auth.md', 'docs/auth.md#추가-근거'],
        previousEscalationId: 'ESC-20260826-01',
        whyPreviousDecisionDoesNotCoverThis: '근거를 더 찾았다',
      }),
    )
    assert.equal(resubmit.ok, false)
    if (resubmit.ok) return
    // 미해소 중복 검사가 먼저 걸린다 — 어느 쪽이든 "같은 경계라 거절"이 요지다
    assert.equal(resubmit.reason, 'DUPLICATE_EPISODE')
    assert.match(resubmit.detail, /같은 경계/)
  })

  it('경계가 실제로 다르면 올릴 수 있다', async () => {
    const store = new MemoryStateStore()
    const ledger = escalations(store)
    await ledger.open(first())

    const next = await ledger.open(
      first({
        escalationId: 'ESC-20260826-02',
        predicates: ['shared_contract_change'],
        question: 'Backend API 응답 형식을 바꿔야 한다',
        evidenceRefs: ['api/schema.md'],
        blockedNodes: ['N3 스키마'],
        previousEscalationId: 'ESC-20260826-01',
        whyPreviousDecisionDoesNotCoverThis: '자격 문제가 아니라 계약 변경이다',
      }),
    )
    assert.equal(next.ok, true)
    if (!next.ok) return
    assert.equal(next.record.previousEscalationId, 'ESC-20260826-01')
  })

  it('새 경계여도 새 근거가 없으면 거절한다', async () => {
    const store = new MemoryStateStore()
    const ledger = escalations(store)
    await ledger.open(first())

    const next = await ledger.open(
      first({
        escalationId: 'ESC-20260826-02',
        predicates: ['shared_contract_change'],
        blockedNodes: ['N3 스키마'],
        previousEscalationId: 'ESC-20260826-01',
        whyPreviousDecisionDoesNotCoverThis: '다른 사안이다',
      }),
    )
    assert.equal(next.ok, false)
    if (next.ok) return
    assert.match(next.detail, /이전에 없던 근거가 없다/)
  })

  it('왜 앞선 결정이 이걸 못 덮는지 적지 않으면 거절한다', async () => {
    const store = new MemoryStateStore()
    const ledger = escalations(store)
    await ledger.open(first())

    const next = await ledger.open(
      first({
        escalationId: 'ESC-20260826-02',
        predicates: ['shared_contract_change'],
        blockedNodes: ['N3 스키마'],
        evidenceRefs: ['api/schema.md'],
        previousEscalationId: 'ESC-20260826-01',
      }),
    )
    assert.equal(next.ok, false)
    if (next.ok) return
    assert.match(next.detail, /왜 이걸 덮지 못하는지/)
  })

  it('거절된 재상신도 기록에 남는다', async () => {
    const store = new MemoryStateStore()
    const ledger = escalations(store)
    await ledger.open(first())
    await ledger.open(first({ escalationId: 'ESC-20260826-02' }))

    const rejected = await ledger.rejected()
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0]!.reason, 'DUPLICATE_EPISODE')
  })

  it('앞선 상신이 닫히면 같은 경계를 다시 올릴 수 있다', async () => {
    const store = new MemoryStateStore()
    const ledger = escalations(store)
    await ledger.open(first())
    await ledger.resolve('ESC-20260826-01', 'controller-a', 'REQ-0001:defer')

    // 닫힌 뒤 같은 경계가 다시 문제가 되는 것은 새 사건이다 — 미해소 중복만 막는다
    const again = await ledger.open(first({ escalationId: 'ESC-20260826-03' }))
    assert.equal(again.ok, true)
  })
})

describe('B-63 Gate — 승인 없이 간 결정도 기록이 남는다 (C-13 §4)', () => {
  const decision = (over: Record<string, unknown> = {}) => ({
    sessionId: SESSION,
    actor: 'impl-agent',
    ownership: ['web/**'],
    class: 'implementation_detail' as const,
    evidenceRefs: ['compose가 PUBLIC_API_BASE_URL 을 주입한다'] as [string, ...string[]],
    selectedOption: 'runtime-config.js',
    alternatives: ['index.html 치환'],
    whyNoApproval: ['owned scope 안', '공유 계약 무변경', '되돌릴 수 있다'] as [string, ...string[]],
    verification: ['같은 이미지로 URL A/B 재기동 확인'],
    ...over,
  })

  it('무엇을 골랐고 무엇과 견줬고 왜 안 물었는지가 남는다', async () => {
    const store = new MemoryStateStore()
    const ledger = audit(store)

    const recorded = await ledger.decide(decision())
    assert.equal(recorded.decision.decisionId, `D-${SESSION}-1`)
    assert.deepEqual(recorded.decision.alternatives, ['index.html 치환'])

    const restored = (await ledger.decisionsOf(SESSION))[0]!
    assert.equal(restored.selectedOption, 'runtime-config.js')
    assert.deepEqual(restored.whyNoApproval, ['owned scope 안', '공유 계약 무변경', '되돌릴 수 있다'])
    assert.deepEqual(restored.verification, ['같은 이미지로 URL A/B 재기동 확인'])
  })

  it('여러 결정이 순서대로 쌓인다', async () => {
    const store = new MemoryStateStore()
    const ledger = audit(store)
    await ledger.decide(decision())
    await ledger.decide(decision({ selectedOption: 'vitest', class: 'local_test_strategy' }))

    assert.deepEqual(
      (await ledger.decisionsOf(SESSION)).map((d) => d.selectedOption),
      ['runtime-config.js', 'vitest'],
    )
  })

  it('사람이 읽는 줄에 승인 불필요 근거가 함께 온다', async () => {
    const store = new MemoryStateStore()
    const ledger = audit(store)
    const recorded = await ledger.decide(decision())

    const rendered = decisionLines([recorded.decision]).join('\n')
    assert.match(rendered, /implementation_detail/)
    assert.match(rendered, /견준 것: index\.html 치환/)
    assert.match(rendered, /승인 불필요 근거/)
  })

  it('결정이 없으면 없다고 적는다', () => {
    assert.deepEqual(decisionLines([]), ['  자율 결정 기록 없음'])
  })

  it('승인 없이 간 결정과 올린 상신이 같은 세션에서 나란히 남는다', async () => {
    const store = new MemoryStateStore()
    await audit(store).decide(decision())
    await escalations(store).open(first())

    // 자율 판단 1건 + 경계 상신 1건 — 이 비율이 곧 "Approval은 예외"의 증거다
    assert.equal((await audit(store).decisionsOf(SESSION)).length, 1)
    assert.equal((await escalations(store).pending()).length, 1)
  })
})
