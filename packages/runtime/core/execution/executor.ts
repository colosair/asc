// Ephemeral Executor — Grant 하나를 집어 외부 행위 한 번을 수행하고 끝난다.
//
// 이 파일이 시스템에서 유일하게 외부 write를 부르는 지점이다. 순서가 곧 안전장치다:
//
//   CLAIM (원자적) → 계약 범위 확인 → Drift Guard → 실행 직전 재검수(읽기)
//   → 외부 행위 1회 → 되돌려 읽기 → EXECUTED
//
// CLAIM을 먼저 하는 이유는 두 Executor가 같은 Grant로 같은 댓글을 두 번 달지 않게 하기
// 위해서고, Drift Guard를 그 다음에 두는 이유는 승인 이후 스레드가 움직였을 때 오래된
// 초안이 나가지 않게 하기 위해서다 (OM §11.9). 둘 다 실패는 조용히 넘어가지 않는다.
//
// 0.8.0 에서 앞뒤로 한 마디씩 붙었다. 앞의 재검수는 승인이 딛고 선 사실이 아직 그대로인지
// **읽기만으로** 확인하고(§D), 뒤의 되돌려 읽기는 명령이 0 으로 끝났다는 것과 밖에 그것이
// 있다는 것이 다르다는 사실을 다룬다(§L·§M·§N). 둘 다 판정은 Core 가 하고, 사실은 Port 가
// 읽어 온다 — 그래야 사람이 보는 검수와 Agent 가 따르는 검수가 같은 판정이다.

import type { ExecutionGrant } from '../model/entities.ts'
import { transitionGrant, transitionRequest } from '../model/transitions.ts'
import { reviewExternalAction, verifyAgainst, type ReviewOutcome } from './remote-review.ts'
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
  /** 실행 직전 재검수가 "지금 이 행동은 성립하지 않는다" 로 답했다. 밖은 그대로다. */
  | { ok: false; reason: 'NOT_EXECUTABLE'; detail: string; review: ReviewOutcome }
  /** 사람이 봐야 하는 것이 남아 있다 — 범위 밖 대상·모호함. 밖은 그대로다. */
  | { ok: false; reason: 'REVIEW_REQUIRED'; detail: string; review: ReviewOutcome }
  /** 밖에서 거절했다. 나간 것이 없다는 것이 확인된 실패다. */
  | { ok: false; reason: 'REJECTED'; detail: string }
  /**
   * 나갔는지 모른다 (0.8.0 §P). 다시 부르지 않는다 — 다시 부르면 같은 것이 두 번 나갈 수
   * 있고, 그것이 이 상태에서 가장 나쁜 결과다. Grant 는 집힌 채로 남아 재사용되지 않는다.
   */
  | { ok: false; reason: 'UNCERTAIN'; detail: string }
  /**
   * 나갔는데 되돌려 읽은 것이 기대와 다르다. 성공이라고 적지 않는다 — Grant 는 소진되되
   * `EXECUTED` 가 되지 않는다. 그 상태는 밖에서 "성공적으로 끝남" 으로 읽히기 때문이다.
   */
  | { ok: false; reason: 'NOT_VERIFIED'; detail: string; resultRef: string; mismatches: string[] }
  | { ok: false; reason: 'ACTION_FAILED'; detail: string }

export type ExecutorDeps = {
  store: StateStore
  scm: ScmPort
  /** 이 Physical Run의 식별자. 누가 집었는지 Grant에 남는다. */
  runId: string
  /**
   * 되돌려 읽을 수 없는 행위를 실행하지 않는다 (0.8.0 보정 P1-2).
   *
   * 강제가 서 있는 자리(AUTO·실행 축을 읽지 못한 자리)에서 참이다. 사람이 실행하는
   * 자리에서는 그 판단이 사람의 것이므로 호출자가 정한다.
   */
  requireVerification?: boolean
  now?: () => string
}

export class Executor {
  #store: StateStore
  #scm: ScmPort
  #runId: string
  #requireVerification: boolean
  #now: () => string

  constructor(deps: ExecutorDeps) {
    this.#store = deps.store
    this.#scm = deps.scm
    this.#runId = deps.runId
    this.#requireVerification = deps.requireVerification ?? false
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
      await this.#close(grant.id, 'INVALIDATED', this.#now(), detail, 'FORBIDDEN')
      return { ok: false, reason: 'FORBIDDEN_ACTION', detail }
    }

    // 3. Drift Guard — 승인 시점의 기준선과 지금을 대조한다
    const drift = await this.#detectDrift(claimed.entity)
    if (drift) {
      await this.#close(grant.id, 'INVALIDATED', this.#now(), drift, 'DRIFT')
      return { ok: false, reason: 'DRIFT', detail: drift }
    }

    const action = {
      action: claimed.entity.action,
      target: claimed.entity.target,
      payload: claimed.entity.payload,
    }

    // 4. 실행 직전 재검수 (0.8.0 §D). 승인은 그때의 사실 위에서 났다 — 그 사실이 아직
    //    그대로인지 **읽기만으로** 확인한다. 여기서 멈추면 밖은 하나도 바뀌지 않는다.
    let review: ReviewOutcome | undefined
    if (this.#scm.review) {
      const facts = await this.#scm.review(action)
      review = reviewExternalAction({
        action: action.action,
        target: action.target,
        facts,
        ...(claimed.entity.basis ? { basis: claimed.entity.basis } : {}),
        ...(this.#requireVerification ? { requireVerification: true } : {}),
      })
      if (review.verdict !== 'READY') {
        const detail = review.findings.map((finding) => `${finding.code}: ${finding.detail}`).join('; ')
        await this.#close(
          grant.id,
          'INVALIDATED',
          this.#now(),
          `재검수 ${review.verdict}: ${detail}`,
          review.verdict === 'NOT_EXECUTABLE' ? 'NOT_EXECUTABLE' : 'REVIEW_REQUIRED',
        )
        return review.verdict === 'NOT_EXECUTABLE'
          ? { ok: false, reason: 'NOT_EXECUTABLE', detail, review }
          : { ok: false, reason: 'REVIEW_REQUIRED', detail, review }
      }
    }

    // 5. 외부 행위 1회. payload는 승인된 내용 그대로 나간다
    const result = await this.#scm.execute(action)
    if (!result.ok) {
      // **나갔는지 모르는 실패와 거절을 가른다** (0.8.0 §P). 어느 쪽이든 다시 부르지
      // 않는다 — 모른 채 재시도하면 같은 것이 두 번 나갈 수 있다.
      if (uncertain(result.error)) {
        await this.#store.appendHistory({
          at: this.#now(),
          actor: this.#runId,
          kind: 'external_action_uncertain',
          ref: grant.id,
          detail: `${grant.action} → ${grant.target}: ${result.error}`,
        })
        // **CLAIMED 로 남기지 않는다** (0.8.0 보정 P1-1). 그 상태는 이 시스템에서 "지금
        // 누가 집고 실행 중" 을 뜻하고(READY→CLAIMED→EXECUTED/INVALIDATED), 아무도 실행
        // 중이 아닌 Grant 를 거기 두면 화면과 감사가 영영 틀린 말을 한다. terminal 로
        // 닫되 **이유가 UNCERTAIN** 이다 — 재실행은 막히고, 성공도 실패도 주장하지 않는다.
        await this.#close(
          grant.id,
          'INVALIDATED',
          this.#now(),
          `결과 불명: ${result.error}`,
          'UNCERTAIN',
        )
        return { ok: false, reason: 'UNCERTAIN', detail: result.error }
      }
      await this.#close(grant.id, 'INVALIDATED', this.#now(), `실행 실패: ${result.error}`, 'REJECTED')
      return { ok: false, reason: 'REJECTED', detail: result.error }
    }

    // 6. 되돌려 읽기 (0.8.0 §L·§M·§N). exit 0 은 성공이 아니다.
    let mismatches: string[] = []
    if (this.#scm.verify && review) {
      const read = await this.#scm.verify(action, { resultRef: result.resultRef })
      if (!read.unsupported) {
        const comparable = Object.keys(review.expected).filter(
          (key) => key !== 'action' && key !== 'target' && read.observed[key] !== undefined,
        )
        const verified = verifyAgainst(review.expected, read.observed, comparable)
        mismatches = comparable.length === 0 ? ['nothing could be read back to compare'] : verified.mismatches
      }
    }

    // 7. 소비 기록. **되돌려 읽은 것이 다르면 EXECUTED 로 적지 않는다** (P0-5) —
    //    그 상태는 밖에서 "성공적으로 끝남" 으로 읽힌다. 나간 것은 나갔으므로 재사용은
    //    막되(terminal), 성공은 주장하지 않는다.
    const executedAt = this.#now()
    if (mismatches.length > 0) {
      await this.#close(
        grant.id,
        'INVALIDATED',
        executedAt,
        `되돌려 읽은 것이 다르다: ${mismatches.join('; ')}`,
        'NOT_VERIFIED',
        result.resultRef,
      )
      await this.#store.appendHistory({
        at: executedAt,
        actor: this.#runId,
        kind: 'external_action_unverified',
        ref: grant.id,
        detail: `${grant.action} → ${grant.target} = ${result.resultRef} (unverified: ${mismatches.join('; ')})`,
      })
      return {
        ok: false,
        reason: 'NOT_VERIFIED',
        detail: mismatches.join('; '),
        resultRef: result.resultRef,
        mismatches,
      }
    }
    const executed = await applyTransition(this.#store, 'grant', grant.id, (g) =>
      transitionGrant(g, 'EXECUTED', 'executor', { resultRef: result.resultRef, consumedAt: executedAt }),
    )
    if (!executed.ok) return { ok: false, reason: 'CLAIMED_BY_OTHER' }

    // 8. 요청이 근거였다면 그 요청을 닫는다 — 외부에 무엇이 남았는지 요청에서 바로
    //    따라갈 수 있어야 한다. 세션이 근거인 경우에는 닫을 요청이 없고, 그 자취는
    //    아래 History 와 세션 자신의 기록에 남는다.
    if (claimed.entity.requestId) {
      await applyTransition(this.#store, 'request', claimed.entity.requestId, (r) =>
        transitionRequest(r, 'DONE', 'executor', { resultRef: result.resultRef }),
      )
    }
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

  /**
   * terminal 로 닫는다. **이유를 함께 적는다** — 상태 다섯 개만으로는 "왜" 가 남지 않고,
   * 소진된 것과 성공한 것을 가르는 것도 그 이유다 (0.8.0 보정 P0-5).
   */
  async #close(
    grantId: string,
    to: 'INVALIDATED' | 'EXPIRED',
    at: string,
    detail: string,
    resolution?: ExecutionGrant['resolution'],
    resultRef?: string,
  ): Promise<void> {
    await applyTransition(this.#store, 'grant', grantId, (g) =>
      transitionGrant(g, to, 'executor', {
        ...(resolution ? { resolution } : {}),
        ...(resultRef ? { resultRef } : {}),
      }),
    )
    await this.#store.appendHistory({ at, actor: this.#runId, kind: `grant_${to.toLowerCase()}`, ref: grantId, detail })
  }
}

/**
 * 이 실패가 "나가지 않았다" 인가, "모른다" 인가 (0.8.0 §P).
 *
 * 시간이 끊기거나 연결이 죽은 자리에서는 요청이 도착했는지 알 수 없다. 그 상태를 실패로
 * 적고 재시도하면 같은 것이 두 번 나갈 수 있으므로, 모르는 것은 모른다고 적는다.
 */
function uncertain(error: string): boolean {
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|aborted|network/i.test(error)
}
