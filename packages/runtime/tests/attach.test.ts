// B-11 Gate — attach가 프로젝트에 무엇을 남기는지, Controller 회수가 무엇을 거두는지.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { FakeScm } from '../adapters/memory/mocks.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { mergePolicyLayers } from '../core/policy/policy.ts'
import {
  discoverProjectRoot,
  excludeFromGit,
  identitiesTemplate,
  overrideTemplate,
  writeIfAbsent,
} from '../core/attach/init.ts'
import { collectSessions, renderCollect } from '../core/runtime/controller.ts'
import { Checkpoint, Handoff, Session } from '../core/model/entities.ts'
import { SessionRuntime } from '../core/runtime/session.ts'
import { UserOverride } from '../schemas/profile.ts'
import type { StateStore } from '../ports/state-store.ts'

const NOW = '2026-08-23T12:00:00+09:00'

const dirs: string[] = []
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function fakeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'asc-project-'))
  dirs.push(root)
  await mkdir(join(root, '.git', 'info'), { recursive: true })
  await mkdir(join(root, 'src', 'deep'), { recursive: true })
  return root
}

describe('프로젝트 뿌리 찾기', () => {
  it('하위 어디서 불러도 .git이 있는 곳을 찾는다', async () => {
    const root = await fakeProject()
    const found = await discoverProjectRoot(join(root, 'src', 'deep'))
    assert.equal(found.root, root)
    assert.equal(found.git, true)
  })

  it('git 저장소가 아니면 부른 자리를 뿌리로 본다', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'asc-plain-'))
    dirs.push(plain)
    const found = await discoverProjectRoot(plain)
    assert.equal(found.git, false)
  })
})

describe('Git 추적 제외', () => {
  it('팀 파일이 아니라 내 작업 공간에만 적는다', async () => {
    const root = await fakeProject()
    assert.equal(await excludeFromGit(root), 'added')

    // .gitignore 는 팀 것이라 건드리지 않는다 — ASC를 쓰지 않는 사람에게 흔적이 보이면 안 된다
    assert.equal(await readFile(join(root, '.git', 'info', 'exclude'), 'utf8'), '.asc/\n')
    await assert.rejects(() => readFile(join(root, '.gitignore'), 'utf8'))
  })

  it('두 번 불러도 줄이 늘지 않는다', async () => {
    const root = await fakeProject()
    await excludeFromGit(root)
    assert.equal(await excludeFromGit(root), 'already')
    const text = await readFile(join(root, '.git', 'info', 'exclude'), 'utf8')
    assert.equal(text.split('\n').filter((l) => l.trim() === '.asc/').length, 1)
  })

  it('기존 내용을 지우지 않고 줄바꿈을 챙긴다', async () => {
    const root = await fakeProject()
    await writeFile(join(root, '.git', 'info', 'exclude'), '*.local', 'utf8') // 끝에 개행 없음
    await excludeFromGit(root)
    assert.equal(await readFile(join(root, '.git', 'info', 'exclude'), 'utf8'), '*.local\n.asc/\n')
  })

  it('git 저장소가 아니면 건너뛴다', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'asc-plain-'))
    dirs.push(plain)
    assert.equal(await excludeFromGit(plain), 'no-git')
  })
})

describe('서식 파일', () => {
  it('사람이 채운 것을 덮지 않는다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asc-tpl-'))
    dirs.push(root)
    const path = join(root, 'override.json')

    assert.equal(await writeIfAbsent(path, overrideTemplate()), true)
    await writeFile(path, '{"schemaVersion":1,"monitorIdentities":["me"]}', 'utf8')
    assert.equal(await writeIfAbsent(path, overrideTemplate()), false)
    assert.match(await readFile(path, 'utf8'), /"me"/)
  })

  it('생성한 서식은 스키마를 만족한다', () => {
    assert.equal(UserOverride.safeParse(JSON.parse(overrideTemplate())).success, true)
    // 승인자 매핑은 비어 있다 — 채우기 전에는 어떤 승인도 통과하지 않는다.
    // 서식에 형식 예시가 들어가 있지만(B-21) 값이 배열인 항목만 매핑으로 읽히므로
    // 예시는 승인자가 되지 않는다. 계약은 "파싱 결과가 비었나"이지 "파일이 {} 인가"가 아니다.
    const parsed = JSON.parse(identitiesTemplate()) as Record<string, unknown>
    const approvers = Object.entries(parsed).filter(([, ids]) => Array.isArray(ids))
    assert.deepEqual(approvers, [])
  })

  it('서식에 비밀이 들어 있지 않다', () => {
    const text = overrideTemplate()
    assert.doesNotMatch(text, /"token"\s*:/)
    assert.match(text, /토큰은 값이 아니라 이름으로만/)
  })
})

describe('Controller 회수', () => {
  const boundary = ['frontend/src/**']

  async function withSessions(store: StateStore) {
    const runtime = new SessionRuntime(store)
    await runtime.issue({ id: 'S-20260823-01', role: 'implementer', goal: '끝난 일', writeBoundary: boundary })
    await runtime.start('S-20260823-01')
    await runtime.complete(
      'S-20260823-01',
      Handoff.parse({
        done: ['T-004'],
        changed: ['frontend/src/a.ts'],
        verified: 'self-check',
        unresolved: ['빈 값 허용 여부는 기획 확인 필요'],
        next: '다음 블록',
        recordedAt: NOW,
      }),
    )

    await runtime.issue({ id: 'S-20260823-02', role: 'implementer', goal: '도는 일', writeBoundary: boundary })
    await runtime.start('S-20260823-02')
    return runtime
  }

  it('활성은 남기고 끝난 것은 거둔다', async () => {
    const store = new MemoryStateStore()
    await withSessions(store)

    const outcome = await collectSessions(store, NOW)
    assert.deepEqual(outcome.active, ['S-20260823-02'])
    assert.deepEqual(outcome.collected, ['S-20260823-01'])

    const state = await store.getControlState()
    assert.deepEqual(state.activeSessions, ['S-20260823-02'])
    assert.equal(state.recentHandoff, 'S-20260823-01')
  })

  it('미결은 세션이 끝나도 사라지지 않는다', async () => {
    const store = new MemoryStateStore()
    await withSessions(store)

    const outcome = await collectSessions(store, NOW)
    assert.deepEqual(outcome.awaiting, ['S-20260823-01: 빈 값 허용 여부는 기획 확인 필요'])
    assert.deepEqual((await store.getControlState()).awaitingController, outcome.awaiting)
  })

  it('막힌 세션도 판단 목록에 오른다', async () => {
    const store = new MemoryStateStore()
    const runtime = await withSessions(store)
    await runtime.block('S-20260823-02')

    const outcome = await collectSessions(store, NOW)
    assert.ok(outcome.awaiting.includes('S-20260823-02: BLOCKED'))
  })

  it('점유 표는 겹침을 보이게 할 뿐 잠그지 않는다', async () => {
    const store = new MemoryStateStore()
    const runtime = await withSessions(store)
    // 같은 범위를 잡는 두 번째 세션도 발급된다 — 겹치게 발급하지 않는 것은 사람 몫이다
    await runtime.issue({ id: 'S-20260823-03', role: 'implementer', goal: '겹치는 일', writeBoundary: boundary })
    await runtime.start('S-20260823-03')

    const outcome = await collectSessions(store, NOW)
    const paths = outcome.occupancy.map((o) => o.paths.join(','))
    assert.equal(paths.filter((p) => p === 'frontend/src/**').length, 2)
  })

  it('회수는 History에 남는다', async () => {
    const store = new MemoryStateStore()
    await withSessions(store)
    await collectSessions(store, NOW)

    const history = await store.readHistory()
    assert.ok(history.some((h) => h.kind === 'session_collected' && h.ref === 'S-20260823-01'))
  })

  it('사람이 읽는 보고서는 다음 할 일로 끝난다', async () => {
    const store = new MemoryStateStore()
    await withSessions(store)
    const outcome = await collectSessions(store, NOW)
    const text = renderCollect(outcome, await store.list('session'))

    assert.match(text, /활성 세션: S-20260823-02/)
    assert.match(text, /거둔 세션:/)
    assert.ok(text.indexOf('거둔 세션') < text.indexOf('판단이 필요한 것'))
  })

  it('거둘 것이 없으면 조용하다', async () => {
    const store = new MemoryStateStore()
    const outcome = await collectSessions(store, NOW)
    assert.deepEqual(outcome, { active: [], collected: [], awaiting: [], occupancy: [] })
    assert.equal(renderCollect(outcome, []), '활성 세션: 없음')
  })
})

describe('세션 발급 실패는 값으로 온다', () => {
  it('형식을 어긴 계약도 예외가 아니라 결과다', async () => {
    const runtime = new SessionRuntime(new MemoryStateStore())
    // CLI에서 스택 트레이스가 사람에게 튀면 안 된다
    const issued = await runtime.issue({ id: '잘못된-id', role: 'implementer', goal: 'x' })
    assert.ok(!issued.ok && issued.failures[0]!.kind === 'INVALID_CONTRACT')
    assert.match(issued.failures[0]!.detail, /^id: /)
  })

  it('빈 목표도 계약 위반이다', async () => {
    const runtime = new SessionRuntime(new MemoryStateStore())
    const issued = await runtime.issue({ id: 'S-20260823-01', role: 'implementer', goal: '' })
    assert.ok(!issued.ok && issued.failures[0]!.kind === 'INVALID_CONTRACT')
  })

  it('Session 스키마를 통과한 계약만 저장된다', async () => {
    const store = new MemoryStateStore()
    const runtime = new SessionRuntime(store)
    await runtime.issue({ id: '잘못된-id', role: 'implementer', goal: 'x' })
    assert.deepEqual(await store.list('session'), [])
    assert.equal(Session.safeParse({ id: '잘못된-id', version: 0, status: 'READY', role: 'implementer', goal: 'x' }).success, false)
  })
})

describe('Resolved Policy가 실제로 강제된다', () => {
  // Profile이 implementer를 web-frontend/** 로 좁힌 상황
  const { policy } = mergePolicyLayers([
    {
      id: 'vanilla',
      hardDeny: ['external.write', 'canonical.modify'],
      softDeny: ['dependency.add'],
      roleScopes: { implementer: ['**'], verifier: [] },
    },
    { id: 'profile:example-team', roleScopes: { implementer: ['web-frontend/**'] } },
  ])

  const runtimeWith = (store: StateStore) => new SessionRuntime(store, policy)

  it('정책을 붙이지 않으면 검사가 통째로 비어버린다', async () => {
    // 이 조합이 attach된 프로젝트에서 일어나면 안 된다 — CLI가 정책을 넘기는 이유다
    const loose = new SessionRuntime(new MemoryStateStore())
    const issued = await loose.issue({
      id: 'S-20260823-09',
      role: 'implementer',
      goal: '아무 데나',
      writeBoundary: ['backend/**'],
    })
    assert.equal(issued.ok, true)
  })

  it('Profile 범위를 넘는 요청은 거절한다', async () => {
    const issued = await runtimeWith(new MemoryStateStore()).issue({
      id: 'S-20260823-01',
      role: 'implementer',
      goal: '남의 파트 건드리기',
      writeBoundary: ['backend/**'],
    })
    assert.ok(!issued.ok && issued.failures[0]!.kind === 'SCOPE_ESCALATION')
  })

  it('HARD DENY를 예외로 요청하면 거절한다', async () => {
    const issued = await runtimeWith(new MemoryStateStore()).issue({
      id: 'S-20260823-01',
      role: 'implementer',
      goal: '게시까지 하기',
      policyExceptions: ['external.write'],
    })
    assert.ok(!issued.ok && issued.failures[0]!.kind === 'HARD_DENY_ESCAPE')
  })

  it('범위 안으로 좁힌 계약은 통과한다', async () => {
    const issued = await runtimeWith(new MemoryStateStore()).issue({
      id: 'S-20260823-01',
      role: 'implementer',
      goal: 'Studio 편집기',
      writeBoundary: ['web-frontend/src/studio/**'],
      policyExceptions: ['dependency.add'],
    })
    assert.ok(issued.ok)
    assert.deepEqual(issued.session.policyExceptions, ['dependency.add'])
  })
})

describe('정본 baseline — 발급·시작·종료', () => {
  const SOURCES = [{ sourceId: 'shared-spec' }, { sourceId: 'fe-plan' }]

  function scmAt(baselines: Record<string, string>) {
    const scm = new FakeScm()
    for (const [id, sha] of Object.entries(baselines)) scm.setBaseline(id, sha)
    return scm
  }

  const runtimeWith = (store: StateStore, scm: FakeScm) =>
    new SessionRuntime(store, null, { scm, canonicalSources: SOURCES })

  async function issued(store: StateStore, scm: FakeScm) {
    const result = await runtimeWith(store, scm).issue({
      id: 'S-20260823-01',
      role: 'implementer',
      goal: 'validate 구현',
    })
    assert.ok(result.ok)
    return result.session
  }

  it('발급 시점의 정본을 source별로 따로 박아 둔다', async () => {
    const store = new MemoryStateStore()
    const session = await issued(store, scmAt({ 'shared-spec': 'abc123', 'fe-plan': 'def456' }))

    // 하나로 뭉개지 않는다 — 갈래마다 다른 브랜치를 보고 있기 때문이다 (OM §8)
    assert.deepEqual(session.canonicalSources, [
      { sourceId: 'shared-spec', baseline: 'abc123' },
      { sourceId: 'fe-plan', baseline: 'def456' },
    ])
  })

  it('정본이 그대로면 시작한다', async () => {
    const store = new MemoryStateStore()
    const scm = scmAt({ 'shared-spec': 'abc123', 'fe-plan': 'def456' })
    await issued(store, scm)

    const started = await runtimeWith(store, scm).start('S-20260823-01')
    assert.equal(started.ok, true)
  })

  it('정본이 움직였으면 시작하지 않는다', async () => {
    const store = new MemoryStateStore()
    await issued(store, scmAt({ 'shared-spec': 'abc123', 'fe-plan': 'def456' }))

    // 발급 이후 공용 spec이 바뀌었다
    const moved = scmAt({ 'shared-spec': 'zzz999', 'fe-plan': 'def456' })
    const started = await runtimeWith(store, moved).start('S-20260823-01')
    assert.ok(!started.ok && started.reason === 'CANONICAL_DRIFT')
    assert.deepEqual(started.drifts, [{ sourceId: 'shared-spec', recorded: 'abc123', current: 'zzz999' }])

    // 상태도 그대로다 — 바닥이 달라진 채로 이어가지 않는다
    assert.equal((await store.get('session', 'S-20260823-01'))!.status, 'READY')
  })

  it('재개할 때도 정본부터 본다', async () => {
    const store = new MemoryStateStore()
    const scm = scmAt({ 'shared-spec': 'abc123', 'fe-plan': 'def456' })
    await issued(store, scm)
    await runtimeWith(store, scm).start('S-20260823-01')
    await runtimeWith(store, scm).pause(
      'S-20260823-01',
      Checkpoint.parse({ position: '절반', nextAction: '이어서', recordedAt: NOW }),
    )

    const moved = scmAt({ 'shared-spec': 'abc123', 'fe-plan': 'zzz999' })
    const resumed = await runtimeWith(store, moved).resume('S-20260823-01')
    assert.ok(!resumed.ok && resumed.reason === 'CANONICAL_DRIFT')
    assert.equal((await store.get('session', 'S-20260823-01'))!.status, 'PAUSED')
  })

  it('종료 시 그 시점의 정본을 Handoff에 남긴다', async () => {
    const store = new MemoryStateStore()
    const scm = scmAt({ 'shared-spec': 'abc123', 'fe-plan': 'def456' })
    await issued(store, scm)
    await runtimeWith(store, scm).start('S-20260823-01')

    await runtimeWith(store, scm).complete(
      'S-20260823-01',
      Handoff.parse({ verified: 'self-check', next: '다음', recordedAt: NOW }),
    )
    const session = (await store.get('session', 'S-20260823-01'))!
    assert.deepEqual(session.handoff?.snapshot, [
      { sourceId: 'shared-spec', baseline: 'abc123' },
      { sourceId: 'fe-plan', baseline: 'def456' },
    ])
  })

  it('정본이 선언돼 있는데 읽을 통로가 없으면 발급하지 않는다', async () => {
    const store = new MemoryStateStore()
    // 자격 증명이 없어 SCM을 만들지 못한 상황
    const blind = new SessionRuntime(store, null, { canonicalSources: SOURCES })

    const result = await blind.issue({ id: 'S-20260823-01', role: 'implementer', goal: 'x' })
    assert.ok(!result.ok && result.failures[0]!.kind === 'CANONICAL_UNAVAILABLE')
    assert.match(result.failures[0]!.detail, /shared-spec, fe-plan/)
    assert.deepEqual(await store.list('session'), [])
  })

  it('기록은 있는데 지금 못 읽으면 시작하지 않는다', async () => {
    const store = new MemoryStateStore()
    await issued(store, scmAt({ 'shared-spec': 'abc123', 'fe-plan': 'def456' }))

    // 발급 이후 자격 증명이 사라졌다 — 같은지 다른지 말할 수 없다
    const blind = new SessionRuntime(store, null, { canonicalSources: SOURCES })
    const started = await blind.start('S-20260823-01')
    assert.ok(!started.ok && started.reason === 'CANONICAL_UNAVAILABLE')
    assert.equal((await store.get('session', 'S-20260823-01'))!.status, 'READY')
  })

  it('조회는 되는데 값이 unknown이면 읽은 것이 아니다', async () => {
    const store = new MemoryStateStore()
    // fe-plan 만 baseline을 모르는 SCM — FakeScm은 모르는 source에 unknown을 준다
    const partial = scmAt({ 'shared-spec': 'abc123' })
    const runtime = new SessionRuntime(store, null, { scm: partial, canonicalSources: SOURCES })

    const result = await runtime.issue({ id: 'S-20260823-01', role: 'implementer', goal: 'x' })
    assert.ok(!result.ok && result.failures[0]!.kind === 'CANONICAL_UNAVAILABLE')
    assert.match(result.failures[0]!.detail, /fe-plan/)
  })

  it('정본을 선언하지 않은 Runtime은 그대로 돈다', async () => {
    // fixture나 attach 전처럼 정본 개념이 없는 환경
    const store = new MemoryStateStore()
    const bare = new SessionRuntime(store)
    const result = await bare.issue({ id: 'S-20260823-01', role: 'implementer', goal: 'x' })
    assert.ok(result.ok)
    assert.deepEqual(result.session.canonicalSources, [])
    assert.equal((await bare.start('S-20260823-01')).ok, true)
  })

  it('종료는 막지 않는다 — Handoff를 남길 길이 없어지면 세션이 갇힌다', async () => {
    const store = new MemoryStateStore()
    const scm = scmAt({ 'shared-spec': 'abc123', 'fe-plan': 'def456' })
    await issued(store, scm)
    await runtimeWith(store, scm).start('S-20260823-01')

    const blind = new SessionRuntime(store, null, { canonicalSources: SOURCES })
    const done = await blind.complete(
      'S-20260823-01',
      Handoff.parse({ verified: 'self-check', next: '다음', recordedAt: NOW }),
    )
    assert.ok(done.ok)
    // 다음 발급·시작이 같은 이유로 멈추므로 모르는 채 이어지지는 않는다
    assert.deepEqual(done.entity.handoff?.snapshot, [])
  })
})

describe('회수는 한 번만 일어난다', () => {
  it('거둔 세션은 보관소로 옮겨져 두 번 거두지 않는다', async () => {
    const store = new MemoryStateStore()
    const runtime = new SessionRuntime(store)
    await runtime.issue({ id: 'S-20260823-01', role: 'implementer', goal: '끝난 일' })
    await runtime.start('S-20260823-01')
    await runtime.complete(
      'S-20260823-01',
      Handoff.parse({ done: ['T-1'], verified: 'self-check', next: '다음', recordedAt: NOW }),
    )

    const first = await collectSessions(store, NOW)
    assert.deepEqual(first.collected, ['S-20260823-01'])
    assert.equal(await store.get('session', 'S-20260823-01'), null)
    // 옮겼을 뿐 잃지 않았다
    assert.ok(store.archived('session', 'S-20260823-01'))

    const second = await collectSessions(store, NOW)
    assert.deepEqual(second.collected, [])
    assert.equal((await store.readHistory()).filter((h) => h.kind === 'session_collected').length, 1)
  })
})
