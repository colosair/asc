// GitLab 조율 표면 — 밖에 있는 durable 한 조율 게시물 하나를 찾고, 만들고, 되읽는다.
//
// 이 파일은 provider 를 아는 자리다. Core 는 `CoordinationSurfacePort` 만 알고 여기 이름을
// 모른다 (C-09 §6). 그래서 여기서 GitLab 어휘를 쓰는 것은 계약대로이고, Core 쪽에 같은
// 어휘가 새는 것은 결함이다.
//
// 신원을 무엇으로 삼는가가 이 adapter 의 핵심 결정이다. 주소(web_url)는 쓰지 않는다 —
// 호스트가 바뀌고, 프로젝트가 옮겨 다니고, 같은 게시물이 다른 주소로 보인다. 대신
// `group/project#iid` 를 쓴다. 이 값은 그 시스템 안에서 안정적이고, 스스로 어느 프로젝트인지
// 말하므로 되읽기가 다른 정보를 필요로 하지 않는다.

import type {
  CoordinationSurfacePort,
  PublicPayload,
  SurfaceCandidate,
  SurfaceQuery,
  SurfaceSnapshot,
} from '../../ports/coordination-surface.ts'
import type { RemoteIdentity } from '../../core/runtime/coordination.ts'
import { encodeProject, parseRef, type GitLabReader, type GitLabWriter } from './client.ts'

/** 상관 관계를 심는 방법. 라벨 하나이고, 그 안에 들어가는 것은 기대 id 뿐이다. */
export const CORRELATION_LABEL = 'asc-coordination'
const correlationLabel = (correlation: string): string => `${CORRELATION_LABEL}:${correlation}`

type IssuePayload = {
  iid: number
  title: string
  state: string
  web_url?: string
  updated_at?: string
  references?: { full?: string }
  project_id?: number
}

export type GitLabCoordinationDeps = {
  reader: GitLabReader
  /** 없으면 만들 수 없다. **없는 것을 있는 척하지 않는다** — create 가 그렇게 답한다. */
  writer?: GitLabWriter
  project: string
}

export class GitLabCoordinationSurface implements CoordinationSurfacePort {
  readonly id = 'gitlab'
  #reader: GitLabReader
  #writer: GitLabWriter | undefined
  #project: string

  constructor(deps: GitLabCoordinationDeps) {
    this.#reader = deps.reader
    this.#writer = deps.writer
    this.#project = deps.project
  }

  #identity(issue: IssuePayload, project = this.#project): RemoteIdentity {
    return {
      adapter: this.id,
      objectType: 'issue',
      // 주소가 아니라 이 값이 정본이다.
      objectId: `${project}#${issue.iid}`,
      resource: project,
      ...(issue.web_url ? { locator: issue.web_url } : {}),
      ...(issue.updated_at ? { revisionMarker: issue.updated_at } : {}),
    }
  }

  #candidate(issue: IssuePayload, matchedBy: SurfaceCandidate['matchedBy']): SurfaceCandidate {
    return {
      identity: this.#identity(issue),
      title: issue.title,
      matchedBy,
      ...(issue.state === 'closed' ? { closed: true } : {}),
    }
  }

  async find(query: SurfaceQuery): Promise<SurfaceCandidate[]> {
    const out: SurfaceCandidate[] = []
    const seen = new Set<string>()
    const add = (candidate: SurfaceCandidate) => {
      if (seen.has(candidate.identity.objectId)) return
      seen.add(candidate.identity.objectId)
      out.push(candidate)
    }

    // 1) 이미 아는 게시물. 가장 강한 근거이고, 여기서 걸리면 나머지를 볼 이유가 없다.
    for (const known of query.known ?? []) {
      const snapshot = await this.read(known)
      if (snapshot) {
        add({
          identity: snapshot.identity,
          title: snapshot.title,
          matchedBy: 'known-identity',
          ...(snapshot.closed ? { closed: true } : {}),
        })
      }
    }

    // 2) 우리가 심어 둔 상관 관계. 라벨은 그 시스템이 색인하는 값이라 제목처럼 흔들리지 않는다.
    const labelled = await this.#reader.get<IssuePayload[]>(
      `/projects/${encodeProject(this.#project)}/issues?labels=${encodeURIComponent(correlationLabel(query.correlation))}&state=all&per_page=20`,
    )
    if (!labelled.ok) {
      // 못 찾은 것을 없는 것으로 넘기지 않는다. 호출자가 이 차이로 판단한다.
      throw new Error(labelled.error ?? `issue search failed (${labelled.status})`)
    }
    for (const issue of labelled.data ?? []) add(this.#candidate(issue, 'correlation'))

    // 3) 작업 항목으로 훑는다. **약한 근거다** — 같은 작업에 여러 조율이 붙을 수 있다.
    if (query.workReference) {
      const searched = await this.#reader.get<IssuePayload[]>(
        `/projects/${encodeProject(this.#project)}/issues?search=${encodeURIComponent(query.workReference)}&in=title,description&state=all&per_page=20`,
      )
      if (searched.ok) for (const issue of searched.data ?? []) add(this.#candidate(issue, 'work-reference'))
    }

    return out
  }

  async create(payload: PublicPayload, query: SurfaceQuery): Promise<RemoteIdentity> {
    if (!this.#writer) throw new Error('this binding has no write channel — nothing was created')

    // **여기를 지나는 것이 밖으로 나가는 전부다.** payload 밖의 값은 이 함수에 오지 않고,
    // 라벨 하나만 우리가 덧붙인다 — 다음 회차가 이 게시물을 다시 찾는 근거다.
    const labels = [...(payload.labels ?? []), correlationLabel(query.correlation)].join(',')
    const created = await this.#writer.post<IssuePayload>(`/projects/${encodeProject(this.#project)}/issues`, {
      title: payload.title,
      description: payload.body,
      labels,
    })
    if (!created.ok || !created.data) {
      throw new Error(created.error ?? `issue create failed (${created.status})`)
    }
    return this.#identity(created.data)
  }

  async read(identity: Pick<RemoteIdentity, 'objectType' | 'objectId'>): Promise<SurfaceSnapshot | null> {
    const parsed = parseRef(identity.objectId)
    if (!parsed || parsed.kind !== 'issue') return null
    const response = await this.#reader.get<IssuePayload>(
      `/projects/${encodeProject(parsed.project)}/issues/${parsed.iid}`,
    )
    if (!response.ok || !response.data) return null
    return {
      identity: this.#identity(response.data, parsed.project),
      title: response.data.title,
      ...(response.data.state === 'closed' ? { closed: true } : {}),
    }
  }
}
