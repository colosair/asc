// 나머지 4개 Port(Approval Channel / SCM / Event Source / Renderer)의 in-memory 구현.
// Port 계약이 실제로 구현 가능한지, 그리고 Core가 특정 플랫폼을 몰라도 되는지 확인하는
// 참조 구현이다. 실 Adapter는 B-04·B-08·B-13에서 별도로 만든다.

import type { CanonicalSnapshot } from '../../core/model/entities.ts'
import type { DecisionSummary, DecisionView } from '../../core/view/decision-view.ts'
import type { ApprovalCapability, ApprovalChannel, IdentityBinding, PresentationOutcome } from '../../ports/approval.ts'
import type { Cursor, EventBatch, EventSource, RawEvent } from '../../ports/event-source.ts'
import type { InventoryItem, InventoryPage, InventoryPort, InventoryQuery } from '../../ports/inventory.ts'
import type { DeliveryOutcome, DigestBatch, PresentationCapability, PresentationPort } from '../../ports/presentation.ts'
import type { BaselineQuery, ExternalAction, ExternalActionResult, ScmPort, ThreadSnapshot } from '../../ports/scm.ts'
import type { ScopedStore } from '../../ports/state-store.ts'

/**
 * 채널 구현 참조. presentation 매핑은 Core entity가 아니라 이 Adapter가 받은
 * ScopedStore에 둔다 — PresentationRecord 소유 결정(ports/approval.ts)의 실물이다.
 */
export class MemoryChannel implements ApprovalChannel {
  readonly id: string
  readonly capabilities: ReadonlySet<ApprovalCapability>
  /** 테스트 관찰용 — 어떤 view가 몇 번 표시·갱신됐는지. */
  readonly presented: DecisionView[] = []
  readonly updated: DecisionView[] = []

  #store: ScopedStore
  #failUpdates = false

  constructor(id: string, store: ScopedStore, capabilities: readonly ApprovalCapability[] = ['interactive_actions']) {
    this.id = id
    this.#store = store
    this.capabilities = new Set(capabilities)
  }

  /** 채널이 죽었거나 메시지 수정을 지원하지 않는 상황을 흉내 낸다. */
  breakUpdates(): void {
    this.#failUpdates = true
  }

  async present(view: DecisionView): Promise<PresentationOutcome> {
    this.presented.push(view)
    const externalRef = `${this.id}:msg:${view.requestId}`
    await this.#store.set(`presentation:${view.requestId}`, JSON.stringify({
      requestId: view.requestId,
      channel: this.id,
      externalMessageRef: externalRef,
      renderedAt: view.stored.detectedAt,
    }))
    return { ok: true, externalRef }
  }

  async update(view: DecisionView): Promise<PresentationOutcome> {
    if (this.#failUpdates) return { ok: false, error: 'channel unreachable' }
    const record = await this.#store.get(`presentation:${view.requestId}`)
    if (!record) return { ok: false, error: 'no presentation to update' }
    this.updated.push(view)
    return { ok: true, externalRef: JSON.parse(record).externalMessageRef }
  }
}

/** 로컬 결정도 무조건 신뢰하지 않는다 — 매핑된 identity만 승인자로 인정한다 (OM §11.6). */
export class MapIdentityBinding implements IdentityBinding {
  #map: Map<string, string> // `${channel}:${actor}` → controller identity

  constructor(entries: Record<string, string>) {
    this.#map = new Map(Object.entries(entries))
  }

  async verify({ channel, actor, authorizedApprover }: { channel: string; actor: string; authorizedApprover: string }) {
    return this.#map.get(`${channel}:${actor}`) === authorizedApprover
  }
}

export class FakeScm implements ScmPort {
  readonly id = 'fake-scm'
  readonly executed: ExternalAction[] = []

  #threads = new Map<string, ThreadSnapshot>()
  #baselines = new Map<string, string>()
  #failNext: string | null = null

  setThread(reference: string, lastEventId: string): void {
    this.#threads.set(reference, { reference, lastEventId })
  }

  setBaseline(sourceId: string, baseline: string): void {
    this.#baselines.set(sourceId, baseline)
  }

  failNextExecute(error: string): void {
    this.#failNext = error
  }

  async getThread(reference: string): Promise<ThreadSnapshot> {
    return this.#threads.get(reference) ?? { reference, lastEventId: '', missing: true }
  }

  async getBaselines(queries: readonly BaselineQuery[]): Promise<CanonicalSnapshot[]> {
    return queries.map((q) => ({ sourceId: q.sourceId, baseline: this.#baselines.get(q.sourceId) ?? 'unknown' }))
  }

  async execute(action: ExternalAction): Promise<ExternalActionResult> {
    if (this.#failNext) {
      const error = this.#failNext
      this.#failNext = null
      return { ok: false, error }
    }
    this.executed.push(action)
    return { ok: true, resultRef: `${this.id}://${action.target}/${this.executed.length}` }
  }
}

/** 미리 넣어둔 배치를 순서대로 돌려준다. push형 Adapter의 내부 버퍼 drain과 같은 모양. */
export class FixtureEventSource implements EventSource {
  readonly id = 'fixture'
  #batches: RawEvent[][]

  constructor(batches: RawEvent[][]) {
    this.#batches = batches.map((b) => [...b])
  }

  async drain(cursor: Cursor): Promise<EventBatch> {
    const index = cursor ? Number(cursor) : 0
    const events = this.#batches[index] ?? []
    const hasMore = index + 1 < this.#batches.length
    return { events, cursor: String(index + 1), hasMore }
  }
}

/**
 * 목록을 통째로 들고 있는 Inventory. 페이지 나눔과 "완주하지 못함"을 흉내 낼 수 있어야
 * Coverage 판정(C-07 §1.5)을 실제로 검사할 수 있다.
 */
export class FixtureInventory implements InventoryPort {
  readonly id = 'fixture'
  /** 회차마다 다른 목록을 주려면 여기를 바꿔 끼운다. */
  items: InventoryItem[]
  #pageSize: number
  /** true면 어떤 페이지도 complete를 말하지 않는다 — 목록을 다 못 본 상황. */
  incomplete: boolean
  /** 설정하면 enumerate가 실패한다. */
  failWith: string | null = null

  constructor(items: InventoryItem[] = [], options: { pageSize?: number; incomplete?: boolean } = {}) {
    this.items = items
    this.#pageSize = options.pageSize ?? 100
    this.incomplete = options.incomplete ?? false
  }

  async enumerate(query: InventoryQuery, cursor?: string): Promise<InventoryPage> {
    if (this.failWith) throw new Error(this.failWith)

    // 경계는 포함해서 준다. 겹쳐 읽는 편이 놓치는 것보다 싸다 (OM §10.5).
    const filtered = query.updatedSince
      ? this.items.filter((item) => item.updatedAt >= query.updatedSince!)
      : this.items
    const page = cursor ? Number(cursor) : 0
    const slice = filtered.slice(page * this.#pageSize, (page + 1) * this.#pageSize)
    const more = (page + 1) * this.#pageSize < filtered.length
    return {
      items: slice,
      ...(more ? { next: String(page + 1) } : {}),
      complete: !more && !this.incomplete,
    }
  }
}

/**
 * 교체 검증용 전달 채널. 능력을 골라 끼울 수 있어야 "일부만 제공하는 채널"(C-08 §1.2)이
 * 실제로 degrade되는지 볼 수 있다.
 */
export class FixturePresentation implements PresentationPort {
  readonly id: string
  readonly capabilities: ReadonlySet<PresentationCapability>
  digests: DigestBatch[] = []
  urgent: DecisionSummary[] = []
  /** 설정하면 전달이 실패한다 — best-effort 계약을 확인하기 위해서다. */
  failWith: string | null = null

  constructor(id = 'fixture-channel', capabilities: PresentationCapability[] = ['presentation.digest']) {
    this.id = id
    this.capabilities = new Set(capabilities)
  }

  async presentDigest(batch: DigestBatch): Promise<DeliveryOutcome> {
    if (this.failWith) return { ok: false, error: this.failWith }
    this.digests.push(batch)
    return { ok: true, externalRef: `${this.id}://digest/${this.digests.length}` }
  }

  async presentUrgent(item: DecisionSummary): Promise<DeliveryOutcome> {
    if (this.failWith) return { ok: false, error: this.failWith }
    this.urgent.push(item)
    return { ok: true, externalRef: `${this.id}://urgent/${item.requestId}` }
  }
}
