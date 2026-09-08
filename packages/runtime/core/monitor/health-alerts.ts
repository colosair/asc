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

/**
 * 지금 관측이 어디까지 성립하는가 — **한 낱말로** (0.8.4).
 *
 * 고친 것은 이 모순이다:
 *
 * ```text
 * asc monitor status  연결 상태: 정상
 * asc front           [HOT_PATH_STALE] 빠른 경로가 조용한 지 1192분
 * ```
 *
 * 둘 다 참이었다. `sourceHealthy` 는 **마지막으로 돌았을 때** 외부를 읽었는가이고,
 * 그 마지막이 18시간 전이라는 사실은 그 값에 들어 있지 않다. 그런데 화면은 그것을
 * "정상" 이라고만 말했다 — 관측이 18시간 멈춘 자리에서 사람이 읽을 수 있는 가장 나쁜
 * 낱말이다. "변경 없음" 과 "못 봄" 을 합치지 않는다는 이 파일의 불변식(⑫)이 정작
 * 화면 한 줄에서 깨져 있었다.
 *
 * ```text
 * UNKNOWN      한 번도 돌지 않았다
 * NOT_RUNNING  돌 것이 없다 — 이 기계에 상시 등록이 없다
 * DEGRADED     마지막 시도에서 외부를 읽지 못했다
 * STALE        읽기는 됐는데 너무 오래됐다 — 지금 상태를 안다고 말할 수 없다
 * HEALTHY      최근에 돌았고 읽혔다
 * ```
 */
export type ObservationState = 'HEALTHY' | 'STALE' | 'NOT_RUNNING' | 'DEGRADED' | 'UNKNOWN'

export type ObservationVerdict = {
  state: ObservationState
  /** 왜 그 상태인가. 사람이 그대로 읽는다. */
  detail: string
  /** 이 판정을 만든 경고들. 비어 있으면 막는 것이 없다. */
  alerts: readonly HealthAlert[]
}

/** 이 판정을 STALE 로 만드는 경고들. 나머지는 경고이되 최신성의 문제는 아니다. */
const STALENESS: ReadonlySet<HealthAlertKind> = new Set(['HOT_PATH_STALE', 'RECONCILE_STALE', 'CENSUS_STALE'])

/**
 * 경고 목록 하나를 상태 하나로 접는다.
 *
 * **판정 순서가 곧 의미다**: 한 번도 안 돈 것 → 돌 것이 없는 것 → 읽지 못한 것 →
 * 오래된 것. 뒤엣것으로 앞엣것을 덮으면 사람이 할 일이 뒤바뀐다.
 *
 * `registered` 는 이 기계에 상시 등록이 있는가다. 없는데 오래됐으면 그것은 운영 사고가
 * 아니라 **애초에 도는 것이 없는 상태**이고, 그 둘은 사람이 할 일이 다르다.
 */
export function observationState(
  alerts: readonly HealthAlert[],
  options: { registered?: boolean } = {},
): ObservationVerdict {
  const never = alerts.find((alert) => alert.kind === 'NEVER_RAN')
  if (never) return { state: 'UNKNOWN', detail: never.detail, alerts }

  const stale = alerts.filter((alert) => STALENESS.has(alert.kind))
  if (options.registered === false && stale.length > 0) {
    return {
      state: 'NOT_RUNNING',
      detail: `${stale[0]!.detail} — 이 기계에 상시 등록이 없어 스스로 다시 돌지 않는다 (asc runtime service status)`,
      alerts,
    }
  }

  const unhealthy = alerts.find((alert) => alert.kind === 'SOURCE_UNHEALTHY')
  if (unhealthy) return { state: 'DEGRADED', detail: unhealthy.detail, alerts }

  if (stale.length > 0) return { state: 'STALE', detail: stale[0]!.detail, alerts }

  const incomplete = alerts.find((alert) => alert.kind === 'PAGINATION_INCOMPLETE')
  if (incomplete) return { state: 'DEGRADED', detail: incomplete.detail, alerts }

  return { state: 'HEALTHY', detail: '최근에 돌았고 외부를 읽었다', alerts }
}

/** 사람이 읽는 블록. 조용한 실패를 조용하게 두지 않는 것이 목적이다. */
export function healthAlertLines(alerts: readonly HealthAlert[]): string[] {
  if (alerts.length === 0) return []
  return ['Monitoring warnings:', ...alerts.map((alert) => `  [${alert.kind}] ${alert.detail}`)]
}
