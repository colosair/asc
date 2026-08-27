// Ephemeral Executor — Grant 하나를 집어 외부 행위 한 번을 수행하고 끝난다.
//
// 이 파일이 시스템에서 유일하게 외부 write를 부르는 지점이다. 순서가 곧 안전장치다:
//
//   CLAIM (원자적)  →  계약 범위 확인  →  Drift Guard  →  외부 행위 1회  →  EXECUTED
//
// CLAIM을 먼저 하는 이유는 두 Executor가 같은 Grant로 같은 댓글을 두 번 달지 않게 하기
// 위해서고, Drift Guard를 그 다음에 두는 이유는 승인 이후 스레드가 움직였을 때 오래된
// 초안이 나가지 않게 하기 위해서다 (OM §11.9). 둘 다 실패는 조용히 넘어가지 않는다.

import type { ExecutionGrant } from '../model/entities.ts'
import { transitionGrant, transitionRequest } from '../model/transitions.ts'
import type { ScmPort } from '../../ports/scm.ts'
import type { StateStore } from '../../ports/state-store.ts'
import { applyTransition } from '../runtime/store-ops.ts'

export type ExecuteOutcome =
  | { ok: true; grant: ExecutionGrant; resultRef: string }
  | { ok: false; reason: 'NOT_FOUND' }
  /** 이미 누군가 집었거나 끝난 Grant. 재실행이 막히는 지점이다. */
  | { ok: false; reason: 'NOT_CLAIMABLE'; status: ExecutionGrant['status'] }
  | { ok: false; reason: 'CLAIMED_BY_OTHER' }
  | { ok: false; reason: 'EXPIRED' }
  /** 계약이 허용하지 않는 행위다 — 계약서와 다른 일을 하려는 것이므로 실행하지 않는다. */
  | { ok: false; reason: 'FORBIDDEN_ACTION'; detail: string }
  /** 승인 이후 대상이 움직였다 — 실행하지 않고 되돌린다. */
  | { ok: false; reason: 'DRIFT'; detail: string }
  | { ok: false; reason: 'ACTION_FAILED'; detail: string }

export type ExecutorDeps = {
  store: StateStore
  scm: ScmPort
  /** 이 Physical Run의 식별자. 누가 집었는지 Grant에 남는다. */
  runId: string
  now?: () => string
}

export class Executor {
  #store: StateStore
  #scm: ScmPort
  #runId: string
  #now: () => string

  constructor(deps: ExecutorDeps) {
    this.#store = deps.store
    this.#scm = deps.scm
    this.#runId = deps.runId
    this.#now = deps.now ?? (() => new Date().toISOString())
  }

  async run(grantId: string): Promise<ExecuteOutcome> {
    const grant = await this.#store.get('grant', grantId)
    if (!grant) return { ok: false, reason: 'NOT_FOUND' }
    if (grant.status !== 'READY') return { ok: false, reason: 'NOT_CLAIMABLE', status: grant.status }

    const at = this.#now()
    if (grant.expiresAt && grant.expiresAt <= at) {
      await this.#close(grant.id, 'EXPIRED', at, '만료')
      return { ok: false, reason: 'EXPIRED' }
    }

    // 1. CLAIM — 두 Run이 동시에 들어와도 하나만 통과한다
    const claimed = await applyTransition(this.#store, 'grant', grant.id, (g) =>
      transitionGrant(g, 'CLAIMED', 'executor', { claimedBy: this.#runId }),
    )
    if (!claimed.ok) {
      if (claimed.reason === 'NOT_FOUND') return { ok: false, reason: 'NOT_FOUND' }
      return { ok: false, reason: 'CLAIMED_BY_OTHER' }
    }

    // 2. 계약 범위 확인 — 허용 목록에 없는 행위는 하지 않는다 (fail-closed).
    //    계약 자체가 모순이면 외부 상태를 조회할 이유도 없으므로 Drift Guard보다 앞에 둔다.
    if (!claimed.entity.allowedWrites.includes(claimed.entity.action)) {
      const detail = `'${claimed.entity.action}' is not in allowed writes [${claimed.entity.allowedWrites.join(', ')}]`
      await this.#close(grant.id, 'INVALIDATED', this.#now(), detail)
      return { ok: false, reason: 'FORBIDDEN_ACTION', detail }
    }

    // 3. Drift Guard — 승인 시점의 기준선과 지금을 대조한다
    const drift = await this.#detectDrift(claimed.entity)
    if (drift) {
      await this.#close(grant.id, 'INVALIDATED', this.#now(), drift)
      return { ok: false, reason: 'DRIFT', detail: drift }
    }

    // 4. 외부 행위 1회. payload는 승인된 내용 그대로 나간다
    const result = await this.#scm.execute({
      action: claimed.entity.action,
      target: claimed.entity.target,
      payload: claimed.entity.payload,
    })
    if (!result.ok) {
      // 재시도하지 않는다. 실패한 호출이 정말 나가지 않았는지는 여기서 알 수 없고,
      // 모른 채 다시 부르면 같은 글이 두 번 올라간다. 사람이 확인하고 새 Grant를 낸다.
      await this.#close(grant.id, 'INVALIDATED', this.#now(), `실행 실패: ${result.error}`)
      return { ok: false, reason: 'ACTION_FAILED', detail: result.error }
    }

    // 5. 소비 기록 — 성공한 Grant는 다시 쓸 수 없다
    const executedAt = this.#now()
    const executed = await applyTransition(this.#store, 'grant', grant.id, (g) =>
      transitionGrant(g, 'EXECUTED', 'executor', { resultRef: result.resultRef, consumedAt: executedAt }),
    )
    if (!executed.ok) return { ok: false, reason: 'CLAIMED_BY_OTHER' }

    // 6. 요청을 닫는다. 외부에 무엇이 남았는지 요청에서 바로 따라갈 수 있어야 한다
    await applyTransition(this.#store, 'request', claimed.entity.requestId, (r) =>
      transitionRequest(r, 'DONE', 'executor', { resultRef: result.resultRef }),
    )
    await this.#store.appendHistory({
      at: executedAt,
      actor: this.#runId,
      kind: 'external_action',
      ref: grant.id,
      detail: `${grant.action} → ${grant.target} = ${result.resultRef}`,
    })

    return { ok: true, grant: executed.entity, resultRef: result.resultRef }
  }

  /** 무엇이 달라졌는지 문장으로 돌려준다. 달라진 것이 없으면 null. */
  async #detectDrift(grant: ExecutionGrant): Promise<string | null> {
    if (grant.threadLastEventId !== undefined) {
      const thread = await this.#scm.getThread(grant.target)
      if (thread.missing) return `대상 스레드를 찾을 수 없다 (${grant.target})`
      if (thread.lastEventId !== grant.threadLastEventId) {
        return `스레드에 새 이벤트가 있다 (${grant.threadLastEventId} → ${thread.lastEventId})`
      }
    }

    if (grant.snapshot.length > 0) {
      const current = await this.#scm.getBaselines(grant.snapshot.map((s) => ({ sourceId: s.sourceId })))
      for (const now of current) {
        const before = grant.snapshot.find((s) => s.sourceId === now.sourceId)?.baseline
        if (before !== now.baseline) return `정본이 바뀌었다 (${now.sourceId}: ${before} → ${now.baseline})`
      }
    }
    return null
  }

  async #close(
    grantId: string,
    to: 'INVALIDATED' | 'EXPIRED',
    at: string,
    detail: string,
  ): Promise<void> {
    await applyTransition(this.#store, 'grant', grantId, (g) => transitionGrant(g, to, 'executor'))
    await this.#store.appendHistory({ at, actor: this.#runId, kind: `grant_${to.toLowerCase()}`, ref: grantId, detail })
  }
}
