// Fixture Work Adapter — 작업 항목 쪽 Binding을 흉내 낸다 (C-09 §9.2).
//
// 왜 있는가: 코드 시스템 A ↔ B 교체만 증명하면 "여러 외부 시스템을 **동시에** 붙인다"는
// 것은 증명되지 않는다. 그런데 실제 작업 추적 도구의 계약을 확인하지 못한 상태에서
// adapter를 추측해 만드는 것은 더 나쁘다 — 맞는지 아무도 모르는 코드가 생긴다.
//
// 그래서 **조합 자체만 검증한다.** 나중에 실제 계약을 확인하면 이 자리에 진짜 adapter를
// 물리고 같은 contract suite를 그대로 돌린다.
//
// 제공하지 않는 것이 중요하다: `context.change` 가 없다. 작업 추적 도구는 코드 변경을
// 모르며, 그런 adapter가 정상이라는 것이 Port를 좁게 나눈 이유다 (C-09 §2.1).

import type { AdapterDescriptor, BindingCandidate, Capability } from '../../core/binding/types.ts'
import type { Adapter, DiscoveryContext, ProbeResult } from '../../ports/adapter.ts'
import type { InventoryItem, InventoryPage, InventoryPort, InventoryQuery } from '../../ports/inventory.ts'
import type {
  CommentQuery,
  ContextComment,
  HistoryEvent,
  HistoryPort,
  ResourceContextPort,
  ResourceSnapshot,
} from '../../ports/resource-context.ts'

const PROVIDES: readonly Capability[] = [
  'inventory.enumerate',
  'context.resource',
  'context.thread',
  'context.history',
]

export type WorkItem = {
  reference: string
  title: string
  state: string
  updatedAt: string
  revisionMarker: string
  assignees?: string[]
  labels?: string[]
  comments?: ContextComment[]
  history?: HistoryEvent[]
}

export type FixtureWorkDeps = {
  items?: WorkItem[]
  /** discover가 후보를 찾을지. 없는 환경을 흉내 내려면 비운다. */
  resource?: string
  probeState?: ProbeResult
}

export class FixtureWorkAdapter
  implements Adapter, InventoryPort, ResourceContextPort, HistoryPort
{
  readonly id = 'fixture-work'
  items: WorkItem[]
  #resource: string | undefined
  #probe: ProbeResult

  constructor(deps: FixtureWorkDeps = {}) {
    this.items = deps.items ?? []
    this.#resource = deps.resource ?? 'work/board'
    this.#probe = deps.probeState ?? { state: 'AVAILABLE', provides: PROVIDES }
  }

  describe(): AdapterDescriptor {
    return { id: this.id, version: '1', provides: PROVIDES }
  }

  async discover(_context: DiscoveryContext): Promise<BindingCandidate[]> {
    return this.#resource
      ? [{ adapterId: this.id, resource: this.#resource, provides: PROVIDES, discoveredBy: 'fixture' }]
      : []
  }

  async probe(_candidate: BindingCandidate, _context: DiscoveryContext): Promise<ProbeResult> {
    return this.#probe
  }

  async enumerate(query: InventoryQuery, cursor?: string): Promise<InventoryPage> {
    if (cursor) return { items: [], complete: true }
    const items: InventoryItem[] = this.items
      .filter((item) => !query.updatedSince || item.updatedAt >= query.updatedSince)
      .map((item) => ({
        reference: item.reference,
        state: item.state,
        updatedAt: item.updatedAt,
        revisionMarker: item.revisionMarker,
        title: item.title,
        assignees: item.assignees ?? [],
        labels: item.labels ?? [],
      }))
    return { items, complete: true }
  }

  async getResource(reference: string): Promise<ResourceSnapshot> {
    const found = this.items.find((item) => item.reference === reference)
    if (!found) {
      return { reference, state: 'unknown', title: '', updatedAt: '', revisionMarker: '', missing: true }
    }
    return {
      reference,
      state: found.state,
      title: found.title,
      assignees: found.assignees ?? [],
      labels: found.labels ?? [],
      updatedAt: found.updatedAt,
      revisionMarker: found.revisionMarker,
    }
  }

  async getComments(reference: string, query: CommentQuery = {}): Promise<ContextComment[]> {
    const found = this.items.find((item) => item.reference === reference)
    return (found?.comments ?? []).slice(0, query.limit ?? 20)
  }

  async getHistory(reference: string, limit?: number): Promise<HistoryEvent[]> {
    const found = this.items.find((item) => item.reference === reference)
    return (found?.history ?? []).slice(0, limit ?? 50)
  }
}
