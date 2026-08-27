// B-54 Gate — "변경 없음"과 "못 봄"을 합치지 않는다 (C-12 §3).
//
// 가장 조용한 실패 모드는 이것이다: 외부 소스가 죽는다 → 사건이 안 온다 → 화면은
// "건넬 것이 없다" 라고 말한다. 그 순간 감시는 켜져 있는 척만 한다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CoverageHealth } from '../core/monitor/coverage.ts'
import { evaluateHealth, healthAlertLines, type HealthAlert } from '../core/monitor/health-alerts.ts'
import { planDigest, renderDigest } from '../core/presentation/digest.ts'

const NOW = '2026-08-26T12:00:00.000Z'
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const THRESHOLDS = { hotPathMs: 6 * HOUR, reconcileMs: 24 * HOUR, censusMs: 7 * 24 * HOUR }

const ago = (ms: number) => new Date(new Date(NOW).getTime() - ms).toISOString()

const healthy = (over: Partial<CoverageHealth> = {}): CoverageHealth =>
  CoverageHealth.parse({
    lastHotEventAt: ago(10 * MINUTE),
    lastReconcileAt: ago(HOUR),
    lastCensusAt: ago(24 * HOUR),
    paginationComplete: true,
    sourceHealthy: true,
    ...over,
  })

const kinds = (alerts: readonly HealthAlert[]) => alerts.map((a) => a.kind).sort()

describe('B-54 Gate — 감시가 성립하는지 판정한다', () => {
  it('전부 최근이면 경고가 없다', () => {
    assert.deepEqual(evaluateHealth(healthy(), NOW, THRESHOLDS), [])
  })

  it('한 번도 안 돈 것과 오래 안 돈 것을 구분한다', () => {
    const never = evaluateHealth(CoverageHealth.parse({}), NOW, THRESHOLDS)
    assert.deepEqual(kinds(never), ['NEVER_RAN'], '설정 문제와 운영 문제를 섞지 않는다')

    const stale = evaluateHealth(healthy({ lastHotEventAt: ago(8 * HOUR) }), NOW, THRESHOLDS)
    assert.deepEqual(kinds(stale), ['HOT_PATH_STALE'])
  })

  it('빠른 경로가 조용한 것을 "변경 없음"으로 읽지 않는다', () => {
    const [alert] = evaluateHealth(healthy({ lastHotEventAt: ago(9 * HOUR) }), NOW, THRESHOLDS)
    assert.equal(alert!.kind, 'HOT_PATH_STALE')
    assert.match(alert!.detail, /조용한 것인지 끊긴 것인지 모른다/)
  })

  it('외부 소스가 죽었으면 그것부터 말한다', () => {
    const alerts = evaluateHealth(healthy({ sourceHealthy: false, detail: '401 Unauthorized' }), NOW, THRESHOLDS)
    assert.equal(alerts[0]!.kind, 'SOURCE_UNHEALTHY')
    assert.match(alerts[0]!.detail, /401/)
  })

  it('회수·목록 확인이 오래되면 각각 잡는다', () => {
    const alerts = evaluateHealth(
      healthy({ lastReconcileAt: ago(30 * HOUR), lastCensusAt: ago(8 * 24 * HOUR) }),
      NOW,
      THRESHOLDS,
    )
    assert.deepEqual(kinds(alerts), ['CENSUS_STALE', 'RECONCILE_STALE'])
  })

  it('끝까지 못 본 상태가 이어지면 상실 판정이 서지 않는다고 말한다', () => {
    const alerts = evaluateHealth(healthy({ paginationComplete: false }), NOW, THRESHOLDS)
    assert.deepEqual(kinds(alerts), ['PAGINATION_INCOMPLETE'])
    assert.match(alerts[0]!.detail, /disappearances are not judged/)
  })

  it('한 번도 안 돌았으면 pagination 경고를 겹쳐 내지 않는다', () => {
    const alerts = evaluateHealth(CoverageHealth.parse({ paginationComplete: false }), NOW, THRESHOLDS)
    assert.deepEqual(kinds(alerts), ['NEVER_RAN'], '같은 사실을 두 번 말하지 않는다')
  })

  it('임계값은 호출자가 정한다 — Core 상수가 아니다', () => {
    const health = healthy({ lastHotEventAt: ago(2 * HOUR) })
    assert.deepEqual(evaluateHealth(health, NOW, THRESHOLDS), [])
    assert.deepEqual(
      kinds(evaluateHealth(health, NOW, { ...THRESHOLDS, hotPathMs: HOUR })),
      ['HOT_PATH_STALE'],
    )
  })
})

describe('B-54 Gate — 묶음이 조용한 이유를 말한다 (C-12 불변식 ⑫)', () => {
  it('건넬 것이 없어도 경고가 있으면 그렇게 말한다', () => {
    const alerts = evaluateHealth(healthy({ sourceHealthy: false, detail: '연결 실패' }), NOW, THRESHOLDS)
    const plan = planDigest({ at: NOW, pending: [], health: alerts })
    const rendered = renderDigest(plan).join('\n')

    assert.match(rendered, /Monitoring warnings/)
    assert.match(rendered, /위 경고를 먼저 보라/)
  })

  it('경고가 없으면 예전처럼 조용히 끝난다', () => {
    const plan = planDigest({ at: NOW, pending: [] })
    const rendered = renderDigest(plan).join('\n')

    assert.doesNotMatch(rendered, /Monitoring warnings/)
    assert.match(rendered, /건넬 것이 없다\./)
  })

  it('경고는 판단 요청이 아니다 — 승인 대기 목록을 만들지 않는다', () => {
    const alerts = evaluateHealth(CoverageHealth.parse({}), NOW, THRESHOLDS)
    const plan = planDigest({ at: NOW, pending: [], health: alerts })

    assert.equal(plan.urgent.length, 0)
    assert.equal(plan.batch.groups.length, 0)
    assert.equal(plan.health.length, 1)
  })

  it('사람이 읽는 블록은 경고가 없으면 아무 줄도 만들지 않는다', () => {
    assert.deepEqual(healthAlertLines([]), [])
  })
})
