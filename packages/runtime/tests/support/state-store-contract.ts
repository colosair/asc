// State Store Port의 계약 테스트. Adapter가 바뀌어도 Core가 그대로여야 한다는 주장은,
// 두 Adapter가 같은 테스트를 통과할 때만 근거가 있다 (OM §7.0).
//
// 이 파일은 `tests/*.test.ts` 글롭 밖에 있어 단독 실행되지 않는다 — 호출하는 쪽이 있어야 돈다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ApprovalRequest, Session } from '../../core/model/entities.ts'
import { transitionRequest } from '../../core/model/transitions.ts'
import type { StateStore } from '../../ports/state-store.ts'

const NOW = '2026-08-22T10:00:00+09:00'
const LATER = '2026-08-22T10:20:00+09:00'

export const sampleRequest = (over: Partial<ApprovalRequest> = {}): ApprovalRequest =>
  ApprovalRequest.parse({
    id: 'REQ-0042',
    version: 0,
    status: 'AWAITING_APPROVAL',
    type: 'actionable',
    priority: 'P0',
    title: 'Issue #19 답변 승인 필요',
    detectedAt: NOW,
    source: { eventKey: 'comment:531245', reference: 'Issue #19', threadLastEventId: 'evt-7' },
    situation: '상대방이 계약 해석을 물었다',
    impact: { interruptRequired: false, affectedSessions: ['S-20260822-01'] },
    draft: '초안 본문',
    snapshot: [{ sourceId: 'shared-spec', baseline: 'abc123' }],
    authorizedApprover: 'controller-a',
    allowedDecisions: ['approve', 'revise', 'defer', 'dismiss'],
    ...over,
  })

const decision = { kind: 'approve' as const, actor: 'controller-a', channel: 'local', decidedAt: NOW }

/**
 * @param label Adapter 이름 — 실패했을 때 어느 구현인지 알아보려고.
 * @param create 매 테스트마다 빈 store를 만드는 함수.
 */
export function describeStateStoreContract(label: string, create: () => Promise<StateStore>): void {
  describe(`State Store 계약 — ${label}`, () => {
    it('create는 중복 id를 거절하고 현재 값을 돌려준다', async () => {
      const store = await create()
      assert.equal((await store.create('request', sampleRequest())).ok, true)

      const again = await store.create('request', sampleRequest({ title: '다른 제목' }))
      assert.ok(!again.ok && again.reason === 'ALREADY_EXISTS')
      assert.equal(again.current.title, 'Issue #19 답변 승인 필요')
    })

    it('두 채널이 같은 버전을 읽고 결정하면 하나만 통과한다', async () => {
      const store = await create()
      await store.create('request', sampleRequest())

      const seenByLocal = (await store.get('request', 'REQ-0042'))!
      const seenByMattermost = (await store.get('request', 'REQ-0042'))!
      assert.equal(seenByLocal.version, seenByMattermost.version)

      const first = await store.compareAndSet(
        'request',
        'REQ-0042',
        seenByLocal.version,
        transitionRequest(seenByLocal, 'APPROVED', 'controller', { decision }),
      )
      assert.equal(first.ok, true)

      const second = await store.compareAndSet(
        'request',
        'REQ-0042',
        seenByMattermost.version,
        transitionRequest(seenByMattermost, 'DISMISSED', 'controller', {
          decision: { ...decision, kind: 'dismiss', channel: 'mattermost' },
        }),
      )
      assert.ok(!second.ok && second.reason === 'VERSION_CONFLICT')
      // 실패 응답의 current가 ALREADY_DECIDED를 설명할 근거가 된다
      assert.equal(second.current.status, 'APPROVED')
      assert.equal(second.current.decision?.channel, 'local')
    })

    it('동시 실행에서도 정확히 하나만 성공한다', async () => {
      const store = await create()
      await store.create('request', sampleRequest())
      const seen = (await store.get('request', 'REQ-0042'))!

      const results = await Promise.all(
        ['local', 'mattermost', 'web'].map((channel) =>
          store.compareAndSet(
            'request',
            'REQ-0042',
            seen.version,
            transitionRequest(seen, 'APPROVED', 'controller', { decision: { ...decision, channel } }),
          ),
        ),
      )
      assert.equal(results.filter((r) => r.ok).length, 1)
      assert.equal(results.filter((r) => !r.ok && r.reason === 'VERSION_CONFLICT').length, 2)

      // 경쟁 뒤에도 저장된 값은 온전해야 한다
      const settled = (await store.get('request', 'REQ-0042'))!
      assert.equal(settled.version, seen.version + 1)
      assert.equal(settled.status, 'APPROVED')
    })

    it('버전을 올리지 않은 갱신은 계약 위반이라 던진다', async () => {
      const store = await create()
      await store.create('request', sampleRequest())
      const current = (await store.get('request', 'REQ-0042'))!
      await assert.rejects(
        () => store.compareAndSet('request', 'REQ-0042', current.version, { ...current, title: '몰래 수정' }),
        /next\.version must be 1/,
      )
    })

    it('없는 entity 갱신은 NOT_FOUND', async () => {
      const store = await create()
      const result = await store.compareAndSet(
        'request',
        'REQ-9999',
        0,
        sampleRequest({ id: 'REQ-9999', version: 1 }),
      )
      assert.ok(!result.ok && result.reason === 'NOT_FOUND')
    })

    it('저장소는 호출자와 객체를 공유하지 않는다', async () => {
      const store = await create()
      await store.create('request', sampleRequest())
      const fetched = (await store.get('request', 'REQ-0042'))!
      fetched.title = '바깥에서 바꾼 제목'
      assert.equal((await store.get('request', 'REQ-0042'))!.title, 'Issue #19 답변 승인 필요')
    })

    it('list는 부분 일치 필터를 지원한다', async () => {
      const store = await create()
      await store.create('request', sampleRequest())
      await store.create('request', sampleRequest({ id: 'REQ-0043', priority: 'P2', title: '참고 사항' }))
      assert.equal((await store.list('request', { where: { priority: 'P0' } })).length, 1)
      assert.equal((await store.list('request')).length, 2)
    })

    it('빈 store의 list는 빈 배열이다', async () => {
      assert.deepEqual(await (await create()).list('session'), [])
    })

    it('Control State도 CAS를 거친다', async () => {
      const store = await create()
      const state = await store.getControlState()
      const ok = await store.setControlState(state.version, {
        ...state,
        version: state.version + 1,
        activeBlock: 'B-04',
      })
      assert.equal(ok.ok, true)
      assert.equal((await store.getControlState()).activeBlock, 'B-04')

      const stale = await store.setControlState(state.version, { ...state, version: state.version + 1 })
      assert.ok(!stale.ok && stale.reason === 'VERSION_CONFLICT')
    })

    it('History는 덧붙이기만 한다', async () => {
      const store = await create()
      await store.appendHistory({ at: NOW, actor: 'controller-a', kind: 'decision', ref: 'REQ-0042', detail: 'approve' })
      await store.appendHistory({ at: LATER, actor: 'executor', kind: 'external_action', ref: 'REQ-0042' })
      const rows = await store.readHistory()
      assert.equal(rows.length, 2)
      assert.deepEqual(rows.map((r) => r.kind), ['decision', 'external_action'])
      assert.equal(rows[0]!.detail, 'approve')
      assert.equal(rows.at(-1)!.detail, undefined)
    })

    it('Adapter scope는 서로 격리되고 원본 key를 돌려준다', async () => {
      const store = await create()
      await store.scope('mattermost').set('presentation:REQ-0042', 'mm-ref')
      assert.equal(await store.scope('local').get('presentation:REQ-0042'), null)
      assert.equal(await store.scope('mattermost').get('presentation:REQ-0042'), 'mm-ref')
      assert.deepEqual(await store.scope('mattermost').keys('presentation:'), ['presentation:REQ-0042'])

      await store.scope('mattermost').delete('presentation:REQ-0042')
      assert.equal(await store.scope('mattermost').get('presentation:REQ-0042'), null)
    })

    it('entity 종류마다 다른 primary key를 쓴다', async () => {
      const store = await create()
      await store.create(
        'session',
        Session.parse({ id: 'S-20260822-01', version: 0, status: 'READY', role: 'implementer', goal: 'B-04' }),
      )
      assert.ok(await store.get('session', 'S-20260822-01'))

      // event key에는 파일명에 못 쓰는 문자가 들어간다 — 저장·조회가 그대로 되어야 한다
      await store.create('event', {
        eventKey: 'comment:531245',
        version: 0,
        detectedAt: NOW,
        type: 'informational',
        suggestedPriority: 'P2',
        processing: 'LOGGED',
        inboxCandidate: false,
      })
      assert.equal((await store.get('event', 'comment:531245'))?.eventKey, 'comment:531245')
    })
  })
}
