// B-07 Gate — APPROVED → Grant READY → atomic CLAIM → 외부 행위 1회 → EXECUTED →
// 재실행 차단, 그리고 snapshot이 바뀌면 INVALIDATED + 행위 0회.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { FakeScm } from '../adapters/memory/mocks.ts'
import { LocalIdentityBinding } from '../adapters/local/identity.ts'
import { ApprovalService } from '../core/approval/service.ts'
import { Executor } from '../core/execution/executor.ts'
import { GrantService } from '../core/execution/grant.ts'
import { ApprovalRequest } from '../core/model/entities.ts'
import type { StateStore } from '../ports/state-store.ts'

const NOW = '2026-08-22T14:00:00+09:00'
const LATER = '2026-08-22T15:00:00+09:00'

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest =>
  ApprovalRequest.parse({
    id: 'REQ-0042',
    version: 0,
    status: 'AWAITING_APPROVAL',
    type: 'actionable',
    priority: 'P0',
    title: 'Issue #19 답변 승인 필요',
    detectedAt: '2026-08-22T10:00:00+09:00',
    source: { eventKey: 'comment:531245', reference: 'owner/repo#19', threadLastEventId: 'evt-7' },
    situation: '계약 해석 질의',
    impact: { interruptRequired: false, affectedSessions: ['S-20260822-01'] },
    draft: '원래 초안입니다.',
    snapshot: [{ sourceId: 'shared-spec', baseline: 'abc123' }],
    authorizedApprover: 'controller-a',
    allowedDecisions: ['approve', 'revise', 'defer', 'dismiss'],
    ...over,
  })

const CONTROLLER_IDS = { 'controller-a': ['local:colosair'] }

const grantInput = (over: Record<string, unknown> = {}) => ({
  grantId: 'G-0001',
  requestId: 'REQ-0042',
  issuedBy: 'colosair',
  channel: 'local',
  action: 'github.issue_comment.create',
  target: 'owner/repo#19',
  issuedAt: NOW,
  ...over,
})

const grantsOn = (store: StateStore) => new GrantService(store, new LocalIdentityBinding(CONTROLLER_IDS))

/** 승인까지 마친 요청과, 정본·스레드가 그대로인 SCM을 준비한다. */
async function approved(over: Partial<ApprovalRequest> = {}, revision?: string) {
  const store: StateStore = new MemoryStateStore()
  await store.create('request', request(over))
  const approval = new ApprovalService({
    store,
    identity: new LocalIdentityBinding({ 'controller-a': ['local:colosair'] }),
    now: () => NOW,
  })
  const decided = await approval.submit({
    requestId: 'REQ-0042',
    expectedVersion: 0,
    kind: revision ? 'revise' : 'approve',
    actor: 'colosair',
    channel: 'local',
    ...(revision !== undefined ? { revision } : {}),
    decidedAt: NOW,
  })
  assert.ok(decided.ok)

  const scm = new FakeScm()
  scm.setThread('owner/repo#19', 'evt-7')
  scm.setBaseline('shared-spec', 'abc123')
  return { store, scm }
}

const executorOn = (store: StateStore, scm: FakeScm, runId = 'run-1') =>
  new Executor({ store, scm, runId, now: () => LATER })

describe('Grant 발급', () => {
  it('승인된 요청만 밖으로 나갈 계약을 얻는다', async () => {
    const { store } = await approved()
    const issued = await grantsOn(store).issue(grantInput())
    assert.ok(issued.ok)
    assert.equal(issued.grant.status, 'READY')
    assert.equal(issued.grant.singleUse, true)
    // 승인 시점의 정본이 Drift Guard 기준선으로 복사된다
    assert.deepEqual(issued.grant.snapshot, [{ sourceId: 'shared-spec', baseline: 'abc123' }])
    assert.equal(issued.grant.threadLastEventId, 'evt-7')
  })

  it('승인 권한자가 아니면 계약을 발급할 수 없다', async () => {
    const { store } = await approved()
    // 외부로 나가는 권한은 여기서 만들어진다 — 임의 이름으로 열리면 승인 검증이 무의미해진다
    const issued = await grantsOn(store).issue(grantInput({ issuedBy: 'assistant' }))
    assert.ok(!issued.ok && issued.failure.kind === 'FORBIDDEN_ISSUER')
    assert.equal(await store.get('grant', 'G-0001'), null)

    const last = (await store.readHistory()).at(-1)!
    assert.equal(last.kind, 'grant_rejected')
    assert.match(last.detail!, /unauthorized issuer via local/)
  })

  it('매핑되지 않은 채널에서 온 발급도 거절한다', async () => {
    const { store } = await approved()
    const issued = await grantsOn(store).issue(grantInput({ channel: 'web' }))
    assert.ok(!issued.ok && issued.failure.kind === 'FORBIDDEN_ISSUER')
  })

  it('내보낼 내용은 승인된 것에서만 나온다', async () => {
    const { store } = await approved({}, '고친 내용입니다.')
    // 호출자가 payload를 끼워 넣을 자리가 없다 — 다른 내용을 보내려면 새 Decision을 받아야 한다
    const issued = await grantsOn(store).issue(grantInput({ payload: '승인받지 않은 내용' }))
    assert.ok(issued.ok)
    assert.equal(issued.grant.payload, '고친 내용입니다.')
  })

  it('아직 승인되지 않은 요청은 계약을 얻지 못한다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    const issued = await grantsOn(store).issue(grantInput())
    assert.ok(!issued.ok && issued.failure.kind === 'NOT_APPROVED')
  })

  it('사람이 고쳐서 승인했으면 고친 쪽이 나간다', async () => {
    const { store } = await approved({}, '고친 내용입니다.')
    const issued = await grantsOn(store).issue(grantInput())
    assert.ok(issued.ok)
    assert.equal(issued.grant.payload, '고친 내용입니다.')
  })

  it('내보낼 내용이 없으면 발급하지 않는다', async () => {
    const { store } = await approved({ draft: undefined })
    const issued = await grantsOn(store).issue(grantInput())
    assert.ok(!issued.ok && issued.failure.kind === 'NO_PAYLOAD')
  })

  it('같은 grant id를 두 번 발급할 수 없다', async () => {
    const { store } = await approved()
    await grantsOn(store).issue(grantInput())
    const again = await grantsOn(store).issue(grantInput())
    assert.ok(!again.ok && again.failure.kind === 'GRANT_EXISTS')
  })
})

describe('실행 — 한 번만, 그리고 확인 후에', () => {
  it('CLAIM → 행위 1회 → EXECUTED → 재실행 차단', async () => {
    const { store, scm } = await approved()
    await grantsOn(store).issue(grantInput())

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(outcome.ok)
    assert.equal(scm.executed.length, 1)
    assert.equal(scm.executed[0]!.payload, '원래 초안입니다.')

    const grant = (await store.get('grant', 'G-0001'))!
    assert.equal(grant.status, 'EXECUTED')
    assert.equal(grant.claimedBy, 'run-1')
    assert.equal(grant.consumedAt, LATER)
    assert.equal(grant.resultRef, outcome.resultRef)

    // 요청도 닫히고 결과를 따라갈 수 있다
    const request = (await store.get('request', 'REQ-0042'))!
    assert.equal(request.status, 'DONE')
    assert.equal(request.resultRef, outcome.resultRef)

    // 같은 Grant로 다시 부르면 아무 일도 일어나지 않는다
    const again = await executorOn(store, scm).run('G-0001')
    assert.ok(!again.ok && again.reason === 'NOT_CLAIMABLE')
    assert.equal(scm.executed.length, 1)
  })

  it('두 Run이 동시에 집으면 하나만 실행한다', async () => {
    const { store, scm } = await approved()
    await grantsOn(store).issue(grantInput())

    const outcomes = await Promise.all([
      executorOn(store, scm, 'run-a').run('G-0001'),
      executorOn(store, scm, 'run-b').run('G-0001'),
    ])
    assert.equal(outcomes.filter((o) => o.ok).length, 1)
    assert.equal(scm.executed.length, 1)
  })

  it('스레드에 새 이벤트가 있으면 실행하지 않고 무효화한다', async () => {
    const { store, scm } = await approved()
    await grantsOn(store).issue(grantInput())

    // 승인 이후 누군가 그 스레드에 글을 달았다
    scm.setThread('owner/repo#19', 'evt-9')

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(!outcome.ok && outcome.reason === 'DRIFT')
    assert.match(outcome.detail, /새 이벤트/)
    assert.equal(scm.executed.length, 0)
    assert.equal((await store.get('grant', 'G-0001'))!.status, 'INVALIDATED')
    // 요청은 승인 상태로 남는다 — 사람이 다시 판단할 수 있게
    assert.equal((await store.get('request', 'REQ-0042'))!.status, 'APPROVED')
  })

  it('정본이 바뀌어도 실행하지 않는다', async () => {
    const { store, scm } = await approved()
    await grantsOn(store).issue(grantInput())
    scm.setBaseline('shared-spec', 'def456')

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(!outcome.ok && outcome.reason === 'DRIFT')
    assert.match(outcome.detail, /정본이 바뀌었다/)
    assert.equal(scm.executed.length, 0)
  })

  it('대상이 사라졌으면 실행하지 않는다', async () => {
    const { store, scm } = await approved()
    await grantsOn(store).issue(grantInput({ target: 'owner/repo#999' }))

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(!outcome.ok && outcome.reason === 'DRIFT')
    assert.equal(scm.executed.length, 0)
  })

  it('만료된 계약은 집지 않는다', async () => {
    const { store, scm } = await approved()
    await grantsOn(store).issue(grantInput({ expiresAt: '2026-08-22T14:30:00+09:00' }))

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(!outcome.ok && outcome.reason === 'EXPIRED')
    assert.equal(scm.executed.length, 0)
    assert.equal((await store.get('grant', 'G-0001'))!.status, 'EXPIRED')
  })

  it('외부 호출이 실패하면 재시도하지 않고 계약을 닫는다', async () => {
    const { store, scm } = await approved()
    await grantsOn(store).issue(grantInput())
    scm.failNextExecute('rate limited')

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(!outcome.ok && outcome.reason === 'ACTION_FAILED')
    // 정말 안 나갔는지 알 수 없으므로 같은 계약을 다시 쓰지 않는다
    assert.equal((await store.get('grant', 'G-0001'))!.status, 'INVALIDATED')
    assert.equal((await store.get('request', 'REQ-0042'))!.status, 'APPROVED')
  })

  it('없는 계약은 NOT_FOUND', async () => {
    const { store, scm } = await approved()
    assert.deepEqual(await executorOn(store, scm).run('G-9999'), { ok: false, reason: 'NOT_FOUND' })
  })
})

describe('계약 범위 밖 행위 (fail-closed)', () => {
  it('허용 목록에 없는 행위는 실행하지 않고 계약을 닫는다', async () => {
    const { store, scm } = await approved()
    await grantsOn(store).issue(grantInput({ allowedWrites: ['github.issue_comment.update'] }))

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(!outcome.ok && outcome.reason === 'FORBIDDEN_ACTION')
    assert.match(outcome.detail, /not in allowed writes/)
    assert.equal(scm.executed.length, 0)
    assert.equal((await store.get('grant', 'G-0001'))!.status, 'INVALIDATED')
    assert.equal((await store.get('request', 'REQ-0042'))!.status, 'APPROVED')
  })

  it('허용 목록을 비우면 계약의 행위 하나만 열린다', async () => {
    const { store, scm } = await approved()
    const issued = await grantsOn(store).issue(grantInput())
    assert.ok(issued.ok)
    assert.deepEqual(issued.grant.allowedWrites, ['github.issue_comment.create'])
    assert.equal((await executorOn(store, scm).run('G-0001')).ok, true)
  })
})

describe('기록', () => {
  it('발급·실행이 History에 남는다', async () => {
    const { store, scm } = await approved()
    await grantsOn(store).issue(grantInput())
    await executorOn(store, scm).run('G-0001')

    const kinds = (await store.readHistory()).map((h) => h.kind)
    assert.deepEqual(kinds, ['decision', 'grant_issued', 'external_action'])
    assert.match((await store.readHistory()).at(-1)!.detail!, /github\.issue_comment\.create → owner\/repo#19 = /)
  })

  it('무효화도 이유와 함께 남는다', async () => {
    const { store, scm } = await approved()
    await grantsOn(store).issue(grantInput())
    scm.setThread('owner/repo#19', 'evt-9')
    await executorOn(store, scm).run('G-0001')

    const last = (await store.readHistory()).at(-1)!
    assert.equal(last.kind, 'grant_invalidated')
    assert.match(last.detail!, /새 이벤트/)
  })
})
