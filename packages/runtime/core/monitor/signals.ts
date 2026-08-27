// Generic Signal — Core가 아는 신호의 전부 (OM §10.6).
//
// 여기에 계정 이름도, 라벨 이름도, 저장소 이름도 없다. "나에게 배정됐다"는 개념은 알지만
// 누가 나인지는 모르고, "우선순위 라벨"이라는 개념은 알지만 어떤 이름의 라벨인지는 모른다.
// 실제 값은 Profile과 User Override가 채운다 — 그래야 같은 Core가 다른 프로젝트에 붙는다.

import type { EventType, Priority } from '../model/entities.ts'
import type { RawEvent } from '../../ports/event-source.ts'
import { isWithinScopes } from '../policy/scope.ts'

export const GENERIC_SIGNALS = [
  'assigned_to_me',
  'mentioned_me',
  'direct_reply',
  'review_requested',
  'my_pr_reviewed',
  'participated_thread_changed',
  'active_canonical_changed',
  'open_change_touches_active_canonical',
  'priority_labels',
  'project_specific_signal',
] as const
export type GenericSignal = (typeof GENERIC_SIGNALS)[number]

/**
 * 신호를 판정하는 데 필요한 프로젝트별 값. 선언형이어야 Profile(B-10)이 그대로 채울 수 있다 —
 * 여기에 함수를 받기 시작하면 설정 파일로는 표현할 수 없는 물건이 된다.
 */
export type MonitorConfig = {
  /** "나"로 인정할 계정들. 개인 값이므로 User Override 몫이다 (OM §4.4). */
  identities?: readonly string[]
  /**
   * provider가 주는 사유 → 신호. Core에 기본값을 두지 않는다 — 어느 provider의 `mention`이든
   * 다른 곳의 무엇이든 그건 provider의 어휘이고, 여기 박아 두면 Core가 특정 provider를
   * 아는 물건이 된다. 매핑은 Adapter가 내놓고 Profile이 고른다.
   */
  reasonSignals?: Readonly<Record<string, GenericSignal>>
  /** 라벨 → 우선순위. */
  priorityLabels?: Readonly<Record<string, Priority>>
  /** 붙어 있으면 한 단계 올린다. */
  escalationLabels?: readonly string[]
  /** 신호별 기본 우선순위. */
  signalPriority?: Partial<Record<GenericSignal, Priority>>
  /** 이 신호 중 하나라도 있으면 사람의 판단 대기함에 올린다. 비우면 신호가 있는 것 전부. */
  inboxSignals?: readonly GenericSignal[]
}

const DEFAULT_SIGNAL_PRIORITY: Record<GenericSignal, Priority> = {
  assigned_to_me: 'P0',
  mentioned_me: 'P0',
  direct_reply: 'P0',
  review_requested: 'P1',
  my_pr_reviewed: 'P1',
  participated_thread_changed: 'P1',
  active_canonical_changed: 'P1',
  open_change_touches_active_canonical: 'P2',
  priority_labels: 'P1',
  project_specific_signal: 'P2',
}

/** 답을 해야 하는 신호. 나머지는 알아두면 되는 것이다 (OM §10.3). */
const ACTIONABLE: ReadonlySet<GenericSignal> = new Set(['mentioned_me', 'direct_reply', 'review_requested'])
const WORK: ReadonlySet<GenericSignal> = new Set(['assigned_to_me'])

export type Classification = {
  signals: GenericSignal[]
  type: EventType
  priority: Priority
  inboxCandidate: boolean
}

const RANK: Priority[] = ['P0', 'P1', 'P2']
const higher = (a: Priority, b: Priority): Priority => (RANK.indexOf(a) <= RANK.indexOf(b) ? a : b)
const raise = (p: Priority): Priority => RANK[Math.max(0, RANK.indexOf(p) - 1)]!

function mentionsMe(text: string | undefined, identities: readonly string[]): boolean {
  if (!text) return false
  return identities.some((id) => text.includes(`@${id.replace(/^@/, '')}`))
}

/**
 * 신호를 세우는 데 필요한 **관찰된 사실**. Config와 나누는 이유는 성격이 다르기 때문이다 —
 * Config는 프로젝트가 미리 적어 두는 선언이고, 이쪽은 이번 사건을 보고 알게 된 것이다.
 * 여기에 함수를 받지 않는 것도 같은 이유다 (설정 파일로 표현할 수 없는 물건이 되지 않게).
 *
 * 전부 optional이다 — 모르면 그 신호를 세우지 않는다. 모르는 것을 false로 적으면
 * "안 건드렸다"는 틀린 판정이 된다.
 */
export type SignalContext = {
  /**
   * 나에게 배정됐는가. 목록 조회로 알게 되는 사실이라 알림 사유와 별개다 —
   * 지정이 알림으로 오지 않는 경우가 정확히 회수 경로가 필요한 이유다.
   */
  assignedToMe?: boolean
  /** 내 글에 달린 응답인가. */
  replyToMe?: boolean
  /** 정본 baseline이 실제로 움직였는가 — actual drift. */
  canonicalChanged?: boolean
  /** 이번 변경이 건드린 실제 경로. */
  changedPaths?: readonly string[]
  /** 정본이 사는 경로. 위와 겹치면 potential drift다. */
  canonicalPaths?: readonly string[]
}

/** 이 이벤트에 어떤 신호가 걸리는가. 순서는 판정에 영향이 없다. */
export function detectSignals(
  event: RawEvent,
  config: MonitorConfig,
  context: SignalContext = {},
): GenericSignal[] {
  const identities = config.identities ?? []
  const raw = (event.raw ?? {}) as { kind?: string; reason?: string; body?: string }
  const signals = new Set<GenericSignal>()

  if (raw.reason) {
    const mapped = config.reasonSignals?.[raw.reason]
    if (mapped) signals.add(mapped)
  }

  // 본문에 내 이름이 불렸다. 알림이 오지 않는 경로(참여하지 않은 스레드)에서도 잡힌다.
  if (mentionsMe(raw.body, identities)) signals.add('mentioned_me')

  const labels = event.hints?.labels ?? []
  if (labels.some((label) => config.priorityLabels?.[label] !== undefined)) signals.add('priority_labels')

  if (context.assignedToMe) signals.add('assigned_to_me')

  // 내 글에 달린 응답. provider의 알림 사유로는 mention과 구분되지 않는 경우가 많아
  // 관찰된 사실로 받는다.
  if (context.replyToMe) signals.add('direct_reply')

  // 정본이 **이미** 움직인 것과, 열린 변경이 정본 영역을 **건드리는** 것은 다른 사건이다
  // (C-07 §2.4). 둘을 합치면 "바뀌었다"와 "바뀔 수 있다"를 구분할 수 없게 된다.
  if (context.canonicalChanged) signals.add('active_canonical_changed')
  if (
    context.changedPaths?.length &&
    context.canonicalPaths?.length &&
    context.changedPaths.some((path) => isWithinScopes(path, context.canonicalPaths!))
  ) {
    signals.add('open_change_touches_active_canonical')
  }

  // 내가 쓴 글은 나에게 알릴 일이 아니다 — 다른 신호가 없다면 조용히 넘긴다.
  const authors = event.hints?.actors ?? []
  const mine = authors.length > 0 && authors.every((a) => identities.includes(a))
  if (mine && signals.size === 0) return []

  return [...signals]
}

/** 신호를 유형·우선순위·수신함 여부로 옮긴다. Phase A의 마지막 단계다. */
export function classify(
  event: RawEvent,
  config: MonitorConfig,
  context: SignalContext = {},
): Classification {
  const signals = detectSignals(event, config, context)

  const type: EventType = signals.some((s) => WORK.has(s))
    ? 'work'
    : signals.some((s) => ACTIONABLE.has(s))
      ? 'actionable'
      : 'informational'

  let priority: Priority = 'P2'
  for (const signal of signals) {
    priority = higher(priority, config.signalPriority?.[signal] ?? DEFAULT_SIGNAL_PRIORITY[signal])
  }
  for (const label of event.hints?.labels ?? []) {
    const mapped = config.priorityLabels?.[label]
    if (mapped) priority = higher(priority, mapped)
  }
  if ((event.hints?.labels ?? []).some((label) => (config.escalationLabels ?? []).includes(label))) {
    priority = raise(priority)
  }
  // provider가 힌트를 줬다면 참고는 하되, 올리는 쪽으로만 쓴다
  if (event.hints?.priority) priority = higher(priority, event.hints.priority)

  const inboxCandidate =
    signals.length > 0 && (config.inboxSignals === undefined || signals.some((s) => config.inboxSignals!.includes(s)))

  return { signals, type, priority, inboxCandidate }
}
