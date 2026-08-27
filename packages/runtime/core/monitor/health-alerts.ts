// Coverage Health Escalation — 못 본 것을 못 봤다고 먼저 말한다 (C-12 §3).
//
// Coverage Health 값 자체는 B-31부터 있었다. 문제는 **사람이 `asc monitor status` 를 쳐야만
// 보인다**는 것이었다. 감시가 상시로 도는데 감시의 고장은 수동 조회로만 알 수 있으면,
// 가장 조용한 실패 모드가 남는다:
//
//   외부 소스가 죽었다 → 사건이 안 온다 → "변경 없음" 처럼 보인다
//
// **"변경 없음"과 "못 봄"을 합치지 않는다** (C-12 불변식 ⑫). 이 파일이 하는 일은 그 둘을
// 가르는 판정 하나뿐이다.
//
// 판정은 하되 **승인 요청을 만들지 않는다** (불변식 ⑬). 결과는 사람이 볼 목록이며,
// 기존 Presentation·Digest 경로로 나간다 — 새 채널도 새 상태도 만들지 않는다.
//
// 임계값은 Core 상수가 아니다 (불변식 ⑭). 호출자가 정해 넣는다.

import type { CoverageHealth } from './coverage.ts'

export type HealthAlertKind =
  /** 빠른 경로로 사건이 온 지 오래됐다. 조용한 것인지 끊긴 것인지 모른다. */
  | 'HOT_PATH_STALE'
  /** 회수 경로가 오래 돌지 않았다. 놓친 것이 쌓여 있을 수 있다. */
  | 'RECONCILE_STALE'
  /** 목록 무결성 확인이 오래됐다. */
  | 'CENSUS_STALE'
  /** 목록을 끝까지 못 보는 상태가 이어진다 — 상실 판정 자체가 서지 않는다. */
  | 'PAGINATION_INCOMPLETE'
  /** 외부 소스가 응답하지 않거나 자격이 상했다. */
  | 'SOURCE_UNHEALTHY'
  /** 한 번도 돌지 않았다. 설정만 하고 켜지 않은 상태다. */
  | 'NEVER_RAN'

export type HealthAlert = {
  kind: HealthAlertKind
  /** 사람이 읽는 한 줄. 무엇을 모르는지가 여기 있어야 한다. */
  detail: string
  /** 마지막으로 확인된 시각. 없으면 확인된 적이 없다. */
  lastAt?: string
}

export type HealthThresholds = {
  hotPathMs: number
  reconcileMs: number
  censusMs: number
}

/**
 * 지금 감시가 어디까지 성립하는가.
 *
 * **추측하지 않는다.** 사건이 안 오는 것이 조용한 것인지 끊긴 것인지 여기서 정하지 않고,
 * "오래 안 왔다"는 사실만 든다 — 사람이 그 둘을 가른다.
 */
export function evaluateHealth(
  health: CoverageHealth,
  at: string,
  thresholds: HealthThresholds,
): HealthAlert[] {
  const alerts: HealthAlert[] = []
  const now = new Date(at).getTime()
  const elapsed = (since: string | undefined): number | undefined => {
    if (!since) return undefined
    const value = now - new Date(since).getTime()
    return Number.isNaN(value) ? undefined : value
  }

  if (!health.sourceHealthy) {
    alerts.push({
      kind: 'SOURCE_UNHEALTHY',
      detail: health.detail ?? 'the external source could not be read — this is not "no changes", it is "not seen"',
      ...(health.lastHotEventAt ? { lastAt: health.lastHotEventAt } : {}),
    })
  }

  // 한 번도 안 돈 것과 오래 안 돈 것은 다르다. 전자는 설정 문제이고 후자는 운영 문제다.
  if (!health.lastHotEventAt && !health.lastReconcileAt && !health.lastCensusAt) {
    alerts.push({ kind: 'NEVER_RAN', detail: 'monitoring has never run — it was not started, or nothing triggered it' })
    return alerts
  }

  const hot = elapsed(health.lastHotEventAt)
  if (hot === undefined || hot >= thresholds.hotPathMs) {
    alerts.push({
      kind: 'HOT_PATH_STALE',
      detail:
        health.lastHotEventAt === undefined
          ? '빠른 경로로 사건이 온 적이 없다 — 조용한 것인지 끊긴 것인지 모른다'
          : `빠른 경로가 조용한 지 ${minutes(hot!)}분 — 조용한 것인지 끊긴 것인지 모른다`,
      ...(health.lastHotEventAt ? { lastAt: health.lastHotEventAt } : {}),
    })
  }

  const reconcile = elapsed(health.lastReconcileAt)
  if (reconcile === undefined || reconcile >= thresholds.reconcileMs) {
    alerts.push({
      kind: 'RECONCILE_STALE',
      detail:
        health.lastReconcileAt === undefined
          ? 'the reconcile path has never run — nothing has picked up what the fast path missed'
          : `${minutes(reconcile!)} min since the reconcile path last ran`,
      ...(health.lastReconcileAt ? { lastAt: health.lastReconcileAt } : {}),
    })
  }

  const census = elapsed(health.lastCensusAt)
  if (census === undefined || census >= thresholds.censusMs) {
    alerts.push({
      kind: 'CENSUS_STALE',
      detail:
        health.lastCensusAt === undefined
          ? 'listing integrity has never been checked'
          : `listing integrity last checked ${minutes(census!)} min ago`,
      ...(health.lastCensusAt ? { lastAt: health.lastCensusAt } : {}),
    })
  }

  // 완주하지 못한 상태에서는 상실 판정 자체가 보류된다 — 그 사실을 사람이 알아야 한다.
  if (!health.paginationComplete && (health.lastReconcileAt || health.lastCensusAt)) {
    alerts.push({
      kind: 'PAGINATION_INCOMPLETE',
      detail: 'the last listing did not complete — disappearances are not judged in this state',
    })
  }

  return alerts
}

const minutes = (ms: number): number => Math.floor(ms / 60_000)

/** 사람이 읽는 블록. 조용한 실패를 조용하게 두지 않는 것이 목적이다. */
export function healthAlertLines(alerts: readonly HealthAlert[]): string[] {
  if (alerts.length === 0) return []
  return ['Monitoring warnings:', ...alerts.map((alert) => `  [${alert.kind}] ${alert.detail}`)]
}
