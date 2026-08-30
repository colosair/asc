// GitLab Adapter — EventSource · Inventory · ResourceContext · ChangeContext.
//
// 이 adapter의 목적은 GitLab 지원 자체가 아니라 **같은 Core가 다른 adapter를 Binding
// 교체만으로 소비하는지** 보이는 것이다 (C-09 §9). 그래서 일부러 다르게 생긴 것을 고른다:
//
//   참조 문법   `group/sub/proj!19` (변경요청) · `group/proj#7` (이슈)
//   event kind  `todo:` · `note:`  — GitHub의 `notification:` 과 다르다
//   상태 어휘   opened / closed / merged
//
// Core가 이 셋 중 무엇도 해석하지 않는다는 것이 Swap Gate의 내용이다.

import type { ChangeContextPort, ChangeSummary } from '../../ports/change-context.ts'
import type { Cursor, EventBatch, EventSource, RawEvent } from '../../ports/event-source.ts'
import type { InventoryItem, InventoryPage, InventoryPort, InventoryQuery } from '../../ports/inventory.ts'
import type {
  CommentQuery,
  ContextComment,
  ResourceContextPort,
  ResourceSnapshot,
} from '../../ports/resource-context.ts'
import { encodeProject, parseRef, type GitLabReader } from './client.ts'

type TodoPayload = {
  id: number
  action_name?: string
  updated_at: string
  target_type?: string
  target?: { iid?: number; title?: string; state?: string; updated_at?: string }
  project?: { path_with_namespace?: string }
  body?: string
  author?: { username?: string }
}

type NotePayload = {
  id: number
  body?: string
  updated_at: string
  created_at: string
  author?: { username?: string }
  resolvable?: boolean
  resolved?: boolean
}

type IssuePayload = {
  iid: number
  title: string
  description?: string | null
  state: string
  updated_at: string
  user_notes_count?: number
  author?: { username?: string }
  assignees?: { username: string }[]
  labels?: string[]
  references?: { full?: string }
}

type MergeRequestPayload = IssuePayload & { sha?: string; detailed_merge_status?: string }
type ChangePayload = { changes?: { new_path?: string; old_path?: string }[]; overflow?: boolean }

const marker = (parts: readonly (string | number | undefined)[]): string =>
  parts.map((p) => (p === undefined ? '' : String(p))).join('|')

export type GitLabDeps = {
  client: GitLabReader
  /** `group/sub/project`. */
  project: string
  perPage?: number
}

abstract class GitLabBase {
  // 하위 클래스가 좁혀 쓴다 — EventSource만 `gitlab-todo` 로 자기 통로를 밝힌다.
  readonly id: string = 'gitlab'
  protected client: GitLabReader
  protected project: string
  protected perPage: number

  constructor(deps: GitLabDeps) {
    this.client = deps.client
    this.project = deps.project
    this.perPage = deps.perPage ?? 50
  }

  protected path(reference: string): string | null {
    const ref = parseRef(reference)
    if (!ref) return null
    const kind = ref.kind === 'change' ? 'merge_requests' : 'issues'
    return `/projects/${encodeProject(ref.project)}/${kind}/${ref.iid}`
  }
}

/**
 * 할 일 목록(todo)으로 증분을 받는다. GitHub의 알림과 같은 자리이고, 같은 한계를 갖는다 —
 * 지정이 빠지면 오지 않는다. 그래서 Inventory가 따로 있다.
 */
export class GitLabEventSource extends GitLabBase implements EventSource {
  override readonly id = 'gitlab-todo'

  cursorFrom(since: string): Cursor {
    return JSON.stringify({ since })
  }

  async drain(cursor: Cursor): Promise<EventBatch> {
    const parsed = cursor ? (JSON.parse(cursor) as { since?: string; page?: string }) : {}
    const params = new URLSearchParams({ per_page: String(this.perPage) })
    if (parsed.page) params.set('page', parsed.page)

    const response = await this.client.get<TodoPayload[]>(`/todos?${params}`)
    if (!response.ok || !response.data) return { events: [], cursor }

    const events: RawEvent[] = []
    for (const todo of response.data) {
      // 기준선 이전 것은 버린다. provider가 since를 지원하지 않아 여기서 거른다 —
      // 겹쳐 읽고 key로 중복을 거르는 편이 놓치는 것보다 싸다 (OM §10.5).
      if (parsed.since && todo.updated_at < parsed.since) continue
      const project = todo.project?.path_with_namespace ?? this.project
      const separator = todo.target_type === 'MergeRequest' ? '!' : '#'
      events.push({
        eventKey: `todo:${todo.id}:${todo.updated_at}`,
        detectedAt: todo.updated_at,
        reference: `${project}${separator}${todo.target?.iid ?? 0}`,
        ...(todo.author?.username ? { hints: { actors: [todo.author.username] } } : {}),
        raw: {
          kind: 'todo',
          // provider 어휘 그대로 둔다 — Generic Signal로 옮기는 것은 Profile의 몫이다 (OM §10.6).
          reason: todo.action_name,
          title: todo.target?.title,
          body: todo.body,
        },
      })
    }

    const next = response.nextPage
      ? JSON.stringify({ ...(parsed.since ? { since: parsed.since } : {}), page: response.nextPage })
      : JSON.stringify({ since: events.at(-1)?.detectedAt ?? parsed.since })

    return { events, cursor: next, ...(response.nextPage ? { hasMore: true } : {}) }
  }
}

/** 상태 무관 열거. 이슈와 변경요청을 각각 받아 합친다 — GitLab은 두 목록이 따로다. */
export class GitLabInventory extends GitLabBase implements InventoryPort {
  async enumerate(query: InventoryQuery, cursor?: string): Promise<InventoryPage> {
    const page = cursor ?? '1'
    const base = new URLSearchParams({ per_page: String(this.perPage), page, scope: 'all' })
    if (query.updatedSince) base.set('updated_after', query.updatedSince)

    const wanted = new Set(query.kinds ?? [])
    const items: InventoryItem[] = []
    let next: string | undefined

    for (const [kind, path, separator] of [
      ['issue', 'issues', '#'],
      ['change', 'merge_requests', '!'],
    ] as const) {
      if (wanted.size > 0 && !wanted.has(kind)) continue
      const response = await this.client.get<MergeRequestPayload[]>(
        `/projects/${encodeProject(this.project)}/${path}?${base}`,
      )
      // 한 갈래라도 못 읽었으면 완주했다고 말할 수 없다.
      if (!response.ok || !response.data) return { items, complete: false }
      if (response.nextPage) next = response.nextPage

      for (const row of response.data) {
        items.push({
          reference: `${this.project}${separator}${row.iid}`,
          state: row.state,
          updatedAt: row.updated_at,
          revisionMarker: marker([row.updated_at, row.sha, row.state, row.user_notes_count]),
          title: row.title,
          assignees: (row.assignees ?? []).map((a) => a.username),
          labels: row.labels ?? [],
        })
      }
    }

    return { items, ...(next ? { next } : {}), complete: next === undefined }
  }
}

export class GitLabResourceContext extends GitLabBase implements ResourceContextPort {
  async getResource(reference: string): Promise<ResourceSnapshot> {
    const path = this.path(reference)
    if (!path) return missing(reference)

    const response = await this.client.get<MergeRequestPayload>(path)
    if (!response.ok || !response.data) return missing(reference)
    const row = response.data

    return {
      reference,
      state: row.state,
      title: row.title,
      ...(row.description ? { body: row.description } : {}),
      ...(row.author?.username ? { author: row.author.username } : {}),
      assignees: (row.assignees ?? []).map((a) => a.username),
      labels: row.labels ?? [],
      updatedAt: row.updated_at,
      revisionMarker: marker([row.updated_at, row.sha, row.state, row.user_notes_count]),
    }
  }

  async getComments(reference: string, query: CommentQuery = {}): Promise<ContextComment[]> {
    const path = this.path(reference)
    if (!path) return []

    const params = new URLSearchParams({ per_page: String(query.limit ?? 20), sort: 'desc' })
    const response = await this.client.get<NotePayload[]>(`${path}/notes?${params}`)
    if (!response.ok || !response.data) return []

    return response.data
      .filter((note) => !query.since || note.updated_at >= query.since)
      .map((note) => ({
        id: String(note.id),
        author: note.author?.username ?? '(unknown)',
        at: note.updated_at ?? note.created_at,
        body: note.body ?? '',
        // 여기는 resolvable 여부를 알려준다 — 아는 것만 적는다.
        ...(note.resolvable ? { unresolved: note.resolved !== true } : {}),
      }))
  }
}

export class GitLabChangeContext extends GitLabBase implements ChangeContextPort {
  async getChange(reference: string): Promise<ChangeSummary> {
    const ref = parseRef(reference)
    if (!ref || ref.kind !== 'change') {
      return { reference, changedPaths: [], revisionMarker: '', missing: true }
    }

    const base = `/projects/${encodeProject(ref.project)}/merge_requests/${ref.iid}`
    const detail = await this.client.get<MergeRequestPayload>(base)
    if (!detail.ok || !detail.data) return { reference, changedPaths: [], revisionMarker: '', missing: true }

    const changes = await this.client.get<ChangePayload>(`${base}/changes`)
    const paths = (changes.data?.changes ?? []).map((c) => c.new_path ?? c.old_path ?? '').filter(Boolean)

    return {
      reference,
      changedPaths: paths,
      // provider가 "다 못 준다"고 말해 준다. 그 사실을 숨기면 "내 영역은 안 바뀌었다"는
      // 틀린 판정이 나온다.
      ...(changes.data?.overflow || !changes.ok ? { truncated: true } : {}),
      ...(detail.data.sha ? { revisions: [detail.data.sha] } : {}),
      revisionMarker: marker([detail.data.updated_at, detail.data.sha, detail.data.state]),
      ...(detail.data.detailed_merge_status ? { reviewState: detail.data.detailed_merge_status } : {}),
    }
  }
}

const missing = (reference: string): ResourceSnapshot => ({
  reference,
  state: 'unknown',
  title: '',
  updatedAt: '',
  revisionMarker: '',
  missing: true,
})
