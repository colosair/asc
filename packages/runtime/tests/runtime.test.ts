// B-03 Gate ①② — Session이 여러 Run에 걸쳐 승계되는지, 요청 생성·전이가 store를 거쳐
// 동작하는지. Attach Pilot(B-11)에서 세션 기능을 처음 만들지 않도록 여기서 확인한다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { ApprovalRequest, Checkpoint, Handoff, Session } from '../core/model/entities.ts'
import { transitionRequest } from '../core/model/transitions.ts'
import { mergePolicyLayers } from '../core/policy/policy.ts'
import { SessionRuntime } from '../core/runtime/session.ts'
import { applyTransition } from '../core/runtime/store-ops.ts'

const NOW = '2026-08-22T10:00:00+09:00'
const LATER = '2026-08-22T14:00:00+09:00'

const { policy } = mergePolicyLayers([
  {
    id: 'vanilla',
    hardDeny: ['external.write', 'canonical.modify'],
    softDeny: ['dependency.add'],
    roleScopes: { implementer: ['**'], verifier: [] },
  },
  { id: 'profile:example-team', roleScopes: { implementer: ['frontend/**'] } },
])

const spec = {
  id: 'S-20260822-01',
  role: 'implementer' as const,
  goal: 'Studio 편집기 T-004~T-006',
  writeBoundary: ['frontend/src/studio/**'],
}

const checkpoint = Checkpoint.parse({
  position: 'T-005 절반',
  completedTasks: ['T-004'],
  nextAction: 'validate 함수부터',
  uncommittedChanges: ['frontend/src/studio/validate.ts'],
  recordedAt: NOW,
})

const handoff = Handoff.parse({
  done: ['T-004', 'T-005', 'T-006'],
  changed: ['frontend/src/studio/validate.ts'],
  verified: 'self-check: npm test 통과 (Verifier 독립 검증 아님)',
  next: 'B-04 Markdown Adapter',
  snapshot: [{ sourceId: 'shared-spec', baseline: 'abc123' }],
  recordedAt: LATER,
})

describe('Session lifecycle — 여러 Run에 걸친 승계', () => {
  it('READY → ACTIVE → PAUSED(+CHECKPOINT) → RESUME → DONE(+HANDOFF)', async () => {
    const store = new MemoryStateStore()
    const runtime = new SessionRuntime(store, policy)

    const issued = await runtime.issue(spec)
    assert.ok(issued.ok)
    assert.equal(issued.session.status, 'READY')

    // Run A
    assert.equal((await runtime.start(spec.id)).ok, true)
    const paused = await runtime.pause(spec.id, checkpoint)
    assert.ok(paused.ok)
    assert.equal(paused.entity.status, 'PAUSED')

    // Run B — 계약도 Checkpoint도 store에서 읽어 이어받는다
    const seenByNextRun = (await runtime.get(spec.id))!
    assert.equal(seenByNextRun.checkpoint?.nextAction, 'validate 함수부터')
    assert.deepEqual(seenByNextRun.checkpoint?.completedTasks, ['T-004'])

    assert.equal((await runtime.resume(spec.id)).ok, true)
    const done = await runtime.complete(spec.id, handoff)
    assert.ok(done.ok)
    assert.equal(done.entity.status, 'DONE')
    assert.equal(done.entity.handoff?.next, 'B-04 Markdown Adapter')

    // Handoff는 History에 남는다 — Controller가 회수할 근거
    const history = await store.readHistory()
    assert.equal(history.at(-1)?.kind, 'session_handoff')
  })

  it('BLOCKED는 Controller만 풀 수 있다', async () => {
    const store = new MemoryStateStore()
    const runtime = new SessionRuntime(store, policy)
    await runtime.issue(spec)
    await runtime.start(spec.id)

    assert.equal((await runtime.block(spec.id)).ok, true)
    // 세션 스스로 재개하려는 시도는 전이 규칙이 거절한다
    const selfResume = await runtime.resume(spec.id)
    assert.ok(!selfResume.ok && selfResume.reason === 'REJECTED')
    assert.equal(selfResume.failure.reason, 'FORBIDDEN_ACTOR')

    assert.equal((await runtime.unblock(spec.id)).ok, true)
  })

  it('두 Run이 동시에 같은 세션을 집으면 하나만 성공한다', async () => {
    const store = new MemoryStateStore()
    const runtime = new SessionRuntime(store, policy)
    await runtime.issue(spec)

    const [a, b] = await Promise.all([runtime.start(spec.id), runtime.start(spec.id)])
    const outcomes = [a, b]
    assert.equal(outcomes.filter((o) => o.ok).length, 1)
    const failed = outcomes.find((o) => !o.ok)!
    // 하나는 CAS 충돌, 하나는 이미 ACTIVE라 전이 거절 — 어느 쪽이든 중복 시작은 막힌다
    assert.ok(!failed.ok && (failed.reason === 'CONFLICT' || failed.reason === 'REJECTED'))
  })

  it('없는 세션 전이는 NOT_FOUND', async () => {
    const runtime = new SessionRuntime(new MemoryStateStore(), policy)
    const outcome = await runtime.start('S-20260822-99')
    assert.ok(!outcome.ok && outcome.reason === 'NOT_FOUND')
  })
})

describe('Session 발급 — 하위 계층은 상위 권한을 넘을 수 없다', () => {
  it('Profile 범위 안으로 좁힌 요청은 통과한다', async () => {
    const runtime = new SessionRuntime(new MemoryStateStore(), policy)
    const issued = await runtime.issue(spec)
    assert.ok(issued.ok)
    assert.deepEqual(issued.session.writeBoundary, ['frontend/src/studio/**'])
  })

  it('Profile 범위를 벗어난 Write Boundary 요청은 거절한다', async () => {
    const runtime = new SessionRuntime(new MemoryStateStore(), policy)
    const issued = await runtime.issue({ ...spec, writeBoundary: ['frontend/src/**', 'backend/**'] })
    assert.equal(issued.ok, false)
    assert.ok(!issued.ok && issued.failures[0]!.kind === 'SCOPE_ESCALATION')
    assert.match(!issued.ok ? issued.failures[0]!.detail : '', /backend/)
  })

  it('HARD DENY를 Policy Exception으로 요청하면 거절한다', async () => {
    const runtime = new SessionRuntime(new MemoryStateStore(), policy)
    const issued = await runtime.issue({ ...spec, policyExceptions: ['external.write'] })
    assert.ok(!issued.ok && issued.failures[0]!.kind === 'HARD_DENY_ESCAPE')
  })

  it('SOFT DENY에 대한 Policy Exception은 계약에 남는다', async () => {
    const runtime = new SessionRuntime(new MemoryStateStore(), policy)
    const issued = await runtime.issue({ ...spec, policyExceptions: ['dependency.add'] })
    assert.ok(issued.ok)
    assert.deepEqual(issued.session.policyExceptions, ['dependency.add'])
  })

  it('같은 id로 두 번 발급할 수 없다', async () => {
    const runtime = new SessionRuntime(new MemoryStateStore(), policy)
    await runtime.issue(spec)
    const again = await runtime.issue(spec)
    assert.ok(!again.ok && again.failures[0]!.kind === 'ALREADY_EXISTS')
  })

  it('policy 없이도 발급된다 — Profile 없는 초기 환경', async () => {
    const runtime = new SessionRuntime(new MemoryStateStore())
    assert.equal((await runtime.issue({ ...spec, writeBoundary: ['anything/**'] })).ok, true)
  })
})

describe('ApprovalRequest 생성과 전이 — store 경유', () => {
  const request = ApprovalRequest.parse({
    id: 'REQ-0042',
    version: 0,
    status: 'AWAITING_APPROVAL',
    type: 'actionable',
    priority: 'P0',
    title: 'Issue #19 답변 승인 필요',
    detectedAt: NOW,
    source: { eventKey: 'comment:531245', reference: 'Issue #19' },
    situation: '계약 해석 질의',
    impact: { interruptRequired: false },
    authorizedApprover: 'controller-a',
    allowedDecisions: ['approve', 'defer', 'dismiss'],
  })
  const decision = { kind: 'approve' as const, actor: 'controller-a', channel: 'local', decidedAt: NOW }

  it('생성 후 Controller 처분까지 store를 거쳐 반영된다', async () => {
    const store = new MemoryStateStore()
    assert.equal((await store.create('request', request)).ok, true)

    const approved = await applyTransition(store, 'request', 'REQ-0042', (r) =>
      transitionRequest(r, 'APPROVED', 'controller', { decision }),
    )
    assert.ok(approved.ok)
    assert.equal(approved.entity.version, 1)
    assert.equal((await store.get('request', 'REQ-0042'))!.status, 'APPROVED')
  })

  it('권한 없는 actor의 전이는 저장되지 않는다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request)

    const rejected = await applyTransition(store, 'request', 'REQ-0042', (r) =>
      transitionRequest(r, 'APPROVED', 'monitor', { decision }),
    )
    assert.ok(!rejected.ok && rejected.reason === 'REJECTED')
    assert.equal((await store.get('request', 'REQ-0042'))!.status, 'AWAITING_APPROVAL')
    assert.equal((await store.get('request', 'REQ-0042'))!.version, 0)
  })

  it('전이 실패가 store를 오염시키지 않는다 — 결정 기록 없는 승인', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request)
    const outcome = await applyTransition(store, 'request', 'REQ-0042', (r) =>
      transitionRequest(r, 'APPROVED', 'controller'),
    )
    assert.ok(!outcome.ok && outcome.reason === 'REJECTED')
    assert.equal(outcome.failure.reason, 'MISSING_REQUIREMENT')
    assert.equal((await store.get('request', 'REQ-0042'))!.version, 0)
  })
})

// B-24 Gate — 발급 시점의 책임 확인. 막는 것은 "정할 것이 있는데 정할 사람이 없는" 경우뿐이다.
describe('B-24 Gate — Session Responsibility Contract (C-04 §1)', () => {
  const ownership = {
    frontend: { paths: ['frontend/**'], authorities: ['client-ui'] },
    backend: { paths: ['backend/**'], authorities: ['api-contract'] },
  }
  const runtimeWith = (map?: typeof ownership) =>
    new SessionRuntime(new MemoryStateStore(), policy, ...(map ? [{ ownership: map }] : []))

  it('결정 영역 없음 + 결정권자 없음 → 기존과 똑같이 발급된다', async () => {
    // owner가 비었다는 이유만으로 막지 않는다. 모든 세션이 cross-part 결정을 요구하지 않는다.
    const issued = await runtimeWith(ownership).issue(spec)
    assert.ok(issued.ok)
    assert.equal(issued.session.owner, undefined)
    assert.deepEqual(issued.session.decisionDomains, [])
    assert.deepEqual(issued.session.dependencies, [])
  })

  it('결정 영역이 있고 결정권자가 하나로 풀리면 발급된다', async () => {
    const issued = await runtimeWith(ownership).issue({
      ...spec,
      owner: 'frontend',
      decisionDomains: ['client-ui'],
    })
    assert.ok(issued.ok)
    assert.equal(issued.session.owner, 'frontend')
  })

  it('결정권자가 선언되지 않았으면 발급을 막고, 어떤 명령으로 푸는지 말한다', async () => {
    const issued = await runtimeWith(ownership).issue({ ...spec, decisionDomains: ['oauth-policy'] })
    assert.ok(!issued.ok)
    assert.equal(issued.failures[0]?.kind, 'RESPONSIBILITY_AMBIGUOUS')
    assert.match(issued.failures[0]!.detail, /선언되지 않았다/)
    assert.match(issued.failures[0]!.detail, /--authority oauth-policy=<role>/)
  })

  it('둘이 주장해 하나로 좁혀지지 않아도 막는다', async () => {
    const contested = {
      frontend: { paths: ['frontend/**'], authorities: ['auth-flow'] },
      backend: { paths: ['backend/**'], authorities: ['auth-flow'] },
    }
    const issued = await runtimeWith(contested).issue({ ...spec, decisionDomains: ['auth-flow'] })
    assert.ok(!issued.ok)
    assert.match(issued.failures[0]!.detail, /갈려 있다 \(backend, frontend\)/)
  })

  it('지도에 없는 결정을 이름이 비슷한 역할에 붙이지 않는다', async () => {
    // 'client-routing'은 'client-ui'와 닮았지만 선언되지 않았다 — 추론하지 않는다
    const issued = await runtimeWith(ownership).issue({ ...spec, decisionDomains: ['client-routing'] })
    assert.ok(!issued.ok)
    assert.equal(issued.failures[0]?.kind, 'RESPONSIBILITY_AMBIGUOUS')
  })

  it('이번 세션에 한해 정한 결정권자는 지도를 대신한다', async () => {
    const issued = await runtimeWith(ownership).issue({
      ...spec,
      decisionDomains: ['oauth-policy'],
      decisionAuthority: { 'oauth-policy': 'product' },
    })
    assert.ok(issued.ok)
    assert.deepEqual(issued.session.decisionAuthority, { 'oauth-policy': 'product' })
  })

  it('책임 지도가 아예 없으면 선언된 결정은 전부 미해결이다', async () => {
    const issued = await runtimeWith().issue({ ...spec, decisionDomains: ['client-ui'] })
    assert.ok(!issued.ok)
    assert.equal(issued.failures[0]?.kind, 'RESPONSIBILITY_AMBIGUOUS')
  })

  it('dependency를 적어도 owner는 그대로다 — 바꾸는 경로가 없다', async () => {
    const store = new MemoryStateStore()
    const runtime = new SessionRuntime(store, policy, { ownership })
    const issued = await runtime.issue({
      ...spec,
      owner: 'frontend',
      dependencies: ['backend callback payload'],
    })
    assert.ok(issued.ok)
    assert.deepEqual(issued.session.dependencies, ['backend callback payload'])

    // lifecycle을 한 바퀴 돌려도 owner는 움직이지 않는다
    await runtime.start(spec.id)
    await runtime.pause(spec.id, checkpoint)
    await runtime.resume(spec.id)
    const after = await runtime.get(spec.id)
    assert.equal(after?.owner, 'frontend')
  })

  it('신규 필드가 없는 기존 Session 파일도 그대로 읽힌다', () => {
    // 이미 디스크에 있는 계약이 스키마 확장으로 깨지면 안 된다 (default([]) 의 이유)
    const legacy = Session.parse({
      id: 'S-20260101-01',
      version: 3,
      status: 'ACTIVE',
      role: 'implementer',
      goal: '예전 세션',
    })
    assert.deepEqual(legacy.decisionDomains, [])
    assert.deepEqual(legacy.decisionAuthority, {})
    assert.deepEqual(legacy.dependencies, [])
  })
})
