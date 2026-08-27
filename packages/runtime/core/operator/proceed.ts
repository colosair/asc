// Generic Operator — "ASC로 진행해"의 provider-neutral 구현 (C-03 §1).
//
// 사람이 CLI 명령을 조립하던 절차를 하나의 진입으로 수렴한다. 판단은 전부 기존 것을
// 쓴다: 상태 전이는 SessionRuntime, 설정 검증은 bootstrap guard, 정본 판정은
// checkCanonical. 이 파일에 새 판단 로직이 생기면 그건 Core를 우회하는 두 번째 길이다.
//
// guard는 optional이 아니다. CLI가 아닌 Host Adapter가 직접 불러도 profile.lock 검증을
// 건너뛸 수 없어야 하며(C-03 §1.2), 정본 조립은 Surface가 아니라 factory가 진다.

import type { Session } from '../model/entities.ts'
import type { StateStore } from '../../ports/state-store.ts'
import type { CanonicalDrift, SessionRuntime, StartOutcome } from '../runtime/session.ts'
import { proceedGateFacts, type EscalationLedger } from '../runtime/escalation.ts'
import { deriveExecutionState, type ExecutionVerdict } from '../runtime/execution-state.ts'

/** proceed 진입 전 설정 검증 결과. 실 구현은 bootstrapGuard를 감싼다 — 새 판단 금지. */
export type ConfigCheck = { ok: true } | { ok: false; detail: string }

export type ProceedIntent = {
  /** 사용자가 특정 세션을 지목했다. 자동 탐색과 semantics가 다르다 (C-03 §1.5). */
  sessionId?: string
  /** 후보가 없을 때 초안에 실어 줄 목표 힌트. 확정이 아니다. */
  goal?: string
}

/** 후보 나열용 요약 — 사람이 고를 근거까지 함께 준다. */
export type SessionCandidate = {
  id: string
  status: Session['status']
  role: Session['role']
  goal: string
  /** 이 세션을 고르면 무슨 일이 일어나는지. */
  wouldDo: 'start' | 'resume' | 'continue'
}

/** 실행 가능 outcome이 Host에 넘겨주는 것 — 계약과 이어받을 지점. */
type Handout = {
  contract: Session
  doneCriteria: string[]
  checkpoint?: Session['checkpoint']
  /** 지금 무엇이 막혔고 무엇이 가는가 (C-13 §6). 상신 원장이 없으면 없다. */
  gate?: ExecutionVerdict
  /** 열려 있는 상신 id. 진행 화면이 "판단 필요 없음"이라고 말하지 않게 하는 근거다. */
  awaiting?: string[]
}

export type ProceedOutcome =
  | ({ kind: 'STARTED' } & Handout)
  | ({ kind: 'RESUMED' } & Handout)
  | ({ kind: 'CONTINUE_ACTIVE' } & Handout)
  | { kind: 'NEEDS_SELECTION'; candidates: SessionCandidate[] }
  | {
      kind: 'PROPOSE_CONTRACT'
      /** 초안일 뿐이다 — issue는 Controller 승인 후 별도 행위 (C-03 §1.3). */
      draft: { role: Session['role']; goal: string; doneCriteria: string[] }
    }
  /**
   * 미해소 상신이 실행 가능한 node를 전부 덮었다 (C-13 §6).
   *
   * BLOCKED와 다르다: 세션은 PAUSED 그대로이고, 경계가 풀리면 그대로 이어진다.
   * **전이를 일으키지 않는다** — 사람이 결정할 때까지 기다리는 것이지 실패가 아니다.
   */
  | { kind: 'HELD'; detail: string; verdict: ExecutionVerdict; escalations: string[] }
  | { kind: 'BLOCKED_CONFIG'; detail: string }
  | { kind: 'BLOCKED_CANONICAL'; detail: string; drifts?: CanonicalDrift[] }
  | { kind: 'FAILED'; reason: 'NOT_FOUND' | 'SESSION_BLOCKED' | 'NOT_RUNNABLE' | 'TRANSITION'; detail: string }

export type OperatorDeps = {
  store: StateStore
  sessions: SessionRuntime
  /**
   * 상신 원장 (C-13). 주면 proceed가 **막힌 node만** 보고 판단한다 —
   * 주지 않으면 예전처럼 상태만 보고 간다(기존 호출자 무손상).
   */
  escalations?: EscalationLedger
  /**
   * 필수다. 모든 진입이 bootstrap/profile.lock 검증을 지난다 — Surface가 어디든.
   * 실 조립은 factory(cli의 createOperator)가 bootstrapGuard로 고정한다.
   */
  guard: () => Promise<ConfigCheck>
}

const RUNNABLE = new Set<Session['status']>(['READY', 'PAUSED', 'ACTIVE'])

export class Operator {
  #store: StateStore
  #sessions: SessionRuntime
  #escalations: EscalationLedger | undefined
  #guard: () => Promise<ConfigCheck>

  constructor(deps: OperatorDeps) {
    this.#store = deps.store
    this.#sessions = deps.sessions
    this.#escalations = deps.escalations
    this.#guard = deps.guard
  }

  async proceed(intent: ProceedIntent = {}): Promise<ProceedOutcome> {
    const config = await this.#guard()
    if (!config.ok) return { kind: 'BLOCKED_CONFIG', detail: config.detail }

    // 명시 지정 — 사용자가 가리킨 그 세션만 본다. 다른 것을 권하지 않는다 (C-03 §1.5).
    if (intent.sessionId) {
      const session = await this.#store.get('session', intent.sessionId)
      if (!session) {
        return { kind: 'FAILED', reason: 'NOT_FOUND', detail: `세션 '${intent.sessionId}' 을 찾지 못했다` }
      }
      return this.#advance(session)
    }

    // 자동 탐색 — 실행 가능한 것만 후보다. archive는 collect가 이미 치웠다.
    const candidates = (await this.#store.list('session')).filter((s) => RUNNABLE.has(s.status))

    if (candidates.length === 0) {
      // 자동 issue 금지. 초안을 제안할 수는 있으나 발급은 Controller 승인 후 별도 행위다.
      return {
        kind: 'PROPOSE_CONTRACT',
        draft: { role: 'implementer', goal: intent.goal ?? '', doneCriteria: [] },
      }
    }

    if (candidates.length > 1) {
      // 임의 선택 금지 — 잘못 고른 세션 위에서 작업이 시작되는 것보다 한 번 묻는 게 싸다.
      return {
        kind: 'NEEDS_SELECTION',
        candidates: candidates.map((s) => ({
          id: s.id,
          status: s.status,
          role: s.role,
          goal: s.goal,
          wouldDo: s.status === 'READY' ? 'start' : s.status === 'PAUSED' ? 'resume' : 'continue',
        })),
      }
    }

    return this.#advance(candidates[0]!)
  }

  /** 상태별로 한 걸음. 전이는 전부 SessionRuntime을 지난다 — 우회 경로 없음. */
  async #advance(session: Session): Promise<ProceedOutcome> {
    switch (session.status) {
      case 'READY':
        return this.#mapStart(await this.#sessions.start(session.id), 'STARTED', session.id)
      case 'PAUSED': {
        // **checkpoint를 발행했다는 이유로 멈추지 않는다** (C-13 불변식 ④).
        // 멈추는 근거는 미해소 상신뿐이고, 그것도 막힌 node에 한한다.
        const gate = await this.#gate(session)
        if (gate && gate.runnable.length === 0 && gate.escalations.length > 0) {
          return {
            kind: 'HELD',
            detail: `실행 가능한 항목이 없다 — 상신 ${gate.escalations.length}건이 전부를 덮었다`,
            verdict: gate.verdict,
            escalations: gate.escalations,
          }
        }
        const resumed = await this.#mapStart(await this.#sessions.resume(session.id), 'RESUMED', session.id)
        return gate && 'contract' in resumed
          ? { ...resumed, gate: gate.verdict, ...(gate.escalations.length > 0 ? { awaiting: gate.escalations } : {}) }
          : resumed
      }
      case 'ACTIVE': {
        // 이미 검증됐다고 가정하지 않는다 — 이어가기 전에도 정본을 다시 본다 (C-03 §1.6).
        const canonical = await this.#sessions.checkCanonical(session.id)
        if (canonical.status === 'DRIFT') {
          return { kind: 'BLOCKED_CANONICAL', detail: '정본이 발급 시점과 다르다', drifts: canonical.drifts }
        }
        if (canonical.status === 'UNAVAILABLE') {
          return { kind: 'BLOCKED_CANONICAL', detail: canonical.detail }
        }
        if (canonical.status === 'NOT_FOUND') {
          return { kind: 'FAILED', reason: 'NOT_FOUND', detail: `세션 '${session.id}' 을 찾지 못했다` }
        }
        // 돌고 있는 세션도 같은 판정을 받는다. PAUSED에만 걸면 "한 번 재개된 뒤에는
        // 전부 막혀도 계속 간다고 말하는" 구멍이 생긴다 (실제로 그랬다).
        const gate = await this.#gate(session)
        if (gate && gate.runnable.length === 0 && gate.escalations.length > 0) {
          return {
            kind: 'HELD',
            detail: `실행 가능한 항목이 없다 — 상신 ${gate.escalations.length}건이 전부를 덮었다`,
            verdict: gate.verdict,
            escalations: gate.escalations,
          }
        }
        return {
          kind: 'CONTINUE_ACTIVE',
          ...handout(session),
          ...(gate ? { gate: gate.verdict } : {}),
          ...(gate && gate.escalations.length > 0 ? { awaiting: gate.escalations } : {}),
        }
      }
      case 'BLOCKED':
        return {
          kind: 'FAILED',
          reason: 'SESSION_BLOCKED',
          detail: `${session.id} 는 BLOCKED — Controller가 해소해야 진행할 수 있다`,
        }
      case 'DONE':
      case 'FAILED':
        return {
          kind: 'FAILED',
          reason: 'NOT_RUNNABLE',
          detail: `${session.id} 는 ${session.status} — 이어갈 수 없는 상태다`,
        }
    }
  }

  /**
   * 이 세션이 지금 어디까지 갈 수 있는가. 원장이 없으면 판단하지 않는다 —
   * 없는 근거로 세우지 않는다.
   */
  async #gate(
    session: Session,
  ): Promise<{ verdict: ExecutionVerdict; runnable: string[]; escalations: string[] } | null> {
    if (!this.#escalations) return null
    const pending = (await this.#escalations.pending()).filter((record) => record.sessionId === session.id)
    const facts = proceedGateFacts(pending, session.doneCriteria)
    return {
      verdict: deriveExecutionState({
        doneCriteria: session.doneCriteria,
        ...(facts.waitingOn.length > 0 ? { waitingOn: facts.waitingOn } : {}),
        ...(facts.conditions.length > 0 ? { conditions: facts.conditions } : {}),
      }),
      runnable: facts.runnable,
      escalations: pending.map((record) => record.escalationId),
    }
  }

  async #mapStart(outcome: StartOutcome, kind: 'STARTED' | 'RESUMED', id: string): Promise<ProceedOutcome> {
    if (outcome.ok) return { kind, ...handout(outcome.entity) }
    if (outcome.reason === 'CANONICAL_DRIFT') {
      return { kind: 'BLOCKED_CANONICAL', detail: '정본이 발급 시점과 다르다', drifts: outcome.drifts }
    }
    if (outcome.reason === 'CANONICAL_UNAVAILABLE') {
      return { kind: 'BLOCKED_CANONICAL', detail: outcome.detail }
    }
    if (outcome.reason === 'NOT_FOUND') {
      return { kind: 'FAILED', reason: 'NOT_FOUND', detail: `세션 '${id}' 을 찾지 못했다` }
    }
    const detail = outcome.reason === 'REJECTED' ? outcome.failure.message : `전이 실패: ${outcome.reason}`
    return { kind: 'FAILED', reason: 'TRANSITION', detail }
  }
}

function handout(session: Session): Handout {
  return {
    contract: session,
    doneCriteria: session.doneCriteria,
    ...(session.checkpoint ? { checkpoint: session.checkpoint } : {}),
  }
}
