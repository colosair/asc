// B-17 Gate — 작업 "중" 가시성이 canonical을 건드리지 않고 사람 말로 나오는지.
//
// Gate 목록:
//   6 시나리오 렌더링 / Progress ↛ canonical state / owner 아닌 기록 거부 /
//   staleness 표현 / terminal 보존·collect 정리 / Core provider 어휘 0

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { ScopedRuntimeBindings } from '../adapters/memory/runtime-binding.ts'
import { Session } from '../core/model/entities.ts'
import { ProgressService, type ProgressInput } from '../core/operator/progress.ts'
import { renderProgress } from '../core/operator/render.ts'

const NOW = '2026-08-23T15:00:00+09:00'
const OWNER = 'physical-owner-1'

function setup(now = NOW) {
  const store = new MemoryStateStore()
  const bindings = new ScopedRuntimeBindings(store.scope('test-host'))
  const service = new ProgressService({ scope: store.scope('progress'), bindings, now: () => now })
  return { store, bindings, service }
}

function session(overrides: Partial<Session> = {}): Session {
  return Session.parse({
    id: 'S-20260823-01',
    version: 0,
    status: 'ACTIVE',
    role: 'implementer',
    goal: '로그인 기능 구현 — 인증 API와 화면 연결',
    canonicalSources: [],
    writeBoundary: ['frontend/**'],
    ...overrides,
  })
}

async function claimed(setupResult: ReturnType<typeof setup>, sessionId = 'S-20260823-01') {
  await setupResult.bindings.claim(
    { logicalSessionId: sessionId, provider: 'test-host', physicalSessionId: OWNER },
    NOW,
  )
}

async function reportOf(input: ProgressInput, now = NOW) {
  const s = setup(now)
  await claimed(s)
  const outcome = await s.service.report('S-20260823-01', OWNER, input)
  assert.equal(outcome.ok, true)
  return { ...s, report: outcome.ok ? outcome.report : null }
}

/** 사용자가 별도 질의 없이 답할 수 있어야 하는 다섯 질문 (post-b16 P1). */
function answersFiveQuestions(body: string[]): void {
  const text = body.join(' ')
  assert.ok(text.length > 0, '본문이 비었다')
  // 5번 질문(내 판단이 필요한가)은 항상 명시적으로 답한다
  assert.match(text, /판단이 필요|판단을 요청|판단이 필요한 항목은 없습니다/)
}

/** 본문에 내부 용어가 새면 사용자가 ASC를 배워야 이해된다 — 실패로 본다. */
const INTERNAL_TERMS = [
  'Logical Session',
  'RuntimeBinding',
  'writeBoundary',
  'ACTIVE',
  'PAUSED',
  'BLOCKED',
  'Verifier',
  'Execution Tier',
  'canonical',
  'SCOPE_ESCALATION',
]

function assertHumanFirst(body: string[]): void {
  const text = body.join(' ')
  for (const term of INTERNAL_TERMS) {
    assert.ok(!text.includes(term), `본문에 내부 용어가 노출됐다: ${term}\n${text}`)
  }
}

describe('B-17 Gate — 6 시나리오 렌더링', () => {
  it('1. 정상 진행 — 끝난 것·지금·다음·판단 불필요를 말한다', async () => {
    const { report } = await reportOf({
      phase: '로그인·콜백 화면과 접근 제어를 구현하는 중입니다',
      milestones: ['인증 API 연결', '로그인 상태 복원'],
      nextStep: '전체 테스트와 별도 검증',
    })
    const { body, detail } = renderProgress({ session: session(), progress: report, now: new Date(NOW) })

    answersFiveQuestions(body)
    assertHumanFirst(body)
    assert.match(body.join('\n'), /인증 API 연결/)
    assert.match(body.join('\n'), /막는 문제는 없습니다/)
    assert.match(body.join('\n'), /다음은 전체 테스트/)
    assert.match(body.join('\n'), /판단이 필요한 항목은 없습니다/)
    assert.match(detail, /S-20260823-01 · 구현 · 작업 중/)
  })

  // 신고(needsUserDecision)는 일하는 쪽의 말이다. 열린 상신이 있으면 신고와 무관하게
  // 판단은 실제로 필요하다 — 그때 "없습니다"라고 하는 화면은 거짓말이다 (B-65).
  it('열린 상신이 있으면 신고가 NONE이어도 판단이 필요하다고 말한다', async () => {
    const { report } = await reportOf({ phase: '설정 도입을 계속하는 중입니다' })
    const { body } = renderProgress({
      session: session(),
      progress: report,
      awaiting: ['ESC-20260826-01'],
      now: new Date(NOW),
    })
    assert.match(body.join('\n'), /지금 판단이 필요합니다 — ESC-20260826-01/)
    assert.doesNotMatch(body.join('\n'), /판단이 필요한 항목은 없습니다/)
  })

  it('보고가 아직 없어도 열린 상신은 화면에 나온다', async () => {
    const { body } = renderProgress({
      session: session(),
      progress: null,
      awaiting: ['ESC-20260826-01'],
      now: new Date(NOW),
    })
    assert.match(body.join('\n'), /지금 판단이 필요합니다 — ESC-20260826-01/)
  })

  it('2. 계속 가능한 unresolved — 문제를 말하되 지금 판단은 요구하지 않는다', async () => {
    const { report } = await reportOf({
      phase: '나머지 로그인 기능을 계속 구현하는 중입니다',
      unresolved: ['로그아웃 API 실제 경로 미확정'],
      needsUserDecision: 'LATER',
      nextStep: '화면 연결 마무리',
    })
    const { body, detail } = renderProgress({ session: session(), progress: report, now: new Date(NOW) })

    assertHumanFirst(body)
    assert.match(body[0]!, /확인이 필요한 항목 1건을 발견했습니다/)
    assert.match(body.join('\n'), /로그아웃 API 실제 경로 미확정/)
    assert.match(body.join('\n'), /계속 진행할 수 있습니다/)
    assert.match(body.join('\n'), /완료 시 함께 판단을 요청/)
    assert.match(detail, /미결 1건/)
  })

  it('3. 지금 판단 필요 — 멈췄다고 말하고 어디서 결정하는지 가리킨다', async () => {
    const { report } = await reportOf({
      phase: '다음 단계 선택을 기다리며 멈춰 있습니다',
      needsUserDecision: 'NOW',
      decisionRef: 'REQ-0042',
    })
    const { body } = renderProgress({ session: session({ status: 'PAUSED' }), progress: report, now: new Date(NOW) })

    assertHumanFirst(body)
    assert.match(body[0]!, /멈춰 있으며, 사용자 판단이 필요합니다/)
    assert.match(body.join('\n'), /REQ-0042/)
    // 멈춰 있는데 "문제 없다"고 하면 앞뒤가 맞지 않는다 (실측에서 잡힌 모순)
    assert.ok(!body.join('\n').includes('막는 문제는 없습니다'))
  })

  it('3-b. 판단 필요인데 참조가 없으면 받은함으로 안내한다 — 결정 정본은 Inbox다', async () => {
    const { report } = await reportOf({ phase: '멈춤', needsUserDecision: 'NOW' })
    const { body } = renderProgress({ session: session(), progress: report, now: new Date(NOW) })
    assert.match(body.join('\n'), /받은함\(asc inbox\)/)
  })

  it('4. Verifier 시작 — 자기보고를 완료로 처리하지 않는다고 말한다', async () => {
    const { report } = await reportOf({
      phase: '구현 결과를 별도 검증에 넘긴 상태입니다',
      milestones: ['구현 완료'],
      verifier: 'RUNNING',
      nextStep: '검증 결과 확인',
    })
    const { body, detail } = renderProgress({ session: session(), progress: report, now: new Date(NOW) })

    assertHumanFirst(body)
    assert.match(body[0]!, /별도 검증을 진행하고 있습니다/)
    assert.match(detail, /검증 진행 중/)
  })

  it('5. Verifier 실패 — 완료로 처리하지 않았음을 분명히 한다', async () => {
    const { report } = await reportOf({
      phase: '검증 실패 원인을 확인하는 중입니다',
      verifier: 'FAIL',
      verifierDetail: '새로고침 복원 시나리오 1건 실패',
    })
    const { body } = renderProgress({ session: session(), progress: report, now: new Date(NOW) })

    assertHumanFirst(body)
    assert.match(body[0]!, /검증에서 문제를 발견했습니다/)
    assert.match(body.join('\n'), /새로고침 복원 시나리오 1건 실패/)
    assert.match(body.join('\n'), /완료로 처리하지 않았습니다/)
  })

  it('6. 완료 — 마쳤다고 말하고 남은 것을 숨기지 않는다', async () => {
    const { report } = await reportOf({
      phase: '완료',
      milestones: ['구현', '자동 검증 통과'],
      unresolved: ['브라우저 수동 시나리오 8건은 사람 확인 필요'],
      verifier: 'PASS',
      terminal: true,
      needsUserDecision: 'LATER',
    })
    const { body } = renderProgress({ session: session({ status: 'DONE' }), progress: report, now: new Date(NOW) })

    assertHumanFirst(body)
    assert.match(body[0]!, /작업을 마쳤습니다/)
    assert.match(body.join('\n'), /브라우저 수동 시나리오 8건/)
    // 끝난 작업을 "지금 …하는 중"으로 말하거나 "계속 진행할 수 있다"고 하지 않는다
    assert.ok(!body.join('\n').includes('지금은'))
    assert.ok(!body.join('\n').includes('계속 진행할 수 있습니다'))
    assert.match(body.join('\n'), /자동화 작업은 끝났으며/)
  })

  it('6-b. 거둔 세션도 최종 화면이 남는다 — entity가 archive로 가도 무엇을 마쳤는지 보인다', async () => {
    const { report } = await reportOf({
      phase: '완료',
      milestones: ['구현', '자동 검증 통과'],
      verifier: 'PASS',
      terminal: true,
    })
    // session === null: collect 후 활성 목록에 없는 상태
    const { body, detail } = renderProgress({ session: null, progress: report, now: new Date(NOW) })

    assertHumanFirst(body)
    assert.match(body[0]!, /마쳤습니다/)
    assert.match(body.join('\n'), /구현, 자동 검증 통과까지 완료했습니다/)
    assert.match(detail, /S-20260823-01 · 거둔 세션/)
  })

  it('목표 앞머리를 자를 때 식별자의 하이픈을 분리자로 쓰지 않는다', async () => {
    const { report } = await reportOf({ phase: '구현 중' })
    const { body } = renderProgress({
      session: session({ goal: 'G-2 로그인 후 원래 목적지 복귀(returnTo) — 딥링크 진입 시 복귀' }),
      progress: report,
      now: new Date(NOW),
    })
    // 실측에서 "G-2 …"가 "G"로 잘렸다
    assert.match(body[0]!, /^G-2 로그인 후 원래 목적지 복귀\(returnTo\) 작업이/)
  })

  it('보고가 없으면 진척을 지어내지 않는다 — 모른다고 말한다', () => {
    const { body, detail } = renderProgress({ session: session(), progress: null, now: new Date(NOW) })
    assertHumanFirst(body)
    assert.match(body.join('\n'), /진행 내용 보고가 없어/)
    assert.match(detail, /진행 보고 없음/)
  })
})

describe('B-17 Gate — Progress는 canonical state를 바꾸지 않는다', () => {
  it('report 전후로 Session entity의 version·status가 그대로다', async () => {
    const s = setup()
    const created = await s.store.create('session', session())
    assert.equal(created.ok, true)
    await claimed(s)

    const before = await s.store.get('session', 'S-20260823-01')
    const outcome = await s.service.report('S-20260823-01', OWNER, { phase: '작업 중', terminal: true })
    assert.equal(outcome.ok, true)
    const after = await s.store.get('session', 'S-20260823-01')

    assert.deepEqual(after, before, 'Progress 기록이 Session entity를 건드렸다')
  })

  it('progress 모듈은 SessionRuntime을 import하지 않는다 — 전이 경로 자체가 없다', async () => {
    const source = await readFile(new URL('../core/operator/progress.ts', import.meta.url), 'utf8')
    assert.ok(!/runtime\/session/.test(source), 'progress가 SessionRuntime을 알고 있다')
    const render = await readFile(new URL('../core/operator/render.ts', import.meta.url), 'utf8')
    assert.ok(!/runtime\/session/.test(render), 'render가 SessionRuntime을 알고 있다')
  })

  it('Progress는 entity 저장소가 아니라 scope에만 쓴다', async () => {
    const s = setup()
    await s.store.create('session', session())
    await claimed(s)
    await s.service.report('S-20260823-01', OWNER, { phase: '작업 중' })

    // entity 목록에 progress 흔적이 없다
    const sessions = await s.store.list('session')
    assert.equal(sessions.length, 1)
    assert.equal(JSON.stringify(sessions[0]).includes('작업 중'), false)
  })
})

describe('B-17 Gate — 기록 권한', () => {
  it('owner가 아닌 Physical Session의 기록은 거부한다', async () => {
    const s = setup()
    await claimed(s)
    const outcome = await s.service.report('S-20260823-01', 'physical-other', { phase: '남의 세션에 기록' })

    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.reason, 'NOT_OWNER')
    assert.equal(await s.service.get('S-20260823-01'), null)
  })

  it('Runtime이 붙지 않은 세션에는 기록할 수 없다', async () => {
    const s = setup()
    const outcome = await s.service.report('S-20260823-01', OWNER, { phase: '무주공산' })
    assert.equal(outcome.ok === false && outcome.reason, 'NOT_OWNER')
  })

  it('승계 후에는 새 owner만 쓴다 — 옛 Host가 표시를 오염시키지 못한다', async () => {
    const s = setup()
    await claimed(s)
    await s.service.report('S-20260823-01', OWNER, { phase: '옛 owner의 마지막 보고' })

    await s.bindings.rebind(
      { logicalSessionId: 'S-20260823-01', provider: 'test-host', physicalSessionId: 'physical-owner-2' },
      NOW,
    )
    const stale = await s.service.report('S-20260823-01', OWNER, { phase: '아직 살아 있는 옛 Host' })
    assert.equal(stale.ok, false)

    const fresh = await s.service.report('S-20260823-01', 'physical-owner-2', { phase: '새 owner의 보고' })
    assert.equal(fresh.ok, true)
    assert.equal((await s.service.get('S-20260823-01'))?.phase, '새 owner의 보고')
  })
})

describe('B-17 Gate — staleness와 lifecycle', () => {
  it('오래된 보고는 지금 상황이라고 단정하지 않는다', async () => {
    const { report } = await reportOf({ phase: '구현 중' }, '2026-08-23T15:00:00+09:00')
    const later = new Date('2026-08-23T15:45:00+09:00')
    const { body, detail } = renderProgress({ session: session(), progress: report, now: later })

    assert.match(body.join('\n'), /마지막 보고가 45분 전/)
    assert.match(detail, /45분 전 기준/)
  })

  it('terminal 보고는 오래돼도 stale로 흔들지 않는다 — 완료는 변하지 않는다', async () => {
    const { report } = await reportOf({ phase: '완료', terminal: true })
    const later = new Date('2026-08-24T15:00:00+09:00')
    const { body } = renderProgress({ session: session({ status: 'DONE' }), progress: report, now: later })
    assert.ok(!body.join('\n').includes('달라졌을 수 있습니다'))
  })

  it('collect는 live projection만 지우고 terminal view는 남긴다', async () => {
    const s = setup()
    await s.bindings.claim({ logicalSessionId: 'S-20260823-02', provider: 'test-host', physicalSessionId: OWNER }, NOW)
    await s.bindings.claim({ logicalSessionId: 'S-20260823-03', provider: 'test-host', physicalSessionId: OWNER }, NOW)
    await s.service.report('S-20260823-02', OWNER, { phase: '진행 중이던 표시' })
    await s.service.report('S-20260823-03', OWNER, { phase: '마쳤습니다', terminal: true })

    const removed = await s.service.collect(['S-20260823-02', 'S-20260823-03'])

    assert.deepEqual(removed, ['S-20260823-02'])
    assert.equal(await s.service.get('S-20260823-02'), null)
    assert.equal((await s.service.get('S-20260823-03'))?.phase, '마쳤습니다')
  })
})

describe('B-18 Gate — liveness는 보조 정보다', () => {
  const liveness = { lastActivityAt: '2026-08-23T14:50:00+09:00', lastTool: 'Bash' }

  it('보고가 없고 활동만 있으면 "활동이 관찰됐다"까지만 말한다 — 진척은 지어내지 않는다', () => {
    const { body, detail } = renderProgress({
      session: session(),
      progress: null,
      liveness,
      now: new Date(NOW),
    })

    assertHumanFirst(body)
    assert.match(body.join('\n'), /10분 전에 활동이 관찰됐지만, 진행 내용 보고는 아직 없습니다/)
    assert.match(detail, /최근 활동 10분 전\(Bash\)/)
    // heartbeat만으로 만들어서는 안 되는 의미론 문구들
    for (const invented of ['순조롭게', '진행 중입니다.', '마쳤', '검증']) {
      assert.ok(!body.slice(1).join('\n').includes(invented), `heartbeat에서 진척을 지어냈다: ${invented}`)
    }
  })

  it('liveness가 없으면 활동에 대해 아무 말도 하지 않는다 — 부재는 판정이 아니다', () => {
    const { body, detail } = renderProgress({ session: session(), progress: null, now: new Date(NOW) })
    assert.ok(!body.join('\n').includes('활동'))
    assert.ok(!detail.includes('활동'))
  })

  it('오래된 heartbeat를 멈춤으로 읽지 않는다 — Bash를 안 쓰는 구간이 있을 뿐이다', async () => {
    const { report } = await reportOf({ phase: '설계 문서를 읽는 중입니다' }, NOW)
    const { body, detail } = renderProgress({
      session: session(),
      progress: report,
      liveness: { lastActivityAt: '2026-08-23T09:00:00+09:00' }, // 6시간 전
      now: new Date(NOW),
    })

    // 진행 보고는 방금이므로 stale 경고가 없어야 한다 — staleness 근거는 progress뿐이다
    assert.ok(!body.join('\n').includes('달라졌을 수 있습니다'))
    for (const negative of ['멈춘', '활동이 없', '응답이 없']) {
      assert.ok(!body.join('\n').includes(negative), `heartbeat 부재를 부정 판정으로 썼다: ${negative}`)
    }
    assert.match(detail, /최근 활동 360분 전/)
  })
})

describe('B-17 Gate — Core 독립성', () => {
  it('progress·render에 provider 어휘가 없다', async () => {
    for (const file of ['progress.ts', 'render.ts']) {
      const source = await readFile(new URL(`../core/operator/${file}`, import.meta.url), 'utf8')
      for (const word of ['claude', 'Claude', 'gpt', 'sonnet', 'opus', 'haiku', 'anthropic']) {
        assert.ok(!source.includes(word), `${file} 에 provider 어휘 '${word}' 가 있다`)
      }
    }
  })
})
