// 0.7.0 / D-05 · Phase G — 세션이 만든 결과가 밖으로 나가는 자리.
//
// 초기 모델(OM §11)은 `Monitor → Request → Approval → Grant` 하나만 그렸다. 정작 계약
// 안에서 일한 세션이 만든 결과가 밖으로 나갈 자리는 없었고, 그래서 실제 작업은 관계없는
// 판단 요청을 하나 지어내 그 위에 얹혀야 했다. 지어낸 요청은 승인 기록을 흐린다.
//
// 새 entity 를 만들지 않았다 — Grant 가 근거를 둘 중 하나로 가질 수 있게 됐을 뿐이다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { GrantService } from '../core/execution/grant.ts'
import { ExecutionGrant, Session } from '../core/model/entities.ts'
import type { IdentityBinding } from '../ports/approval.ts'

const NOW = '2026-09-06T00:00:00.000Z'
const SESSION = 'S-20260906-01'

const approver: IdentityBinding = {
  async verify({ actor, authorizedApprover }) {
    return actor === 'colosair' && authorizedApprover === 'colosair'
  },
}

const session = (status: Session['status'] = 'ACTIVE') =>
  Session.parse({
    id: SESSION,
    version: 1,
    status,
    role: 'implementer',
    goal: '조작 안내 4항',
    doneCriteria: ['4항이 보인다'],
    writeBoundary: ['fe/**'],
  })

const issueFor = async (store: MemoryStateStore, over: Record<string, unknown> = {}) =>
  new GrantService(store, approver).issueForSession({
    grantId: 'G-0001',
    sessionId: SESSION,
    issuedBy: 'colosair',
    channel: 'local',
    action: 'gitlab.note.create',
    target: 'g/p!19',
    payload: '작업 결과입니다',
    issuedAt: NOW,
    ...over,
  })

describe('세션을 근거로 한 계약', () => {
  it('세션이 있고 사람이 승인 권한자면 발급된다', async () => {
    const store = new MemoryStateStore()
    await store.create('session', session())

    const result = await issueFor(store)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.grant.sessionId, SESSION)
    assert.equal(result.grant.requestId, undefined, '없는 요청을 지어내지 않는다')
    assert.deepEqual(result.grant.allowedWrites, ['gitlab.note.create'], '승인된 것은 이 행위 하나다')
  })

  it('내보낼 내용은 사람이 준 것이다 — 비어 있으면 발급하지 않는다', async () => {
    const store = new MemoryStateStore()
    await store.create('session', session())
    const result = await issueFor(store, { payload: '' })
    assert.equal(result.ok === false && result.failure.kind, 'NO_PAYLOAD')
  })

  it('승인 권한자가 아니면 발급되지 않고 그 사실이 남는다', async () => {
    const store = new MemoryStateStore()
    await store.create('session', session())

    const result = await issueFor(store, { issuedBy: 'someone-else' })
    assert.equal(result.ok === false && result.failure.kind, 'FORBIDDEN_ISSUER')
    const history = await store.readHistory()
    assert.ok(history.some((entry) => entry.kind === 'grant_rejected'))
  })

  it('아직 시작하지 않은 세션에는 내보낼 결과가 없다', async () => {
    const store = new MemoryStateStore()
    await store.create('session', session('READY'))
    const result = await issueFor(store)
    assert.equal(result.ok === false && result.failure.kind, 'SESSION_NOT_RUNNABLE')
  })

  it('없는 세션으로는 발급되지 않는다', async () => {
    const result = await issueFor(new MemoryStateStore())
    assert.equal(result.ok === false && result.failure.kind, 'SESSION_NOT_FOUND')
  })
})

describe('계약은 근거 하나 위에 선다', () => {
  const base = {
    id: 'G-0002',
    version: 0,
    status: 'READY',
    issuedBy: 'colosair',
    issuedAt: NOW,
    action: 'gitlab.note.create',
    target: 'g/p!19',
    payload: 'x',
  }

  it('둘 다 없으면 계약이 아니다', () => {
    assert.throws(() => ExecutionGrant.parse(base))
  })

  it('둘 다 있으면 어느 것이 승인인지 알 수 없다', () => {
    assert.throws(() => ExecutionGrant.parse({ ...base, requestId: 'REQ-0001', sessionId: SESSION }))
  })

  it('하나만 있으면 선다', () => {
    assert.ok(ExecutionGrant.parse({ ...base, requestId: 'REQ-0001' }))
    assert.ok(ExecutionGrant.parse({ ...base, sessionId: SESSION }))
  })
})
