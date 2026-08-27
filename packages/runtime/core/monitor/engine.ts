// Monitor Engine — 이벤트를 발견하고, 사람이 판단할 것만 골라 보고서로 만든다.
//
// 두 단계로 나뉘는 이유는 값이다 (OM §10.2~10.3). Phase A는 들어온 것 전부를 훑지만
// 싸게 훑고, Phase B는 비싸게 파지만 수신함에 올릴 것만 판다. 전부를 깊게 조사하면
// 조용한 날에도 비용이 나가고, 전부를 얕게 두면 정작 답해야 할 것 앞에서 사람이
// 스레드를 처음부터 읽어야 한다.
//
// 이 파일에도 프로젝트 고유값은 없다. 누가 "나"인지, 어떤 라벨이 급한지는 config가 들고 온다.

import { ApprovalRequest, type MonitorEvent, type Priority } from '../model/entities.ts'
import type { EventSource, RawEvent } from '../../ports/event-source.ts'
import type { InventoryItem, InventoryPage, InventoryPort } from '../../ports/inventory.ts'
import type { OwnershipMap } from '../policy/ownership.ts'
import type { ScmPort } from '../../ports/scm.ts'
import type { ScopedStore, StateStore } from '../../ports/state-store.ts'
import { classify, type Classification, type MonitorConfig, type SignalContext } from './signals.ts'
import { evaluateRelevance, type Relevance, type RelevanceContext } from './relevance.ts'
import { fingerprintOf, type ObservationLedger } from './observation.ts'
import { CoverageLedger, type CoverageDiff, type SweepKind } from './coverage.ts'
import { investigate, type InvestigationPorts, type StepResult } from './investigation.ts'

/** 회수 경로 한 회차. scan과 나누는 이유는 답하는 질문이 다르기 때문이다. */
export type SweepOutcome = {
  skipped?: boolean
  kind: SweepKind
  /** 목록에서 본 리소스 수. */
  seen: number
  /** 지난번과 달라 올린 것. */
  changed: number
  packets: string[]
  /** 알던 것 중 이번 목록에 없던 것. 원인은 판정하지 않는다 (C-07 §1.5). */
  missing: string[]
  /** 목록을 빠짐없이 훑었는가. 아니면 상실 판정을 하지 않았다는 뜻이다. */
  complete: boolean
  /** 조회 자체가 실패했다면 그 이유. */
  detail?: string
}

export type ScanOutcome = {
  /** 다른 Run이 돌고 있어 이번엔 건너뛰었다. polling이므로 다음 회차가 잡는다. */
  skipped?: boolean
  detected: number
  duplicates: number
  logged: number
  packets: string[]
  retries: string[]
  cursor: string | null
}

export type MonitorDeps = {
  store: StateStore
  source: EventSource
  config: MonitorConfig
  /** Phase B의 맥락 조사에 쓴다. 없으면 정본 대조 없이 얕은 보고서만 만든다. */
  scm?: ScmPort
  /** 이 요청을 결정할 수 있는 사람. Profile/Override가 채운다 (OM §11.6). */
  authorizedApprover: string
  /** canonical source 목록. 보고서의 기준선이 된다 (OM §8). */
  canonicalSources?: readonly string[]
  /**
   * 이 사건에 대해 지금 관찰된 사실을 모아 준다 (C-07 §2·§3). 없으면 신호만으로 판정하며,
   * 그러면 "나를 불렀는가"까지밖에 알 수 없다.
   *
   * 콜백 하나로 받는 이유: 이벤트마다 외부 조회가 필요할 수 있어 여러 번 왕복하면
   * 회차 비용이 그만큼 늘어난다.
   */
  observe?: (event: RawEvent) => Promise<EventObservation> | EventObservation
  /** 같은 reference를 지난번에 어떻게 봤는지 (C-07 §4·§5). 없으면 억제도 Shadow도 없다. */
  observations?: ObservationLedger
  /**
   * 목록을 다시 세어 놓친 것을 찾는 통로 (C-07 §1.2·§1.3). 없으면 reconcile·census가
   * 성립하지 않는다 — 빠른 경로만으로는 완전성을 말할 수 없다.
   */
  inventory?: InventoryPort
  /**
   * 조사 단계가 요청하는 통로들 (C-07 §6.2). 없는 것은 그 단계가 판정 불성립으로 남는다 —
   * 다른 단계 결과로 대신하지 않는다.
   */
  investigation?: Pick<InvestigationPorts, 'resource' | 'change' | 'work' | 'history'>
  /** 조사에 넘길 프로젝트 사실. Core는 Profile을 모르므로 Surface가 꺼내 준다. */
  investigationContext?: (event: RawEvent) => {
    ownership?: OwnershipMap
    owner?: string
    decisionDomains?: readonly string[]
    canonicalPaths?: readonly string[]
    /** 이 사건에 연결된 작업 항목. 코드 쪽과 다른 Binding일 수 있다 (C-07 §6.1 ⑦). */
    workReference?: string
  }
  /** 이 Run의 이름. lease에 남아 누가 잡고 있는지 보인다. */
  runId?: string
  /**
   * cursor가 없을 때 어디서부터 볼지. 주지 않으면 처음부터 — 붙인 지 오래된 저장소에서는
   * 그 자체가 잡음이 된다 (OM §18).
   */
  startFrom?: string
  now?: () => string
}

/** 이번 사건에 대해 밖에서 알아 온 것. 없는 항목은 그 판정을 하지 않는다. */
export type EventObservation = {
  signal?: SignalContext
  relevance?: RelevanceContext
  /**
   * 실질 변화 마커 (C-07 §4.2). adapter가 만든다. 없으면 억제 판정이 서지 않으므로
   * 같은 스레드의 반복 호출이 매번 새 패킷이 된다.
   */
  revisionMarker?: string
}

/**
 * 회수 경로가 찾은 변화를 이벤트 하나로 만든다.
 *
 * key에 marker를 넣는 이유: 같은 리소스라도 달라진 것은 다른 사건이다. marker가 같으면
 * 애초에 diff에 오르지 않으므로 회차마다 새 key가 쏟아지지 않는다 (C-07 §1.4).
 */
function sweepEvent(kind: SweepKind, diff: CoverageDiff, at: string): RawEvent {
  const item = diff.kind === 'RESOURCE_MISSING' ? null : diff.item
  const reference = item?.reference ?? (diff.kind === 'RESOURCE_MISSING' ? diff.reference : '')
  return {
    eventKey: `${kind}:${reference}:${item?.revisionMarker ?? at}`,
    detectedAt: at,
    reference,
    // assignee를 actors로 넘기지 않는다 — actors는 "누가 했는가"이고, 그걸로 자기 글
    // 억제가 걸린다. 배정 사실은 signal context로 따로 전달한다.
    ...(item
      ? {
          ...(item.labels ? { hints: { labels: item.labels } } : {}),
          raw: { kind: 'inventory', title: item.title, state: item.state },
        }
      : {}),
  }
}

/** cursor는 entity가 아니라 Monitor 계약의 일부라 Adapter scope에 둔다. */
const CURSOR_KEY = 'cursor'
const LEASE_KEY = 'scan-lease'
/** 이보다 오래된 lease는 죽은 프로세스가 남긴 것으로 보고 회수한다. */
const LEASE_STALE_MS = 5 * 60_000

export class MonitorEngine {
  #store: StateStore
  #source: EventSource
  #config: MonitorConfig
  #scm: ScmPort | undefined
  #approver: string
  #canonicalSources: readonly string[]
  #observe: ((event: RawEvent) => Promise<EventObservation> | EventObservation) | undefined
  #observations: ObservationLedger | undefined
  #inventory: InventoryPort | undefined
  #investigation: Pick<InvestigationPorts, 'resource' | 'change' | 'work' | 'history'> | undefined
  #investigationContext: MonitorDeps['investigationContext']
  #now: () => string
  #runId: string
  #startFrom: string | undefined

  constructor(deps: MonitorDeps) {
    this.#store = deps.store
    this.#source = deps.source
    this.#config = deps.config
    this.#scm = deps.scm
    this.#approver = deps.authorizedApprover
    this.#canonicalSources = deps.canonicalSources ?? []
    this.#observe = deps.observe
    this.#observations = deps.observations
    this.#inventory = deps.inventory
    this.#investigation = deps.investigation
    this.#investigationContext = deps.investigationContext
    this.#now = deps.now ?? (() => new Date().toISOString())
    this.#runId = deps.runId ?? `${process.pid}-${this.#source.id}`
    this.#startFrom = deps.startFrom
  }

  /**
   * 한 회차. 겹쳐 돌면 같은 이벤트로 요청이 두 개 생기므로 하나만 돈다 (OM §7.2·§10.1).
   *
   * 같은 객체 안에서만 막으면 소용이 없다 — CLI를 두 번 띄우면 프로세스가 둘이고, 둘 다
   * 자기 안에서는 첫 Run이다. 그래서 잠금을 `.asc/` 안에 둔다: 프로젝트 하나에 Run 하나.
   *
   * 대기시키지 않고 건너뛰는 이유는, 밀린 Run이 쌓이는 것보다 다음 회차가 다시 보는 편이
   * 싸기 때문이다 — 이벤트는 사라지지 않고 cursor에 남아 있다.
   */
  async scan(): Promise<ScanOutcome> {
    const scope = this.#store.scope(`monitor:${this.#source.id}`)
    if (!(await this.#acquire(scope))) {
      return { skipped: true, detected: 0, duplicates: 0, logged: 0, packets: [], retries: [], cursor: null }
    }
    try {
      return await this.#scan(scope)
    } finally {
      await scope.delete(LEASE_KEY)
    }
  }

  /** 비정상 종료로 남은 lease는 시간이 지나면 회수한다 — 영영 잠긴 채로 두지 않는다. */
  async #acquire(scope: ScopedStore): Promise<boolean> {
    const mine = JSON.stringify({ owner: this.#runId, at: this.#now() })
    if (await scope.setIfAbsent(LEASE_KEY, mine)) return true

    const held = await scope.get(LEASE_KEY)
    if (!held) return scope.setIfAbsent(LEASE_KEY, mine)
    try {
      const { at } = JSON.parse(held) as { at: string }
      // 같은 시계로 잰다. 기록은 주입된 시계로 하고 판정만 벽시계로 하면, 시계가 서로
      // 어긋나는 순간 살아 있는 lease를 죽은 것으로 회수한다 — 테스트의 고정 시각에서
      // 실제로 터졌던 결함이다.
      if (new Date(this.#now()).getTime() - new Date(at).getTime() < LEASE_STALE_MS) return false
    } catch {
      // 읽을 수 없는 lease도 죽은 것으로 본다
    }
    await scope.delete(LEASE_KEY)
    return scope.setIfAbsent(LEASE_KEY, mine)
  }

  /**
   * 이번 관측을 판단 대기함에 올릴 것인가 (C-07 §4·§5).
   *
   * 관측 기록이 없으면 예전처럼 신호만으로 정한다 — 없는 기능을 조용히 켜지 않는다.
   * 관련성 판정이 없으면 억제도 하지 않는다: 근거 없이 숨기는 것이 가장 나쁜 결과다.
   */
  async #shouldSurface(
    event: RawEvent,
    relevance: Relevance | undefined,
    revisionMarker: string | undefined,
  ): Promise<boolean> {
    if (!this.#observations || !relevance) return true

    const fingerprint = fingerprintOf(relevance, revisionMarker ?? event.eventKey)
    const decision = await this.#observations.decide(event.reference, fingerprint, relevance.disposition)
    await this.#observations.record(
      event.reference,
      fingerprint,
      relevance.disposition,
      relevance.disposition === 'SHADOW' ? '관련 근거 없음' : undefined,
    )
    return decision.surface
  }

  /**
   * 이벤트 하나를 Phase A로 통과시킨다 — dedupe · 신호 · 관련성 · 억제 · 기록.
   *
   * 빠른 경로(scan)와 회수 경로(reconcile·census)가 같은 문을 지나야 한다. 경로마다 다른
   * 판정을 하면 "늦게 발견됐으니 덜 중요하다"가 코드에 새겨진다 (C-07 §1.6).
   */
  async #intake(
    event: RawEvent,
    extra: SignalContext = {},
  ): Promise<{ duplicate: true } | { duplicate: false; fresh?: { event: RawEvent; verdict: Classification } }> {
    // dedupe는 log를 훑는 게 아니라 key 하나로 본다 (OM §10.4)
    if (await this.#store.get('event', event.eventKey)) return { duplicate: true }
    // 밖에서 알아 온 사실을 먼저 모은다 — 없으면 신호만으로 판정한다.
    const observed = this.#observe ? await this.#observe(event) : {}
    const verdict = classify(event, this.#config, { ...extra, ...(observed.signal ?? {}) })

    // 신호와 관련성은 다른 층이다 (C-07 §2). 신호는 "무슨 일이 있었나"이고
    // 관련성은 "그래서 내 일인가"다.
    const relevance = observed.relevance ? evaluateRelevance(verdict.signals, observed.relevance) : undefined
    const surfaced = await this.#shouldSurface(event, relevance, observed.revisionMarker)
    const inboxCandidate = verdict.inboxCandidate && surfaced

    // 빠른 경로가 본 것을 회수 경로도 알아야 한다. 안 그러면 다음 대조가 같은 변화를
    // "처음 본다"로 판단해 패킷이 둘이 된다 (C-07 §1.7).
    if (observed.revisionMarker) {
      await this.#coverage().record({ reference: event.reference, revisionMarker: observed.revisionMarker })
    }

    await this.#store.create('event', {
      eventKey: event.eventKey,
      version: 0,
      detectedAt: event.detectedAt,
      type: verdict.type,
      suggestedPriority: verdict.priority,
      processing: inboxCandidate ? 'PENDING_RETRY' : 'LOGGED',
      inboxCandidate,
      ...(relevance
        ? {
            relevance: {
              explicit: relevance.explicit,
              actual: relevance.actual,
              disposition: relevance.disposition,
              evidence: relevance.evidence.map((e) => `${e.supports ? '+' : '-'} ${e.detail}`),
            },
          }
        : {}),
      // 조사가 실패해도 다시 해볼 수 있게 원본을 남긴다. cursor는 이미 지나갔고,
      // provider가 같은 것을 또 주리라는 보장이 없다.
      ...(inboxCandidate
        ? {
            replay: {
              reference: event.reference,
              ...(event.raw !== undefined ? { raw: event.raw } : {}),
              ...(event.hints !== undefined ? { hints: event.hints as Record<string, unknown> } : {}),
            },
          }
        : {}),
    })
    // log는 전 이벤트, 수신함은 행동할 것만 (OM §10.2)
    await this.#store.appendHistory({
      at: event.detectedAt,
      actor: this.#source.id,
      kind: 'monitor_event',
      ref: event.eventKey,
      detail:
        `${event.reference} · ${verdict.type} · ${verdict.priority} · ` +
        `${verdict.signals.join(',') || 'no-signal'}` +
        (relevance ? ` · relevance ${relevance.explicit}/${relevance.actual}` : '') +
        // 올리지 않은 것도 log에는 남는다. 숨김은 폐기가 아니다 (OM §10.7 허용 write).
        (verdict.inboxCandidate && !inboxCandidate ? ' · 억제' : ''),
    })
    return { duplicate: false, ...(inboxCandidate ? { fresh: { event, verdict } } : {}) }
  }

  /** Coverage 기록은 scan lease와 같은 scope에 둔다 — 회수 경로도 같은 문을 지난다. */
  #coverage(): CoverageLedger {
    return new CoverageLedger(this.#store.scope(`monitor:${this.#source.id}`), this.#now)
  }

  /**
   * 빠른 경로가 놓친 것을 회수한다 (C-07 §1.2). 알림 재생이 아니라 **목록 재조회**다.
   *
   * `updatedSince` 기준선 이후만 본다 — 전수는 census의 몫이고, 매번 전부 훑으면
   * 30분마다 도는 물건이 될 수 없다.
   */
  async reconcile(): Promise<SweepOutcome> {
    return this.#sweep('reconcile')
  }

  /**
   * 우리가 아는 세계와 provider의 실제 세계가 일치하는지 본다 (C-07 §1.3).
   * 기준선 없이 전부 훑고, 알던 것 중 이번에 없는 것도 찾는다.
   */
  async census(): Promise<SweepOutcome> {
    return this.#sweep('census')
  }

  async #sweep(kind: SweepKind): Promise<SweepOutcome> {
    const scope = this.#store.scope(`monitor:${this.#source.id}`)
    if (!this.#inventory) {
      return { kind, seen: 0, changed: 0, packets: [], missing: [], complete: false, detail: '목록을 셀 통로가 없다' }
    }
    // scan과 같은 lease를 쓴다. 회수와 빠른 경로가 겹쳐 돌면 같은 변화로 요청이 둘 생긴다.
    if (!(await this.#acquire(scope))) {
      return { skipped: true, kind, seen: 0, changed: 0, packets: [], missing: [], complete: false }
    }

    try {
      const coverage = this.#coverage()
      const health = await coverage.health()
      const query =
        kind === 'reconcile' && health.coverageWatermark ? { updatedSince: health.coverageWatermark } : {}

      const items: InventoryItem[] = []
      const seen = new Set<string>()
      let complete = false
      let cursor: string | undefined
      let failure: string | undefined

      // 페이지를 끝까지 돈다. 완주 여부는 **마지막 페이지가 말한다** — 중간 페이지는
      // 아직 알 수 없으므로 false이고, 그것을 그대로 받으면 어떤 다중 페이지 열거도
      // 완주로 인정되지 않는다.
      for (;;) {
        const page: InventoryPage = await this.#inventory.enumerate(query, cursor).catch((error: unknown) => {
          failure = String(error)
          return { items: [], complete: false }
        })
        for (const item of page.items) {
          items.push(item)
          seen.add(item.reference)
        }
        complete = page.complete
        if (!page.next) break
        cursor = page.next
      }

      const diffs = await coverage.diff(items)
      // 상실 판정은 census에서, 그것도 완주한 목록에서만 한다.
      const missing = kind === 'census' ? await coverage.missing(seen, complete && !failure) : []

      const at = this.#now()
      const packets: string[] = []
      const fresh: { event: RawEvent; verdict: Classification }[] = []

      const me = this.#config.identities ?? []
      for (const diff of diffs) {
        if (diff.kind === 'RESOURCE_MISSING') continue
        // 목록에서만 알 수 있는 사실을 신호 판정에 넘긴다. 알림이 오지 않은 배정이
        // 정확히 이 경로로 잡힌다.
        const assignedToMe = (diff.item.assignees ?? []).some((who) => me.includes(who))
        const taken = await this.#intake(sweepEvent(kind, diff, at), assignedToMe ? { assignedToMe } : {})
        if (!taken.duplicate && taken.fresh) fresh.push(taken.fresh)
        await coverage.record(diff.item)
      }

      for (const { event, verdict } of fresh) {
        const made = await this.#buildPacket(event, verdict)
        if (made) packets.push(made)
      }

      for (const gone of missing) {
        // 사라진 이유를 여기서 정하지 않는다. 사실만 남기고 사람이 본다.
        await this.#store.appendHistory({
          at,
          actor: this.#source.id,
          kind: 'coverage_anomaly',
          ref: gone.kind === 'RESOURCE_MISSING' ? gone.reference : '',
          detail: 'RESOURCE_MISSING — 알던 리소스가 이번 목록에 없다 (삭제·권한·가시성·조회 오류 중 무엇인지는 모른다)',
        })
      }

      // 기준선은 **provider가 말한 시각**으로 옮긴다. 우리 시계로 옮기면 시계 차이만큼의
      // 변경이 영영 회수되지 않는다 — 그 창이 정확히 이 경로가 막으려던 구멍이다.
      const watermark = items.reduce<string | undefined>(
        (max, item) => (max === undefined || item.updatedAt > max ? item.updatedAt : max),
        undefined,
      )

      await coverage.updateHealth({
        ...(kind === 'reconcile' ? { lastReconcileAt: at } : { lastCensusAt: at }),
        // 완주하지 못한 회차로 기준선을 옮기면 그 사이 변경이 영영 회수되지 않는다.
        ...(complete && !failure && watermark ? { coverageWatermark: watermark } : {}),
        paginationComplete: complete && !failure,
        sourceHealthy: !failure,
        ...(failure ? { detail: failure } : {}),
      })

      return {
        kind,
        seen: items.length,
        changed: diffs.filter((d) => d.kind !== 'RESOURCE_MISSING').length,
        packets,
        missing: missing.flatMap((m) => (m.kind === 'RESOURCE_MISSING' ? [m.reference] : [])),
        complete: complete && !failure,
        ...(failure ? { detail: failure } : {}),
      }
    } finally {
      await scope.delete(LEASE_KEY)
    }
  }

  /** 지금까지 어디까지 확인했는가. 판정하지 않고 보여주기만 한다. */
  async health() {
    return this.#coverage().health()
  }

  async #scan(scope: ScopedStore): Promise<ScanOutcome> {
    // 지난 회차에 조사하다 실패한 것부터. 새 이벤트에 밀려 영영 안 보는 일이 없게 한다.
    const pending = await this.#store.list('event', { where: { processing: 'PENDING_RETRY' } })
    // 처음 도는 회차라면 어디서부터 볼지 정해 둔다. 과거를 전부 긁으면 사람이 읽을 수 없다.
    let cursor = await scope.get(CURSOR_KEY)
    if (cursor === null && this.#startFrom && this.#source.cursorFrom) {
      cursor = this.#source.cursorFrom(this.#startFrom)
      await scope.set(CURSOR_KEY, cursor ?? '')
    }
    const batch = await this.#source.drain(cursor)

    let duplicates = 0
    let logged = 0
    const packets: string[] = []
    const retries: string[] = []

    // ── Phase A — 전부, 싸게 ──────────────────────────────────────────────
    const fresh: { event: RawEvent; verdict: Classification }[] = []
    for (const event of batch.events) {
      const taken = await this.#intake(event)
      if (taken.duplicate) {
        duplicates++
        continue
      }
      logged++
      if (taken.fresh) fresh.push(taken.fresh)
    }

    // ── Phase B — 수신함에 올릴 것만, 깊게 ────────────────────────────────
    // 지난 회차 실패분을 먼저 처리한다. 새 이벤트가 계속 들어오면 영영 뒤로 밀리기 때문이다.
    for (const stale of pending) {
      const restored = restore(stale)
      if (!restored) {
        retries.push(stale.eventKey)
        continue
      }
      const made = await this.#buildPacket(restored.event, restored.verdict, restored.steps)
      if (made) packets.push(made)
      else retries.push(stale.eventKey)
    }

    for (const { event, verdict } of fresh) {
      const made = await this.#buildPacket(event, verdict)
      if (made) packets.push(made)
      else retries.push(event.eventKey)
    }

    // cursor는 Phase B까지 끝난 뒤에 옮긴다. 중간에 죽으면 다시 받는 편이 안전하다 (OM §10.5)
    if (batch.cursor) await scope.set(CURSOR_KEY, batch.cursor)

    // 빠른 경로가 마지막으로 무언가를 본 시각. 이 값이 오래됐다는 것 자체가 신호다 —
    // 조용한 것과 끊긴 것을 사람이 구분할 수 있어야 한다 (C-07 §8.2).
    if (batch.events.length > 0) {
      await this.#coverage().updateHealth({ lastHotEventAt: batch.events.at(-1)!.detectedAt })
    }

    return {
      detected: batch.events.length,
      duplicates,
      logged,
      packets,
      retries,
      cursor: batch.cursor,
    }
  }

  /** 조사에 실패하면 null. 이벤트는 PENDING_RETRY로 남아 다음 회차가 다시 본다. */
  async #buildPacket(
    event: RawEvent,
    verdict: Classification,
    resume: readonly StepResult[] = [],
  ): Promise<string | null> {
    // 끝난 단계는 실패해도 남긴다. 재시도가 처음부터 다시 하면 비싼 단계에서 걸린 사건은
    // 영영 넘지 못한다 (C-07 §6.3).
    let progress: readonly StepResult[] = resume
    try {
      const requestId = await this.#nextRequestId()
      const snapshot = this.#scm && this.#canonicalSources.length > 0
        ? await this.#scm.getBaselines(this.#canonicalSources.map((sourceId) => ({ sourceId })))
        : []
      const thread = this.#scm ? await this.#scm.getThread(event.reference) : null

      const control = await this.#store.getControlState()
      const depth = packetDepth(verdict.type, verdict.priority)
      const raw = (event.raw ?? {}) as { body?: string; title?: string; reason?: string }

      // 단계 조사 (C-07 §6). 각 단계는 필요한 Port만 요청하고, 없으면 판정 불성립으로 남는다.
      const known = await this.#store.get('event', event.eventKey)
      const context = this.#investigationContext?.(event) ?? {}
      const previous = await this.#coverage().get(event.reference)
      const inquiry = await investigate(
        {
          reference: event.reference,
          ...(known?.relevance
            ? {
                relevance: {
                  explicit: known.relevance.explicit,
                  actual: known.relevance.actual,
                  disposition: known.relevance.disposition,
                  evidence: known.relevance.evidence.map((line) => ({
                    kind: 'ownership' as const,
                    detail: line.replace(/^[+-] /, ''),
                    supports: line.startsWith('+'),
                  })),
                },
              }
            : {}),
          ...(previous ? { previous: { revisionMarker: previous.revisionMarker, state: previous.state } } : {}),
          ...(control.activeSessions.length > 0 ? { activeSessions: control.activeSessions } : {}),
          ...context,
        },
        {
          ...(this.#investigation ?? {}),
          ...(this.#scm && this.#canonicalSources.length > 0
            ? { baselines: async () => snapshot }
            : {}),
        },
        resume,
      )
      progress = inquiry.steps

      const request = ApprovalRequest.parse({
        id: requestId,
        version: 0,
        status: 'AWAITING_APPROVAL',
        type: verdict.type,
        priority: verdict.priority,
        title: raw.title ?? `${event.reference} 확인 필요`,
        detectedAt: event.detectedAt,
        source: {
          eventKey: event.eventKey,
          reference: event.reference,
          ...(thread && !thread.missing ? { threadLastEventId: thread.lastEventId } : {}),
        },
        situation: situationOf(event, verdict, raw),
        // 깊이는 유형이 정한다. 참고용 알림에 전체 보고서를 붙이면 정작 급한 것이 묻힌다.
        // 조사 결과는 요약하지 않고 그대로 잇는다 — 무엇을 못 봤는지가 특히 남아야 한다.
        context: depth === 'full' ? [contextOf(event, verdict), ...inquiry.situation].join('\n') : '',
        impact: {
          interruptRequired: verdict.priority === 'P0' && verdict.type !== 'informational',
          affectedSessions: control.activeSessions,
          rationale: depth === 'brief' ? '' : rationaleOf(verdict, control.activeSessions.length),
        },
        recommendation:
          inquiry.undecidable.length > 0
            ? `${inquiry.recommendation} (확인 못 함: ${inquiry.undecidable.join(' / ')})`
            : inquiry.recommendation,
        // 정본은 Monitor가 답변 초안까지 준비하도록 한다 (OM §10.3 — 대응형 전체 패킷).
        // 지금 비어 있는 것은 계약이 아니라 미구현이다: 초안을 짓는 Draft Generator가
        // 아직 없다. 금지된 것은 초안 작성이 아니라 승인 없는 게시다 (OM §11.5).
        snapshot,
        authorizedApprover: this.#approver,
        allowedDecisions: allowedDecisionsFor(verdict.type),
      })

      const created = await this.#store.create('request', request)
      if (!created.ok) {
        // 만들지 못했어도 조사한 것은 남긴다 — 다음 회차가 같은 조사를 다시 하지 않게.
        await this.#saveProgress(event.eventKey, progress)
        return null
      }

      // 조사까지 끝났으니 이 이벤트는 처리된 것이다
      const stored = (await this.#store.get('event', event.eventKey))!
      await this.#store.compareAndSet('event', event.eventKey, stored.version, {
        ...stored,
        version: stored.version + 1,
        processing: 'PROCESSED',
        requestId,
      })
      await this.#store.appendHistory({
        at: this.#now(),
        actor: 'monitor',
        kind: 'packet_created',
        ref: requestId,
        detail: `${event.reference} · ${depth}`,
      })
      return requestId
    } catch {
      // 한 건이 실패해도 나머지는 계속 간다 (OM §10.5)
      await this.#saveProgress(event.eventKey, progress)
      return null
    }
  }

  /** 실패한 조사의 부분 결과를 replay에 남긴다. 다음 회차가 여기서부터 잇는다. */
  async #saveProgress(eventKey: string, steps: readonly StepResult[]): Promise<void> {
    if (steps.length === 0) return
    const stored = await this.#store.get('event', eventKey)
    if (!stored?.replay) return
    await this.#store.compareAndSet('event', eventKey, stored.version, {
      ...stored,
      version: stored.version + 1,
      replay: {
        ...stored.replay,
        steps: steps.map((step) => ({
          id: step.id,
          kind: step.kind,
          findings: step.kind === 'DONE' ? step.findings : [],
          ...(step.kind === 'DONE' ? {} : { detail: step.detail }),
        })),
      },
    })
  }

  async #nextRequestId(): Promise<string> {
    const existing = await this.#store.list('request')
    const numbers = existing.map((r) => Number(r.id.slice(4))).filter((n) => Number.isFinite(n))
    const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 1
    return `REQ-${String(next).padStart(4, '0')}`
  }
}

/**
 * 저장해 둔 이벤트를 조사 가능한 형태로 되살린다.
 * 분류는 이미 끝나 있으므로 다시 하지 않는다 — 그때의 판정이 지금도 그 판정이다.
 */
function restore(
  stored: MonitorEvent,
): { event: RawEvent; verdict: Classification; steps: StepResult[] } | null {
  if (!stored.replay) return null
  return {
    // 지난번에 끝낸 단계. 여기서부터 잇는다.
    steps: (stored.replay.steps ?? []).map((step) =>
      step.kind === 'DONE'
        ? { id: step.id as StepResult['id'], kind: 'DONE', findings: step.findings }
        : { id: step.id as StepResult['id'], kind: step.kind, detail: step.detail ?? '' },
    ),
    event: {
      eventKey: stored.eventKey,
      detectedAt: stored.detectedAt,
      reference: stored.replay.reference,
      ...(stored.replay.raw !== undefined ? { raw: stored.replay.raw } : {}),
      ...(stored.replay.hints !== undefined ? { hints: stored.replay.hints as RawEvent['hints'] } : {}),
    },
    verdict: {
      signals: [],
      type: stored.type,
      priority: stored.suggestedPriority,
      inboxCandidate: stored.inboxCandidate,
    },
  }
}

export type PacketDepth = 'full' | 'compact' | 'brief'

/** OM §10.3 — 대응형·작업형은 전부, 정보형은 우선순위에 따라 접는다. */
export function packetDepth(type: string, priority: Priority): PacketDepth {
  if (type !== 'informational') return 'full'
  return priority === 'P2' ? 'brief' : 'compact'
}

function situationOf(event: RawEvent, verdict: Classification, raw: { reason?: string; body?: string }): string {
  const what = verdict.signals.length > 0 ? verdict.signals.join(', ') : '변화 감지'
  const snippet = raw.body ? ` — ${raw.body.slice(0, 140)}${raw.body.length > 140 ? '…' : ''}` : ''
  return `${event.reference}: ${what}${snippet}`
}

function contextOf(event: RawEvent, verdict: Classification): string {
  const labels = event.hints?.labels ?? []
  const actors = event.hints?.actors ?? []
  return [
    actors.length > 0 ? `관련 인물: ${actors.join(', ')}` : '',
    labels.length > 0 ? `라벨: ${labels.join(', ')}` : '',
    `신호: ${verdict.signals.join(', ') || '없음'}`,
  ]
    .filter(Boolean)
    .join('\n')
}

function rationaleOf(verdict: Classification, activeSessions: number): string {
  return `${verdict.type}/${verdict.priority} 판정. 활성 세션 ${activeSessions}건 기준으로 영향 산정.`
}

function recommendationOf(type: string): string {
  if (type === 'work') return '작업으로 승격할지 판단이 필요하다'
  if (type === 'actionable') return '답변이 필요하다 — 초안을 검토하고 승인하라'
  return '확인만 하면 된다'
}

/** 작업형은 작업 큐로, 대응형은 답변으로 간다 (OM §11.10). */
function allowedDecisionsFor(type: string): string[] {
  return type === 'work' ? ['queue', 'defer', 'dismiss'] : ['approve', 'revise', 'defer', 'dismiss']
}
