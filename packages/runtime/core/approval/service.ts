// 결정 제출 경로 — 사람의 명시적 의사표현을 ApprovalDecision으로 받아 상태를 옮긴다.
//
// 조회(LocalOperator)와 결정을 다른 파일에 둔 이유는 문 하나 차이다. 조회 객체가
// submit을 갖고 있으면 요청을 읽던 Agent가 그대로 승인까지 이어가기 쉬워지고,
// "AI 판단 ≠ Controller Decision"이 구조가 아니라 습관에 기대게 된다 (C-01 §5).
//
// **신뢰 경계 (현 단계 계약)**: `asc inbox decide` 같은 결정 표면을 사람이 조작하는
// 표면으로 간주하고, Identity Binding으로 *승인자 identity*를 검증한다. 이것은
// "지금 키보드를 두드린 것이 사람이다"라는 기술적 증명이 아니다 — 셸을 쓸 수 있는
// Agent는 매핑된 이름을 댈 수 있다. OS 인증·서명·대화형 확인 같은 강한 local
// authentication은 별도 후속 범위이며, 그전까지 이 계층이 막는 것은 "권한자로 지정되지
// 않은 이름의 결정"까지다. 매핑에 없는 이름은 거절되고 시도가 History에 남는다 (OM §11.6).

import type { ApprovalDecision, ApprovalRequest, DecisionKind } from '../model/entities.ts'
import { transitionRequest } from '../model/transitions.ts'
import type { ApprovalChannel, DecisionOutcome, DecisionSink, IdentityBinding } from '../../ports/approval.ts'
import type { ScmPort } from '../../ports/scm.ts'
import type { StateStore } from '../../ports/state-store.ts'
import { assembleView, assess, buildOverlay } from '../view/build-view.ts'
import type { DecisionView } from '../view/decision-view.ts'

/**
 * 사람의 선택이 요청을 어느 상태로 옮기는가.
 * `revise`가 APPROVED로 가는 것은 "고쳐서 승인한다"이지 별도 상태가 아니다 —
 * 무엇을 고쳤는지는 revision에 남고, 실제 실행은 그 revision을 payload로 쓴다.
 */
const TARGET_STATUS: Record<DecisionKind, ApprovalRequest['status']> = {
  approve: 'APPROVED',
  revise: 'APPROVED',
  queue: 'QUEUED',
  defer: 'DEFERRED',
  dismiss: 'DISMISSED',
}

/**
 * 아직 사람의 판단을 더 받을 수 있는 상태.
 * 보류는 결정을 미룬 것이지 끝낸 것이 아니므로 다시 판단할 수 있어야 한다 (OM §11.2).
 * 판정 기준을 "결정 기록이 있는가"로 두면 defer가 사실상 terminal이 되어버린다 —
 * 기록은 남기되 상태로 판단한다.
 */
const REOPENABLE = new Set<ApprovalRequest['status']>(['AWAITING_APPROVAL', 'DEFERRED'])

export type ApprovalDeps = {
  store: StateStore
  identity: IdentityBinding
  /** 결정 후 표시를 갱신할 채널들. 실패해도 결정은 유효하다 (C-01 §9). */
  channels?: readonly ApprovalChannel[]
  scm?: ScmPort
  now?: () => string
}

export class ApprovalService implements DecisionSink {
  #store: StateStore
  #identity: IdentityBinding
  #channels: readonly ApprovalChannel[]
  #scm: ScmPort | undefined
  #now: () => string

  constructor(deps: ApprovalDeps) {
    this.#store = deps.store
    this.#identity = deps.identity
    this.#channels = deps.channels ?? []
    this.#scm = deps.scm
    this.#now = deps.now ?? (() => new Date().toISOString())
  }

  async submit(decision: ApprovalDecision): Promise<DecisionOutcome> {
    const request = await this.#store.get('request', decision.requestId)
    if (!request) return { ok: false, reason: 'NOT_FOUND' }

    const authorized = await this.#identity.verify({
      channel: decision.channel,
      actor: decision.actor,
      authorizedApprover: request.authorizedApprover,
    })
    if (!authorized) {
      // 거절로 끝내지 않고 남긴다 — 누가 승인하려 했는지는 나중에 물을 수 있는 질문이다
      await this.#store.appendHistory({
        at: this.#now(),
        actor: decision.actor,
        kind: 'decision_rejected',
        ref: request.id,
        detail: `unauthorized via ${decision.channel} (${decision.kind})`,
      })
      return { ok: false, reason: 'FORBIDDEN_ACTOR' }
    }

    if (!request.allowedDecisions.includes(decision.kind)) return { ok: false, reason: 'NOT_ALLOWED_DECISION' }
    if (request.expiresAt && request.expiresAt <= decision.decidedAt) return { ok: false, reason: 'EXPIRED' }

    // 읽은 뒤 상황이 바뀌었는지부터 본다. 끝난 요청과 그 사이 한 번 더 움직인 요청은
    // 사용자에게 다른 이야기이므로 이유를 갈라서 돌려준다.
    if (!REOPENABLE.has(request.status)) {
      return { ok: false, reason: 'ALREADY_DECIDED', view: await this.#view(request) }
    }
    if (request.version !== decision.expectedVersion) {
      return { ok: false, reason: 'STALE', view: await this.#view(request) }
    }

    const next = transitionRequest(request, TARGET_STATUS[decision.kind], 'controller', {
      decision: {
        kind: decision.kind,
        actor: decision.actor,
        channel: decision.channel,
        ...(decision.revision !== undefined ? { revision: decision.revision } : {}),
        decidedAt: decision.decidedAt,
      },
    })

    const saved = await this.#store.compareAndSet('request', request.id, decision.expectedVersion, next)
    if (!saved.ok) {
      if (saved.reason === 'NOT_FOUND') return { ok: false, reason: 'NOT_FOUND' }
      // 다른 채널이 먼저 들어왔다. 그쪽이 요청을 끝냈다면 이미 결정된 것이고,
      // 아직 판단을 더 받을 수 있는 상태라면 다시 보고 결정할 일이다.
      const view = await this.#view(saved.current)
      return REOPENABLE.has(saved.current.status)
        ? { ok: false, reason: 'STALE', view }
        : { ok: false, reason: 'ALREADY_DECIDED', view }
    }

    await this.#store.appendHistory({
      at: decision.decidedAt,
      actor: decision.actor,
      kind: 'decision',
      ref: request.id,
      detail: `${decision.kind} via ${decision.channel}${decision.revision ? ' (revised)' : ''}`,
    })

    const view = await this.#view(saved.entity)
    await this.#notifyChannels(view)
    return { ok: true, view }
  }

  /** 표시 갱신은 best-effort다 — 채널이 죽어도 결정은 이미 확정됐고, 낡은 버튼은 CAS가 막는다. */
  async #notifyChannels(view: DecisionView): Promise<void> {
    for (const channel of this.#channels) {
      try {
        await channel.update(view)
      } catch {
        // 채널 사정은 canonical state에 영향을 주지 않는다
      }
    }
  }

  async #view(request: ApprovalRequest): Promise<DecisionView> {
    const overlay = await buildOverlay(request, {
      control: await this.#store.getControlState(),
      observedAt: this.#now(),
      ...(this.#scm ? { scm: this.#scm } : {}),
    })
    return assembleView(request, await assess(request, overlay, this.#scm), overlay)
  }
}
