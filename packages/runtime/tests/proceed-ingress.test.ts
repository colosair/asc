// P0-D Gate — 돌릴 세션이 없을 때 proceed 가 조사부터 하는가.
//
// 지켜야 할 두 가지:
//   ① 이미 끝난 일에 세션을 내지 않는다 (실제로 저질렀던 실수다)
//   ② 범위·책임·발급 권한을 proceed 가 다시 계산하지 않는다 — plan 이 답한 것을 읽기만 한다

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { Operator, type WorkIngress } from '../core/operator/proceed.ts'
import { SessionRuntime } from '../core/runtime/session.ts'
import type { SessionContractDraft, SessionContractPlan } from '../core/operator/contract-draft.ts'
import type { RepoObservation } from '../ports/local-repo.ts'
import type { ResourceSnapshot } from '../ports/resource-context.ts'

const workItem: ResourceSnapshot = {
  reference: 'PROJ-87',
  state: '진행 중',
  title: 'BoothSlot 목록 화면',
  updatedAt: '2026-08-27T10:00:00Z',
  revisionMarker: 'r3',
}

const repoMerged: RepoObservation = {
  branch: 'front',
  remotes: [],
  refs: ['feat/PROJ-87-x'],
  canonicalRef: 'origin/develop',
  mergedIntoCanonical: true,
  pathsExist: { 'fe/SlotListPage.tsx': true },
}

const repoEmpty: RepoObservation = {
  branch: 'front',
  remotes: [],
  refs: [],
  canonicalRef: 'origin/develop',
  mergedIntoCanonical: false,
  pathsExist: {},
}

const draft: SessionContractDraft = {
  id: 'S-20260828-01',
  role: 'implementer',
  goal: 'PROJ-187: asset:// 회귀 테스트',
  boundary: ['fe/src/**'],
  criteria: ['테스트가 존재한다'],
}

/** 저장소 전체를 쓰겠다는 초안. 근거가 무엇이냐에 따라 결과가 갈린다. */
const wideDraft = (over: Partial<SessionContractDraft> = {}): SessionContractDraft => ({
  ...draft,
  boundary: ['**'],
  ...over,
})

const planWith = (
  status: SessionContractPlan['status'],
  authority: 'delegated' | 'controller',
): SessionContractPlan => ({
  status,
  draft,
  facts: [],
  proposals: [],
  unresolved: status === 'NEEDS_DECISION' ? [{ field: 'criteria', reason: 'missing_input', detail: '완료 조건 없음' }] : [],
  issuance: { authority, delegatedRoles: authority === 'delegated' ? ['implementer'] : [], detail: 'fixture' },
  invalid: [],
})

type Calls = { gather: string[]; plan: number; issue: number; derive: number }

function harness(over: Partial<WorkIngress> & { repo?: RepoObservation | null } = {}) {
  const store = new MemoryStateStore()
  const sessions = new SessionRuntime(store)
  const calls: Calls = { gather: [], plan: 0, issue: 0, derive: 0 }

  const ingress: WorkIngress = {
    gather: async (workRef) => {
      calls.gather.push(workRef)
      return { workItem, trackerDone: false, comments: [], change: 'UNAVAILABLE' as const }
    },
    ...(over.repo === null ? {} : { observeRepo: async () => over.repo ?? repoEmpty }),
    derive: () => {
      calls.derive += 1
      return draft
    },
    usedIds: async () => (await store.list('session')).map((session) => session.id),
    plan: async () => planWith('READY_TO_ISSUE', 'delegated'),
    issue: async (d) => {
      calls.issue += 1
      const issued = await sessions.issue({
        id: d.id!,
        role: 'implementer',
        goal: d.goal ?? '',
        doneCriteria: [...(d.criteria ?? [])],
        ...(d.boundary ? { writeBoundary: [...d.boundary] } : {}),
      })
      return issued.ok ? { ok: true as const, sessionId: issued.session.id } : { ok: false as const, detail: 'issue 실패' }
    },
    ...over,
  }
  const wrappedPlan = ingress.plan
  ingress.plan = async (d) => {
    calls.plan += 1
    return wrappedPlan(d)
  }

  const operator = new Operator({ store, sessions, ingress, guard: async () => ({ ok: true }) })
  return { store, operator, calls }
}

describe('P0-D — proceed 작업 항목 유입', () => {
  it('작업 항목 없이 부르면 예전 그대로 빈 초안을 제안한다 (회귀)', async () => {
    const store = new MemoryStateStore()
    const operator = new Operator({
      store,
      sessions: new SessionRuntime(store),
      guard: async () => ({ ok: true }),
    })

    const outcome = await operator.proceed({ goal: '뭔가 해라' })
    assert.equal(outcome.kind, 'PROPOSE_CONTRACT')
    assert.equal(outcome.kind === 'PROPOSE_CONTRACT' ? outcome.plan : 'x', undefined)
  })

  it('이미 정본에 병합된 작업이면 세션을 내지 않는다 — WORK_STATE 로 답한다', async () => {
    const h = harness({ repo: repoMerged })

    const outcome = await h.operator.proceed({ workRef: 'PROJ-87' })

    assert.equal(outcome.kind, 'WORK_STATE')
    if (outcome.kind !== 'WORK_STATE') return
    assert.equal(outcome.result.state, 'IMPLEMENTED_STALE_TRACKER')
    assert.match(outcome.nextAction, /상태 정리/)
    assert.equal((await h.store.list('session')).length, 0, '세션이 생겼다')
    assert.equal(h.calls.derive, 0, '계약을 도출하려 들었다')
  })

  it('저장소를 관측하지 않으면 추천하지 않는다 — 세션도 계약도 없다', async () => {
    const h = harness({ repo: null })

    const outcome = await h.operator.proceed({ workRef: 'PROJ-87' })

    assert.equal(outcome.kind, 'WORK_STATE')
    if (outcome.kind !== 'WORK_STATE') return
    assert.equal(outcome.result.state, 'UNDECIDABLE')
    assert.deepEqual(outcome.result.missing, ['repository'])
    assert.equal((await h.store.list('session')).length, 0)
  })

  it('착수 가능하고 발급이 위임돼 있으면 발급하고 시작까지 간다', async () => {
    const h = harness()

    const outcome = await h.operator.proceed({ workRef: 'PROJ-187' })

    assert.equal(outcome.kind, 'STARTED')
    assert.equal(h.calls.issue, 1)
    const sessions = await h.store.list('session')
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]!.status, 'ACTIVE')
  })

  it('발급이 Controller 것이면 명령만 건네고 멈춘다', async () => {
    const h = harness({ plan: async () => planWith('READY_TO_ISSUE', 'controller') })

    const outcome = await h.operator.proceed({ workRef: 'PROJ-187' })

    assert.equal(outcome.kind, 'PROPOSE_CONTRACT')
    if (outcome.kind !== 'PROPOSE_CONTRACT') return
    assert.ok(outcome.forController?.includes('S-20260828-01'))
    assert.equal(h.calls.issue, 0, '위임 없이 발급했다')
    assert.equal((await h.store.list('session')).length, 0)
  })

  it('계약이 성립하지 않으면 무엇이 남았는지 그대로 실어 준다', async () => {
    const h = harness({ plan: async () => planWith('NEEDS_DECISION', 'delegated') })

    const outcome = await h.operator.proceed({ workRef: 'PROJ-187' })

    assert.equal(outcome.kind, 'PROPOSE_CONTRACT')
    if (outcome.kind !== 'PROPOSE_CONTRACT') return
    assert.equal(outcome.plan?.status, 'NEEDS_DECISION')
    assert.equal(outcome.plan?.unresolved[0]?.field, 'criteria')
    assert.equal(h.calls.issue, 0)
  })

  it('범위·발급 권한을 스스로 계산하지 않는다 — plan 이 답한 것만 쓴다', async () => {
    const h = harness({ plan: async () => planWith('READY_TO_ISSUE', 'controller') })

    const outcome = await h.operator.proceed({ workRef: 'PROJ-187' })

    assert.equal(h.calls.plan, 1, 'plan 을 부르지 않았거나 여러 번 불렀다')
    assert.equal(outcome.kind, 'PROPOSE_CONTRACT')
    // plan 이 controller 라고 했으므로 위임 판단을 자체적으로 뒤집지 않는다
    assert.equal(h.calls.issue, 0)
  })
})

describe('P0-1 백스톱 — 근거 없는 전역 쓰기 범위는 스스로 발급하지 않는다', () => {
  it('boundary 가 ** 이고 이번 작업에 대한 근거가 없으면 위임 범위에서도 발급하지 않는다', async () => {
    const h = harness({ derive: () => wideDraft() })

    const outcome = await h.operator.proceed({ workRef: 'PROJ-187' })

    assert.equal(outcome.kind, 'PROPOSE_CONTRACT')
    if (outcome.kind !== 'PROPOSE_CONTRACT') return
    assert.ok(outcome.forController, '사람에게 넘기지 않았다')
    assert.ok(outcome.plan?.unresolved.some((u) => u.field === 'boundary'))
    assert.equal(h.calls.issue, 0, '전역 범위를 스스로 발급했다')
    assert.equal((await h.store.list('session')).length, 0)
  })

  it('사람이 이번 작업에 대해 전역 범위를 말했으면 그때는 발급한다', async () => {
    const h = harness({
      derive: () =>
        wideDraft({
          provenance: [{ field: 'boundary', status: 'FACT', source: 'user', reason: '사용자가 전체 범위를 지시했다' }],
        }),
    })

    const outcome = await h.operator.proceed({ workRef: 'PROJ-187' })

    assert.equal(outcome.kind, 'STARTED')
    assert.equal(h.calls.issue, 1)
  })

  it('상한이 ** 라는 사실만으로는 근거가 되지 않는다 — provenance 가 PROPOSAL 이면 막는다', async () => {
    const h = harness({
      derive: () =>
        wideDraft({
          provenance: [
            { field: 'boundary', status: 'PROPOSAL', source: 'profile', reason: 'roleScopes 가 ** 다' },
          ],
        }),
    })

    const outcome = await h.operator.proceed({ workRef: 'PROJ-187' })

    assert.equal(outcome.kind, 'PROPOSE_CONTRACT')
    assert.equal(h.calls.issue, 0)
  })
})

describe('작업 항목을 지목하면 그 작업만 본다', () => {
  it('다른 작업의 멈춘 세션이 있어도 지목한 작업을 조사한다', async () => {
    const h = harness({ repo: repoMerged })
    await h.operator.proceed({ workRef: 'PROJ-187' })
    // 먼저 다른 작업의 세션을 하나 만들어 둔다 (지목 대상이 아니다).
    const other = await new SessionRuntime(h.store).issue({
      id: 'S-20260828-09',
      role: 'implementer',
      goal: 'PROJ-999: 다른 작업',
      doneCriteria: ['x'],
    })
    assert.ok(other.ok)

    const outcome = await h.operator.proceed({ workRef: 'PROJ-87' })

    assert.equal(outcome.kind, 'WORK_STATE', '지목을 무시하고 다른 세션을 이어갔다')
    if (outcome.kind !== 'WORK_STATE') return
    assert.equal(outcome.workRef, 'PROJ-87')
  })
})
