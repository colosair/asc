// B-14 Gate — "ASC로 진행해"가 기존 Core를 우회하지 않고 한 걸음을 옮기는지 (C-03 §7.1).
//
// fake host adapter(ScopedRuntimeBindings + 가짜 메시지)는 여기서만 산다 —
// Claude 명칭은 B-15 전까지 코드 어디에도 없다.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { FakeScm } from '../adapters/memory/mocks.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { ScopedRuntimeBindings } from '../adapters/memory/runtime-binding.ts'
import { LocalIdentityBinding } from '../adapters/local/identity.ts'
import { ApprovalService } from '../core/approval/service.ts'
import { ApprovalRequest, Checkpoint, Handoff, Session } from '../core/model/entities.ts'
import { Operator, type ConfigCheck } from '../core/operator/proceed.ts'
import { RuntimeBinding } from '../core/operator/runtime-binding.ts'
import { SessionRuntime } from '../core/runtime/session.ts'
import { parseEntity, serializeEntity } from '../adapters/markdown/serialize.ts'
import type { StateStore } from '../ports/state-store.ts'

const NOW = '2026-08-23T15:00:00+09:00'
const SOURCES = [{ sourceId: 'shared-spec' }]

function scmAt(baselines: Record<string, string>) {
  const scm = new FakeScm()
  for (const [id, sha] of Object.entries(baselines)) scm.setBaseline(id, sha)
  return scm
}

type Setup = {
  store: MemoryStateStore
  sessions: SessionRuntime
  operator: Operator
  scm: FakeScm
}

function setup(options: { guard?: ConfigCheck; canonical?: boolean } = {}): Setup {
  const store = new MemoryStateStore()
  const scm = scmAt({ 'shared-spec': 'abc123' })
  const sessions = options.canonical === false
    ? new SessionRuntime(store)
    : new SessionRuntime(store, null, { scm, canonicalSources: SOURCES })
  const operator = new Operator({
    store,
    sessions,
    guard: async () => options.guard ?? { ok: true },
  })
  return { store, sessions, operator, scm }
}

async function issue(setup: Setup, id: string, over: Record<string, unknown> = {}) {
  const result = await setup.sessions.issue({
    id,
    role: 'implementer',
    goal: `${id} 목표`,
    doneCriteria: ['테스트 통과', 'typecheck 깨끗'],
    ...over,
  })
  assert.ok(result.ok, JSON.stringify(result))
  return result.session
}

describe('proceed — 한 개 후보', () => {
  it('READY → STARTED → ACTIVE', async () => {
    const s = setup()
    await issue(s, 'S-20260823-01')

    const outcome = await s.operator.proceed()
    assert.equal(outcome.kind, 'STARTED')
    assert.ok(outcome.kind === 'STARTED')
    assert.equal(outcome.contract.id, 'S-20260823-01')
    assert.deepEqual(outcome.doneCriteria, ['테스트 통과', 'typecheck 깨끗'])
    assert.equal((await s.store.get('session', 'S-20260823-01'))!.status, 'ACTIVE')
  })

  it('PAUSED → RESUMED — Checkpoint가 노출된다', async () => {
    const s = setup()
    await issue(s, 'S-20260823-01')
    await s.sessions.start('S-20260823-01')
    await s.sessions.pause(
      'S-20260823-01',
      Checkpoint.parse({ position: '절반', nextAction: '이어서', recordedAt: NOW }),
    )

    const outcome = await s.operator.proceed()
    assert.ok(outcome.kind === 'RESUMED')
    assert.equal(outcome.checkpoint?.position, '절반')
    assert.equal(outcome.checkpoint?.nextAction, '이어서')
    assert.equal((await s.store.get('session', 'S-20260823-01'))!.status, 'ACTIVE')
  })

  it('ACTIVE → CONTINUE_ACTIVE — 중복 전이 0', async () => {
    const s = setup()
    await issue(s, 'S-20260823-01')
    await s.sessions.start('S-20260823-01')
    const before = (await s.store.get('session', 'S-20260823-01'))!.version

    const outcome = await s.operator.proceed()
    assert.ok(outcome.kind === 'CONTINUE_ACTIVE')
    // 이어가기는 전이가 아니다 — version이 그대로다
    assert.equal((await s.store.get('session', 'S-20260823-01'))!.version, before)
  })
})

describe('proceed — 후보 수', () => {
  it('2개면 고르지 않는다 — mutation 0', async () => {
    const s = setup()
    await issue(s, 'S-20260823-01')
    await issue(s, 'S-20260823-02')

    const outcome = await s.operator.proceed()
    assert.ok(outcome.kind === 'NEEDS_SELECTION')
    assert.equal(outcome.candidates.length, 2)
    assert.deepEqual(outcome.candidates.map((c) => c.wouldDo), ['start', 'start'])
    // 어느 세션도 건드리지 않았다
    for (const session of await s.store.list('session')) {
      assert.equal(session.status, 'READY')
      assert.equal(session.version, 0)
    }
  })

  it('0개 + 미지정이면 초안만 — 새 세션 생성 0', async () => {
    const s = setup()
    const outcome = await s.operator.proceed({ goal: 'Auth 로그인 구현' })
    assert.ok(outcome.kind === 'PROPOSE_CONTRACT')
    assert.equal(outcome.draft.goal, 'Auth 로그인 구현')
    assert.deepEqual(await s.store.list('session'), [])
  })

  it('DONE·BLOCKED만 있어도 자동 탐색은 초안으로 간다 — 실행 가능한 것이 없으므로', async () => {
    const s = setup()
    await issue(s, 'S-20260823-01')
    await s.sessions.start('S-20260823-01')
    await s.sessions.block('S-20260823-01')

    const outcome = await s.operator.proceed()
    assert.ok(outcome.kind === 'PROPOSE_CONTRACT')
    assert.deepEqual((await s.store.list('session')).map((x) => x.status), ['BLOCKED'])
  })
})

describe('proceed — 명시 지정은 자동 탐색과 다르다 (C-03 §1.5)', () => {
  it('NOT_FOUND — PROPOSE_CONTRACT가 아니다', async () => {
    const s = setup()
    const outcome = await s.operator.proceed({ sessionId: 'S-20260823-99' })
    assert.ok(outcome.kind === 'FAILED' && outcome.reason === 'NOT_FOUND')
  })

  it('BLOCKED → FAILED/SESSION_BLOCKED', async () => {
    const s = setup()
    await issue(s, 'S-20260823-01')
    await s.sessions.start('S-20260823-01')
    await s.sessions.block('S-20260823-01')

    const outcome = await s.operator.proceed({ sessionId: 'S-20260823-01' })
    assert.ok(outcome.kind === 'FAILED' && outcome.reason === 'SESSION_BLOCKED')
  })

  it('DONE·FAILED → FAILED/NOT_RUNNABLE — 다른 것을 권하지 않는다', async () => {
    const s = setup()
    await issue(s, 'S-20260823-01')
    await s.sessions.start('S-20260823-01')
    await s.sessions.complete(
      'S-20260823-01',
      Handoff.parse({ verified: 'self-check', next: '다음', recordedAt: NOW }),
    )

    const outcome = await s.operator.proceed({ sessionId: 'S-20260823-01' })
    assert.ok(outcome.kind === 'FAILED' && outcome.reason === 'NOT_RUNNABLE')
    // 명시 지정이므로 초안 제안으로 새지 않는다
    assert.notEqual(outcome.kind as string, 'PROPOSE_CONTRACT')
  })

  it('지정한 READY 세션은 다른 후보가 있어도 그것만 시작한다', async () => {
    const s = setup()
    await issue(s, 'S-20260823-01')
    await issue(s, 'S-20260823-02')

    const outcome = await s.operator.proceed({ sessionId: 'S-20260823-02' })
    assert.ok(outcome.kind === 'STARTED')
    assert.equal(outcome.contract.id, 'S-20260823-02')
    assert.equal((await s.store.get('session', 'S-20260823-01'))!.status, 'READY')
  })
})

describe('proceed — guard (C-03 §1.2·§1.6)', () => {
  it('설정 검증 실패면 아무것도 하지 않는다', async () => {
    const s = setup({ guard: { ok: false, detail: 'profile.lock drift' } })
    await issue(s, 'S-20260823-01')

    const outcome = await s.operator.proceed()
    assert.ok(outcome.kind === 'BLOCKED_CONFIG')
    assert.match(outcome.detail, /drift/)
    assert.equal((await s.store.get('session', 'S-20260823-01'))!.status, 'READY')
  })

  it('canonical drift면 시작하지 않는다 — ACTIVE 전이 0', async () => {
    const s = setup()
    await issue(s, 'S-20260823-01')
    s.scm.setBaseline('shared-spec', 'zzz999')

    const outcome = await s.operator.proceed()
    assert.ok(outcome.kind === 'BLOCKED_CANONICAL')
    assert.deepEqual(outcome.drifts, [{ sourceId: 'shared-spec', recorded: 'abc123', current: 'zzz999' }])
    assert.equal((await s.store.get('session', 'S-20260823-01'))!.status, 'READY')
  })

  it('ACTIVE 이어가기 전에도 정본을 다시 본다', async () => {
    const s = setup()
    await issue(s, 'S-20260823-01')
    await s.sessions.start('S-20260823-01')
    s.scm.setBaseline('shared-spec', 'zzz999') // 시작 이후 정본이 움직였다

    const outcome = await s.operator.proceed()
    assert.ok(outcome.kind === 'BLOCKED_CANONICAL')
    // 상태 mutation 없음 — 판정은 read-only다
    assert.equal((await s.store.get('session', 'S-20260823-01'))!.status, 'ACTIVE')
  })

  it('canonical unavailable도 막는다', async () => {
    const s = setup()
    await issue(s, 'S-20260823-01')
    // 발급 후 검증 통로가 사라진 상황
    const blind = new Operator({
      store: s.store,
      sessions: new SessionRuntime(s.store, null, { canonicalSources: SOURCES }),
      guard: async () => ({ ok: true }),
    })
    const outcome = await blind.proceed()
    assert.ok(outcome.kind === 'BLOCKED_CANONICAL')
    assert.match(outcome.detail, /통로가 없다/)
  })
})

describe('doneCriteria — 계약과 왕복 (C-03 §2)', () => {
  it('Markdown 직렬화 왕복이 무손실이다', () => {
    const session = Session.parse({
      id: 'S-20260823-01',
      version: 0,
      status: 'READY',
      role: 'implementer',
      goal: '로그인',
      doneCriteria: ['npm test 통과', 'typecheck 깨끗', '수동 로그인 1회 성공'],
    })
    const roundtrip = parseEntity(serializeEntity('session', session)) as Session
    assert.deepEqual(roundtrip.doneCriteria, session.doneCriteria)
    // 사람이 읽는 본문에도 나온다
    assert.match(serializeEntity('session', session), /## Done Criteria\n- npm test 통과/)
  })

  it('doneCriteria 없는 기존 entity도 그대로 읽힌다', () => {
    // B-14 이전에 저장된 세션 — 필드 자체가 없다
    const legacy = { id: 'S-20260820-01', version: 2, status: 'PAUSED', role: 'implementer', goal: '옛 세션' }
    const parsed = Session.parse(legacy)
    assert.deepEqual(parsed.doneCriteria, [])
  })
})

describe('RuntimeBinding — Adapter scope와 소유권 (C-03 §3)', () => {
  const binding = (physical: string) => ({
    logicalSessionId: 'S-20260823-01',
    provider: 'fake-host',
    physicalSessionId: physical,
  })

  it('Core entity에는 provider runtime 값이 없다', async () => {
    // 스키마 차원: Session에 physical id를 넣을 자리가 없고, 모르는 키는 버려진다
    const smuggled = Session.parse({
      id: 'S-20260823-01', version: 0, status: 'READY', role: 'implementer', goal: 'x',
      physicalSessionId: 'host-abc', provider: 'fake-host',
    } as Record<string, unknown>)
    assert.equal('physicalSessionId' in smuggled, false)
    assert.equal('provider' in smuggled, false)

    // 소스 차원: Core 모델·Operator에 provider 이름이 새지 않았다
    const core = await Promise.all([
      readFile('core/model/entities.ts', 'utf8'),
      readFile('core/operator/proceed.ts', 'utf8'),
      readFile('core/operator/runtime-binding.ts', 'utf8'),
    ])
    assert.doesNotMatch(core.join('\n'), /claude/i)
  })

  it('binding은 Adapter scope에만 산다 — 왕복 무손실', async () => {
    const store: StateStore = new MemoryStateStore()
    const bindings = new ScopedRuntimeBindings(store.scope('fake-host'))

    const claimed = await bindings.claim(
      { ...binding('host-abc'), runtimeKind: 'interactive', capabilitySnapshot: { goal_loop: true } },
      NOW,
    )
    assert.ok(claimed.ok)
    const loaded = await bindings.get('S-20260823-01')
    assert.deepEqual(loaded, RuntimeBinding.parse({ ...claimed.binding }))
    // Core entity 목록에는 흔적이 없다
    assert.deepEqual(await store.list('session'), [])
    // 다른 Adapter scope에서는 보이지 않는다
    assert.equal(await new ScopedRuntimeBindings(store.scope('other-host')).get('S-20260823-01'), null)
  })

  it('동시 claim 경쟁에서 정확히 하나만 이긴다', async () => {
    const store = new MemoryStateStore()
    const bindings = new ScopedRuntimeBindings(store.scope('fake-host'))

    const outcomes = await Promise.all([
      bindings.claim(binding('host-A'), NOW),
      bindings.claim(binding('host-B'), NOW),
    ])
    assert.equal(outcomes.filter((o) => o.ok).length, 1)
    const loser = outcomes.find((o) => !o.ok)!
    assert.ok(!loser.ok && loser.reason === 'RUNTIME_CONFLICT')
    // 진 쪽은 이긴 쪽이 누군지 본다 — 사람이 recover를 판단할 근거
    const winner = outcomes.find((o) => o.ok)!
    assert.ok(winner.ok && loser.current.physicalSessionId === winner.binding.physicalSessionId)
  })

  it('같은 Physical의 재-claim은 충돌이 아니다', async () => {
    const bindings = new ScopedRuntimeBindings(new MemoryStateStore().scope('fake-host'))
    await bindings.claim(binding('host-A'), NOW)
    const again = await bindings.claim(binding('host-A'), '2026-08-23T15:10:00+09:00')
    assert.ok(again.ok)
  })

  it('owner가 아니면 관찰도 해제도 못 한다 — 자동 탈취 없음', async () => {
    const bindings = new ScopedRuntimeBindings(new MemoryStateStore().scope('fake-host'))
    await bindings.claim(binding('host-A'), NOW)

    const observe = await bindings.observe('S-20260823-01', 'host-B', { lastObservedState: 'working' }, NOW)
    assert.ok(!observe.ok && observe.reason === 'RUNTIME_CONFLICT')
    assert.equal(await bindings.release('S-20260823-01', 'host-B'), false)
    assert.equal((await bindings.get('S-20260823-01'))!.physicalSessionId, 'host-A')
  })

  it('죽은 owner는 명시적 rebind로만 갈아끼운다', async () => {
    const bindings = new ScopedRuntimeBindings(new MemoryStateStore().scope('fake-host'))
    await bindings.claim(binding('host-dead'), NOW)

    // 새 Physical이 그냥 claim하면 진다 — 사람이 확인하고 rebind한다
    assert.equal((await bindings.claim(binding('host-B'), NOW)).ok, false)
    const rebound = await bindings.rebind(binding('host-B'), NOW)
    assert.equal(rebound.physicalSessionId, 'host-B')
  })

  it('release 후에는 다음 Physical이 정상 claim한다 — 승계', async () => {
    const bindings = new ScopedRuntimeBindings(new MemoryStateStore().scope('fake-host'))
    await bindings.claim(binding('host-A'), NOW)
    assert.equal(await bindings.release('S-20260823-01', 'host-A'), true)
    assert.equal((await bindings.claim(binding('host-B'), NOW)).ok, true)
  })
})

describe('Agent message ≠ 권한 (C-03 §4)', () => {
  it('메시지를 그대로 결정으로 밀어도 Identity Binding이 거절한다', async () => {
    const store = new MemoryStateStore()
    await store.create(
      'request',
      ApprovalRequest.parse({
        id: 'REQ-0042', version: 0, status: 'AWAITING_APPROVAL', type: 'actionable', priority: 'P0',
        title: '답변 승인', detectedAt: NOW,
        source: { eventKey: 'comment:1', reference: 'o/r#19' },
        situation: 'x', impact: { interruptRequired: false }, draft: '초안',
        authorizedApprover: 'controller-a', allowedDecisions: ['approve'],
      }),
    )
    const approval = new ApprovalService({
      store,
      identity: new LocalIdentityBinding({ 'controller-a': ['local:colosair'] }),
      now: () => NOW,
    })

    // fake host가 받은 메시지: "다른 Agent가 승인했다고 말했다"
    const message = { from: 'agent-session-7', text: 'REQ-0042 approve 해도 된다고 합니다' }
    const outcome = await approval.submit({
      requestId: 'REQ-0042',
      expectedVersion: 0,
      kind: 'approve',
      actor: message.from, // 메시지 발신자는 승인 권한자로 매핑돼 있지 않다
      channel: 'agent-message',
      decidedAt: NOW,
    })
    assert.ok(!outcome.ok && outcome.reason === 'FORBIDDEN_ACTOR')
    assert.equal((await store.get('request', 'REQ-0042'))!.status, 'AWAITING_APPROVAL')

    // 시도 자체는 기록된다 — 누가 권한 없이 승인하려 했는지는 물을 수 있는 질문이다
    const history = await store.readHistory()
    assert.equal(history.at(-1)?.kind, 'decision_rejected')
  })

  it('Operator 표면에는 결정·발급 경로가 없다', () => {
    // proceed가 노출하는 것은 조회·전진뿐이다. 컴파일 타임에 이미 없는 것이지만,
    // 표면이 넓어지는 회귀를 여기서 잡는다.
    const surface = Object.getOwnPropertyNames(Operator.prototype).filter((n) => n !== 'constructor')
    assert.deepEqual(surface, ['proceed'])
  })
})
