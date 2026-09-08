// 0.8.4 — ASC 가 실제 일을 자기 lifecycle 안으로 받아들이지 못한 자리들.
//
// 전수조사에서 나온 결함들을 그 결함이 실제로 났던 모양 그대로 고정한다. 여기 있는 숫자와
// 참조는 지어낸 것이 아니라 실기계 기록에서 온 것이다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ApprovalRequest } from '../core/model/entities.ts'
import { transitionRequest, TransitionError } from '../core/model/transitions.ts'
import { decisionSubject, judgeReconcile, readOrigin, supersedes } from '../core/approval/reconcile.ts'
import { evaluateHealth, observationState } from '../core/monitor/health-alerts.ts'
import { judgePhysicalId } from '../adapters/claude-code/identity.ts'
import type { ResourceSnapshot } from '../ports/resource-context.ts'

const AT = '2026-09-08T02:00:00.000Z'

function request(patch: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return ApprovalRequest.parse({
    id: 'REQ-0010',
    version: 0,
    status: 'AWAITING_APPROVAL',
    type: 'actionable',
    priority: 'P0',
    title: '[back,front] Project 좋아요 쓰기 endpoint 구현 통보',
    detectedAt: '2026-09-07T08:22:57.347Z',
    source: {
      eventKey: 'todo:767486:2026-09-07T08:22:57.347Z',
      reference: 'group/project#122',
      subject: 'group/project#122|actionable|mentioned_me',
    },
    situation: 'mentioned_me',
    impact: { interruptRequired: true, affectedSessions: [], rationale: 'actionable/P0' },
    authorizedApprover: 'colosair',
    allowedDecisions: ['approve', 'dismiss'],
    ...patch,
  })
}

function snapshot(patch: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
  return {
    reference: 'group/project#122',
    state: 'opened',
    title: 'Project 좋아요 쓰기 endpoint',
    updatedAt: '2026-09-07T08:22:58.235Z',
    revisionMarker: 'm1',
    ...patch,
  }
}

describe('C-3 — Inbox 는 원본의 지금 상태와 맞는다', () => {
  // 실측: #122 가 닫힌 시각 17:22:58.235, 그 이슈로 만들어진 REQ-0010 의 감지 시각
  // 17:22:57.347. 요청은 태어날 때 이미 낡아 있었고 17시간 뒤 사람이 손으로 치웠다.
  it('원본이 끝나 있으면 결정 대기로 남기지 않는다', () => {
    const verdict = judgeReconcile(request(), {
      kind: 'READ',
      snapshot: snapshot({ state: 'closed', settled: true }),
      at: AT,
    })
    assert.equal(verdict.kind, 'OBSOLETE')
    assert.equal(verdict.kind === 'OBSOLETE' && verdict.reason, 'ORIGIN_SETTLED')
    assert.match(
      verdict.kind === 'OBSOLETE' ? verdict.evidence : '',
      /작업이 끝났다는 뜻은 아니다/,
      '"내 몫이 끝났다" 와 "원본이 닫혔다" 를 같은 말로 적지 않는다',
    )
  })

  it('열려 있으면 그대로 선다', () => {
    const verdict = judgeReconcile(request(), { kind: 'READ', snapshot: snapshot({ settled: false }), at: AT })
    assert.equal(verdict.kind, 'STANDS')
  })

  it('provider 가 settled 를 모르면 그것으로 지우지 않는다', () => {
    const verdict = judgeReconcile(request(), { kind: 'READ', snapshot: snapshot(), at: AT })
    assert.equal(verdict.kind, 'STANDS', 'undefined 는 "열려 있다" 도 "닫혔다" 도 아니다')
  })

  it('못 읽은 것을 최신으로 치지 않는다', () => {
    const unreadable = judgeReconcile(request(), { kind: 'UNREADABLE', detail: 'no token', at: AT })
    assert.equal(unreadable.kind, 'UNKNOWN')
    const gone = judgeReconcile(request(), { kind: 'READ', snapshot: snapshot({ missing: true }), at: AT })
    assert.equal(gone.kind, 'UNKNOWN', '목록에서 사라진 것은 삭제·권한·가시성·오류 중 무엇인지 모른다')
  })

  it('이미 사람이 결정한 것 위에 관측을 덮지 않는다', () => {
    const decided = request({
      status: 'DISMISSED',
      decision: { kind: 'dismiss', actor: 'colosair', channel: 'local', decidedAt: AT },
    })
    const verdict = judgeReconcile(decided, {
      kind: 'READ',
      snapshot: snapshot({ state: 'closed', settled: true }),
      at: AT,
    })
    assert.equal(verdict.kind, 'STANDS')
  })

  it('OBSOLETE 는 근거 없이 갈 수 없고, 사람의 결정을 흉내 내지 않는다', () => {
    assert.throws(
      () => transitionRequest(request(), 'OBSOLETE', 'monitor'),
      (error: unknown) => error instanceof TransitionError && error.reason === 'MISSING_REQUIREMENT',
    )
    assert.throws(
      () =>
        transitionRequest(request(), 'OBSOLETE', 'controller', {
          obsolete: { reason: 'ORIGIN_SETTLED', evidence: 'closed', observedAt: AT },
        }),
      (error: unknown) => error instanceof TransitionError && error.reason === 'FORBIDDEN_ACTOR',
      'Controller 가 이 칸을 쓰면 그것은 dismiss 를 다른 이름으로 부르는 것이다',
    )
    const moved = transitionRequest(request(), 'OBSOLETE', 'monitor', {
      obsolete: { reason: 'ORIGIN_SETTLED', evidence: 'closed', observedAt: AT },
    })
    assert.equal(moved.status, 'OBSOLETE')
    assert.equal(moved.decision, undefined, '아무도 결정하지 않았다는 사실이 남는다')
  })
})

describe('C-5 — 같은 사람 결정을 두 번 묻지 않는다', () => {
  // 실측: GitLab #131 하나에 REQ-0003(07:37) 과 REQ-0012(15:06) 가 생겼고, 사람은
  // 1.2초 간격으로 같은 처분을 두 번 내렸다. eventKey 는 전송 중복만 막는다.
  it('같은 자원·같은 성격·같은 신호는 같은 물음이다', () => {
    const a = decisionSubject({ reference: 'group/project#131', type: 'actionable', signals: ['mentioned_me'] })
    const b = decisionSubject({ reference: 'group/project#131', type: 'actionable', signals: ['mentioned_me'] })
    assert.equal(a, b)
  })

  it('신호가 다르면 다른 물음이다 — 억지로 합치지 않는다', () => {
    const mention = decisionSubject({ reference: 'group/project#131', type: 'actionable', signals: ['mentioned_me'] })
    const review = decisionSubject({
      reference: 'group/project#131',
      type: 'actionable',
      signals: ['review_requested'],
    })
    assert.notEqual(mention, review, '한 스레드 안에 서로 다른 결정이 설 수 있다')
  })

  it('신호 순서는 물음을 바꾸지 않는다', () => {
    assert.equal(
      decisionSubject({ reference: 'x#1', type: 'work', signals: ['b', 'a'] }),
      decisionSubject({ reference: 'x#1', type: 'work', signals: ['a', 'b'] }),
    )
  })

  it('더 새로운 것만 옛것을 대신한다', () => {
    const older = request({ id: 'REQ-0003', detectedAt: '2026-09-06T22:37:31.601Z' })
    assert.equal(supersedes({ subject: older.source.subject!, detectedAt: '2026-09-07T06:06:20.568Z' }, older), true)
    assert.equal(
      supersedes({ subject: older.source.subject!, detectedAt: '2026-09-06T00:00:00.000Z' }, older),
      false,
      '회수 경로가 늦게 찾은 옛 사건이 최신 물음을 밀어내면 사람이 보는 것이 뒤로 간다',
    )
  })

  it('이미 결정된 것은 대신되지 않는다', () => {
    const decided = request({
      id: 'REQ-0003',
      status: 'DISMISSED',
      decision: { kind: 'dismiss', actor: 'colosair', channel: 'local', decidedAt: AT },
    })
    assert.equal(supersedes({ subject: decided.source.subject!, detectedAt: AT }, decided), false)
  })

  it('subject 가 없는 옛 요청은 건드리지 않는다', () => {
    const legacy = request({ source: { eventKey: 'todo:1:x', reference: 'group/project#131' } })
    assert.equal(supersedes({ subject: 'group/project#131|actionable|', detectedAt: AT }, legacy), false)
  })
})

describe('C-4 — 관측 상태를 한 낱말로 말한다', () => {
  // 실측: asc monitor status 는 "연결 상태: 정상", 같은 시각 asc front 는
  // "[HOT_PATH_STALE] 빠른 경로가 조용한 지 1192분". 둘 다 참이었고 화면만 갈렸다.
  const thresholds = { hotPathMs: 6 * 60 * 60_000, reconcileMs: 24 * 60 * 60_000, censusMs: 7 * 24 * 60 * 60_000 }
  const stale = {
    lastHotEventAt: '2026-09-07T08:22:58.343Z',
    lastReconcileAt: '2026-09-07T08:22:58.343Z',
    lastCensusAt: '2026-09-07T04:39:03.861Z',
    paginationComplete: true,
    sourceHealthy: true,
  }

  it('마지막 시도가 성공했어도 18시간 멈춘 것은 정상이 아니다', () => {
    const alerts = evaluateHealth(stale, AT, thresholds)
    const verdict = observationState(alerts, { registered: true })
    assert.equal(verdict.state, 'STALE')
    assert.match(verdict.detail, /빠른 경로/)
  })

  it('상시 등록이 없으면 그것은 운영 사고가 아니라 도는 것이 없는 상태다', () => {
    const verdict = observationState(evaluateHealth(stale, AT, thresholds), { registered: false })
    assert.equal(verdict.state, 'NOT_RUNNING')
    assert.match(verdict.detail, /상시 등록이 없어/)
  })

  it('한 번도 안 돈 것은 오래된 것과 다르다', () => {
    const verdict = observationState(evaluateHealth({ paginationComplete: true, sourceHealthy: true }, AT, thresholds))
    assert.equal(verdict.state, 'UNKNOWN')
  })

  it('읽지 못한 것은 오래된 것보다 먼저 말한다', () => {
    const verdict = observationState(
      evaluateHealth({ ...stale, sourceHealthy: false, detail: '자격 만료' }, AT, thresholds),
      { registered: true },
    )
    assert.equal(verdict.state, 'DEGRADED')
    assert.match(verdict.detail, /자격 만료/)
  })

  it('최근에 돌고 읽혔으면 HEALTHY 다', () => {
    const verdict = observationState(
      evaluateHealth({ ...stale, lastHotEventAt: AT, lastReconcileAt: AT, lastCensusAt: AT }, AT, thresholds),
      { registered: true },
    )
    assert.equal(verdict.state, 'HEALTHY')
  })
})

describe('C-8 — 결합이 가리키는 것과 Guard 가 찾는 것이 같다', () => {
  // 실측: --physical windows-worker-57 로 묶인 결합을 guard 는 영영 찾지 못했다.
  // guard 는 hook payload 의 session_id 로만 찾는다.
  const RUN = 'f44a9a81-b331-499a-8264-9a269f5767d7'
  const OTHER = '11111111-2222-4333-8444-555555555555'

  it('사람이 붙인 라벨은 신원이 아니다', () => {
    const verdict = judgePhysicalId({ provided: 'windows-worker-57', observed: RUN })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.ok === false && verdict.reason, 'NOT_A_RUN_ID')
    assert.equal(verdict.ok === false && verdict.observed, RUN, '무엇을 써야 하는지까지 말한다')
  })

  it('관측할 수 있으면 사람이 적을 이유가 없다', () => {
    const verdict = judgePhysicalId({ observed: RUN })
    assert.equal(verdict.ok && verdict.id, RUN)
    assert.equal(verdict.ok && verdict.source, 'observed')
  })

  it('다른 Run 을 묶는 것은 막지 않되 그 사실을 말한다', () => {
    const verdict = judgePhysicalId({ provided: OTHER, observed: RUN })
    assert.equal(verdict.ok && verdict.source, 'other-run')
    assert.equal(verdict.ok && verdict.observed, RUN)
  })

  it('Run 을 모르고 값도 없으면 결합을 만들지 않는다', () => {
    const verdict = judgePhysicalId({})
    assert.equal(verdict.ok, false)
    assert.equal(verdict.ok === false && verdict.reason, 'UNKNOWN_RUN')
  })

  it('라벨은 Run 을 관측하지 못한 자리에서도 거부된다', () => {
    const verdict = judgePhysicalId({ provided: 'claude-main' })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.ok === false && verdict.reason, 'NOT_A_RUN_ID')
  })
})

describe('C-3 — 한 통로가 모른다고 원본이 없는 것은 아니다', () => {
  // 실기계: 작업 항목 통로를 선언한 순간 자원 조회가 그쪽으로 넘어갔고, 코드 저장소의
  // 이슈 참조는 전부 "읽지 못했다" 로 떨어졌다. 통로는 있었는데 엉뚱한 통로에게만 물었다.
  const reader = (id: string, answer: () => Promise<ResourceSnapshot>) => ({ id, getResource: answer })

  it('처음으로 실물을 돌려주는 통로를 쓴다', async () => {
    const origin = await readOrigin(
      [
        reader('tracker', async () => ({ ...snapshot(), missing: true })),
        reader('code', async () => snapshot({ state: 'closed', settled: true })),
      ],
      'group/project#122',
      AT,
    )
    assert.equal(origin.kind, 'READ')
    assert.equal(origin.kind === 'READ' && origin.snapshot.settled, true)
  })

  it('전부 실패했을 때만 못 읽었다고 말한다', async () => {
    const origin = await readOrigin(
      [
        reader('tracker', async () => ({ ...snapshot(), missing: true })),
        reader('code', async () => {
          throw new Error('401')
        }),
      ],
      'group/project#122',
      AT,
    )
    assert.equal(origin.kind, 'UNREADABLE')
    assert.match(origin.kind === 'UNREADABLE' ? origin.detail : '', /tracker/)
    assert.match(origin.kind === 'UNREADABLE' ? origin.detail : '', /401/, '어느 통로가 왜 실패했는지 남는다')
  })

  it('통로가 하나도 없으면 그렇게 말한다', async () => {
    const origin = await readOrigin([], 'group/project#122', AT)
    assert.equal(origin.kind, 'UNREADABLE')
    assert.match(origin.kind === 'UNREADABLE' ? origin.detail : '', /읽을 통로가 없다/)
  })
})
