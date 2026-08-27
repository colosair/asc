// B-41 Gate — 발급된 세션과 실제 실행을 갈라 적는다 (C-10 §1).
//
// 이 파일이 지키는 한 문장: **logical session id를 만든 것은 그 일을 누가 했다는 증거가
// 아니다.** 세 사람이 실제로 나눠 한 흐름과, 한 사람이 id 세 개를 만든 흐름이 기록에서
// 구분돼야 한다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ScopedRuntimeBindings } from '../adapters/memory/runtime-binding.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { Checkpoint, Handoff } from '../core/model/entities.ts'
import { AuditLedger, delegationLine, executionLines, reclaimLine, validationLines } from '../core/runtime/audit.ts'
import { collectSessions } from '../core/runtime/controller.ts'
import { SessionRuntime } from '../core/runtime/session.ts'

const NOW = '2026-08-26T21:00:00+09:00'
const LATER = '2026-08-26T22:30:00+09:00'

const CONTROLLER = 'S-20260826-01'
const IMPLEMENTER = 'S-20260826-02'
const VALIDATOR = 'S-20260826-03'

const ledgerOn = (store: MemoryStateStore, now = NOW) => new AuditLedger(store.scope('audit'), () => now)
const bindingsOn = (store: MemoryStateStore, now = NOW) =>
  new ScopedRuntimeBindings(store.scope('test-host'), () => now)

const delegation = (over: Record<string, unknown> = {}) => ({
  parentSessionId: CONTROLLER,
  childSessionId: IMPLEMENTER,
  role: 'implementer',
  goal: '관찰 조립 결함을 닫는다',
  scope: ['composition/**'],
  doneCriteria: ['Gate 통과'],
  issuedBy: 'controller-a',
  ...over,
})

describe('B-41 Gate — Delegation은 의도, Execution은 사실 (C-10 §1.1)', () => {
  it('위임을 선언해도 실행 증거는 생기지 않는다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)

    const result = await audit.delegate(delegation())
    assert.equal(result.ok, true)

    // 발급만 하고 아무도 집지 않은 상태 — 결함이 아니라 정확히 그 상태다
    assert.deepEqual(await audit.executionsOf(IMPLEMENTER), [])
    assert.deepEqual(executionLines([]), ['  실행 증거 없음 — 발급됐으나 아무도 집지 않았다'])
  })

  it('같은 세션을 두 번 맡기면 덮지 않고 거부한다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)

    await audit.delegate(delegation())
    const second = await audit.delegate(delegation({ issuedBy: 'controller-b', goal: '다른 목표' }))

    assert.equal(second.ok, false)
    if (second.ok) return
    assert.equal(second.reason, 'ALREADY_RECORDED')
    assert.equal(second.existing.issuedBy, 'controller-a', '먼저 적힌 것이 남는다')
  })

  it('부모 없는 발급은 최상위로 적고 없는 부모를 지어내지 않는다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)

    const result = await audit.delegate(delegation({ parentSessionId: undefined, childSessionId: CONTROLLER }))
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.record.parentSessionId, undefined)
    assert.match(delegationLine(result.record, CONTROLLER), /최상위/)
  })

  it('위임 기록이 없으면 없다고 적는다', () => {
    assert.match(delegationLine(null, IMPLEMENTER), /위임 기록 없음/)
  })

  it('부모 축으로 맡긴 것들을 되찾는다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)

    await audit.delegate(delegation())
    await audit.delegate(delegation({ childSessionId: VALIDATOR, role: 'verifier' }))
    await audit.delegate(delegation({ parentSessionId: IMPLEMENTER, childSessionId: 'S-20260826-04' }))

    const mine = await audit.delegationsFrom(CONTROLLER)
    assert.deepEqual(mine.map((d) => d.childSessionId).sort(), [IMPLEMENTER, VALIDATOR])
  })
})

describe('B-41 Gate — 실행 증거는 회수 뒤에도 남는다 (C-10 §1.3)', () => {
  it('실행을 기록하고 끝나면 끝났다고 적는다 — 시작 기록은 그대로다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)

    const started = await audit.execute({
      logicalSessionId: IMPLEMENTER,
      hostAdapter: 'test-host',
      principal: 'alice',
      principalSource: 'declared',
      physicalReference: 'phys-1',
      evidenceSource: 'bind',
    })
    assert.equal(started.evidence.status, 'RUNNING')
    assert.equal(started.evidence.finishedAt, undefined)

    const ended = await audit.endExecution(started.evidence.executionId, 'RELEASED', LATER)
    assert.equal(ended.ok, true)
    if (!ended.ok) return
    assert.equal(ended.evidence.status, 'RELEASED')
    assert.equal(ended.evidence.finishedAt, LATER)
    assert.equal(ended.evidence.startedAt, NOW, '시작 시각은 흔들리지 않는다')
  })

  it('두 번 끝냈다고 적지 않는다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)
    const started = await audit.execute({
      logicalSessionId: IMPLEMENTER,
      hostAdapter: 'test-host',
      principal: 'alice',
      principalSource: 'declared',
      physicalReference: 'phys-1',
      evidenceSource: 'bind',
    })

    await audit.endExecution(started.evidence.executionId, 'RELEASED')
    const again = await audit.endExecution(started.evidence.executionId, 'RELEASED')
    assert.equal(again.ok, false)
    if (again.ok) return
    assert.equal(again.reason, 'ALREADY_ENDED')
  })

  it('한 세션을 거쳐 간 실행이 여럿이면 전부 남는다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)
    const base = {
      logicalSessionId: IMPLEMENTER,
      hostAdapter: 'test-host',
      principalSource: 'declared' as const,
      evidenceSource: 'bind',
    }

    const first = await audit.execute({ ...base, principal: 'alice', physicalReference: 'phys-1' })
    await audit.endExecution(first.evidence.executionId, 'SUPERSEDED')
    await audit.execute({ ...base, principal: 'bob', physicalReference: 'phys-2' })

    const all = await audit.executionsOf(IMPLEMENTER)
    assert.equal(all.length, 2, '승계 뒤에도 앞선 실행이 남는다')
    assert.deepEqual(
      all.map((e) => [e.principal, e.status]),
      [
        ['alice', 'SUPERSEDED'],
        ['bob', 'RUNNING'],
      ],
    )
  })

  it('없는 실행을 끝냈다고 적지 않는다', async () => {
    const store = new MemoryStateStore()
    const ended = await ledgerOn(store).endExecution('E-없음-1', 'RELEASED')
    assert.equal(ended.ok, false)
    if (ended.ok) return
    assert.equal(ended.reason, 'NOT_FOUND')
  })
})

describe('B-41 Gate — 소유권 묘비 (Runtime Binding)', () => {
  const spec = (physical: string) => ({
    logicalSessionId: IMPLEMENTER,
    provider: 'test-provider',
    physicalSessionId: physical,
  })

  it('내려놓으면 현재 소유권은 사라지되 이력은 남는다', async () => {
    const store = new MemoryStateStore()
    const bindings = bindingsOn(store)

    await bindings.claim(spec('phys-1'), NOW)
    assert.equal(await bindings.release(IMPLEMENTER, 'phys-1'), true)

    assert.equal(await bindings.get(IMPLEMENTER), null, '현재 소유권은 비어야 한다')
    const history = await bindings.history(IMPLEMENTER)
    assert.equal(history.length, 1)
    assert.equal(history[0]!.physicalSessionId, 'phys-1')
    assert.equal(history[0]!.kind, 'RELEASED')
  })

  it('승계도 덮이는 쪽을 남긴다', async () => {
    const store = new MemoryStateStore()
    const bindings = bindingsOn(store)

    await bindings.claim(spec('phys-1'), NOW)
    await bindings.rebind(spec('phys-2'), LATER)

    const history = await bindings.history(IMPLEMENTER)
    assert.equal(history.length, 1)
    assert.equal(history[0]!.kind, 'SUPERSEDED')
    assert.equal(history[0]!.physicalSessionId, 'phys-1')
    assert.equal((await bindings.get(IMPLEMENTER))!.physicalSessionId, 'phys-2')
  })

  it('같은 physical로 rebind하면 묘비를 만들지 않는다 — 승계가 아니다', async () => {
    const store = new MemoryStateStore()
    const bindings = bindingsOn(store)

    await bindings.claim(spec('phys-1'), NOW)
    await bindings.rebind(spec('phys-1'), LATER)

    assert.deepEqual(await bindings.history(IMPLEMENTER), [])
  })

  it('owner가 아니면 내려놓지 못하고 이력도 생기지 않는다', async () => {
    const store = new MemoryStateStore()
    const bindings = bindingsOn(store)

    await bindings.claim(spec('phys-1'), NOW)
    assert.equal(await bindings.release(IMPLEMENTER, 'phys-2'), false)
    assert.deepEqual(await bindings.history(IMPLEMENTER), [])
  })

  it('묘비 키가 guard의 관리 대상 판별에 걸리지 않는다', async () => {
    const store = new MemoryStateStore()
    const bindings = bindingsOn(store)
    await bindings.claim(spec('phys-1'), NOW)
    await bindings.release(IMPLEMENTER, 'phys-1')

    // Host guard는 이 scope에서 `runtime-binding` 으로 시작하는 항목만 관리 대상으로 읽는다.
    // 묘비가 거기 걸리면 이미 내려놓은 세션이 계속 관리 대상으로 판정된다.
    const live = (await store.scope('test-host').keys('runtime-binding')).length
    assert.equal(live, 0, '내려놓은 뒤에는 관리 대상으로 읽힐 항목이 없어야 한다')
  })
})

describe('B-41 Gate — 3-agent 흐름과 1인 3-id 흐름의 구분 (C-10 §5.1)', () => {
  const base = { hostAdapter: 'test-host', evidenceSource: 'bind' }

  it('한 사람이 id 셋을 만들면 principal이 하나로 보인다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)

    for (const session of [CONTROLLER, IMPLEMENTER, VALIDATOR]) {
      await audit.execute({
        ...base,
        logicalSessionId: session,
        principal: 'phys-solo',
        principalSource: 'derived',
        physicalReference: 'phys-solo',
      })
    }

    const principals = new Set(
      (
        await Promise.all([CONTROLLER, IMPLEMENTER, VALIDATOR].map((s) => audit.executionsOf(s)))
      ).flat().map((e) => e.principal),
    )
    assert.equal(principals.size, 1, '세 역할을 한 주체가 연기했다')
    const derived = (await audit.executionsOf(VALIDATOR)).every((e) => e.principalSource === 'derived')
    assert.equal(derived, true, '선언되지 않은 principal은 유추로 남는다')
  })

  it('세 주체가 각각 선언하면 principal이 셋으로 보인다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)
    const cast: [string, string][] = [
      [CONTROLLER, 'alice'],
      [IMPLEMENTER, 'bob'],
      [VALIDATOR, 'carol'],
    ]

    for (const [session, principal] of cast) {
      await audit.execute({
        ...base,
        logicalSessionId: session,
        principal,
        principalSource: 'declared',
        physicalReference: `phys-${principal}`,
      })
    }

    const principals = new Set(
      (await Promise.all(cast.map(([s]) => audit.executionsOf(s)))).flat().map((e) => e.principal),
    )
    assert.equal(principals.size, 3)
  })

  it('사람이 읽는 줄에 신고 수준이 드러난다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)
    await audit.execute({
      ...base,
      logicalSessionId: IMPLEMENTER,
      principal: 'phys-1',
      principalSource: 'derived',
      physicalReference: 'phys-1',
    })

    const [line] = executionLines(await audit.executionsOf(IMPLEMENTER))
    assert.match(line!, /유추/, '유추한 principal을 선언된 것처럼 보이게 하지 않는다')
    assert.match(line!, /진행 중/)
  })
})

// B-42 Gate — 기록할 자격과 회수 주체 (C-10 §2).
describe('B-42 Gate — Checkpoint·Handoff writer 대칭 (C-10 §2.3)', () => {
  const SESSION = 'S-20260826-09'

  const checkpoint = () =>
    Checkpoint.parse({
      position: '절반',
      nextAction: '이어서',
      currentJudgment: '조립 결함이 원인이다',
      blockers: ['자격 없음'],
      evidenceRefs: ['tests/observe.test.ts'],
      recordedAt: NOW,
    })

  const handoff = () =>
    Handoff.parse({
      done: ['A'],
      changed: [],
      verified: 'self-check (독립 검증 아님)',
      unresolved: [],
      next: '회수 요청',
      recordedAt: NOW,
    })

  async function activeSession(store: MemoryStateStore) {
    await store.create('session', {
      id: SESSION,
      version: 0,
      status: 'READY',
      role: 'implementer',
      goal: '관찰 조립을 닫는다',
      doneCriteria: [],
      readScope: [],
      writeBoundary: [],
      outOfScope: [],
      policyExceptions: [],
      canonicalSources: [],
      decisionDomains: [],
      decisionAuthority: {},
      dependencies: [],
    })
  }

  const runtimeWith = (store: MemoryStateStore, bindings?: ScopedRuntimeBindings) =>
    new SessionRuntime(store, null, bindings ? { bindings } : {})

  it('binding이 있으면 owner만 checkpoint를 쓴다', async () => {
    const store = new MemoryStateStore()
    await activeSession(store)
    const bindings = bindingsOn(store)
    await bindings.claim({ logicalSessionId: SESSION, provider: 'test', physicalSessionId: 'phys-1' }, NOW)

    const runtime = runtimeWith(store, bindings)
    await runtime.start(SESSION)

    const stranger = await runtime.pause(SESSION, checkpoint(), 'phys-2')
    assert.equal(stranger.ok, false)
    if (stranger.ok) return
    assert.equal(stranger.reason, 'NOT_OWNER')
    assert.match((stranger as { detail: string }).detail, /phys-1/, '누가 owner인지 말해 준다')

    const owner = await runtime.pause(SESSION, checkpoint(), 'phys-1')
    assert.equal(owner.ok, true)
  })

  it('binding이 있는데 physical을 대지 않으면 거부한다', async () => {
    const store = new MemoryStateStore()
    await activeSession(store)
    const bindings = bindingsOn(store)
    await bindings.claim({ logicalSessionId: SESSION, provider: 'test', physicalSessionId: 'phys-1' }, NOW)

    const runtime = runtimeWith(store, bindings)
    await runtime.start(SESSION)
    const anonymous = await runtime.pause(SESSION, checkpoint())
    assert.equal(anonymous.ok, false)
    if (anonymous.ok) return
    assert.equal(anonymous.reason, 'NOT_OWNER')
  })

  it('handoff도 같은 검사를 받는다 — 종료만 열려 있지 않다', async () => {
    const store = new MemoryStateStore()
    await activeSession(store)
    const bindings = bindingsOn(store)
    await bindings.claim({ logicalSessionId: SESSION, provider: 'test', physicalSessionId: 'phys-1' }, NOW)

    const runtime = runtimeWith(store, bindings)
    await runtime.start(SESSION)
    const stranger = await runtime.complete(SESSION, handoff(), 'phys-2')
    assert.equal(stranger.ok, false)
    if (stranger.ok) return
    assert.equal(stranger.reason, 'NOT_OWNER')
    assert.equal((await store.get('session', SESSION))!.status, 'ACTIVE', '거부는 전이를 남기지 않는다')
  })

  it('binding 통로가 없으면 지금처럼 통과한다 — 없던 잠금을 새로 걸지 않는다', async () => {
    const store = new MemoryStateStore()
    await activeSession(store)
    const runtime = runtimeWith(store)
    await runtime.start(SESSION)

    assert.equal((await runtime.pause(SESSION, checkpoint())).ok, true)
  })

  it('binding이 없는 세션은 막지 않는다 — 소유권 개념이 없는 경로다', async () => {
    const store = new MemoryStateStore()
    await activeSession(store)
    const runtime = runtimeWith(store, bindingsOn(store))
    await runtime.start(SESSION)

    assert.equal((await runtime.pause(SESSION, checkpoint())).ok, true)
  })

  it('확장 필드가 기록에 남는다 — 판단과 근거가 사라지지 않는다', async () => {
    const store = new MemoryStateStore()
    await activeSession(store)
    const runtime = runtimeWith(store)
    await runtime.start(SESSION)
    await runtime.pause(SESSION, checkpoint())

    const saved = (await store.get('session', SESSION))!.checkpoint!
    assert.equal(saved.currentJudgment, '조립 결함이 원인이다')
    assert.deepEqual(saved.blockers, ['자격 없음'])
    assert.deepEqual(saved.evidenceRefs, ['tests/observe.test.ts'])
  })

  it('예전 형식 checkpoint도 그대로 읽힌다', () => {
    const legacy = Checkpoint.parse({ position: '절반', nextAction: '이어서', recordedAt: NOW })
    assert.deepEqual(legacy.blockers, [])
    assert.equal(legacy.currentJudgment, undefined)
  })
})

describe('B-42 Gate — 회수 주체 (C-10 §2.4)', () => {
  it('회수 증거에 주체와 회수 시점 실행이 남는다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)
    await audit.execute({
      logicalSessionId: IMPLEMENTER,
      hostAdapter: 'test-host',
      principal: 'bob',
      principalSource: 'declared',
      physicalReference: 'phys-2',
      evidenceSource: 'bind',
    })

    const reclaimed = await audit.reclaim({
      sessionId: IMPLEMENTER,
      reclaimedBy: 'alice',
      reclaimedAt: LATER,
      handoffRef: NOW,
    })
    assert.equal(reclaimed.ok, true)
    if (!reclaimed.ok) return
    assert.equal(reclaimed.record.reclaimedBy, 'alice')
    assert.deepEqual(reclaimed.record.executionRefs, [`E-${IMPLEMENTER}-1`])
    assert.match(reclaimLine(reclaimed.record, IMPLEMENTER), /alice/)
  })

  it('두 번 거뒀다고 적지 않는다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)
    await audit.reclaim({ sessionId: IMPLEMENTER, reclaimedBy: 'alice', reclaimedAt: LATER })
    const again = await audit.reclaim({ sessionId: IMPLEMENTER, reclaimedBy: 'mallory', reclaimedAt: LATER })

    assert.equal(again.ok, false)
    const stored = await audit.reclaimOf(IMPLEMENTER)
    assert.equal(stored!.reclaimedBy, 'alice', '먼저 적힌 주체가 남는다')
  })

  it('회수 기록이 없으면 없다고 적는다', () => {
    assert.match(reclaimLine(null, IMPLEMENTER), /회수 기록 없음/)
  })

  it('collect가 익명이 아니라 실제 주체를 History에 남긴다', async () => {
    const store = new MemoryStateStore()
    await store.create('session', {
      id: IMPLEMENTER,
      version: 0,
      status: 'DONE',
      role: 'implementer',
      goal: '끝난 일',
      doneCriteria: [],
      readScope: [],
      writeBoundary: [],
      outOfScope: [],
      policyExceptions: [],
      canonicalSources: [],
      decisionDomains: [],
      decisionAuthority: {},
      dependencies: [],
      handoff: {
        done: [],
        changed: [],
        verified: 'self-check',
        unresolved: [],
        next: '다음',
        snapshot: [],
        recordedAt: NOW,
      },
    })

    const audit = ledgerOn(store)
    await collectSessions(store, LATER, { reclaimedBy: 'alice', auditLedger: audit })

    const history = await store.readHistory()
    const collected = history.find((h) => h.kind === 'session_collected')
    assert.equal(collected!.actor, 'alice', '익명 controller 문자열이 아니다')
    assert.equal((await audit.reclaimOf(IMPLEMENTER))!.reclaimedBy, 'alice')
  })
})

// B-43 Gate — 독립 검증과 자기 신고를 가른다 (C-10 §4).
describe('B-43 Gate — Validator Execution Evidence (C-10 §4)', () => {
  const run = (
    audit: AuditLedger,
    session: string,
    principal: string,
    source: 'declared' | 'derived' = 'declared',
  ) =>
    audit.execute({
      logicalSessionId: session,
      hostAdapter: 'test-host',
      principal,
      principalSource: source,
      physicalReference: `phys-${principal}`,
      evidenceSource: 'bind',
    })

  it('검증 세션에 실행 증거가 없으면 기록하지 않는다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)
    await run(audit, IMPLEMENTER, 'bob')

    // VALIDATOR 세션 id는 있지만 아무도 그것을 집지 않았다
    const recorded = await audit.validate({
      validatorSessionId: VALIDATOR,
      targetSessionId: IMPLEMENTER,
      result: 'PASS',
    })
    assert.equal(recorded.ok, false)
    if (recorded.ok) return
    assert.equal(recorded.reason, 'NO_VALIDATOR_EXECUTION')
    assert.deepEqual(await audit.validationsOf(IMPLEMENTER), [])
  })

  it('다른 선언 주체가 검증하면 INDEPENDENT다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)
    await run(audit, IMPLEMENTER, 'bob')
    await run(audit, VALIDATOR, 'carol')

    const recorded = await audit.validate({
      validatorSessionId: VALIDATOR,
      targetSessionId: IMPLEMENTER,
      result: 'PASS',
      findings: ['npm test 699 pass'],
    })
    assert.equal(recorded.ok, true)
    if (!recorded.ok) return
    assert.equal(recorded.record.independence, 'INDEPENDENT')
    assert.equal(recorded.record.validatorExecutionId, `E-${VALIDATOR}-1`)
    assert.deepEqual(recorded.record.findings, ['npm test 699 pass'])
  })

  it('같은 주체가 자기 일을 PASS 하면 SELF_REPORTED다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)
    await run(audit, IMPLEMENTER, 'bob')
    await run(audit, VALIDATOR, 'bob')

    const recorded = await audit.validate({
      validatorSessionId: VALIDATOR,
      targetSessionId: IMPLEMENTER,
      result: 'PASS',
    })
    assert.equal(recorded.ok, true)
    if (!recorded.ok) return
    assert.equal(recorded.record.independence, 'SELF_REPORTED')
    assert.match(recorded.record.independenceDetail, /같은 주체/)
  })

  it('주체가 유추면 다르게 보여도 UNVERIFIED다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)
    await run(audit, IMPLEMENTER, 'phys-a', 'derived')
    await run(audit, VALIDATOR, 'phys-b', 'derived')

    const recorded = await audit.validate({
      validatorSessionId: VALIDATOR,
      targetSessionId: IMPLEMENTER,
      result: 'PASS',
    })
    assert.equal(recorded.ok, true)
    if (!recorded.ok) return
    assert.equal(recorded.record.independence, 'UNVERIFIED', '선언되지 않은 주체로는 독립을 주장하지 못한다')
  })

  it('대상에 실행 증거가 없으면 비교할 상대가 없어 UNVERIFIED다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)
    await run(audit, VALIDATOR, 'carol')

    const recorded = await audit.validate({
      validatorSessionId: VALIDATOR,
      targetSessionId: IMPLEMENTER,
      result: 'PASS',
    })
    assert.equal(recorded.ok, true)
    if (!recorded.ok) return
    assert.equal(recorded.record.independence, 'UNVERIFIED')
    assert.match(recorded.record.independenceDetail, /비교할 주체가 없다/)
  })

  it('검증이 없으면 없다고 적는다', () => {
    assert.deepEqual(validationLines([]), ['  검증 없음'])
  })

  it('사람이 읽는 줄에 등급과 이유가 함께 온다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)
    await run(audit, IMPLEMENTER, 'bob')
    await run(audit, VALIDATOR, 'bob')
    const recorded = await audit.validate({
      validatorSessionId: VALIDATOR,
      targetSessionId: IMPLEMENTER,
      result: 'PASS',
    })
    assert.equal(recorded.ok, true)
    if (!recorded.ok) return

    const [line] = validationLines([recorded.record])
    assert.match(line!, /SELF_REPORTED/)
    assert.match(line!, /같은 주체/, '등급만 적고 이유를 빼지 않는다')
  })

  it('같은 대상을 여러 번 검증하면 전부 남는다', async () => {
    const store = new MemoryStateStore()
    const audit = ledgerOn(store)
    await run(audit, IMPLEMENTER, 'bob')
    await run(audit, VALIDATOR, 'carol')

    await audit.validate({ validatorSessionId: VALIDATOR, targetSessionId: IMPLEMENTER, result: 'FAIL' })
    await audit.validate({ validatorSessionId: VALIDATOR, targetSessionId: IMPLEMENTER, result: 'PASS' })

    const all = await audit.validationsOf(IMPLEMENTER)
    assert.deepEqual(
      all.map((v) => v.result),
      ['FAIL', 'PASS'],
      '뒤집힌 판정도 앞선 기록을 지우지 않는다',
    )
  })
})

// C-10 §5.1 — 이 Gate가 잡는 것은 거짓말이 아니라 근거 없는 승격이다.
describe('B-43 Gate — 3-agent 흐름과 1인 연기의 최종 구분', () => {
  const cast = async (audit: AuditLedger, principals: [string, string, string], source: 'declared' | 'derived') => {
    const sessions = [CONTROLLER, IMPLEMENTER, VALIDATOR]
    for (const [index, session] of sessions.entries()) {
      await audit.execute({
        logicalSessionId: session,
        hostAdapter: 'test-host',
        principal: principals[index]!,
        principalSource: source,
        physicalReference: `phys-${principals[index]}-${index}`,
        evidenceSource: 'bind',
      })
    }
    return audit.validate({ validatorSessionId: VALIDATOR, targetSessionId: IMPLEMENTER, result: 'PASS' })
  }

  it('한 사람이 세 역할을 연기하면 독립 검증으로 세지 않는다', async () => {
    const store = new MemoryStateStore()
    const recorded = await cast(ledgerOn(store), ['solo', 'solo', 'solo'], 'derived')
    assert.equal(recorded.ok, true)
    if (!recorded.ok) return
    assert.notEqual(recorded.record.independence, 'INDEPENDENT')
  })

  it('세 주체가 각각 선언하면 독립 검증으로 선다', async () => {
    const store = new MemoryStateStore()
    const recorded = await cast(ledgerOn(store), ['alice', 'bob', 'carol'], 'declared')
    assert.equal(recorded.ok, true)
    if (!recorded.ok) return
    assert.equal(recorded.record.independence, 'INDEPENDENT')
  })
})
