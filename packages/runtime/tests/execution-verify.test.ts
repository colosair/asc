// 실행 앞뒤에 붙은 두 마디 (0.8.0 보정 §D·§L·§P).
//
//   앞: 실행 직전 재검수 — 승인이 딛고 선 사실이 아직 그대로인가. 읽기만 한다
//   뒤: 되돌려 읽기     — 명령이 0 으로 끝났다는 것과 밖에 그것이 있다는 것은 다르다
//
// 그리고 실패의 종류를 뭉개지 않는다: 거절된 것과 결과를 모르는 것은 다음 행동이 다르다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { LocalIdentityBinding } from '../adapters/local/identity.ts'
import { Executor } from '../core/execution/executor.ts'
import { GrantService } from '../core/execution/grant.ts'
import { Session } from '../core/model/entities.ts'
import type { RemoteFacts } from '../core/execution/remote-review.ts'
import type { ExternalAction, ExternalActionResult, ScmPort, ThreadSnapshot } from '../ports/scm.ts'
import type { StateStore } from '../ports/state-store.ts'

const NOW = '2026-09-07T09:00:00+09:00'
/** 세션 근거 발급은 발급자 이름 자체가 승인 권한자여야 한다 (OM §11.6). */
const IDENTITIES = { colosair: ['local:colosair'] }

/** 검수와 되돌려 읽기를 할 줄 아는 통로. 무엇을 답할지는 시험이 정한다. */
class ReviewingScm implements ScmPort {
  readonly id = 'fixture'
  executed: ExternalAction[] = []
  facts: RemoteFacts = { provider: 'fixture', capability: true, resource: 'group/project' }
  result: ExternalActionResult = { ok: true, resultRef: 'group/project!7' }
  observed: Record<string, string | undefined> = { sha: 'abc123', resource: 'group/project' }

  async getThread(reference: string): Promise<ThreadSnapshot> {
    return { reference, lastEventId: 'evt-1' }
  }
  async getBaselines(): Promise<[]> {
    return []
  }
  supports(): boolean {
    return true
  }
  async review(): Promise<RemoteFacts> {
    return this.facts
  }
  async execute(action: ExternalAction): Promise<ExternalActionResult> {
    this.executed.push(action)
    return this.result
  }
  async verify(): Promise<{ observed: Record<string, string | undefined> }> {
    return { observed: this.observed }
  }
}

async function readyGrant(basis?: { sourceSha?: string; resource?: string }): Promise<{
  store: StateStore
  scm: ReviewingScm
}> {
  const store: StateStore = new MemoryStateStore()
  await store.create(
    'session',
    Session.parse({
      id: 'S-20260907-01',
      version: 0,
      role: 'implementer',
      status: 'ACTIVE',
      goal: '올린다',
      issuedBy: 'controller-a',
      issuedAt: NOW,
    }),
  )
  const grants = new GrantService(store, new LocalIdentityBinding(IDENTITIES))
  const issued = await grants.issueForSession({
    grantId: 'G-0001',
    sessionId: 'S-20260907-01',
    issuedBy: 'colosair',
    channel: 'local',
    action: 'git.push',
    target: 'origin front',
    // 사람이 준 내용이 payload 다. push 에는 본문이 없으므로 무엇을 올리는지가 그 자리다.
    payload: 'front ← develop',
    issuedAt: NOW,
    ...(basis ? { basis } : {}),
  })
  assert.ok(issued.ok)
  return { store, scm: new ReviewingScm() }
}

const executorOn = (store: StateStore, scm: ReviewingScm) =>
  new Executor({ store, scm, runId: 'run-1', now: () => NOW })

describe('실행 직전 재검수 — 밖은 하나도 바뀌지 않는다', () => {
  it('T-10 — 승인한 commit 이 아니면 나가지 않는다', async () => {
    const { store, scm } = await readyGrant({ sourceSha: 'abc123', resource: 'group/project' })
    scm.facts = { ...scm.facts, observed: { 'local.head': 'def456' } }

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(!outcome.ok && outcome.reason === 'NOT_EXECUTABLE')
    assert.match(outcome.detail, /DRIFT/)
    assert.equal(scm.executed.length, 0, '한 번도 나가지 않았다')
    assert.equal((await store.get('grant', 'G-0001'))!.status, 'INVALIDATED')
  })

  it('T-06 / F-02 — 결합 밖의 대상이면 사람에게 올라가고, 밖은 그대로다', async () => {
    const { store, scm } = await readyGrant({ resource: 'group/project' })
    scm.facts = { ...scm.facts, resource: 'group/other' }

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(!outcome.ok && outcome.reason === 'REVIEW_REQUIRED')
    assert.equal(scm.executed.length, 0)
  })

  it('F-01 — 같은 저장소 안의 다른 branch 는 그대로 나간다', async () => {
    // 프로젝트가 "front 를 최신화한다" 고 정했다면 그 판단은 프로젝트의 것이다.
    // 검수가 확인하는 것은 그 행위가 지금 이 원격 상태에서 성립하는가뿐이다.
    const { store, scm } = await readyGrant({ sourceSha: 'abc123', resource: 'group/project' })
    scm.facts = { ...scm.facts, observed: { 'local.head': 'abc123', branch: 'front' } }

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(outcome.ok)
    assert.equal(scm.executed.length, 1)
  })
})

describe('되돌려 읽기 — exit 0 은 성공이 아니다', () => {
  it('T-11 — 읽어 온 것이 기대와 다르면 성공으로 적지 않는다', async () => {
    const { store, scm } = await readyGrant({ sourceSha: 'abc123' })
    scm.facts = { ...scm.facts, observed: { 'local.head': 'abc123' } }
    // 밖은 다른 것을 들고 있다 — 명령은 0 으로 끝났는데도.
    scm.observed = { sha: 'zzz999' }

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(!outcome.ok && outcome.reason === 'NOT_VERIFIED')
    assert.equal(outcome.resultRef, 'group/project!7', '나간 것은 나갔다고 말한다')
    // 나간 것은 나갔으므로 계약은 소진된다 — 재실행으로 두 번 나가지 않는다.
    assert.equal((await store.get('grant', 'G-0001'))!.status, 'EXECUTED')
    const history = await store.readHistory()
    assert.equal(history.at(-1)!.kind, 'external_action_unverified')
  })

  it('되돌려 읽을 것이 하나도 없으면 확인했다고 하지 않는다', async () => {
    const { store, scm } = await readyGrant({ sourceSha: 'abc123' })
    scm.facts = { ...scm.facts, observed: { 'local.head': 'abc123' } }
    scm.observed = {}

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(!outcome.ok && outcome.reason === 'NOT_VERIFIED')
    assert.match(outcome.detail, /nothing could be read back/)
  })

  it('기대와 같으면 그때 성공이다', async () => {
    const { store, scm } = await readyGrant({ sourceSha: 'abc123', resource: 'group/project' })
    scm.facts = { ...scm.facts, observed: { 'local.head': 'abc123' } }
    scm.observed = { sha: 'abc123', resource: 'group/project' }

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(outcome.ok)
  })
})

describe('T-12 — 나갔는지 모르는 실패', () => {
  it('결과를 모르면 계약을 태우지도, 다시 부르지도 않는다', async () => {
    const { store, scm } = await readyGrant({ sourceSha: 'abc123' })
    scm.facts = { ...scm.facts, observed: { 'local.head': 'abc123' } }
    scm.result = { ok: false, error: 'connect ETIMEDOUT 10.0.0.1:443' }

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(!outcome.ok && outcome.reason === 'UNCERTAIN')
    // CLAIMED 로 남는다: 다시 실행할 수 없고(READY 가 아니므로), 실패했다고 단정하지도 않는다.
    assert.equal((await store.get('grant', 'G-0001'))!.status, 'CLAIMED')
    const again = await executorOn(store, scm).run('G-0001')
    assert.ok(!again.ok && again.reason === 'NOT_CLAIMABLE')
    assert.equal(scm.executed.length, 1, '자동 재시도 0')
  })

  it('밖이 거절한 것은 확인된 실패다 — 그때는 계약을 닫는다', async () => {
    const { store, scm } = await readyGrant({ sourceSha: 'abc123' })
    scm.facts = { ...scm.facts, observed: { 'local.head': 'abc123' } }
    scm.result = { ok: false, error: 'HTTP 403 forbidden' }

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(!outcome.ok && outcome.reason === 'REJECTED')
    assert.equal((await store.get('grant', 'G-0001'))!.status, 'INVALIDATED')
  })
})
