// Execution Grant 발급 — 승인된 요청 하나를 밖으로 내보낼 수 있는 일회용 계약을 만든다.
//
// 승인은 게시 권한이 아니다 (OM §11.8). APPROVED는 "사람이 내용에 동의했다"까지이고,
// 실제로 무엇을 어디에 쓸 것인지는 Controller가 별도로 지정한다. 그래서 Grant는 Policy
// hierarchy의 예외가 아니라 그 바깥에서 새로 만들어지는 계약이다 (OM §5.2·§11.5).
//
// 승인 즉시 자동 발급하지 않는 이유도 같다. 두 행위를 붙여 놓으면 "승인했으니 나갔겠지"가
// 되고, 무엇이 언제 나갔는지 사람이 따로 붙잡을 지점이 사라진다.

import { ExecutionGrant } from '../model/entities.ts'
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

export type IssueFailure =
  | { kind: 'REQUEST_NOT_FOUND' }
  | { kind: 'NOT_APPROVED'; status: string }
  | { kind: 'FORBIDDEN_ISSUER' }
  | { kind: 'NO_PAYLOAD' }
  | { kind: 'GRANT_EXISTS' }

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
}
