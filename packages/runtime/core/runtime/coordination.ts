// Coordination Evidence — 물었다는 사실과, 전달됐다는 사실과, 답이 왔다는 사실을 나눈다.
//
// 반복된 실패는 이것이었다:
//
//   dependency 가 있다
//   ≠ 상대에게 전달됐다
//   ≠ 상대가 응답했다
//
// 세 사실이 한 레코드로 뭉개지면 "Task 도 있고 무언가 오갔으니 됐다"가 성립한다.
// 그래서 뭉개지지 않게 **따로 적는다.**
//
// 새 subsystem 을 만들지 않는다. 기대는 이미 Bounded Query 가 지고 있고(C-04), 여기서
// 더하는 것은 C-10 과 같은 모양의 append-only 원장 둘뿐이다:
//
//   ExecutionEvidence   누가 이 세션을 실제로 집었는가        (C-10, 이미 있음)
//   CommunicationEvidence  그 기대가 실제로 밖에 게시됐는가   (여기)
//   ResponseEvidence       그 게시물에 실제로 답이 왔는가      (여기)
//
// 상태를 저장하지 않는다. `UNPUBLISHED`·`WAITING_EXTERNAL`·`RESPONSE_RECEIVED` 는
// 전부 위 셋에서 **파생**한다 — 저장하면 그것이 곧 두 번째 정본이 되고, 증거와 어긋나는
// 순간 어느 쪽이 맞는지 정할 방법이 없어진다.
//
// **provider 이름을 모른다.** 아는 것은 adapter id 와 그 adapter 가 준 opaque identity 다
// (C-09 §6 과 같은 선). 어느 외부 시스템의 이름도 이 파일에 나오지 않으며, 그것은
// core/** 전체에 걸린 기존 규칙이기도 하다.

import { z } from 'zod'

import { QUERY_ID } from '../model/ids.ts'
import type { ScopedStore } from '../../ports/state-store.ts'

/**
 * 외부 시스템이 준 **안정적인** 신원 (F3).
 *
 * 사람이 보는 링크는 여기 있어도 되지만 그것이 정본은 아니다. 링크의 모양이 예상과
 * 다르다는 이유로 생성이 실패했다고 읽고 하나 더 만든 사고가 실제로 있었다 — 그때
 * 대조할 수 있는 다른 값이 계약에 없었다.
 */
export const RemoteIdentity = z.object({
  /** 어느 adapter 가 이 사실을 만들었는가. provider 이름이 아니라 adapter id 다. */
  adapter: z.string().min(1),
  /** 그 adapter 의 어휘로 된 객체 종류. Core 는 이 문자열로 분기하지 않는다. */
  objectType: z.string().min(1),
  /** 그 시스템 안에서 이 객체를 다시 찾을 수 있는 값. **성공의 정본이다.** */
  objectId: z.string().min(1),
  /** 어느 자원 아래인가 (저장소·프로젝트 등). adapter 어휘 그대로. */
  resource: z.string().min(1).optional(),
  /**
   * 사람이 열어 보는 주소. **판정에 쓰지 않는다** — 모양이 바뀌어도 같은 객체다.
   */
  locator: z.string().min(1).optional(),
  /** 이 시점의 판본. 있으면 응답 중복을 가리는 데 쓴다. */
  revisionMarker: z.string().min(1).optional(),
})
export type RemoteIdentity = z.infer<typeof RemoteIdentity>

/**
 * 기대가 실제로 밖에 게시됐다는 증거.
 *
 * **이 레코드를 만드는 것이 게시가 아니다.** 게시는 adapter 가 하고, 여기 남는 것은
 * 그것이 일어났다는 관측이다 — 그 구분이 사라지면 "적어 뒀으니 됐다"가 다시 성립한다.
 */
export const CommunicationEvidence = z.object({
  evidenceId: z.string().min(1),
  /** 어느 기대에 대한 것인가. 지금은 Bounded Query 가 기대의 정본이다 (C-04). */
  queryId: z.string().regex(QUERY_ID),
  /** 어느 binding 을 통해 나갔는가 (C-09). 역할 이름이며 provider 이름이 아니다. */
  bindingRole: z.string().min(1).optional(),
  identity: RemoteIdentity,
  /** 누구에게 닿아야 하는가. 프로젝트 정책이 정하고 여기서는 그대로 보관한다. */
  audience: z.array(z.string()).default([]),
  publishedAt: z.string().min(1),
  /** 이 사실을 우리가 언제 봤는가. 게시 시각과 다를 수 있다. */
  observedAt: z.string().min(1),
  /** 선언인가 관측인가 (C-10 의 같은 필드와 같은 뜻). */
  evidenceSource: z.string().min(1),
})
export type CommunicationEvidence = z.infer<typeof CommunicationEvidence>

/**
 * 그 게시물에 외부 응답이 도착했다는 증거.
 *
 * **답의 의미를 판정하지 않는다.** 이것은 `QueryAnswer` 가 아니고, 자동으로 그것이
 * 되지도 않는다 — 누가 무엇을 결정할 수 있는지는 C-04 의 권한 판정이고, 사람 승인은
 * C-13 이다. 여기 있는 것은 "왔다"까지다.
 */
export const ResponseEvidence = z.object({
  evidenceId: z.string().min(1),
  /** 어느 게시물에 대한 응답인가. */
  communicationId: z.string().min(1),
  identity: RemoteIdentity,
  /** 그 시스템이 말하는 응답자. 우리 역할 이름으로 번역하지 않는다. */
  responder: z.string().min(1).optional(),
  receivedAt: z.string().min(1),
  observedAt: z.string().min(1),
  evidenceSource: z.string().min(1),
})
export type ResponseEvidence = z.infer<typeof ResponseEvidence>

/**
 * 파생 상태. **저장하지 않는다** — 위 증거들에서 매번 계산한다.
 */
export type CoordinationState =
  /** 기대는 있는데 밖에 나간 적이 없다. */
  | 'UNPUBLISHED'
  /** 나갔고, 답을 기다린다. */
  | 'WAITING_EXTERNAL'
  /** 답이 왔다. 그 답이 무엇을 뜻하는지는 여기서 정하지 않는다. */
  | 'RESPONSE_RECEIVED'
  /** 나갔고, 애초에 답을 기대하지 않는다. */
  | 'PUBLISHED'

export type CoordinationView = {
  queryId: string
  state: CoordinationState
  /** 이 기대가 답을 기다리는가. 기대 쪽 사실이며 증거가 아니다. */
  expectsResponse: boolean
  communications: CommunicationEvidence[]
  responses: ResponseEvidence[]
}

/**
 * 기대 하나의 지금 상태를 계산한다.
 *
 * 순서가 곧 규칙이다: 응답이 있으면 왔다, 없으면 기다리는지 아닌지, 게시가 없으면
 * 아직 나가지 않았다. **없는 것을 있는 것으로 올리는 방향은 없다.**
 */
export function deriveCoordination(input: {
  queryId: string
  expectsResponse: boolean
  communications: readonly CommunicationEvidence[]
  responses: readonly ResponseEvidence[]
}): CoordinationView {
  const communications = [...input.communications].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId))
  const responses = [...input.responses].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId))

  const state: CoordinationState =
    communications.length === 0
      ? 'UNPUBLISHED'
      : responses.length > 0
        ? 'RESPONSE_RECEIVED'
        : input.expectsResponse
          ? 'WAITING_EXTERNAL'
          : 'PUBLISHED'

  return { queryId: input.queryId, state, expectsResponse: input.expectsResponse, communications, responses }
}

const communicationKey = (id: string) => `coord:pub:${id}`
const responseKey = (id: string) => `coord:res:${id}`

export type AppendOutcome<T> =
  | { ok: true; evidence: T }
  /** 같은 id 가 이미 있다. 덮지 않는다 — 증거는 한 번만 쓰인다 (C-10 과 같은 이유). */
  | { ok: false; reason: 'ALREADY_EXISTS'; detail: string }
  /** 가리키는 게시물이 없다. 없는 것에 응답을 붙이지 않는다. */
  | { ok: false; reason: 'COMMUNICATION_NOT_FOUND'; detail: string }

/**
 * 조율 증거 원장. append-only 이며 `setIfAbsent` 위에 선다.
 *
 * 잃는 것이 표시값이 아니라 **누가 무엇을 밖에 내보냈고 누가 답했는가**이기 때문에,
 * 나중 쓰기가 앞선 것을 덮지 않는다.
 */
export class CoordinationLedger {
  #scope: ScopedStore
  #now: () => string

  constructor(scope: ScopedStore, now: () => string = () => new Date().toISOString()) {
    this.#scope = scope
    this.#now = now
  }

  async publishRecorded(
    input: Omit<CommunicationEvidence, 'observedAt'> & { observedAt?: string },
  ): Promise<AppendOutcome<CommunicationEvidence>> {
    const evidence = CommunicationEvidence.parse({ ...input, observedAt: input.observedAt ?? this.#now() })
    const written = await this.#scope.setIfAbsent(communicationKey(evidence.evidenceId), JSON.stringify(evidence))
    return written
      ? { ok: true, evidence }
      : { ok: false, reason: 'ALREADY_EXISTS', detail: `${evidence.evidenceId} 는 이미 있다` }
  }

  async responseRecorded(
    input: Omit<ResponseEvidence, 'observedAt'> & { observedAt?: string },
  ): Promise<AppendOutcome<ResponseEvidence>> {
    const target = await this.#scope.get(communicationKey(input.communicationId))
    if (!target) {
      return {
        ok: false,
        reason: 'COMMUNICATION_NOT_FOUND',
        detail: `${input.communicationId} 를 찾지 못했다 — 게시된 적 없는 것에 응답을 붙이지 않는다`,
      }
    }
    const evidence = ResponseEvidence.parse({ ...input, observedAt: input.observedAt ?? this.#now() })
    const written = await this.#scope.setIfAbsent(responseKey(evidence.evidenceId), JSON.stringify(evidence))
    return written
      ? { ok: true, evidence }
      : { ok: false, reason: 'ALREADY_EXISTS', detail: `${evidence.evidenceId} 는 이미 있다` }
  }

  async communications(): Promise<CommunicationEvidence[]> {
    const out: CommunicationEvidence[] = []
    for (const key of await this.#scope.keys('coord:pub:')) {
      const raw = await this.#scope.get(key)
      if (raw) out.push(CommunicationEvidence.parse(JSON.parse(raw)))
    }
    return out.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId))
  }

  async responses(): Promise<ResponseEvidence[]> {
    const out: ResponseEvidence[] = []
    for (const key of await this.#scope.keys('coord:res:')) {
      const raw = await this.#scope.get(key)
      if (raw) out.push(ResponseEvidence.parse(JSON.parse(raw)))
    }
    return out.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId))
  }

  /**
   * 이미 이 게시물이 있는가 — **원격 신원으로** 찾는다 (F3).
   *
   * 같은 것을 두 번 만들지 않기 위한 조회다. 제목이나 링크가 아니라 adapter 가 준
   * 안정 id 로 본다.
   */
  async findByIdentity(identity: Pick<RemoteIdentity, 'adapter' | 'objectType' | 'objectId'>): Promise<CommunicationEvidence | null> {
    for (const evidence of await this.communications()) {
      const seen = evidence.identity
      if (seen.adapter === identity.adapter && seen.objectType === identity.objectType && seen.objectId === identity.objectId) {
        return evidence
      }
    }
    return null
  }

  /** 기대 하나에 달린 증거 전부. */
  async forQuery(queryId: string): Promise<{ communications: CommunicationEvidence[]; responses: ResponseEvidence[] }> {
    const communications = (await this.communications()).filter((evidence) => evidence.queryId === queryId)
    const ids = new Set(communications.map((evidence) => evidence.evidenceId))
    const responses = (await this.responses()).filter((evidence) => ids.has(evidence.communicationId))
    return { communications, responses }
  }
}

/**
 * 기대 목록과 증거를 합쳐 지금 상태를 낸다.
 *
 * 기대는 이 모듈이 만들지 않는다 — Bounded Query 가 정본이고, 여기서는 그것을 받아
 * 증거와 맞춘다. 기대가 없으면 조율도 없다.
 */
export async function viewCoordination(
  ledger: CoordinationLedger,
  expectations: readonly { id: string; expectsResponse: boolean }[],
): Promise<CoordinationView[]> {
  const views: CoordinationView[] = []
  for (const expectation of expectations) {
    const { communications, responses } = await ledger.forQuery(expectation.id)
    views.push(
      deriveCoordination({
        queryId: expectation.id,
        expectsResponse: expectation.expectsResponse,
        communications,
        responses,
      }),
    )
  }
  return views.sort((a, b) => a.queryId.localeCompare(b.queryId))
}

/**
 * 사람이 읽는 줄. **없는 것을 0 으로 그리지 않는다** — 기대가 없으면 그렇게 말한다.
 */
export function coordinationLines(views: readonly CoordinationView[]): string[] {
  if (views.length === 0) return ['No external expectation is recorded here.']
  const lines: string[] = []
  const counts: Record<CoordinationState, number> = {
    UNPUBLISHED: 0,
    WAITING_EXTERNAL: 0,
    RESPONSE_RECEIVED: 0,
    PUBLISHED: 0,
  }
  for (const view of views) counts[view.state] += 1

  lines.push(
    `Coordination: ${views.length} expectation${views.length === 1 ? '' : 's'} — ` +
      `unpublished ${counts.UNPUBLISHED} · waiting ${counts.WAITING_EXTERNAL} · ` +
      `answered ${counts.RESPONSE_RECEIVED} · published ${counts.PUBLISHED}`,
  )
  for (const view of views) {
    const where = view.communications[0]?.identity
    // 링크는 사람이 열어 보는 값이다. 없으면 안정 신원을 보인다 — 판정의 정본은 그쪽이다.
    const at = where ? ` @ ${where.locator ?? `${where.adapter}:${where.objectType}:${where.objectId}`}` : ''
    lines.push(`  ${view.queryId} ${view.state}${at}`)
  }
  return lines
}
