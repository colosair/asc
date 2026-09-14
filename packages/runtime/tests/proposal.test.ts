// 0.10.0 P3 — 발급 전 초안은 보존되고, 사람은 id 하나로 발급한다.
//
// dogfood 2026-09-13 F1: 발급이 Controller 의 것일 때 사람이 받은 것은 결정이 아니라 agent 초안
// 전체의 재타이핑이었다. 여기서 고정하는 것은 lifecycle 과 발급 기록의 분리다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { Operator, type WorkIngress } from '../core/operator/proceed.ts'
import { ContractProposal, ProposalLedger, fingerprintMatches } from '../core/operator/proposal.ts'
import { DelegationRecord } from '../core/runtime/audit.ts'
import { SessionRuntime } from '../core/runtime/session.ts'
import type { SessionContractDraft, SessionContractPlan } from '../core/operator/contract-draft.ts'
import type { ResourceSnapshot } from '../ports/resource-context.ts'

const draft: SessionContractDraft = {
  id: 'S-20260914-01',
  role: 'implementer',
  goal: 'PROJ-1: 첫 일',
  boundary: ['fe/src/**'],
  criteria: ['테스트가 있다'],
  provenance: [{ field: 'goal', status: 'FACT', source: 'work_item' }],
}

let tick = 0
const ledgerOf = (store: MemoryStateStore) =>
  new ProposalLedger(store.scope('proposals'), () => new Date(Date.UTC(2026, 8, 14, 0, 0, tick++)).toISOString())

describe('ProposalLedger — CREATED → ISSUED | REVISED | REJECTED | OBSOLETE', () => {
  it('만들고, 발급하면 ISSUED 로 닫히고, 닫힌 것은 다시 닫히지 않는다', async () => {
    const ledger = ledgerOf(new MemoryStateStore())
    const created = await ledger.create({ id: 'S-1', workRef: 'PROJ-1', draft, createdBy: 'run-a' })
    assert.equal(created.ok, true)
    assert.deepEqual((await ledger.open()).map((p) => p.id), ['S-1'])
    const issued = await ledger.close('S-1', { status: 'ISSUED', issuedSessionId: 'S-1' })
    assert.equal(issued.ok && issued.proposal.status, 'ISSUED')
    assert.deepEqual(await ledger.open(), [])
    const again = await ledger.close('S-1', { status: 'REJECTED', reason: 'late' })
    assert.equal(again.ok === false && again.reason, 'NOT_OPEN')
  })

  it('같은 작업 항목의 새 제안은 이전 것을 REVISED 로 닫는다 — 열린 제안은 하나다', async () => {
    const ledger = ledgerOf(new MemoryStateStore())
    await ledger.create({ id: 'S-1', workRef: 'PROJ-1', draft })
    const next = await ledger.create({ id: 'S-2', workRef: 'PROJ-1', draft: { ...draft, id: 'S-2' } })
    assert.ok(next.ok && next.revised.includes('S-1'))
    assert.equal((await ledger.get('S-1'))?.status, 'REVISED')
    assert.equal((await ledger.get('S-1'))?.supersededBy, 'S-2')
    assert.deepEqual((await ledger.open()).map((p) => p.id), ['S-2'])
    // 다른 작업 항목은 건드리지 않는다
    await ledger.create({ id: 'S-3', workRef: 'PROJ-9', draft: { ...draft, id: 'S-3' } })
    assert.equal((await ledger.get('S-2'))?.status, 'CREATED')
  })

  it('같은 id 는 두 번 만들지 않는다', async () => {
    const ledger = ledgerOf(new MemoryStateStore())
    await ledger.create({ id: 'S-1', draft })
    assert.equal((await ledger.create({ id: 'S-1', draft })).ok, false)
  })

  it('거절과 폐기는 이유를 남긴다', async () => {
    const ledger = ledgerOf(new MemoryStateStore())
    await ledger.create({ id: 'S-1', draft })
    await ledger.create({ id: 'S-2', draft })
    assert.equal((await ledger.close('S-1', { status: 'REJECTED', reason: '범위가 넓다' })).ok, true)
    assert.equal((await ledger.close('S-2', { status: 'OBSOLETE', reason: '항목이 바뀌었다' })).ok, true)
    assert.equal((await ledger.get('S-1'))?.reason, '범위가 넓다')
    assert.equal((await ledger.get('S-2'))?.status, 'OBSOLETE')
  })

  it('작업 항목 지문 — 모르는 것은 다르다고 하지 않고, 아는 것이 다르면 다르다', () => {
    assert.equal(fingerprintMatches(undefined, { title: 'x' }), true)
    assert.equal(fingerprintMatches({ title: 'a' }, {}), true)
    assert.equal(fingerprintMatches({ title: 'a' }, { title: 'a' }), true)
    assert.equal(fingerprintMatches({ title: 'a' }, { title: 'b' }), false)
    assert.equal(fingerprintMatches({ trackerDone: false }, { trackerDone: true }), false)
  })

  it('저장형은 스키마를 지난다 — Run 이 끊겨도 제안은 남는다 (createdBy 는 기록일 뿐)', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOf(store)
    await ledger.create({ id: 'S-1', draft, createdBy: 'run-gone' })
    const raw = await store.scope('proposals').get('proposal:S-1')
    const parsed = ContractProposal.parse(JSON.parse(raw!))
    assert.equal(parsed.createdBy, 'run-gone')
    assert.equal(parsed.status, 'CREATED')
  })
})

describe('proceed — 발급이 Controller 의 것이면 제안을 보존한다', () => {
  const workItem: ResourceSnapshot = {
    reference: 'PROJ-1',
    state: '진행 중',
    title: '첫 일',
    updatedAt: '2026-09-14T00:00:00Z',
    revisionMarker: 'r1',
  }
  const plan = (authority: 'controller' | 'delegated'): SessionContractPlan => ({
    status: 'READY_TO_ISSUE',
    draft,
    facts: [],
    proposals: [],
    unresolved: [],
    issuance: { authority, delegatedRoles: authority === 'delegated' ? ['implementer'] : [], detail: 'fixture' },
    invalid: [],
  })
  const harness = (authority: 'controller' | 'delegated', withLedger = true) => {
    const store = new MemoryStateStore()
    const sessions = new SessionRuntime(store)
    let seenDraft: SessionContractDraft | undefined
    const ingress: WorkIngress = {
      gather: async () => ({ workItem, trackerDone: false, comments: [], change: 'UNAVAILABLE' }),
      observeRepo: async () => ({
        branch: 'front',
        remotes: [],
        freshness: { state: 'FRESH' },
        refs: [],
        canonicalRef: 'origin/develop',
        mergedIntoCanonical: false,
        pathsExist: {},
      }),
      derive: () => ({ ...draft, criteria: [] }),
      usedIds: async () => [],
      plan: async (d) => {
        seenDraft = d
        return plan(authority)
      },
      issue: async (d) => {
        const issued = await sessions.issue({ id: d.id!, role: 'implementer', goal: d.goal ?? '', doneCriteria: [...(d.criteria ?? [])] })
        return issued.ok ? { ok: true, sessionId: issued.session.id } : { ok: false, detail: 'x' }
      },
    }
    const ledger = ledgerOf(store)
    const operator = new Operator({
      store,
      sessions,
      ingress,
      guard: async () => ({ ok: true }),
      ...(withLedger ? { proposals: ledger, runId: 'run-a' } : {}),
    })
    return { store, operator, ledger, seen: () => seenDraft }
  }

  it('제안이 저장되고 outcome 이 그 id 를 든다 — 세션은 아직 없다', async () => {
    const h = harness('controller')
    const outcome = await h.operator.proceed({ workRef: 'PROJ-1', fill: { criteria: ['테스트가 있다'] } })
    assert.equal(outcome.kind, 'PROPOSE_CONTRACT')
    if (outcome.kind !== 'PROPOSE_CONTRACT') return
    assert.equal(outcome.proposal?.id, 'S-20260914-01')
    assert.ok(outcome.forController, 'advanced 표면(JSON) 에는 명령이 남는다')
    const saved = await h.ledger.get('S-20260914-01')
    assert.equal(saved?.status, 'CREATED')
    assert.equal(saved?.workRef, 'PROJ-1')
    assert.equal(saved?.createdBy, 'run-a')
    assert.deepEqual(saved?.workItem, { title: '첫 일', trackerDone: false })
    assert.deepEqual(saved?.draft.criteria, ['테스트가 있다'], 'agent 가 채운 값이 초안에 실려 보존된다')
    assert.equal((await h.store.list('session')).length, 0)
  })

  it('agent 가 채운 값은 출처와 함께 plan 에 간다 — 적지 않으면 제안으로 분류될 뿐 사실이 되지 않는다', async () => {
    const h = harness('controller')
    await h.operator.proceed({
      workRef: 'PROJ-1',
      fill: { criteria: ['a'], provenance: [{ field: 'criteria', status: 'FACT', source: 'work_item' }] },
    })
    const seen = h.seen()
    assert.deepEqual(seen?.criteria, ['a'])
    assert.ok(seen?.provenance?.some((p) => p.field === 'criteria' && p.status === 'FACT'))
    assert.ok(seen?.provenance?.some((p) => p.field === 'goal'), '파생된 출처는 남는다')
  })

  it('위임됐으면 제안 없이 발급까지 간다 (기존 경로)', async () => {
    const h = harness('delegated')
    const outcome = await h.operator.proceed({ workRef: 'PROJ-1' })
    assert.equal(outcome.kind, 'STARTED')
    assert.deepEqual(await h.ledger.open(), [])
  })

  it('장부가 없으면 예전처럼 명령만 건넨다 (기존 호출자 무손상)', async () => {
    const h = harness('controller', false)
    const outcome = await h.operator.proceed({ workRef: 'PROJ-1' })
    assert.equal(outcome.kind === 'PROPOSE_CONTRACT' && outcome.proposal, undefined)
    assert.ok(outcome.kind === 'PROPOSE_CONTRACT' && outcome.forController)
  })
})

describe('발급 기록 — 발급자와 권한 근거는 다른 칸이다', () => {
  it('DelegationRecord 는 authority·delegatedBy·recordedBy·proposalId 를 받고, 없어도 읽힌다', () => {
    const old = DelegationRecord.parse({
      delegationId: 'D-1',
      childSessionId: 'S-20260914-01',
      role: 'implementer',
      goal: 'g',
      issuedBy: 'colosair',
      issuedAt: '2026-09-14T00:00:00Z',
    })
    assert.equal(old.authority, undefined)
    const now = DelegationRecord.parse({
      ...old,
      issuedBy: 'run:abc',
      authority: 'delegated',
      delegatedBy: 'policy:issuanceDelegation (colosair)',
      recordedBy: 'abc',
    })
    assert.equal(now.authority, 'delegated')
    assert.notEqual(now.issuedBy, now.delegatedBy)
  })
})

// 0.10.2 — 닫힌 제안의 id 는 쓴 id 다. 0.10.1 게시본 acceptance 에서 거절된 제안과 같은 id 로 새 초안이
// 나와 저장이 조용히 실패했고, 화면은 "보존했다" 고 말했다.
describe('제안 id 는 겹치지 않고, 저장 실패는 저장했다고 말하지 않는다', () => {
  it('ledger.ids() 는 닫힌 제안까지 든다', async () => {
    const ledger = ledgerOf(new MemoryStateStore())
    await ledger.create({ id: 'S-1', draft })
    await ledger.close('S-1', { status: 'REJECTED', reason: 'x' })
    assert.deepEqual(await ledger.ids(), ['S-1'])
  })

  it('같은 id 의 제안이 이미 있으면 outcome 에 proposal 이 없고 forController 만 남는다', async () => {
    const store = new MemoryStateStore()
    const sessions = new SessionRuntime(store)
    const ledger = ledgerOf(store)
    await ledger.create({ id: 'S-20260914-01', draft })
    await ledger.close('S-20260914-01', { status: 'REJECTED', reason: 'x' })
    const workItem: ResourceSnapshot = { reference: 'PROJ-1', state: 's', title: '첫 일', updatedAt: 'u', revisionMarker: 'r' }
    const ingress: WorkIngress = {
      gather: async () => ({ workItem, trackerDone: false, comments: [], change: 'UNAVAILABLE' }),
      observeRepo: async () => ({ branch: 'b', remotes: [], refs: [], canonicalRef: 'origin/develop', freshness: { state: 'FRESH' }, pathsExist: {}, mergedIntoCanonical: false }),
      derive: () => draft,
      usedIds: async () => [],
      plan: async (d) => ({ status: 'READY_TO_ISSUE', draft: d, facts: [], proposals: [], unresolved: [], issuance: { authority: 'controller', delegatedRoles: [], detail: 'f' }, invalid: [] }),
      issue: async () => ({ ok: false, detail: 'unused' }),
    }
    const operator = new Operator({ store, sessions, ingress, guard: async () => ({ ok: true }), proposals: ledger })
    const outcome = await operator.proceed({ workRef: 'PROJ-1' })
    assert.equal(outcome.kind, 'PROPOSE_CONTRACT')
    if (outcome.kind !== 'PROPOSE_CONTRACT') return
    assert.equal(outcome.proposal, undefined)
    assert.ok(outcome.forController)
    assert.equal((await ledger.get('S-20260914-01'))?.status, 'REJECTED', '닫힌 제안을 덮지 않는다')
  })
})
