// Local Operator Interface — 로컬 작업환경이 ASC 요청을 조회하는 표면 (C-01 §4).
//
// Core는 어떤 도구가 이걸 부르는지 모른다. CLI든 MCP든 IDE 확장이든 전부 소비자일 뿐이고,
// 제품 이름이 이 파일에 들어오는 순간 계약이 깨진다.
//
// 여기 있는 것은 읽기뿐이다. 결정 제출은 사람의 명시적 의사표현을 받은 뒤에만 일어나므로
// 별도 경로(B-06)로 나간다 — Agent가 조회하다가 이어서 승인해버릴 수 있는 문을 만들지 않는다 (C-01 §5).

import type { ApprovalRequest } from '../model/entities.ts'
import type { ScmPort } from '../../ports/scm.ts'
import type { HistoryEntry, StateStore } from '../../ports/state-store.ts'
import type { DecisionSummary, DecisionView, Freshness } from '../view/decision-view.ts'
import { assembleView, assess, buildOverlay, summarize } from '../view/build-view.ts'

/** 아직 사람의 판단을 기다리는 상태. 목록의 기본 필터다. */
const PENDING = new Set(['AWAITING_APPROVAL', 'APPROVED'])

export type ListOptions = {
  /** true면 처분된 것까지 전부 (기본은 판단 대기만). */
  all?: boolean
  priority?: 'P0' | 'P1' | 'P2'
  limit?: number
}

export type GetOutcome =
  | { ok: true; view: DecisionView }
  | { ok: false; reason: 'NOT_FOUND'; requestId: string }

/**
 * 참조가 하나로 좁혀지지 않을 때의 결과. Agent가 임의로 하나를 고르지 않도록
 * 후보를 그대로 돌려준다 (C-01 §11).
 */
export type ResolveOutcome =
  | { kind: 'resolved'; view: DecisionView }
  | { kind: 'ambiguous'; candidates: DecisionSummary[] }
  | { kind: 'none' }

export type OperatorDeps = {
  store: StateStore
  /** 없어도 동작한다 — 정본·스레드 확인만 건너뛴다. */
  scm?: ScmPort
  /** 테스트에서 시각을 고정하기 위한 주입점. */
  now?: () => string
}

export class LocalOperator {
  #store: StateStore
  #scm: ScmPort | undefined
  #now: () => string

  constructor(deps: OperatorDeps) {
    this.#store = deps.store
    this.#scm = deps.scm
    this.#now = deps.now ?? (() => new Date().toISOString())
  }

  /** 최근 감지 순. 목록에도 freshness를 붙여 이미 결정된 것을 눈에 띄게 한다. */
  async list(options: ListOptions = {}): Promise<DecisionSummary[]> {
    const requests = await this.#store.list('request')
    const filtered = requests
      .filter((r) => options.all || PENDING.has(r.status))
      .filter((r) => !options.priority || r.priority === options.priority)
      .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))
      .slice(0, options.limit ?? requests.length)

    const summaries: DecisionSummary[] = []
    for (const request of filtered) summaries.push(summarize(request, await this.#freshness(request)))
    return summaries
  }

  /** 하나를 지목해 전체 보고서를 만든다 — stored와 current를 함께 담는다. */
  async get(requestId: string): Promise<GetOutcome> {
    const request = await this.#store.get('request', requestId)
    if (!request) return { ok: false, reason: 'NOT_FOUND', requestId }
    return { ok: true, view: await this.#view(request) }
  }

  /**
   * "방금 온 알림 보여줘" — request_id 없이 최근 것을 찾는다.
   * 후보가 여럿이면 하나를 고르지 않고 그대로 돌려준다. 잘못 고른 요청을 승인 화면까지
   * 끌고 가는 것보다 한 번 더 묻는 편이 싸다.
   */
  async resolveLatest(options: ListOptions = {}): Promise<ResolveOutcome> {
    const candidates = await this.list({ ...options, limit: undefined })
    if (candidates.length === 0) return { kind: 'none' }
    if (candidates.length > 1) return { kind: 'ambiguous', candidates }

    const outcome = await this.get(candidates[0]!.requestId)
    return outcome.ok ? { kind: 'resolved', view: outcome.view } : { kind: 'none' }
  }

  /**
   * 이 요청이 지금 상태가 된 경위 (C-05 §3.2 trace).
   *
   * 새 저장 구조를 만들지 않는다 — depth는 "얼마나 읽을 것인가"의 계약이지 새 데이터가
   * 아니고, 감지와 최종 처분의 이력은 이미 History Log에 있다 (OM §11.2).
   *
   * 여기도 읽기뿐이다. 경위를 아무리 깊게 읽어도 결정 제출 경로는 열리지 않는다 (C-01 §5).
   */
  async trace(requestId: string, limit?: number): Promise<HistoryEntry[]> {
    const entries = await this.#store.readHistory(limit)
    return entries.filter((entry) => entry.ref === requestId)
  }

  async #view(request: ApprovalRequest): Promise<DecisionView> {
    const overlay = await buildOverlay(request, {
      control: await this.#store.getControlState(),
      observedAt: this.#now(),
      ...(this.#scm ? { scm: this.#scm } : {}),
    })
    return assembleView(request, await assess(request, overlay, this.#scm), overlay)
  }

  async #freshness(request: ApprovalRequest): Promise<Freshness> {
    const overlay = await buildOverlay(request, {
      control: await this.#store.getControlState(),
      observedAt: this.#now(),
      ...(this.#scm ? { scm: this.#scm } : {}),
    })
    return (await assess(request, overlay, this.#scm)).freshness
  }
}
