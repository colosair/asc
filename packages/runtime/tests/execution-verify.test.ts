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
  /** 되돌려 읽을 수 있다고 답할지는 시험이 정한다 (P1-2). */
  verifiable = true
  verifies(): boolean {
    return this.verifiable
  }
  async review(): Promise<RemoteFacts> {
    return { verifiable: this.verifiable, ...this.facts }
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

const executorOn = (store: StateStore, scm: ReviewingScm, requireVerification = false) =>
  new Executor({ store, scm, runId: 'run-1', now: () => NOW, requireVerification })

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
  it('T-11 / T-20 — 읽어 온 것이 다르면 EXECUTED 로 적지 않는다', async () => {
    const { store, scm } = await readyGrant({ sourceSha: 'abc123' })
    scm.facts = { ...scm.facts, observed: { 'local.head': 'abc123' } }
    // 밖은 다른 것을 들고 있다 — 명령은 0 으로 끝났는데도.
    scm.observed = { sha: 'zzz999' }

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(!outcome.ok && outcome.reason === 'NOT_VERIFIED')
    assert.equal(outcome.resultRef, 'group/project!7', '나간 것은 나갔다고 말한다')

    // **EXECUTED 가 아니다** — 그 상태는 밖에서 "성공적으로 끝남" 으로 읽힌다 (P0-5).
    // 나간 것은 나갔으므로 재사용은 막되(terminal), 성공은 주장하지 않는다.
    const grant = (await store.get('grant', 'G-0001'))!
    assert.equal(grant.status, 'INVALIDATED')
    assert.equal(grant.resolution, 'NOT_VERIFIED')
    assert.equal(grant.resultRef, 'group/project!7', '무엇이 나갔는지는 남는다')
    const history = await store.readHistory()
    assert.equal(history.at(-1)!.kind, 'external_action_unverified')

    // 재실행 불가.
    const again = await executorOn(store, scm).run('G-0001')
    assert.ok(!again.ok && again.reason === 'NOT_CLAIMABLE')
    assert.equal(scm.executed.length, 1)
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
  it('P1-1 — 결과를 모르면 terminal 로 닫되 이유가 UNCERTAIN 이다', async () => {
    const { store, scm } = await readyGrant({ sourceSha: 'abc123' })
    scm.facts = { ...scm.facts, observed: { 'local.head': 'abc123' } }
    scm.result = { ok: false, error: 'connect ETIMEDOUT 10.0.0.1:443' }

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(!outcome.ok && outcome.reason === 'UNCERTAIN')
    // CLAIMED 로 두지 않는다: 이 시스템에서 그 상태는 "지금 누가 집고 실행 중" 을 뜻하고,
    // 아무도 실행 중이 아닌 Grant 를 거기 두면 화면과 감사가 영영 틀린 말을 한다.
    const grant = (await store.get('grant', 'G-0001'))!
    assert.equal(grant.status, 'INVALIDATED')
    assert.equal(grant.resolution, 'UNCERTAIN')
    assert.equal(grant.resultRef, undefined, '결과를 모르므로 결과 참조도 없다')

    const again = await executorOn(store, scm).run('G-0001')
    assert.ok(!again.ok && again.reason === 'NOT_CLAIMABLE')
    assert.equal(scm.executed.length, 1, '자동 재시도 0')
  })

  it('T-23 — 되돌려 읽을 수 없는 행위는 자율 실행에서 나가지 않는다', async () => {
    const { store, scm } = await readyGrant({ sourceSha: 'abc123' })
    scm.facts = { ...scm.facts, observed: { 'local.head': 'abc123' } }
    scm.verifiable = false

    const outcome = await executorOn(store, scm, true).run('G-0001')
    assert.ok(!outcome.ok && outcome.reason === 'NOT_EXECUTABLE')
    assert.match(outcome.detail, /NO_VERIFY_PATH/)
    assert.equal(scm.executed.length, 0, 'mutation 0')

    // 사람이 실행하는 자리에서는 같은 판단이 사람의 것이다 — 여기서 막지 않는다.
    const { store: manualStore, scm: manualScm } = await readyGrant({ sourceSha: 'abc123' })
    manualScm.facts = { ...manualScm.facts, observed: { 'local.head': 'abc123' } }
    manualScm.verifiable = false
    manualScm.observed = { sha: 'abc123' }
    assert.ok((await executorOn(manualStore, manualScm, false).run('G-0001')).ok)
  })

  it('T-24 / P1-3 — 행위 승인만으로 결합 밖으로 나가지 않는다', async () => {
    // Grant 는 "이 행위를 해도 된다" 는 승인이지 "범위를 project B 까지 넓힌다" 는 결정이
    // 아니다. 실행 직전 재검수가 계약에 박힌 범위와 지금의 대상을 견준다.
    const { store, scm } = await readyGrant({ resource: 'group/project' })
    scm.facts = { ...scm.facts, resource: 'group/other', observed: { 'local.head': 'abc123' } }

    const outcome = await executorOn(store, scm, true).run('G-0001')
    assert.ok(!outcome.ok && outcome.reason === 'REVIEW_REQUIRED')
    assert.equal(scm.executed.length, 0)
    assert.equal((await store.get('grant', 'G-0001'))!.resolution, 'REVIEW_REQUIRED')
  })

  it('T-25 — 범위가 그 대상까지로 정해진 계약이면 통과한다', async () => {
    // 범위를 바꾸는 결정이 선행돼야 한다는 뜻이지, 영원히 못 나간다는 뜻이 아니다.
    const { store, scm } = await readyGrant({ resource: 'group/other', sourceSha: 'abc123' })
    scm.facts = { ...scm.facts, resource: 'group/other', observed: { 'local.head': 'abc123' } }
    scm.observed = { sha: 'abc123', resource: 'group/other' }

    const outcome = await executorOn(store, scm, true).run('G-0001')
    assert.ok(outcome.ok)
    assert.equal(scm.executed.length, 1)
  })

  it('밖이 거절한 것은 확인된 실패다 — 그때는 계약을 닫는다', async () => {
    const { store, scm } = await readyGrant({ sourceSha: 'abc123' })
    scm.facts = { ...scm.facts, observed: { 'local.head': 'abc123' } }
    scm.result = { ok: false, error: 'HTTP 403 forbidden' }

    const outcome = await executorOn(store, scm).run('G-0001')
    assert.ok(!outcome.ok && outcome.reason === 'REJECTED')
    const grant = (await store.get('grant', 'G-0001'))!
    assert.equal(grant.status, 'INVALIDATED')
    assert.equal(grant.resolution, 'REJECTED')
  })
})
