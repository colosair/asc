// Execution Grant 발급 — 승인된 요청 하나를 밖으로 내보낼 수 있는 일회용 계약을 만든다.
//
// 승인은 게시 권한이 아니다 (OM §11.8). APPROVED는 "사람이 내용에 동의했다"까지이고,
// 실제로 무엇을 어디에 쓸 것인지는 Controller가 별도로 지정한다. 그래서 Grant는 Policy
// hierarchy의 예외가 아니라 그 바깥에서 새로 만들어지는 계약이다 (OM §5.2·§11.5).
//
// 승인 즉시 자동 발급하지 않는 이유도 같다. 두 행위를 붙여 놓으면 "승인했으니 나갔겠지"가
// 되고, 무엇이 언제 나갔는지 사람이 따로 붙잡을 지점이 사라진다.

import { ExecutionGrant, type CanonicalSnapshot } from '../model/entities.ts'
import type { IdentityBinding } from '../../ports/approval.ts'
import type { StateStore } from '../../ports/state-store.ts'

export type IssueGrantInput = {
  grantId: string
  requestId: string
  /** 발급자. 그 요청의 승인 권한자로 매핑돼 있어야 한다 — 임의 문자열로는 발급되지 않는다. */
  issuedBy: string
  /** 발급이 들어온 표면. Identity 검증은 채널까지 함께 본다. */
  channel: string
  /** '<adapter>.<행위>' 형태의 행위 키. Adapter가 해석한다. */
  action: string
  target: string
  expiresAt?: string
  /** 이 계약으로 허용되는 행위 목록. 비우면 `action` 하나만 허용된다. */
  allowedWrites?: string[]
  issuedAt: string
}

/**
 * 세션이 만든 결과를 내보내는 경우의 입력 (0.7.0).
 *
 * 초기 모델에는 이 자리가 없었다. Grant 는 `Monitor → Request → Approval` 을 위해
 * 생겼고, 정작 **계약 안에서 일한 세션이 만든 결과**가 밖으로 나갈 자리는 없었다.
 * 그래서 실제 작업은 관계없는 판단 요청을 하나 지어내 그 위에 얹혀야 했고, 지어낸
 * 요청은 승인 기록을 흐린다.
 *
 * 여기서 승인은 **사람이 지금 그렇게 하라고 말한 것**이다. 그 말과 함께 온 내용이
 * payload 이고, 호출자가 지어내지 않는다. 범위는 넓히지 않는다 — 승인된 것은 이
 * 행위 하나이며 `allowedWrites` 가 그 경계다.
 */
export type IssueForSessionInput = {
  grantId: string
  sessionId: string
  /** 발급자. 승인 권한자로 매핑돼 있어야 한다 — 임의 문자열로는 발급되지 않는다. */
  issuedBy: string
  channel: string
  action: string
  target: string
  /** 사람이 내보내라고 한 내용 그대로. */
  payload: string
  expiresAt?: string
  allowedWrites?: string[]
  issuedAt: string
  /** 게시 직전 대조할 기준 (OM §11.9). 없으면 대조하지 않는다. */
  snapshot?: CanonicalSnapshot[]
}

export type IssueFailure =
  | { kind: 'REQUEST_NOT_FOUND' }
  | { kind: 'NOT_APPROVED'; status: string }
  | { kind: 'FORBIDDEN_ISSUER' }
  | { kind: 'NO_PAYLOAD' }
  | { kind: 'GRANT_EXISTS' }
  | { kind: 'SESSION_NOT_FOUND' }
  /** 아직 일하지 않은 세션의 결과는 없다. */
  | { kind: 'SESSION_NOT_RUNNABLE'; status: string }

export type IssueResult = { ok: true; grant: ExecutionGrant } | { ok: false; failure: IssueFailure }

export class GrantService {
  #store: StateStore
  #identity: IdentityBinding

  constructor(store: StateStore, identity: IdentityBinding) {
    this.#store = store
    this.#identity = identity
  }

  async issue(input: IssueGrantInput): Promise<IssueResult> {
    const request = await this.#store.get('request', input.requestId)
    if (!request) return { ok: false, failure: { kind: 'REQUEST_NOT_FOUND' } }
    if (request.status !== 'APPROVED') {
      return { ok: false, failure: { kind: 'NOT_APPROVED', status: request.status } }
    }

    // 발급도 Controller의 행위다. 승인만 검증하고 발급을 열어 두면 승인 이후 구간이
    // 통째로 무방비가 된다 — 정작 외부로 나가는 권한은 여기서 만들어지기 때문이다.
    const authorized = await this.#identity.verify({
      channel: input.channel,
      actor: input.issuedBy,
      authorizedApprover: request.authorizedApprover,
    })
    if (!authorized) {
      await this.#store.appendHistory({
        at: input.issuedAt,
        actor: input.issuedBy,
        kind: 'grant_rejected',
        ref: input.requestId,
        detail: `unauthorized issuer via ${input.channel} (${input.action})`,
      })
      return { ok: false, failure: { kind: 'FORBIDDEN_ISSUER' } }
    }

    // 내보낼 내용은 승인된 것에서만 나온다. 호출자가 payload를 주입할 수 있으면
    // 사람이 본 적 없는 글이 사람의 승인 기록을 달고 나갈 수 있다.
    // 다른 내용을 보내려면 새 Decision을 받아야 한다.
    const payload = request.decision?.revision ?? request.draft
    if (payload === undefined) return { ok: false, failure: { kind: 'NO_PAYLOAD' } }

    const grant = ExecutionGrant.parse({
      id: input.grantId,
      version: 0,
      requestId: request.id,
      status: 'READY',
      issuedBy: input.issuedBy,
      issuedAt: input.issuedAt,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      singleUse: true,
      action: input.action,
      target: input.target,
      payload,
      // 이 시점의 정본이 Drift Guard의 기준선이 된다 (OM §11.9)
      snapshot: request.snapshot,
      ...(request.source.threadLastEventId !== undefined
        ? { threadLastEventId: request.source.threadLastEventId }
        : {}),
      allowedWrites: input.allowedWrites ?? [input.action],
    })

    const created = await this.#store.create('grant', grant)
    if (!created.ok) return { ok: false, failure: { kind: 'GRANT_EXISTS' } }

    await this.#store.appendHistory({
      at: input.issuedAt,
      actor: input.issuedBy,
      kind: 'grant_issued',
      ref: grant.id,
      detail: `${grant.action} → ${grant.target} (request ${grant.requestId})`,
    })
    return { ok: true, grant: created.entity }
  }

  /**
   * 세션이 만든 결과를 내보낼 계약. 근거는 그 세션이고, 승인은 사람이 지금 한 말이다.
   *
   * 검증은 두 가지다: 그 세션이 실제로 있고 일한 적이 있는가, 그리고 이 사람이 승인
   * 권한자인가. 뒤엣것은 요청 경로와 같은 통로를 쓴다 — 발급이 열려 있으면 승인 이후
   * 구간이 통째로 무방비가 되고, 그것은 근거가 요청이든 세션이든 같다.
   */
  async issueForSession(input: IssueForSessionInput): Promise<IssueResult> {
    const session = await this.#store.get('session', input.sessionId)
    if (!session) return { ok: false, failure: { kind: 'SESSION_NOT_FOUND' } }
    // 아직 시작하지 않은 계약에는 내보낼 결과가 없다.
    if (session.status === 'READY') {
      return { ok: false, failure: { kind: 'SESSION_NOT_RUNNABLE', status: session.status } }
    }
    if (input.payload.length === 0) return { ok: false, failure: { kind: 'NO_PAYLOAD' } }

    const authorized = await this.#identity.verify({
      channel: input.channel,
      actor: input.issuedBy,
      authorizedApprover: input.issuedBy,
    })
    if (!authorized) {
      await this.#store.appendHistory({
        at: input.issuedAt,
        actor: input.issuedBy,
        kind: 'grant_rejected',
        ref: input.sessionId,
        detail: `unauthorized issuer via ${input.channel} (${input.action})`,
      })
      return { ok: false, failure: { kind: 'FORBIDDEN_ISSUER' } }
    }

    const grant = ExecutionGrant.parse({
      id: input.grantId,
      version: 0,
      sessionId: session.id,
      status: 'READY',
      issuedBy: input.issuedBy,
      issuedAt: input.issuedAt,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      singleUse: true,
      action: input.action,
      target: input.target,
      payload: input.payload,
      snapshot: input.snapshot ?? [],
      allowedWrites: input.allowedWrites ?? [input.action],
    })

    const created = await this.#store.create('grant', grant)
    if (!created.ok) return { ok: false, failure: { kind: 'GRANT_EXISTS' } }

    await this.#store.appendHistory({
      at: input.issuedAt,
      actor: input.issuedBy,
      kind: 'grant_issued',
      ref: grant.id,
      detail: `${grant.action} → ${grant.target} (session ${session.id})`,
    })
    return { ok: true, grant: created.entity }
  }
}
