// B-34 Gate — provider를 바꿔도 Core가 바뀌지 않는지 (C-09 §9).
//
// 세 가지를 본다:
//   ① 같은 Core 시나리오가 서로 다른 adapter에서 똑같이 돈다
//   ② 전달 채널도 교체된다
//   ③ 코드 Binding과 작업 Binding을 **동시에** 쓴다
//
// 마지막 것이 특히 중요하다. A ↔ B 교체만 증명하면 "여러 외부 시스템을 동시에 붙인다"는
// 것은 증명되지 않는다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FixturePresentation } from '../adapters/memory/mocks.ts'
import { FixtureWorkAdapter } from '../adapters/fixture-work/index.ts'
import { LocalPresentation } from '../adapters/local/presentation.ts'
import { GitHubChangeContext, GitHubInventory, GitHubResourceContext } from '../adapters/github/context.ts'
import { GitHubClient } from '../adapters/github/client.ts'
import { GitHubEventSource } from '../adapters/github/event-source.ts'
import { GitLabClient } from '../adapters/gitlab/client.ts'
import {
  GitLabChangeContext,
  GitLabEventSource,
  GitLabInventory,
  GitLabResourceContext,
} from '../adapters/gitlab/ports.ts'
import { composeBindings } from '../composition/registry.ts'
import { resolveCapability } from '../core/binding/types.ts'
import { investigate } from '../core/monitor/investigation.ts'
import { deliver, planDigest } from '../core/presentation/digest.ts'
import type { DecisionSummary } from '../core/view/decision-view.ts'
import { describeProviderContract, type ProviderFixture } from './support/provider-contract.ts'
import type { InventoryItem, InventoryPage, InventoryPort, InventoryQuery } from '../ports/inventory.ts'
import type { Adapter } from '../ports/adapter.ts'

const NOW = '2026-08-26T09:00:00Z'

/** 응답을 미리 정해 두는 fetch. 실 네트워크에 기대는 테스트는 남의 사정으로 깨진다. */
function stubFetch(routes: Record<string, unknown>, headers: Record<string, string> = {}) {
  return (async (url: string | URL) => {
    const path = String(url)
    // 가장 구체적인 경로가 이긴다 — `/issues/19` 가 `/issues/19/comments` 를 가로채면
    // 응답 모양이 달라져 조사 단계가 엉뚱하게 실패한다.
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((route) => path.includes(route))
    const body = key ? routes[key] : []
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => headers[name] ?? null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  }) as typeof globalThis.fetch
}

/** 목록만 갈아 끼우기 위한 얇은 감싸개 — provider 구현을 건드리지 않는다. */
class Relabeled implements InventoryPort {
  readonly id = 'relabeled'
  #inner: InventoryPort
  #marker: string
  constructor(inner: InventoryPort, marker: string) {
    this.#inner = inner
    this.#marker = marker
  }
  async enumerate(query: InventoryQuery, cursor?: string): Promise<InventoryPage> {
    const page = await this.#inner.enumerate(query, cursor)
    return { ...page, items: page.items.map((item): InventoryItem => ({ ...item, revisionMarker: this.#marker })) }
  }
}

// ── provider A ───────────────────────────────────────────────────────────────

const githubFetch = stubFetch({
  '/notifications': [
    {
      id: '9001',
      updated_at: NOW,
      reason: 'assign',
      subject: { title: '콜백 정리', type: 'Issue', url: 'https://api.github.com/repos/org/repo/issues/19' },
      repository: { full_name: 'org/repo' },
    },
  ],
  '/issues/19/comments': [{ id: 1, body: '확인 부탁', updated_at: NOW, user: { login: 'someone' } }],
  '/issues/19': { number: 19, title: '콜백 정리', state: 'open', updated_at: NOW, comments: 1 },
  '/issues/comments': [],
  '/issues': [{ number: 19, title: '콜백 정리', state: 'open', updated_at: NOW, comments: 1 }],
  '/pulls/19/files': [{ filename: 'fe/a.ts' }],
  '/pulls/19/reviews': [],
  '/pulls/19': { updated_at: NOW, state: 'open', head: { sha: 'abc' } },
  '/pulls/comments': [],
})

function githubFixture(): ProviderFixture {
  const client = new GitHubClient({ token: 't', fetch: githubFetch })
  const inventory = new GitHubInventory({ client, defaultRepo: 'org/repo' })
  return {
    name: 'github',
    reference: 'org/repo#19',
    inventory,
    changedInventory: new Relabeled(inventory, 'changed'),
    resource: new GitHubResourceContext({ client, defaultRepo: 'org/repo' }),
    change: new GitHubChangeContext({ client, defaultRepo: 'org/repo' }),
    events: new GitHubEventSource({ client, repo: 'org/repo', perPage: 30 }),
    config: { identities: ['me'], reasonSignals: { assign: 'assigned_to_me' } },
  }
}

// ── provider B — 참조 문법도, 사건 어휘도, 상태 이름도 다르다 ─────────────────

const gitlabFetch = stubFetch({
  '/todos': [
    {
      id: 55,
      action_name: 'assigned',
      updated_at: NOW,
      target_type: 'MergeRequest',
      target: { iid: 19, title: '콜백 정리', state: 'opened' },
      project: { path_with_namespace: 'group/sub/proj' },
    },
  ],
  '/merge_requests/19/changes': { changes: [{ new_path: 'fe/a.ts' }] },
  '/merge_requests/19/notes': [{ id: 1, body: '확인 부탁', updated_at: NOW, author: { username: 'someone' } }],
  '/merge_requests/19': { iid: 19, title: '콜백 정리', state: 'opened', updated_at: NOW, sha: 'def' },
  '/merge_requests': [{ iid: 19, title: '콜백 정리', state: 'opened', updated_at: NOW, sha: 'def' }],
  '/issues': [],
})

function gitlabFixture(): ProviderFixture {
  const client = new GitLabClient({ token: 't', fetch: gitlabFetch })
  const inventory = new GitLabInventory({ client, project: 'group/sub/proj' })
  return {
    name: 'gitlab',
    reference: 'group/sub/proj!19',
    inventory,
    changedInventory: new Relabeled(inventory, 'changed'),
    resource: new GitLabResourceContext({ client, project: 'group/sub/proj' }),
    change: new GitLabChangeContext({ client, project: 'group/sub/proj' }),
    events: new GitLabEventSource({ client, project: 'group/sub/proj', perPage: 30 }),
    config: { identities: ['me'], reasonSignals: { assigned: 'assigned_to_me' } },
  }
}

describeProviderContract(githubFixture())
describeProviderContract(gitlabFixture())

// ── Binding 교체 ─────────────────────────────────────────────────────────────

describe('B-34 Gate — Binding 교체 (C-09 §9)', () => {
  const context = { projectRoot: '/nowhere', env: {} }

  const stubAdapter = (id: string, remote: string): Adapter => ({
    describe: () => ({ id, version: '1', provides: ['observe.delta', 'inventory.enumerate'] }),
    discover: async () => [
      { adapterId: id, resource: remote, provides: ['observe.delta', 'inventory.enumerate'] },
    ],
    probe: async () => ({ state: 'AVAILABLE' }),
  })

  it('adapter를 바꿔도 같은 capability가 풀린다 — 부르는 쪽은 그대로다', async () => {
    const a = await composeBindings({ context, adapters: [stubAdapter('provider-a', 'org/repo')] })
    const b = await composeBindings({ context, adapters: [stubAdapter('provider-b', 'group/sub/proj')] })

    for (const plan of [a, b]) {
      const resolved = resolveCapability(plan, { capability: 'inventory.enumerate' })
      assert.equal(resolved.kind, 'RESOLVED')
    }
    // 바뀐 것은 adapter id와 resource뿐이다
    assert.notEqual(a.bindings[0]?.adapterId, b.bindings[0]?.adapterId)
  })

  it('설치된 adapter가 없으면 그 갈래는 애초에 없다', async () => {
    const empty = await composeBindings({ context, adapters: [] })
    assert.deepEqual(empty.bindings, [])
    assert.equal(resolveCapability(empty, { capability: 'observe.delta' }).kind, 'UNAVAILABLE')
  })
})

// ── Code + Work 동시 사용 ────────────────────────────────────────────────────

describe('B-34 Gate — Code + Work multi-binding (C-09 §9.2)', () => {
  const work = new FixtureWorkAdapter({
    items: [
      {
        reference: 'work/board#T-12',
        title: '로그인 콜백',
        state: 'in-progress',
        updatedAt: NOW,
        revisionMarker: 'w1',
        comments: [{ id: 'c1', author: 'planner', at: NOW, body: '계약 확정 대기' }],
        history: [{ at: NOW, actor: 'planner', kind: 'assigned', detail: 'to frontend' }],
      },
    ],
  })

  it('한 조사가 두 Binding을 동시에 소비한다', async () => {
    const gitlab = gitlabFixture()

    // 코드 쪽은 gitlab, 작업 쪽은 fixture-work — 한 조사가 두 adapter를 동시에 쓴다.
    const result = await investigate(
      { reference: gitlab.reference, workReference: 'work/board#T-12' },
      { resource: gitlab.resource, change: gitlab.change, work, history: work },
    )

    const byId = new Map(result.steps.map((s) => [s.id, s]))
    // 코드 쪽 Binding
    assert.equal(byId.get('resource')?.kind, 'DONE')
    assert.equal(byId.get('change')?.kind, 'DONE')
    // 작업 쪽 Binding — 다른 adapter가 답했다
    const workStep = byId.get('work-context')!
    assert.equal(workStep.kind, 'DONE')
    assert.ok(result.situation.some((line) => line.includes('로그인 콜백')))
    assert.ok(result.situation.some((line) => line.includes('planner assigned')))
    // 정본 통로는 어느 쪽도 주지 않았다 — 그 단계만 판정 불성립이다
    assert.equal(byId.get('canonical')?.kind, 'UNDECIDABLE')
  })

  it('두 binding이 각자 다른 capability를 채운다', async () => {
    const plan = await composeBindings({
      context: { projectRoot: '/nowhere', env: {} },
      adapters: [work],
      roles: [{ adapterId: 'fixture-work', resource: 'work/board', role: 'work' }],
    })
    assert.equal(resolveCapability(plan, { capability: 'context.history' }).kind, 'RESOLVED')
    // 작업 추적 쪽은 코드 변경을 모른다 — 그런 adapter가 정상이다
    assert.equal(resolveCapability(plan, { capability: 'context.change' }).kind, 'UNAVAILABLE')
  })

  it('목록도 두 갈래에서 각각 센다', async () => {
    const page = await work.enumerate({})
    assert.equal(page.items[0]?.reference, 'work/board#T-12')
    assert.equal(page.complete, true)
  })
})

// ── Presentation 교체 ────────────────────────────────────────────────────────

describe('B-34 Gate — Presentation 교체 (C-08 §1)', () => {
  const summary: DecisionSummary = {
    requestId: 'REQ-0001',
    reference: 'group/sub/proj!19',
    version: 0,
    freshness: 'CURRENT',
    status: 'AWAITING_APPROVAL',
    priority: 'P0',
    title: '콜백 정리',
    detectedAt: NOW,
  }

  it('같은 계획이 Local과 fixture 채널 양쪽으로 나간다', async () => {
    const plan = planDigest({ at: NOW, pending: [summary] })

    const lines: string[] = []
    const local = await deliver(plan, new LocalPresentation({ write: (line) => lines.push(line) }))
    assert.equal(local.digest?.ok, true)
    assert.equal(local.urgent[0]?.outcome.ok, true)

    const channel = new FixturePresentation('other', ['presentation.digest', 'presentation.priority'])
    const other = await deliver(plan, channel)
    assert.equal(other.digest?.ok, true)
    assert.deepEqual(channel.urgent.map((i) => i.requestId), ['REQ-0001'])

    // 계획은 하나다 — 채널이 늘어도 request가 늘지 않는다 (C-08 §3.1)
    assert.equal(plan.batch.groups[0]?.items.length, 1)
  })
})
