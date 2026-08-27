// B-32 Gate — 조사가 단계 계약인지, 그리고 못 본 것을 못 봤다고 말하는지.
//
// 가장 중요한 두 가지:
//   ① 단계는 필요한 Port만 요청한다 — provider 이름으로 갈라지지 않는다
//   ② 판정 불성립은 통과가 아니다 — 다른 단계 결과로 대신하지 않는다

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { FixtureEventSource } from '../adapters/memory/mocks.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { MonitorEngine } from '../core/monitor/engine.ts'
import { investigate, type InvestigationPorts, type StepResult } from '../core/monitor/investigation.ts'
import type { EntityKind, EntityMap, CreateResult } from '../ports/state-store.ts'
import type { Relevance } from '../core/monitor/relevance.ts'
import type { ChangeContextPort, ChangeSummary } from '../ports/change-context.ts'
import type {
  CommentQuery,
  ContextComment,
  ResourceContextPort,
  ResourceSnapshot,
} from '../ports/resource-context.ts'

const OWNERSHIP = {
  frontend: { paths: ['fe/**'], authorities: ['client-ui'] },
  backend: { paths: ['be/**'], authorities: ['api-contract'] },
}

const relevant: Relevance = {
  explicit: 'HIGH',
  actual: 'HIGH',
  disposition: 'INBOX',
  evidence: [{ kind: 'ownership', detail: '내 영역 변경: fe/a.ts', supports: true }],
}

class FakeResource implements ResourceContextPort {
  readonly id = 'fixture'
  snapshot: Partial<ResourceSnapshot>
  comments: ContextComment[]
  constructor(snapshot: Partial<ResourceSnapshot> = {}, comments: ContextComment[] = []) {
    this.snapshot = snapshot
    this.comments = comments
  }
  async getResource(reference: string): Promise<ResourceSnapshot> {
    return {
      reference,
      state: 'open',
      title: '로그인 콜백 정리',
      updatedAt: '2026-08-26T09:00:00Z',
      revisionMarker: 'r2',
      assignees: ['me'],
      ...this.snapshot,
    }
  }
  async getComments(_reference: string, _query?: CommentQuery): Promise<ContextComment[]> {
    return this.comments
  }
}

class FakeChange implements ChangeContextPort {
  readonly id = 'fixture'
  paths: string[]
  constructor(paths: string[] = ['fe/a.ts']) {
    this.paths = paths
  }
  async getChange(reference: string): Promise<ChangeSummary> {
    return { reference, changedPaths: this.paths, revisionMarker: 'r2', reviewState: 'APPROVED' }
  }
}

const allPorts = (over: Partial<InvestigationPorts> = {}): InvestigationPorts => ({
  resource: new FakeResource(),
  change: new FakeChange(),
  baselines: async () => [{ sourceId: 'spec', baseline: 'abc123' }],
  ...over,
})

describe('B-32 Gate — 단계는 Port만 요청한다 (C-07 §6.2)', () => {
  it('통로가 있으면 각 단계가 자기 것을 읽는다', async () => {
    const result = await investigate({ reference: 'o/r#19', relevance: relevant }, allPorts())
    const done = result.steps.filter((s) => s.kind === 'DONE').map((s) => s.id)
    assert.ok(done.includes('resource'))
    assert.ok(done.includes('thread'))
    assert.ok(done.includes('change'))
    assert.ok(done.includes('canonical'))
    assert.deepEqual(result.undecidable, [])
  })

  it('통로가 없으면 그 단계만 판정 불성립이다 — 다른 결과로 대신하지 않는다', async () => {
    const result = await investigate(
      { reference: 'o/r#19', relevance: relevant },
      { baselines: async () => [] },
    )
    const byId = new Map(result.steps.map((s) => [s.id, s]))
    assert.equal(byId.get('resource')?.kind, 'UNDECIDABLE')
    assert.equal(byId.get('change')?.kind, 'UNDECIDABLE')
    assert.equal(byId.get('thread')?.kind, 'UNDECIDABLE')
    // canonical은 통로가 있으므로 성립한다 — 없는 단계가 있는 단계를 오염시키지 않는다
    assert.equal(byId.get('canonical')?.kind, 'DONE')
    assert.equal(result.undecidable.length, 3)
  })

  it('확인 못 한 것이 있으면 권고가 그것부터 말한다', async () => {
    const result = await investigate({ reference: 'o/r#19', relevance: relevant }, {})
    assert.match(result.recommendation, /확인하지 못한 것이 있다/)
    assert.ok(result.situation.some((line) => line.includes('확인 못 함')))
  })

  it('조회가 실패해도 통로가 없는 것과 구분해 말한다', async () => {
    const broken: ResourceContextPort = {
      id: 'fixture',
      getResource: async () => {
        throw new Error('boom')
      },
      getComments: async () => {
        throw new Error('boom')
      },
    }
    const result = await investigate({ reference: 'o/r#19' }, { resource: broken })
    const resource = result.steps.find((s) => s.id === 'resource')!
    assert.equal(resource.kind, 'UNDECIDABLE')
    assert.match(resource.kind === 'UNDECIDABLE' ? resource.detail : '', /읽지 못했다/)
  })

  it('provider 이름으로 분기하지 않는다', async () => {
    const source = await readFile(new URL('../core/monitor/investigation.ts', import.meta.url), 'utf8')
    for (const word of ['github', 'gitlab', 'jira', 'jam', 'mattermost']) {
      assert.doesNotMatch(source.toLowerCase(), new RegExp(word))
    }
  })
})

describe('B-32 Gate — Responsibility · Canonical (C-07 §6.1)', () => {
  it('결정권자를 실제로 푼다 (C-04 소비)', async () => {
    const result = await investigate(
      {
        reference: 'o/r#19',
        relevance: relevant,
        owner: 'frontend',
        decisionDomains: ['api-contract', 'oauth-policy'],
        ownership: OWNERSHIP,
      },
      allPorts(),
    )
    const step = result.steps.find((s) => s.id === 'responsibility')!
    assert.equal(step.kind, 'DONE')
    const findings = step.kind === 'DONE' ? step.findings.join('\n') : ''
    assert.match(findings, /Owner: frontend/)
    assert.match(findings, /api-contract → backend/)
    assert.match(findings, /oauth-policy → 결정권자 미선언/)
  })

  it('정본 영역이 바뀌면 contract drift 후보로 든다', async () => {
    const result = await investigate(
      { reference: 'o/r#19', relevance: relevant, canonicalPaths: ['fe/**'] },
      allPorts({ change: new FakeChange(['fe/api/types.ts']) }),
    )
    assert.ok(result.situation.join('\n').includes('contract drift 후보'))
    assert.match(result.recommendation, /정본 영역이 바뀌었다/)
  })

  it('지난 관측이 있으면 무엇이 달라졌는지 본다', async () => {
    const result = await investigate(
      { reference: 'o/r#19', previous: { revisionMarker: 'r1', state: 'closed' } },
      allPorts(),
    )
    const delta = result.steps.find((s) => s.id === 'delta')!
    assert.equal(delta.kind, 'DONE')
    const findings = delta.kind === 'DONE' ? delta.findings.join('\n') : ''
    assert.match(findings, /실질 변화 있음/)
    assert.match(findings, /상태 closed → open/)
  })
})

describe('B-32 Gate — Work Context (C-07 §6.1 ⑦)', () => {
  const workItem = new FakeResource({
    title: '로그인 콜백 작업',
    state: 'in-progress',
    assignees: ['planner'],
    related: ['o/r#19'],
  })
  const workHistory = {
    id: 'fixture-work',
    getHistory: async () => [{ at: '2026-08-26T08:00:00Z', actor: 'planner', kind: 'assigned' }],
  }

  it('연결된 작업 항목이 선언되지 않으면 해당 없음이다', async () => {
    const result = await investigate({ reference: 'o/r#19' }, allPorts())
    const step = result.steps.find((s) => s.id === 'work-context')!
    assert.equal(step.kind, 'SKIPPED')
    assert.match(step.kind === 'SKIPPED' ? step.detail : '', /선언되지 않았다/)
  })

  it('선언됐는데 통로가 없으면 판정 불성립이다 — 해당 없음과 다르다', async () => {
    const result = await investigate({ reference: 'o/r#19', workReference: 'work#T-12' }, allPorts())
    const step = result.steps.find((s) => s.id === 'work-context')!
    assert.equal(step.kind, 'UNDECIDABLE')
    assert.ok(result.undecidable.some((line) => line.startsWith('work-context:')))
  })

  it('작업 쪽 통로는 코드 쪽과 다른 adapter여도 된다', async () => {
    const result = await investigate(
      { reference: 'o/r#19', workReference: 'work#T-12' },
      { ...allPorts(), work: workItem, history: workHistory },
    )
    const step = result.steps.find((s) => s.id === 'work-context')!
    assert.equal(step.kind, 'DONE')
    const findings = step.kind === 'DONE' ? step.findings.join('\n') : ''
    assert.match(findings, /로그인 콜백 작업 — in-progress/)
    assert.match(findings, /담당: planner/)
    assert.match(findings, /연결: o\/r#19/)
    assert.match(findings, /planner assigned/)
  })

  it('경위를 모르는 도구여도 이 단계가 무너지지 않는다', async () => {
    const result = await investigate(
      { reference: 'o/r#19', workReference: 'work#T-12' },
      { ...allPorts(), work: workItem },
    )
    assert.equal(result.steps.find((s) => s.id === 'work-context')?.kind, 'DONE')
  })

  it('작업 항목을 읽지 못하면 못 읽었다고 말한다', async () => {
    const gone: ResourceContextPort = {
      id: 'fixture-work',
      getResource: async (reference) => ({
        reference,
        state: 'unknown',
        title: '',
        updatedAt: '',
        revisionMarker: '',
        missing: true,
      }),
      getComments: async () => [],
    }
    const result = await investigate(
      { reference: 'o/r#19', workReference: 'work#T-12' },
      { ...allPorts(), work: gone },
    )
    const step = result.steps.find((s) => s.id === 'work-context')!
    assert.equal(step.kind, 'UNDECIDABLE')
    assert.match(step.kind === 'UNDECIDABLE' ? step.detail : '', /읽지 못했다/)
  })

  it('단계 수는 계약과 같다 — 11단계', async () => {
    const { STEPS } = await import('../core/monitor/investigation.ts')
    assert.equal(STEPS.length, 11)
    const result = await investigate({ reference: 'o/r#19', workReference: 'work#T-12' }, allPorts())
    assert.equal(new Set(result.steps.map((s) => s.id)).size, 11)
  })
})

describe('B-32 Gate — Draft Gate (C-07 §7)', () => {
  const draftOf = (result: { steps: StepResult[] }) => result.steps.find((s) => s.id === 'draft')!

  it('근거가 충분하고 결정권이 분명하면 초안 조건을 만족한다', async () => {
    const result = await investigate(
      {
        reference: 'o/r#19',
        relevance: relevant,
        decisionDomains: ['api-contract'],
        ownership: OWNERSHIP,
      },
      allPorts(),
    )
    assert.equal(draftOf(result).kind, 'DONE')
    assert.equal(result.draftBlocked, undefined)
  })

  it('확인 못 한 단계가 있으면 초안을 만들지 않는다', async () => {
    const result = await investigate({ reference: 'o/r#19', relevance: relevant }, {})
    assert.equal(draftOf(result).kind, 'SKIPPED')
    assert.match(result.draftBlocked ?? '', /확인하지 못한 단계/)
  })

  it('결정권자가 정해지지 않았으면 초안을 만들지 않는다', async () => {
    const result = await investigate(
      { reference: 'o/r#19', relevance: relevant, decisionDomains: ['oauth-policy'], ownership: OWNERSHIP },
      allPorts(),
    )
    assert.match(result.draftBlocked ?? '', /'oauth-policy' 의 결정권자가 정해지지 않았다/)
  })

  it('정본과 충돌 가능성이 있으면 사람이 먼저 정한다', async () => {
    const result = await investigate(
      { reference: 'o/r#19', relevance: relevant, canonicalPaths: ['fe/**'] },
      allPorts({ change: new FakeChange(['fe/api/types.ts']) }),
    )
    assert.match(result.draftBlocked ?? '', /정본과 충돌 가능성/)
  })

  it('관련 근거가 약하면 초안을 만들지 않는다', async () => {
    const weak: Relevance = { ...relevant, actual: 'LOW', disposition: 'SHADOW' }
    const result = await investigate({ reference: 'o/r#19', relevance: weak }, allPorts())
    assert.match(result.draftBlocked ?? '', /관련 근거가 약하다/)
  })

  it('관련성 판정 자체가 없으면 초안을 만들지 않는다', async () => {
    const result = await investigate({ reference: 'o/r#19' }, allPorts())
    assert.match(result.draftBlocked ?? '', /관련성 판정이 없다/)
  })
})

describe('B-32 Gate — 부분 결과 이어받기 (C-07 §6.3)', () => {
  it('이미 끝난 단계는 다시 하지 않는다', async () => {
    let reads = 0
    const counting: ResourceContextPort = {
      id: 'fixture',
      getResource: async (reference) => {
        reads++
        return new FakeResource().getResource(reference)
      },
      getComments: async () => [],
    }

    const done: StepResult[] = [{ id: 'resource', kind: 'DONE', findings: ['이미 확인함'] }]
    const result = await investigate({ reference: 'o/r#19' }, { resource: counting }, done)

    // resource 단계는 건너뛴다 — 다만 뒤 단계(delta)가 쓰는 조회까지 막지는 않는다
    assert.ok(result.steps.some((s) => s.id === 'resource' && s.kind === 'DONE'))
    assert.equal(result.steps.filter((s) => s.id === 'resource').length, 1)
    assert.ok(result.situation.includes('이미 확인함'))
  })
})

// 재시도가 조사를 처음부터 다시 하지 않는지 — engine 경로에서 확인한다.
describe('B-32 Gate — 재시도 후 조사 결과 보존', () => {
  it('패킷을 만들지 못해도 끝낸 단계는 replay에 남는다', async () => {
    // 패킷 생성만 실패시킨다 — 조사까지는 정상으로 돈다
    class RefusingStore extends MemoryStateStore {
      override async create<K extends EntityKind>(
        kind: K,
        entity: EntityMap[K],
      ): Promise<CreateResult<EntityMap[K]>> {
        if (kind === 'request') return { ok: false, reason: 'ALREADY_EXISTS', current: entity }
        return super.create(kind, entity)
      }
    }

    const store = new RefusingStore()
    const engine = new MonitorEngine({
      store,
      source: new FixtureEventSource([
        [
          {
            eventKey: 'notification:1:2026-08-26T09:00:00Z',
            detectedAt: '2026-08-26T09:00:00Z',
            reference: 'o/r#19',
            raw: { kind: 'notification', reason: 'mention', body: '@me 확인 부탁' },
          },
        ],
      ]),
      config: { identities: ['me'], reasonSignals: { mention: 'mentioned_me' } },
      authorizedApprover: 'controller-a',
      investigation: { resource: new FakeResource(), change: new FakeChange() },
      now: () => '2026-08-26T10:00:00+09:00',
    })

    const outcome = await engine.scan()
    assert.equal(outcome.packets.length, 0)
    assert.deepEqual(outcome.retries, ['notification:1:2026-08-26T09:00:00Z'])

    const event = (await store.list('event'))[0]!
    assert.equal(event.processing, 'PENDING_RETRY')
    const steps = event.replay?.steps ?? []
    assert.ok(steps.length > 0, '조사 단계가 남지 않았다')
    assert.ok(steps.some((s) => s.id === 'resource' && s.kind === 'DONE'))
  })
})
