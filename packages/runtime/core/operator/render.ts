// Human-first Progress Renderer (B-17).
//
// 목표는 ASC 내부 상태를 많이 보여주는 것이 아니다 — 사용자가 별도 질의 없이
// "내 작업이 지금 어떻게 되고 있는가"를 이해하게 하는 것이다. 그래서 본문은 항상
// 다섯 질문에 답한다: 지금 무엇을 / 무엇이 끝났나 / 문제가 있나 / 다음은 / 내 판단이
// 지금 필요한가.
//
// 규칙 셋:
//   1. 본문에 내부 용어(Logical Session·ACTIVE·writeBoundary·Verifier·RuntimeBinding)를
//      쓰지 않는다. 사람이 ASC를 배워야 이해되는 화면은 실패다. 내부 용어는 상세 한 줄에만.
//   2. Renderer는 progress schema 덤프가 아니다. 필드를 나열하는 대신 문장을 만든다.
//   3. ACTIVE 세션의 checkpoint를 현재 진행으로 읽지 않는다 — checkpoint는 중단 시점의
//      승계 정보이고, 재개 후에도 남아 있어 지금 상황과 다를 수 있다.
//
// heartbeat(관찰된 활동)만으로 "순조롭게 진행 중" 같은 의미론적 진척을 만들지 않는다.
// 활동 흔적은 진척이 아니다 — 보고가 없으면 없다고 말한다.

import type { Session } from '../model/entities.ts'
import type { ProgressReport } from './progress.ts'

/** 내부 상태 → 사람 말. 상세 줄에서는 원래 용어를 써도 된다. */
const ROLE_WORDS: Record<Session['role'], string> = {
  planner: '계획',
  researcher: '조사',
  implementer: '구현',
  verifier: '검증',
}

const STATUS_WORDS: Record<Session['status'], string> = {
  READY: '시작 대기',
  ACTIVE: '작업 중',
  PAUSED: '멈춤',
  BLOCKED: '막힘',
  DONE: '완료',
  FAILED: '실패',
}

/** 보고가 이만큼 오래되면 지금 상황이라고 단정하지 않는다. */
const STALE_AFTER_MS = 20 * 60 * 1000

export type RenderInput = {
  /**
   * 종결·archive 후에는 세션 entity가 활성 목록에 없다. 그때도 "무엇을 마쳤나"는
   * 보여야 하므로 없어도 렌더한다 — 최종 화면이 사라지면 완료를 확인할 수단이 없다.
   */
  session: Session | null
  progress: ProgressReport | null
  /**
   * 관찰된 활동 신호. **진척이 아니다** — 도구가 한 번 돌았다는 사실까지다.
   * 없거나 오래됐다고 "멈췄다"고 말하지 않는다: 파일만 고치는 구간, 생각하는 구간,
   * 하위 작업을 기다리는 구간에는 애초에 신호가 없다 (B-18).
   */
  liveness?: { lastActivityAt: string; lastTool?: string }
  /**
   * 지금 사람의 결정을 기다리는 것들 (상신·요청 참조).
   *
   * `progress.needsUserDecision` 은 **일하는 쪽의 신고**다. 신고가 없거나 NONE이어도
   * 열린 상신이 있으면 판단은 실제로 필요하다 — 그때 "판단 필요 없음"이라고 말하는
   * 화면은 거짓말이다 (B-65 dogfood에서 잡힌 것). 여기 값이 있으면 그것이 이긴다.
   */
  awaiting?: readonly string[]
  now?: Date
}

/** 사람에게 보여줄 본문과, 그 아래 붙는 작은 상세 한 줄. */
export type RenderedProgress = { body: string[]; detail: string }

export function renderProgress(input: RenderInput): RenderedProgress {
  const { session, progress, liveness } = input
  const awaiting = input.awaiting ?? []
  const now = input.now ?? new Date()
  const work = session ? shortGoal(session.goal) : '이'

  if (!progress) {
    const state = session ? STATUS_WORDS[session.status] : '확인 불가'
    // 활동 신호가 있으면 "언제 뭔가 돌긴 했다"까지만 더한다 — 그 이상은 지어내는 것이다
    const noReport = liveness
      ? `${minutesSince(liveness.lastActivityAt, now)}분 전에 활동이 관찰됐지만, 진행 내용 보고는 아직 없습니다.`
      : '아직 진행 내용 보고가 없어 어디까지 됐는지는 알 수 없습니다.'
    return {
      body: [
        `${work} 작업이 ${state === '작업 중' ? '진행 중입니다' : `${state} 상태입니다`}.`,
        noReport,
        awaiting.length > 0 ? awaitingLine(awaiting) : decisionLine('NONE'),
      ],
      detail: detailLine(session, null, now, liveness),
    }
  }

  const body: string[] = [headline(work, progress)]

  // 무엇이 끝났고 지금 무엇을 하는가 — 한 문단으로 붙인다.
  // 끝난 작업에는 "지금 무엇을"이 없다 — 무엇을 마쳤는지만 말한다.
  const done = progress.milestones.length > 0 ? joinKorean(progress.milestones) : ''
  if (progress.terminal) {
    if (done) body.push(`${done}까지 완료했습니다.`)
  } else {
    body.push(`${done ? `${done}까지 마쳤고, ` : ''}지금은 ${progress.phase}.`)
  }

  // 문제가 있는가 + 다음은 무엇인가
  const trouble = troubleLine(progress)
  const next = progress.terminal ? '' : progress.nextStep ? ` 다음은 ${progress.nextStep}.` : ''
  if (trouble || next) body.push(`${trouble}${next}`.trim())

  body.push(
    awaiting.length > 0
      ? awaitingLine(awaiting)
      : decisionLine(progress.needsUserDecision, progress.decisionRef, progress.terminal),
  )

  if (isStale(progress, now)) {
    body.push(`(마지막 보고가 ${minutesAgo(progress, now)}분 전입니다 — 그 사이 상황이 달라졌을 수 있습니다.)`)
  }

  return { body, detail: detailLine(session, progress, now, liveness) }
}

function headline(work: string, p: ProgressReport): string {
  if (p.terminal) return `${work} 작업을 마쳤습니다.`
  if (p.needsUserDecision === 'NOW') return `${work} 작업이 멈춰 있으며, 사용자 판단이 필요합니다.`
  if (p.verifier === 'FAIL') return `${work} 구현은 끝났지만 검증에서 문제를 발견했습니다.`
  if (p.verifier === 'RUNNING') return `${work} 작업은 끝났고, 지금은 별도 검증을 진행하고 있습니다.`
  if (p.unresolved.length > 0) {
    return `${work} 작업은 계속 진행 중이며, 확인이 필요한 항목 ${p.unresolved.length}건을 발견했습니다.`
  }
  return `${work} 작업이 진행 중입니다.`
}

function troubleLine(p: ProgressReport): string {
  if (p.verifier === 'FAIL') {
    return p.verifierDetail
      ? `검증에서 확인된 문제: ${p.verifierDetail}. 아직 완료로 처리하지 않았습니다.`
      : '검증에서 실패한 항목이 있어 아직 완료로 처리하지 않았습니다.'
  }
  if (p.unresolved.length > 0) {
    return `확인이 필요한 항목: ${joinKorean(p.unresolved)}.`
  }
  if (p.terminal) return ''
  // 판단을 기다리며 멈춰 있는데 "문제 없다"고 하면 앞뒤가 맞지 않는다 — 멈춤 자체가 문제다
  if (p.needsUserDecision === 'NOW') return ''
  return '현재 작업을 막는 문제는 없습니다.'
}

/** 열린 상신이 있으면 무엇을 기다리는지 이름으로 말한다 — "받은함을 보라"보다 구체적이다. */
function awaitingLine(awaiting: readonly string[]): string {
  return `지금 판단이 필요합니다 — ${awaiting.join(', ')} (asc inbox) 를 확인해 주세요.`
}

function decisionLine(need: ProgressReport['needsUserDecision'], ref?: string, terminal = false): string {
  switch (need) {
    case 'NOW':
      return ref
        ? `지금 판단이 필요합니다 — ${ref} 를 확인해 주세요.`
        : '지금 판단이 필요합니다 — 받은함(asc inbox)을 확인해 주세요.'
    case 'LATER':
      // 끝난 작업에 "계속 진행할 수 있습니다"라고 하면 아직 도는 줄 안다
      return terminal
        ? '자동화 작업은 끝났으며, 남은 항목은 따로 판단할 수 있습니다.'
        : '작업은 계속 진행할 수 있습니다. 미확정 항목은 완료 시 함께 판단을 요청하겠습니다.'
    case 'NONE':
      return terminal ? '남은 판단 항목은 없습니다.' : '지금 사용자 판단이 필요한 항목은 없습니다.'
  }
}

/** 2단계 정보. 여기서는 내부 용어를 그대로 써도 된다 — 본문 이해에 필수가 아니어야 한다. */
function detailLine(
  session: Session | null,
  progress: ProgressReport | null,
  now: Date,
  liveness?: RenderInput['liveness'],
): string {
  const parts = session
    ? [session.id, ROLE_WORDS[session.role], STATUS_WORDS[session.status]]
    : [progress?.logicalSessionId ?? '(세션 미상)', '거둔 세션']
  if (progress) {
    if (progress.verifier !== 'NONE') parts.push(`검증 ${verifierWord(progress.verifier)}`)
    if (progress.unresolved.length > 0) parts.push(`미결 ${progress.unresolved.length}건`)
    parts.push(`${minutesAgo(progress, now)}분 전 기준`)
  } else {
    parts.push('진행 보고 없음')
  }
  // 있을 때만 덧붙인다 — 없다고 "활동 없음"을 적으면 그것도 판정이다
  if (liveness) {
    const tool = liveness.lastTool ? `(${liveness.lastTool})` : ''
    parts.push(`최근 활동 ${minutesSince(liveness.lastActivityAt, now)}분 전${tool}`)
  }
  return parts.join(' · ')
}

const verifierWord = (v: ProgressReport['verifier']) =>
  v === 'RUNNING' ? '진행 중' : v === 'PASS' ? 'PASS' : v === 'FAIL' ? 'FAIL' : '없음'

function minutesAgo(p: ProgressReport, now: Date): number {
  return minutesSince(p.lastUpdatedAt, now)
}

function minutesSince(at: string, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - new Date(at).getTime()) / 60_000))
}

const isStale = (p: ProgressReport, now: Date) =>
  !p.terminal && now.getTime() - new Date(p.lastUpdatedAt).getTime() > STALE_AFTER_MS

/**
 * 목표 문장이 길면 첫 구절만 — 헤드라인이 목표 전문을 되뇌면 읽히지 않는다.
 * ASCII 하이픈은 자르지 않는다: 식별자(G-2, spec-001)와 합성어에 흔해서
 * 분리자로 쓰면 "G-2 …"가 "G"로 잘린다 (실측에서 걸렸다).
 */
function shortGoal(goal: string): string {
  const head = goal.split(/\s[—–]\s|\.\s/)[0]?.trim() ?? goal
  return head.length > 40 ? `${head.slice(0, 40)}…` : head
}

function joinKorean(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')}, ${items[items.length - 1]}`
}
