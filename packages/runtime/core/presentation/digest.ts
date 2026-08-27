// Digest Coordinator — 감지와 방해를 분리한다 (C-08).
//
// 빨리 감지하는 것과 사람을 지금 끊는 것은 다른 결정이다. 지금까지 둘이 붙어 있었고, 그래서
// 실시간 감지를 켜면 새 사건마다 작업 흐름이 끊겼다. 문제는 감지 속도가 아니라 전달 방식이다.
//
// **Monitor 밖이다.** Monitor의 write 경계는 자기 계약 파일·inbox entity·log뿐이고(OM §10.7),
// 전달은 그 밖이다. 여기서 패킷을 만들지 않는다 — 이미 만들어진 것을 언제 어디로 건넬지만 정한다.
//
// 패킷 생성은 미루지 않는다. 미루면 그 사건은 재시도 대기로 남아 다음 회차가 같은 조사를
// 다시 하게 되고, 미완료와 보류가 구분되지 않는다 (C-08 §2.2).

import { z } from 'zod'

import { healthAlertLines, type HealthAlert } from '../monitor/health-alerts.ts'
import type { DecisionSummary } from '../view/decision-view.ts'
import type { DigestBatch, DeliveryOutcome, PresentationPort } from '../../ports/presentation.ts'
import type { ScopedStore } from '../../ports/state-store.ts'

export type DigestInput = {
  at: string
  /** 판단 대기 중인 것들. LocalOperator가 이미 우선순위·freshness를 붙여 준다. */
  pending: readonly DecisionSummary[]
  /** 숨겨 두고 보는 것의 수 (C-07 §5). 숫자만 알려도 무엇을 못 보고 있는지 안다. */
  shadowCount?: number
  /** 회수 경로에서 발견된 수. coverage 정보이며 우선순위와 무관하다 (C-07 §1.6). */
  recoveredCount?: number
  /** 이미 보낸 것 — requestId → 그때 version. 같은 것을 두 번 묶어 보내지 않는다. */
  delivered?: ReadonlyMap<string, number>
  /**
   * 감시 자체의 경고 (C-12 §3). Core가 판정하지 않는다 — 판정은 evaluateHealth가 하고
   * 여기는 그 결과를 함께 실어 나른다.
   */
  health?: readonly HealthAlert[]
}

export type DigestPlan = {
  /** 지금 끊어야 하는 것. P0만이다. */
  urgent: DecisionSummary[]
  /** 묶어서 건넬 것. */
  batch: DigestBatch
  /** 보내지 않은 것과 그 이유. 조용히 빠지면 사람이 왜 안 보였는지 알 수 없다. */
  skipped: { alreadyDecided: number; alreadyDelivered: number; shadow: number }
  /**
   * 감시 자체의 상태 (C-12 §3). 판단 요청이 아니라 **"지금 이 목록을 믿어도 되는가"** 다.
   * 비어 있지 않으면 목록이 조용한 이유가 조용해서가 아닐 수 있다.
   */
  health: HealthAlert[]
}

/**
 * 무엇을 지금 건네고 무엇을 묶을지 정한다.
 *
 * 간격·주기는 여기 없다. 그건 설정이고 실행 계기는 밖에 있다 (C-08 §2.3) — 프로젝트마다
 * 다르고 같은 프로젝트에서도 시기마다 다르다.
 */
export function planDigest(input: DigestInput): DigestPlan {
  const urgent: DecisionSummary[] = []
  const p1: DecisionSummary[] = []
  const p2: DecisionSummary[] = []
  const health = input.health ?? []
  const skipped = { alreadyDecided: 0, alreadyDelivered: 0, shadow: input.shadowCount ?? 0 }

  for (const item of input.pending) {
    // 이미 결정된 것은 판단 요청이 아니다. freshness가 그 사실을 들고 있다 (C-01 §7).
    if (item.freshness === 'ALREADY_DECIDED') {
      skipped.alreadyDecided++
      continue
    }
    // 같은 판(version)을 다시 보내지 않는다. 바뀌었으면 다시 보낸다 — 그건 새 사실이다.
    if (input.delivered?.get(item.requestId) === item.version) {
      skipped.alreadyDelivered++
      continue
    }

    if (item.priority === 'P0') urgent.push(item)
    else if (item.priority === 'P1') p1.push(item)
    else p2.push(item)
  }

  const groups: DigestBatch['groups'] = [
    ...(urgent.length > 0 ? [{ priority: 'P0' as const, items: urgent }] : []),
    ...(p1.length > 0 ? [{ priority: 'P1' as const, items: p1 }] : []),
    ...(p2.length > 0 ? [{ priority: 'P2' as const, items: p2 }] : []),
  ]

  return {
    health: [...health],
    urgent,
    batch: {
      at: input.at,
      groups,
      suppressed: { shadow: skipped.shadow, alreadyDecided: skipped.alreadyDecided },
      ...(input.recoveredCount ? { recovered: input.recoveredCount } : {}),
    },
    skipped,
  }
}

const LABEL: Record<string, string> = { P0: '🔴 지금 확인 필요', P1: '🟡 판단 필요', P2: '🔵 참고' }

/**
 * 사람이 먼저 봐야 할 것은 **몇 건이 있고 그중 지금 정해야 할 것이 무엇인가**다 (C-08 §2.4).
 * 걸러진 것도 숫자로 남긴다 — 0으로 감추면 걸러졌다는 사실 자체가 사라진다.
 */
export function renderDigest(plan: DigestPlan): string[] {
  const lines = [`ASC · ${plan.batch.at}`]
  for (const group of plan.batch.groups) {
    lines.push(`${LABEL[group.priority] ?? group.priority} ${group.items.length}`)
    for (const item of group.items) {
      lines.push(`  ${item.requestId}  ${item.reference}  ${item.title}`)
      // 묶은 뒤 변한 것은 새 값을 만들지 않고 freshness 4종으로 말한다 (C-08 §3.3).
      if (item.freshness !== 'CURRENT') lines.push(`    (${item.freshness})`)
    }
  }
  // 목록보다 먼저 온다. 감시가 고장 났으면 "건넬 것이 없다"는 사실이 아니다.
  for (const line of healthAlertLines(plan.health)) lines.push(line)
  if (plan.skipped.shadow > 0) lines.push(`⚪ 숨김 ${plan.skipped.shadow} (관련 근거 없음 — 계속 본다)`)
  if (plan.skipped.alreadyDecided > 0) lines.push(`⚪ 이미 결정됨 ${plan.skipped.alreadyDecided}`)
  if (plan.skipped.alreadyDelivered > 0) lines.push(`⚪ 이미 보냄 ${plan.skipped.alreadyDelivered}`)
  if (plan.batch.recovered) lines.push(`↺ 회수 경로에서 발견 ${plan.batch.recovered}`)
  if (plan.batch.groups.length === 0) {
    // "변경 없음"과 "못 봄"을 합치지 않는다 (C-12 불변식 ⑫)
    lines.push(plan.health.length > 0 ? '건넬 것이 없다 — 다만 위 경고를 먼저 보라.' : '건넬 것이 없다.')
  }
  return lines
}

// ── 전달 기록 ────────────────────────────────────────────────────────────────

export const Delivery = z.object({
  requestId: z.string().min(1),
  version: z.number().int().nonnegative(),
  channel: z.string().min(1),
  externalRef: z.string().optional(),
  at: z.string().min(1),
})
export type Delivery = z.infer<typeof Delivery>

/**
 * 어느 request를 어느 채널에 언제 보냈는가.
 *
 * **Core Entity가 아니다** (C-01 §9, C-02 §3) — 정본이 아니고, 전달은 best-effort이며,
 * 실패가 canonical state에 영향을 주면 안 된다. 그래서 adapter-scope에 둔다.
 */
export class DeliveryLedger {
  #scope: ScopedStore
  #now: () => string

  constructor(scope: ScopedStore, now: () => string = () => new Date().toISOString()) {
    this.#scope = scope
    this.#now = now
  }

  async record(requestId: string, version: number, channel: string, externalRef?: string): Promise<void> {
    await this.#scope.set(
      `sent:${channel}:${requestId}`,
      JSON.stringify(
        Delivery.parse({ requestId, version, channel, ...(externalRef ? { externalRef } : {}), at: this.#now() }),
      ),
    )
  }

  /** 이 채널에 무엇을 어느 판으로 보냈는가. */
  async delivered(channel: string): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    for (const key of await this.#scope.keys(`sent:${channel}:`)) {
      const raw = await this.#scope.get(key)
      if (raw) {
        const record = Delivery.parse(JSON.parse(raw))
        out.set(record.requestId, record.version)
      }
    }
    return out
  }
}

// ── 전달 ─────────────────────────────────────────────────────────────────────

export type DeliveryReport = {
  channel: string
  digest?: DeliveryOutcome
  urgent: { requestId: string; outcome: DeliveryOutcome }[]
  /** 능력이 없어 아래로 내린 것. 조용히 무시하지 않는다 (C-08 §1.3). */
  degraded: string[]
}

/**
 * 건넨다. 채널이 능력을 다 갖추지 못하면 **그 기능만 내려간다** — 급한 것을 따로 보낼 수
 * 없으면 묶음에 실어 보내고, 그 사실을 적는다.
 */
export async function deliver(
  plan: DigestPlan,
  channel: PresentationPort,
  ledger?: DeliveryLedger,
): Promise<DeliveryReport> {
  const report: DeliveryReport = { channel: channel.id, urgent: [], degraded: [] }

  if (channel.capabilities.has('presentation.priority') && channel.presentUrgent) {
    for (const item of plan.urgent) {
      const outcome = await channel.presentUrgent(item)
      report.urgent.push({ requestId: item.requestId, outcome })
      if (outcome.ok) await ledger?.record(item.requestId, item.version, channel.id, outcome.externalRef)
    }
  } else if (plan.urgent.length > 0) {
    report.degraded.push(
      `${channel.id} 는 급한 건을 따로 전달하지 못한다 — ${plan.urgent.length}건을 묶음에 실었다`,
    )
  }

  if (!channel.capabilities.has('presentation.digest')) {
    report.degraded.push(`${channel.id} 는 묶음을 전달하지 못한다`)
    return report
  }

  report.digest = await channel.presentDigest(plan.batch)
  if (report.digest.ok && ledger) {
    for (const group of plan.batch.groups) {
      for (const item of group.items) {
        await ledger.record(item.requestId, item.version, channel.id, report.digest.externalRef)
      }
    }
  }
  return report
}
