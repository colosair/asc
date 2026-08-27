// Coverage Ledger — 빠른 경로가 놓친 것을 찾기 위해 "지난번엔 이랬다"를 남긴다 (C-07 §1).
//
// Delta(빠른 경로)는 놓치면 그대로 놓친다. webhook이 유실되고, 지정이 빠지고, 닫힌 뒤에
// 달린 댓글은 알림이 오지 않는다. 그래서 주기적으로 목록을 다시 세어 본다.
//
// **event 스트림을 재생하지 않는다** (C-07 §1.4). 매 회차 같은 객체를 새 key로 올리면
// 회차마다 새 패킷이 된다. reference 하나의 상태를 지난번과 비교해 **달라진 것만** 올린다.
//
// Observation Ledger(observation.ts)와 나누는 이유: 저쪽은 "이 사건을 사람에게 올릴까"이고
// 이쪽은 "이 리소스가 지난번과 달라졌나"다. 하나는 판단이고 하나는 관측 사실이다.

import { z } from 'zod'

import type { InventoryItem } from '../../ports/inventory.ts'
import type { ScopedStore } from '../../ports/state-store.ts'

export const CoverageRecord = z.object({
  reference: z.string().min(1),
  state: z.string(),
  revisionMarker: z.string(),
  updatedAt: z.string(),
  /** 마지막으로 목록에서 본 시각. missing 판정의 기준이 된다. */
  seenAt: z.string().min(1),
})
export type CoverageRecord = z.infer<typeof CoverageRecord>

/**
 * 지금까지 어디까지 확인했는가 (C-07 §8.2). **100% 보장을 대신하는 값이 아니라, 무엇을
 * 확인했고 무엇을 모르는지 사람이 볼 수 있게 하는 값이다.**
 */
export const CoverageHealth = z.object({
  lastHotEventAt: z.string().optional(),
  lastReconcileAt: z.string().optional(),
  lastCensusAt: z.string().optional(),
  /** 이 시각까지의 변경은 회수했다고 보는 기준선. */
  coverageWatermark: z.string().optional(),
  /**
   * 마지막 열거가 목록을 빠짐없이 훑었는가. **모르면 false다** — 이 값이 false인 열거로
   * missing을 판정하면 없는 상실을 만들어낸다.
   */
  paginationComplete: z.boolean().default(false),
  sourceHealthy: z.boolean().default(true),
  /** 마지막 실패 이유. 상태만 주면 고칠 수가 없다. */
  detail: z.string().optional(),
})
export type CoverageHealth = z.infer<typeof CoverageHealth>

const recordKey = (reference: string) => `cov:${reference}`
const HEALTH_KEY = 'coverage-health'

export type SweepKind = 'reconcile' | 'census'

export type CoverageDiff =
  /** 처음 보는 리소스. */
  | { kind: 'NEW'; item: InventoryItem }
  /** 지난번과 달라졌다. */
  | { kind: 'CHANGED'; item: InventoryItem; previous: CoverageRecord }
  /**
   * 알고 있었는데 이번 목록에 없다. **원인을 추측하지 않는다** (C-07 §1.5) —
   * 삭제일 수도, 권한·가시성 변화일 수도, filter나 provider 오류일 수도 있다.
   */
  | { kind: 'RESOURCE_MISSING'; reference: string; previous: CoverageRecord }

export class CoverageLedger {
  #scope: ScopedStore
  #now: () => string

  constructor(scope: ScopedStore, now: () => string = () => new Date().toISOString()) {
    this.#scope = scope
    this.#now = now
  }

  async get(reference: string): Promise<CoverageRecord | null> {
    const raw = await this.#scope.get(recordKey(reference))
    return raw ? CoverageRecord.parse(JSON.parse(raw)) : null
  }

  async list(): Promise<CoverageRecord[]> {
    const out: CoverageRecord[] = []
    for (const key of await this.#scope.keys('cov:')) {
      const raw = await this.#scope.get(key)
      if (raw) out.push(CoverageRecord.parse(JSON.parse(raw)))
    }
    return out.sort((a, b) => a.reference.localeCompare(b.reference))
  }

  /** 이번에 본 모습을 남긴다. 빠른 경로도 이걸 갱신해야 회수 경로가 같은 것을 또 올리지 않는다. */
  async record(item: {
    reference: string
    state?: string
    revisionMarker: string
    updatedAt?: string
  }): Promise<void> {
    const at = this.#now()
    await this.#scope.set(
      recordKey(item.reference),
      JSON.stringify(
        CoverageRecord.parse({
          reference: item.reference,
          state: item.state ?? '',
          revisionMarker: item.revisionMarker,
          updatedAt: item.updatedAt ?? at,
          seenAt: at,
        }),
      ),
    )
  }

  /** 이번 목록과 지난 기록을 견준다. 달라진 것만 돌려준다. */
  async diff(items: readonly InventoryItem[]): Promise<CoverageDiff[]> {
    const out: CoverageDiff[] = []
    for (const item of items) {
      const previous = await this.get(item.reference)
      if (!previous) {
        out.push({ kind: 'NEW', item })
        continue
      }
      // marker가 실질 변화의 정본이다. state는 보조 — 빠른 경로가 남긴 기록에는 상태가
      // 없을 수 있고(알림에는 목록 상태가 안 실린다), 그것을 "달라졌다"로 읽으면 같은
      // 변화로 패킷이 둘 생긴다.
      const stateChanged = previous.state !== '' && previous.state !== item.state
      if (previous.revisionMarker !== item.revisionMarker || stateChanged) {
        out.push({ kind: 'CHANGED', item, previous })
      }
    }
    return out
  }

  /**
   * 알던 것 중 이번 목록에 없는 것.
   *
   * **빠짐없이 훑은 열거에서만 판정한다.** 페이지를 다 돌지 못한 목록으로 비교하면
   * 멀쩡한 리소스가 사라졌다고 나온다.
   */
  async missing(seen: ReadonlySet<string>, paginationComplete: boolean): Promise<CoverageDiff[]> {
    if (!paginationComplete) return []
    return (await this.list())
      .filter((record) => !seen.has(record.reference))
      .map((previous) => ({ kind: 'RESOURCE_MISSING' as const, reference: previous.reference, previous }))
  }

  async health(): Promise<CoverageHealth> {
    const raw = await this.#scope.get(HEALTH_KEY)
    return raw ? CoverageHealth.parse(JSON.parse(raw)) : CoverageHealth.parse({})
  }

  async updateHealth(patch: Partial<CoverageHealth>): Promise<CoverageHealth> {
    const merged = CoverageHealth.parse({ ...(await this.health()), ...patch })
    await this.#scope.set(HEALTH_KEY, JSON.stringify(merged))
    return merged
  }
}

/**
 * 사람이 읽는 상태. **"100% 감지 보장"이라고 쓰지 않는다** (C-07 §8.1) — provider 장애·자격
 * 문제·전달 실패·가시성 변화 중 어느 것도 ASC가 통제하지 못한다.
 */
export function renderHealth(sourceId: string, health: CoverageHealth): string[] {
  const or = (value: string | undefined) => value ?? '(없음)'
  return [
    `${sourceId}`,
    `  빠른 경로 마지막 사건: ${or(health.lastHotEventAt)}`,
    `  마지막 대조(reconcile): ${or(health.lastReconcileAt)}`,
    `  마지막 전수(census):    ${or(health.lastCensusAt)}`,
    `  확인 기준선:            ${or(health.coverageWatermark)}`,
    `  목록 완주:              ${health.paginationComplete ? '예' : '아니오 (이 상태로는 상실을 판정하지 않는다)'}`,
    `  연결 상태:              ${health.sourceHealthy ? '정상' : `이상 — ${or(health.detail)}`}`,
  ]
}
