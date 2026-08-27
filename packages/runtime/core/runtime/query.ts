// Bounded Query — 다른 파트에 묻되, 답할 수 있는 형태로만 묻는다 (C-04 §3~§5).
//
// 왜 자유형 질문을 막는가: "이거 어떻게 할까요?" 는 무엇에 답해야 하는지도, 답이 무엇을
// 풀어 주는지도 말하지 않는다. 받은 쪽은 판단할 근거가 없으니 다시 미루고, 그렇게 결정이
// Agent 사이를 돈다. 실제로 도는 동안 세 세션의 context가 소모되고 사람은 마지막에야 안다.
//
// 이 모듈이 하는 일과 하지 않는 일:
//   한다   — 질의를 구조로 받고, 답을 한 번만 받고, 되던지기를 발행 시점에 막고, 표면화
//   안 한다 — 승인·Grant·예외·범위 확대. 답 하나로 권한이 생기는 경로는 없다 (C-03 §4)
//
// DECIDE는 "그 결정의 주인이 결론을 냈다"까지다. Human Approval이 아니고, 그 자체로
// 어떤 Core 전이도 일으키지 않는다. 사람 결정이 필요하면 이 답을 근거로 올릴 뿐이다.
//
// 저장은 closure.ts와 같은 이유로 전부 setIfAbsent 위에 선다 — 잃는 것이 표시값이 아니라
// 누가 무엇을 물었고 누가 답했는가이기 때문이다. 답은 한 번만 쓰이고 덮이지 않는다.

import { z } from 'zod'

import { QUERY_ID } from '../model/ids.ts'
import { lookupAuthority, type OwnershipMap } from '../policy/ownership.ts'
import type { ScopedStore } from '../../ports/state-store.ts'

export const BoundedQuery = z.object({
  id: z.string().regex(QUERY_ID),
  /** 물은 쪽. 답을 받은 뒤 흐름이 돌아갈 자리다. */
  ownerSessionId: z.string().min(1),
  /** 물은 쪽의 파트. 되던지기 판정의 기준이라 발행 시점 스냅샷으로 박아 둔다. */
  ownerRole: z.string().min(1).optional(),
  /** 어느 결정을 묻는가 (decision domain). 누구에게가 아니라 무엇에 대해서다. */
  requestedAuthority: z.string().min(1),
  question: z.string().min(1),
  context: z.string().optional(),
  /**
   * 답이 없을 때 물은 쪽이 취할 기본값. 이것이 있으면 질문은 차단이 아니라 확인이 되고,
   * 없으면 blockingScope가 실제로 막힌다.
   */
  proposedDefault: z.string().optional(),
  /** 이 답이 없으면 막히는 범위. 비어 있으면 "막히지 않는다"는 뜻이다. */
  blockingScope: z.string().optional(),
  expectedResponse: z.enum(['DECIDE', 'ANSWER']).default('DECIDE'),
  /** 이 질의가 어느 질의에서 파생했는가. 되던지기는 여기로 드러난다. */
  inReplyTo: z.string().regex(QUERY_ID).optional(),
  openedAt: z.string().min(1),
})
export type BoundedQuery = z.infer<typeof BoundedQuery>

export const QueryAnswer = z.object({
  kind: z.enum(['DECIDE', 'ANSWER', 'ESCALATE']),
  /** 답한 파트. DECIDE는 이 값이 그 결정의 주인일 때만 성립한다. */
  byRole: z.string().min(1),
  body: z.string().min(1),
  /** ESCALATE 대상. Agent가 아니라 사람·권한자여야 한다 (C-04 §4.1). */
  escalateTo: z.string().optional(),
  at: z.string().min(1),
})
export type QueryAnswer = z.infer<typeof QueryAnswer>

export type OpenOutcome =
  | { ok: true; query: BoundedQuery }
  | { ok: false; reason: 'INVALID_ID'; detail: string }
  | { ok: false; reason: 'ALREADY_EXISTS'; detail: string }
  | { ok: false; reason: 'ORIGIN_NOT_FOUND'; detail: string }
  /** 받은 질의를 제3자에게 다시 넘겼다. 종결 수단은 DECIDE/ANSWER/ESCALATE뿐이다. */
  | { ok: false; reason: 'ONE_HOP_VIOLATION'; detail: string; origin: BoundedQuery }
  /** 같은 결정이 물은 쪽으로 되돌아왔다. */
  | { ok: false; reason: 'CIRCULAR_DELEGATION'; detail: string; origin: BoundedQuery }

export type AnswerOutcome =
  | { ok: true; query: BoundedQuery; answer: QueryAnswer }
  | { ok: false; reason: 'NOT_FOUND'; detail: string }
  | { ok: false; reason: 'ALREADY_ANSWERED'; detail: string; answer: QueryAnswer }
  /** 그 결정의 주인이 아니다. 할 수 있는 것은 ANSWER 또는 ESCALATE다. */
  | { ok: false; reason: 'FORBIDDEN_AUTHORITY'; detail: string }

const queryKey = (id: string) => `query:req:${id}`
const answerKey = (id: string) => `query:ans:${id}`
/** 막힌 발행 시도. 막았다고 없던 일이 아니다 — 사람이 봐야 할 사실이다. */
const violationKey = (id: string) => `query:vio:${id}`

export type OpenSpec = {
  id: string
  ownerSessionId: string
  ownerRole?: string
  requestedAuthority: string
  question: string
  context?: string
  proposedDefault?: string
  blockingScope?: string
  expectedResponse?: 'DECIDE' | 'ANSWER'
  inReplyTo?: string
}

export type Violation = {
  attemptedId: string
  kind: 'ONE_HOP_VIOLATION' | 'CIRCULAR_DELEGATION'
  originId: string
  detail: string
  at: string
}

export class QueryLedger {
  #scope: ScopedStore
  #ownership: OwnershipMap | undefined
  #now: () => string

  constructor(
    scope: ScopedStore,
    ownership?: OwnershipMap,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#scope = scope
    this.#ownership = ownership
    this.#now = now
  }

  /**
   * 질의를 연다. 되던지기는 **여기서** 막는다 — 실행 중인 세션을 끊는 대신 발행을 막는
   * 것이 OM §16(Interrupt 부재)을 지키면서 순환을 끊는 유일한 자리다.
   */
  async open(spec: OpenSpec): Promise<OpenOutcome> {
    if (!QUERY_ID.test(spec.id)) {
      return { ok: false, reason: 'INVALID_ID', detail: `질의 id 형식이 아니다: '${spec.id}' (X-YYYYMMDD-NN)` }
    }

    if (spec.inReplyTo) {
      const origin = await this.get(spec.inReplyTo)
      if (!origin) {
        return { ok: false, reason: 'ORIGIN_NOT_FOUND', detail: `${spec.inReplyTo} 를 찾지 못했다` }
      }
      const refusal = this.#judgeRelay(spec, origin)
      if (refusal) {
        await this.#recordViolation(spec.id, refusal.reason, origin.id, refusal.detail)
        return { ok: false, reason: refusal.reason, detail: refusal.detail, origin }
      }
    }

    const query = BoundedQuery.parse({ ...spec, openedAt: this.#now() })
    const written = await this.#scope.setIfAbsent(queryKey(query.id), JSON.stringify(query))
    if (!written) return { ok: false, reason: 'ALREADY_EXISTS', detail: `${query.id} 는 이미 있다` }
    return { ok: true, query }
  }

  /**
   * 파생 질의가 허용되는가.
   *
   * 물은 쪽이 답을 받고 다시 묻는 것은 여전히 1 hop이다 — 막지 않는다.
   * 막는 것은 **받은 쪽이 같은 결정을 다시 넘기는** 경우이고, 그 넘김이 물은 쪽으로
   * 돌아가면 순환, 제3자로 가면 one-hop 위반이다.
   */
  #judgeRelay(
    spec: OpenSpec,
    origin: BoundedQuery,
  ): { reason: 'ONE_HOP_VIOLATION' | 'CIRCULAR_DELEGATION'; detail: string } | null {
    const sameAsker =
      spec.ownerSessionId === origin.ownerSessionId ||
      (!!spec.ownerRole && !!origin.ownerRole && spec.ownerRole === origin.ownerRole)
    if (sameAsker) return null

    const asked = lookupAuthority(this.#ownership, spec.requestedAuthority)
    const backToOrigin = origin.ownerRole !== undefined && asked.kind === 'RESOLVED' && asked.role === origin.ownerRole

    return backToOrigin
      ? {
          reason: 'CIRCULAR_DELEGATION',
          detail:
            `${origin.id} 를 물은 쪽은 ${origin.ownerRole} 인데, 그 답 대신 ` +
            `'${spec.requestedAuthority}' 를 다시 ${origin.ownerRole} 에게 묻고 있다. ` +
            `원 요청 '${origin.requestedAuthority}' 을 DECIDE / ANSWER / ESCALATE 중 하나로 종결하라.`,
        }
      : {
          reason: 'ONE_HOP_VIOLATION',
          detail:
            `${origin.id} 로 받은 결정을 제3자에게 다시 넘기고 있다. ` +
            '받은 쪽이 할 수 있는 것은 DECIDE / ANSWER / ESCALATE 뿐이며, ESCALATE는 Agent가 아니라 ' +
            '명시된 사람·권한자에게 올린다.',
        }
  }

  /**
   * 답은 한 번만 쓰인다. 두 사람이 동시에 답해도 먼저 쓴 것이 남고 나중 것은 거절된다 —
   * 조용히 덮으면 누구 말을 따랐는지 알 수 없게 된다.
   *
   * **이 호출은 어떤 Core 전이도 일으키지 않는다.** DECIDE도 마찬가지다 (C-04 §3.4).
   */
  async answer(id: string, input: Omit<QueryAnswer, 'at'>): Promise<AnswerOutcome> {
    const query = await this.get(id)
    if (!query) return { ok: false, reason: 'NOT_FOUND', detail: `${id} 를 찾지 못했다` }

    if (input.kind === 'DECIDE') {
      const found = lookupAuthority(this.#ownership, query.requestedAuthority)
      if (found.kind !== 'RESOLVED' || found.role !== input.byRole) {
        const who =
          found.kind === 'RESOLVED'
            ? `그 결정의 주인은 '${found.role}' 이다`
            : found.kind === 'AMBIGUOUS'
              ? `그 결정의 주인이 갈려 있다 (${found.candidates.join(', ')})`
              : '그 결정의 주인이 선언되지 않았다'
        return {
          ok: false,
          reason: 'FORBIDDEN_AUTHORITY',
          detail:
            `'${input.byRole}' 은 '${query.requestedAuthority}' 를 결정할 수 없다 — ${who}. ` +
            'ANSWER(사실 반환) 또는 ESCALATE(권한자에게 상신)로 종결하라.',
        }
      }
    }

    const answer = QueryAnswer.parse({ ...input, at: this.#now() })
    const written = await this.#scope.setIfAbsent(answerKey(id), JSON.stringify(answer))
    if (!written) {
      const existing = (await this.getAnswer(id))!
      return { ok: false, reason: 'ALREADY_ANSWERED', detail: `${id} 는 이미 답이 있다`, answer: existing }
    }
    return { ok: true, query, answer }
  }

  async get(id: string): Promise<BoundedQuery | null> {
    const raw = await this.#scope.get(queryKey(id))
    return raw ? BoundedQuery.parse(JSON.parse(raw)) : null
  }

  async getAnswer(id: string): Promise<QueryAnswer | null> {
    const raw = await this.#scope.get(answerKey(id))
    return raw ? QueryAnswer.parse(JSON.parse(raw)) : null
  }

  async list(): Promise<{ query: BoundedQuery; answer: QueryAnswer | null }[]> {
    const out: { query: BoundedQuery; answer: QueryAnswer | null }[] = []
    for (const key of await this.#scope.keys('query:req:')) {
      const raw = await this.#scope.get(key)
      if (!raw) continue
      const query = BoundedQuery.parse(JSON.parse(raw))
      out.push({ query, answer: await this.getAnswer(query.id) })
    }
    return out.sort((a, b) => a.query.id.localeCompare(b.query.id))
  }

  /**
   * 사람에게 넘겨진 질의. 답은 쓰였지만 **끝난 것이 아니다** — 그 답이 "사람이 정하라"였다.
   * 이것이 없으면 ESCALATE는 어느 화면에도 뜨지 않는 write-only 로그가 된다.
   */
  async escalated(): Promise<{ query: BoundedQuery; answer: QueryAnswer }[]> {
    return (await this.list()).filter(
      (entry): entry is { query: BoundedQuery; answer: QueryAnswer } => entry.answer?.kind === 'ESCALATE',
    )
  }

  /** 아직 답이 없는 질의. 누군가 기다리고 있다는 뜻이다. */
  async pending(): Promise<BoundedQuery[]> {
    return (await this.list()).filter((e) => e.answer === null).map((e) => e.query)
  }

  /** 막힌 발행 시도. 막았다고 사라지지 않는다 — 같은 결정이 돌고 있었다는 사실이다. */
  async violations(): Promise<Violation[]> {
    const out: Violation[] = []
    for (const key of await this.#scope.keys('query:vio:')) {
      const raw = await this.#scope.get(key)
      if (raw) out.push(JSON.parse(raw) as Violation)
    }
    return out.sort((a, b) => a.attemptedId.localeCompare(b.attemptedId))
  }

  async #recordViolation(
    attemptedId: string,
    kind: Violation['kind'],
    originId: string,
    detail: string,
  ): Promise<void> {
    const violation: Violation = { attemptedId, kind, originId, detail, at: this.#now() }
    await this.#scope.setIfAbsent(violationKey(attemptedId), JSON.stringify(violation))
  }
}

/**
 * 사람에게 넘겨진 질의를 줄로. 상신했는데 어느 화면에도 안 뜨는 상태를 막는 것이 목적이다.
 */
export function escalatedLines(
  answered: readonly { query: BoundedQuery; answer: QueryAnswer }[],
): string[] {
  return answered.map(
    (entry) =>
      `${entry.query.id}: 사람에게 넘김 — ${entry.query.question}` +
      (entry.answer.escalateTo ? ` (→ ${entry.answer.escalateTo})` : ''),
  )
}

/** 사람이 읽을 줄로. collect의 "판단이 필요한 것"에 그대로 들어간다. */
export function queryLines(open: readonly BoundedQuery[], violations: readonly Violation[]): string[] {
  const lines: string[] = []
  for (const q of open) {
    const blocked = q.blockingScope ? ` (막힘: ${q.blockingScope})` : ''
    lines.push(`${q.ownerSessionId}: 답을 기다리는 질의 ${q.id} — '${q.requestedAuthority}'${blocked}`)
  }
  for (const v of violations) {
    lines.push(`${v.kind}: ${v.attemptedId} (원 질의 ${v.originId}) — ${v.detail}`)
  }
  return lines
}
