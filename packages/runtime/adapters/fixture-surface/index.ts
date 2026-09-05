// Fixture Coordination Surface — 조율 표면 계약을 provider 없이 돌린다 (R7).
//
// 왜 있는가: 조율이 특정 회사 도구의 성질이 아니라는 것은, 그 도구가 아닌 것으로도
// 같은 계약이 성립할 때만 증명된다. 여기 있는 것은 메모리 위의 게시판 하나이며,
// Core 는 이것과 실제 adapter 를 구분하지 못한다 — 구분하면 그것이 결함이다.
//
// 실 사고를 흉내 낼 수 있어야 쓸모가 있다. 그래서 두 개의 손잡이가 있다:
//   `loseNextResponses` — 만들어지긴 하는데 응답을 잃는다 (중복 생성의 실제 원인)
//   `locatorShape`      — 주소 모양이 바뀐다 (주소로 판정하면 여기서 깨진다)

import type {
  CoordinationSurfacePort,
  PublicPayload,
  SurfaceCandidate,
  SurfaceQuery,
  SurfaceSnapshot,
} from '../../ports/coordination-surface.ts'
import type { RemoteIdentity } from '../../core/runtime/coordination.ts'

type Stored = {
  objectId: string
  payload: PublicPayload
  correlation: string
  workReference?: string
  closed?: boolean
}

export type FixtureSurfaceDeps = {
  /** 이 횟수만큼은 만들고 나서 응답을 잃는다. 객체는 남는다 — 그것이 이 사고의 요점이다. */
  loseNextResponses?: number
  /** 주소를 어떻게 짓는가. 판정이 주소에 기대고 있으면 이 값을 바꿔 보면 드러난다. */
  locatorShape?: (objectId: string) => string
  /** 찾기가 실패하는가. 못 찾은 것과 없는 것은 다른 사실이다. */
  findFails?: boolean
}

export class FixtureSurfaceAdapter implements CoordinationSurfacePort {
  readonly id = 'fixture-surface'
  readonly objects: Stored[] = []
  /** 실제로 만들기가 몇 번 일어났는가. 중복 생성 0 을 세는 자리다. */
  createCalls = 0
  #lose: number
  #locator: (objectId: string) => string
  #findFails: boolean

  constructor(deps: FixtureSurfaceDeps = {}) {
    this.#lose = deps.loseNextResponses ?? 0
    this.#locator = deps.locatorShape ?? ((objectId) => `fixture://board/${objectId}`)
    this.#findFails = deps.findFails ?? false
  }

  #identity(stored: Stored): RemoteIdentity {
    return {
      adapter: this.id,
      objectType: 'thread',
      objectId: stored.objectId,
      resource: 'board',
      locator: this.#locator(stored.objectId),
    }
  }

  async find(query: SurfaceQuery): Promise<SurfaceCandidate[]> {
    if (this.#findFails) throw new Error('surface unreachable')

    const out: SurfaceCandidate[] = []
    const seen = new Set<string>()
    const push = (stored: Stored, matchedBy: SurfaceCandidate['matchedBy']) => {
      if (seen.has(stored.objectId)) return
      seen.add(stored.objectId)
      out.push({
        identity: this.#identity(stored),
        title: stored.payload.title,
        matchedBy,
        ...(stored.closed ? { closed: true } : {}),
      })
    }

    for (const known of query.known ?? []) {
      const hit = this.objects.find((stored) => stored.objectId === known.objectId)
      if (hit) push(hit, 'known-identity')
    }
    for (const stored of this.objects) {
      if (stored.correlation === query.correlation) push(stored, 'correlation')
    }
    if (query.workReference) {
      for (const stored of this.objects) {
        if (stored.workReference === query.workReference) push(stored, 'work-reference')
      }
    }
    return out
  }

  async create(payload: PublicPayload, query: SurfaceQuery): Promise<RemoteIdentity> {
    this.createCalls += 1
    const stored: Stored = {
      objectId: `OBJ-${this.objects.length + 1}`,
      payload,
      correlation: query.correlation,
      ...(query.workReference ? { workReference: query.workReference } : {}),
    }
    // 먼저 남기고 나서 응답을 잃는다 — 반대로 하면 이 fixture 가 흉내 내는 사고가 아니다.
    this.objects.push(stored)
    if (this.#lose > 0) {
      this.#lose -= 1
      throw new Error('response lost after the object was created')
    }
    return this.#identity(stored)
  }

  async read(identity: Pick<RemoteIdentity, 'objectType' | 'objectId'>): Promise<SurfaceSnapshot | null> {
    const hit = this.objects.find((stored) => stored.objectId === identity.objectId)
    if (!hit) return null
    return {
      identity: this.#identity(hit),
      title: hit.payload.title,
      ...(hit.closed ? { closed: true } : {}),
    }
  }

  /** 밖에서 일어난 일을 흉내 낸다 — 시험이 게시물을 닫거나 남의 것을 심을 때 쓴다. */
  seed(stored: Omit<Stored, 'objectId'> & { objectId?: string }): RemoteIdentity {
    const full: Stored = { objectId: stored.objectId ?? `OBJ-${this.objects.length + 1}`, ...stored }
    this.objects.push(full)
    return this.#identity(full)
  }
}
