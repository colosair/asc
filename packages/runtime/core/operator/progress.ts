// Semantic Progress — 작업 "중" 가시성의 정본 (B-17, post-b16-candidates P1).
//
// 왜 별도 구조인가: 사람이 알고 싶은 것은 "내 작업이 지금 어떻게 되고 있는가"인데,
// canonical Session state는 READY/ACTIVE/PAUSED/DONE 넷뿐이라 23분 동안 ACTIVE 하나로
// 침묵한다(B-16 friction ④ — 사용자가 중간보고를 직접 요청했다).
//
// 불변조건 (이 파일의 존재 이유):
//   Runtime Progress ≠ Canonical Session State.
//   Agent가 "80% 완료"라고 보고해도 Session.status는 변하지 않는다. 그래서 이 모듈은
//   SessionRuntime을 import하지 않는다 — 전이 경로가 아예 없어야 실수로도 못 바꾼다.
//   저장도 EntityMap 밖(ScopedStore)이라 Session 파일에 손이 닿지 않는다.
//
// Checkpoint와의 관계: Checkpoint는 Physical Run 승계 정보(PAUSED의 필수 요건)이고
// Progress는 표시용 projection이다. 병합하지 않으며, Checkpoint lifecycle도 건드리지
// 않는다 — ACTIVE 세션에 남아 있는 옛 checkpoint를 현재 진행으로 읽지 않는 것은
// Renderer의 규칙이다 (render.ts).

import { z } from 'zod'

import type { ScopedStore } from '../../ports/state-store.ts'
import type { RuntimeBindings } from './runtime-binding.ts'

/**
 * 사용자 판단이 지금 필요한가. 단순 BLOCKED 여부보다 이게 사람에게 더 중요하다 —
 * "내가 지금 뭘 해야 하지"에 바로 답한다.
 */
export const DecisionNeed = z.enum([
  'NONE', // 계속 진행 가능
  'LATER', // 미확정 항목 있음 — 완료 시 함께 판단
  'NOW', // 여기서 멈췄다 — 판단 없이 다음 단계 불가
])
export type DecisionNeed = z.infer<typeof DecisionNeed>

/** 독립 검증의 관측 상태. 자기 보고(Handoff.verified)와 다른 축이다. */
export const VerifierState = z.enum(['NONE', 'RUNNING', 'PASS', 'FAIL'])
export type VerifierState = z.infer<typeof VerifierState>

export const ProgressReport = z.object({
  logicalSessionId: z.string().min(1),
  /** 지금 무엇을 하는 중인가 — 한 줄. */
  phase: z.string().min(1),
  /** 무엇이 끝났는가. 파일 하나·테스트 하나가 아니라 의미 있는 묶음만. */
  milestones: z.array(z.string()).default([]),
  /** 다음에는 무엇을 하는가. */
  nextStep: z.string().optional(),
  /** 확인이 필요한 항목 — 작업을 막지는 않는 것들. */
  unresolved: z.array(z.string()).default([]),
  needsUserDecision: DecisionNeed.default('NONE'),
  /**
   * NOW일 때 사람이 어디서 결정하는지. 판단 요청의 정본은 계속 ApprovalRequest/Inbox다 —
   * Progress가 두 번째 결정 창구가 되면 control plane이 갈라진다.
   */
  decisionRef: z.string().optional(),
  verifier: VerifierState.default('NONE'),
  verifierDetail: z.string().optional(),
  /**
   * 종결 후 보존되는 최종 보고. DONE 즉시 삭제하면 "무엇을 마쳤나"를 볼 수단이 사라진다 —
   * live projection 정리는 collect가 하고, terminal view는 남긴다.
   */
  terminal: z.boolean().default(false),
  /** 기록한 Physical Session. 승계 후 옛 Host가 덮어쓰는 것을 막는 근거다. */
  recordedBy: z.string().min(1),
  lastUpdatedAt: z.string().min(1),
})
export type ProgressReport = z.infer<typeof ProgressReport>

/** 기록 입력 — 저장 책임 필드(recordedBy·lastUpdatedAt)는 서비스가 채운다. */
export type ProgressInput = {
  phase: string
  milestones?: string[]
  nextStep?: string
  unresolved?: string[]
  needsUserDecision?: DecisionNeed
  decisionRef?: string
  verifier?: VerifierState
  verifierDetail?: string
  terminal?: boolean
}

export type ReportOutcome =
  | { ok: true; report: ProgressReport }
  | { ok: false; reason: 'NOT_OWNER'; detail: string }
  | { ok: false; reason: 'INVALID'; detail: string }

const keyOf = (logicalSessionId: string) => `progress:${logicalSessionId}`

export type ProgressDeps = {
  /** Adapter가 넘기는 격리 저장소. Core entity를 건드리지 않는 유일한 이유다. */
  scope: ScopedStore
  /**
   * 기록 권한 판정용. owner인 Physical Session만 쓴다 — RuntimeBinding이 이미
   * 단일 소유권을 정해 뒀으므로 여기서 두 번째 권한 모델을 만들지 않는다.
   */
  bindings: RuntimeBindings
  now?: () => string
  /** History 기록. 없으면 남기지 않는다(테스트·비-store 환경). */
  appendHistory?: (entry: { at: string; actor: string; kind: string; ref: string; detail?: string }) => Promise<void>
}

export class ProgressService {
  #scope: ScopedStore
  #bindings: RuntimeBindings
  #now: () => string
  #appendHistory?: ProgressDeps['appendHistory']

  constructor(deps: ProgressDeps) {
    this.#scope = deps.scope
    this.#bindings = deps.bindings
    this.#now = deps.now ?? (() => new Date().toISOString())
    if (deps.appendHistory) this.#appendHistory = deps.appendHistory
  }

  /**
   * 진행 보고를 기록한다. Session entity는 읽지도 쓰지도 않는다 —
   * canonical state와 무관함이 호출 경로에서부터 보장돼야 한다.
   */
  async report(logicalSessionId: string, physicalSessionId: string, input: ProgressInput): Promise<ReportOutcome> {
    const binding = await this.#bindings.get(logicalSessionId)
    if (!binding) {
      return {
        ok: false,
        reason: 'NOT_OWNER',
        detail: `${logicalSessionId} 에 Runtime이 붙어 있지 않다 — 먼저 소유권을 주장하라`,
      }
    }
    if (binding.physicalSessionId !== physicalSessionId) {
      // 승계 후 죽지 않은 옛 Host가 계속 쓰면 표시가 오염된다. owner만 쓴다.
      return {
        ok: false,
        reason: 'NOT_OWNER',
        detail: `${logicalSessionId} 의 owner가 아니다 (현재 owner: ${binding.physicalSessionId})`,
      }
    }

    const at = this.#now()
    const parsed = ProgressReport.safeParse({
      logicalSessionId,
      ...input,
      recordedBy: physicalSessionId,
      lastUpdatedAt: at,
    })
    if (!parsed.success) {
      return { ok: false, reason: 'INVALID', detail: parsed.error.issues.map((i) => i.message).join('; ') }
    }

    // 갱신은 last-write-wins다. 표시 전용이고 owner가 하나뿐이라 수용한다 —
    // 원자성이 필요한 것(소유권·전이)은 각자 다른 곳에서 이미 지키고 있다.
    await this.#scope.set(keyOf(logicalSessionId), JSON.stringify(parsed.data))
    await this.#appendHistory?.({
      at,
      actor: physicalSessionId,
      kind: 'session_progress',
      ref: logicalSessionId,
      detail: parsed.data.phase,
    })
    return { ok: true, report: parsed.data }
  }

  async get(logicalSessionId: string): Promise<ProgressReport | null> {
    const raw = await this.#scope.get(keyOf(logicalSessionId))
    if (!raw) return null
    const parsed = ProgressReport.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  }

  /**
   * collect 시점의 live projection 정리. terminal 보고는 남긴다 — 완료 화면이
   * 사라지면 "무엇을 마쳤나"를 볼 수단이 없어진다.
   * @returns 실제로 지운 세션 id
   */
  async collect(closedSessionIds: readonly string[]): Promise<string[]> {
    const removed: string[] = []
    for (const id of closedSessionIds) {
      const current = await this.get(id)
      if (!current || current.terminal) continue
      await this.#scope.delete(keyOf(id))
      removed.push(id)
    }
    return removed
  }
}
