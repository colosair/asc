// GitHub Context Adapters — Inventory · ResourceContext · ChangeContext (C-09 §2).
//
// 세 Port를 한 파일에 두는 이유는 같은 client와 같은 참조 문법을 쓰기 때문이다.
// 인터페이스는 셋으로 나뉘어 있으므로 소비자는 필요한 것만 받는다.
//
// revisionMarker는 여기서 만든다 — 무엇이 실질 변화인지는 provider가 아는 사실이고,
// Core는 그 값을 비교만 한다 (C-07 §4.2).

import type {
  InventoryPage,
  InventoryPort,
  InventoryQuery,
  InventoryItem,
} from '../../ports/inventory.ts'
import type {
  ChangeContextPort,
  ChangeSummary,
} from '../../ports/change-context.ts'
import type {
  CommentQuery,
  ContextComment,
  ResourceContextPort,
  ResourceSnapshot,
} from '../../ports/resource-context.ts'
import type { GitHubClient } from './client.ts'
import { parseThreadRef } from './scm.ts'

type IssuePayload = {
  number: number
  title: string
  body?: string | null
  state: string
  updated_at: string
  comments: number
  user?: { login?: string }
  assignees?: { login: string }[]
  labels?: ({ name?: string } | string)[]
  pull_request?: unknown
}

type CommentPayload = { id: number; updated_at: string; created_at: string; body?: string; user?: { login?: string } }
type PullPayload = { updated_at: string; head?: { sha?: string }; merged_at?: string | null; state: string }
type PullFile = { filename: string }
type ReviewPayload = { state: string; submitted_at?: string }

const labelNames = (labels: IssuePayload['labels']): string[] =>
  (labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter((n) => n.length > 0)

/**
 * 실질 변화 마커. 갱신 시각 하나로는 댓글 외의 변화를 놓치므로 여러 조각을 묶는다
 * (C-07 §4.2 — 무엇을 넣을지는 adapter가 정한다).
 */
const marker = (parts: readonly (string | number | undefined)[]): string =>
  parts.map((p) => (p === undefined ? '' : String(p))).join('|')

export type GitHubContextDeps = {
  client: GitHubClient
  /** `owner/repo`. 짧은 참조(`#19`)를 풀 때 쓴다. */
  defaultRepo?: string
  /** 한 페이지 크기. 기본 100 — provider 상한이다. */
  pageSize?: number
}

abstract class GitHubContextBase {
  readonly id = 'github'
  protected client: GitHubClient
  protected defaultRepo: string | undefined

  constructor(deps: GitHubContextDeps) {
    this.client = deps.client
    this.defaultRepo = deps.defaultRepo
  }

  protected expand(reference: string): string {
    const trimmed = reference.trim()
    return trimmed.startsWith('#') && this.defaultRepo ? `${this.defaultRepo}${trimmed}` : trimmed
  }
}

/**
 * 상태 무관 열거 (C-09 §2). `state=all`이 이 Port의 존재 이유다 —
 * 닫힌 것을 빼면 닫힌 뒤에 일어난 일을 통째로 놓친다.
 *
 * GitHub은 PR도 issues 목록에 실어 주므로 한 번의 열거로 둘 다 덮인다.
 * 그래서 `kinds`를 받아도 별도 호출로 나누지 않고 결과에서 가른다.
 */
export class GitHubInventory extends GitHubContextBase implements InventoryPort {
  #pageSize: number

  constructor(deps: GitHubContextDeps) {
    super(deps)
    this.#pageSize = deps.pageSize ?? 100
  }

  async enumerate(query: InventoryQuery, cursor?: string): Promise<InventoryPage> {
    if (!this.defaultRepo) {
      // 어디를 열거할지 모른다. 빈 목록을 "없다"로 돌려주면 census가 전부 사라졌다고 본다.
      return { items: [], complete: false }
    }
    const page = cursor ? Number(cursor) : 1
    const params = new URLSearchParams({
      state: 'all',
      per_page: String(this.#pageSize),
      page: String(page),
      sort: 'updated',
      direction: 'desc',
    })
    if (query.updatedSince) params.set('since', query.updatedSince)

    const response = await this.client.get<IssuePayload[]>(`/repos/${this.defaultRepo}/issues?${params}`)
    // 못 읽었으면 complete=false다. 페이지를 다 돌지 못했는데 끝인 척하면
    // Census가 "사라졌다"를 잘못 만들어낸다 (C-07 §1.5).
    if (!response.ok || !response.data) return { items: [], complete: false }

    const wanted = new Set(query.kinds ?? [])
    const items: InventoryItem[] = []
    for (const issue of response.data) {
      const kind = issue.pull_request ? 'change' : 'issue'
      if (wanted.size > 0 && !wanted.has(kind)) continue
      items.push({
        reference: `${this.defaultRepo}#${issue.number}`,
        state: issue.state,
        updatedAt: issue.updated_at,
        revisionMarker: marker([issue.updated_at, issue.comments, issue.state]),
        title: issue.title,
        assignees: (issue.assignees ?? []).map((a) => a.login),
        labels: labelNames(issue.labels),
      })
    }

    const full = response.data.length === this.#pageSize
    return {
      items,
      ...(full ? { next: String(page + 1) } : {}),
      // 마지막 페이지에서만 완주를 말한다 (ports/inventory.ts 계약).
      complete: !full,
    }
  }
}

export class GitHubResourceContext extends GitHubContextBase implements ResourceContextPort {
  async getResource(reference: string): Promise<ResourceSnapshot> {
    const ref = parseThreadRef(this.expand(reference))
    if (!ref) return missingResource(reference)

    const response = await this.client.get<IssuePayload>(
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`,
    )
    if (!response.ok || !response.data) return missingResource(reference)
    const issue = response.data

    return {
      reference,
      state: issue.state,
      title: issue.title,
      ...(issue.body ? { body: issue.body } : {}),
      ...(issue.user?.login ? { author: issue.user.login } : {}),
      assignees: (issue.assignees ?? []).map((a) => a.login),
      labels: labelNames(issue.labels),
      updatedAt: issue.updated_at,
      revisionMarker: marker([issue.updated_at, issue.comments, issue.state]),
    }
  }

  /**
   * 최근 것부터. 전문을 통째로 넘기지 않는 것이 이 Port의 계약이므로 개수를 호출자가 정한다
   * — 조사 depth가 예산을 쥔다 (C-05 §3).
   */
  async getComments(reference: string, query: CommentQuery = {}): Promise<ContextComment[]> {
    const ref = parseThreadRef(this.expand(reference))
    if (!ref) return []

    const params = new URLSearchParams({ per_page: String(query.limit ?? 20), sort: 'created', direction: 'desc' })
    if (query.since) params.set('since', query.since)

    const response = await this.client.get<CommentPayload[]>(
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?${params}`,
    )
    if (!response.ok || !response.data) return []

    return response.data.map((comment) => ({
      id: String(comment.id),
      author: comment.user?.login ?? '(unknown)',
      at: comment.updated_at ?? comment.created_at,
      body: comment.body ?? '',
      // unresolved 여부를 이 API가 말해주지 않는다. 모르는 것을 false로 적지 않는다.
    }))
  }
}

export class GitHubChangeContext extends GitHubContextBase implements ChangeContextPort {
  #pageSize: number

  constructor(deps: GitHubContextDeps) {
    super(deps)
    this.#pageSize = deps.pageSize ?? 100
  }

  async getChange(reference: string): Promise<ChangeSummary> {
    const ref = parseThreadRef(this.expand(reference))
    if (!ref) return { reference, changedPaths: [], revisionMarker: '', missing: true }

    const base = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`
    const pull = await this.client.get<PullPayload>(base)
    if (!pull.ok || !pull.data) {
      // 변경요청이 아니거나 못 읽었다. 둘 다 "경로가 없다"가 아니라 "모른다"이다.
      return { reference, changedPaths: [], revisionMarker: '', missing: true }
    }

    const files = await this.client.get<PullFile[]>(`${base}/files?per_page=${this.#pageSize}`)
    const paths = (files.data ?? []).map((f) => f.filename)
    // 한 페이지를 꽉 채웠으면 뒤가 더 있을 수 있다. 그 사실을 숨기면
    // "내 영역은 안 바뀌었다"는 틀린 판정이 나온다.
    const truncated = paths.length === this.#pageSize || !files.ok

    const reviews = await this.client.get<ReviewPayload[]>(`${base}/reviews?per_page=20`)
    const reviewState = (reviews.data ?? []).at(-1)?.state

    return {
      reference,
      changedPaths: paths,
      ...(truncated ? { truncated: true } : {}),
      ...(pull.data.head?.sha ? { revisions: [pull.data.head.sha] } : {}),
      revisionMarker: marker([pull.data.updated_at, pull.data.head?.sha, pull.data.state, reviewState]),
      ...(reviewState ? { reviewState } : {}),
    }
  }
}

const missingResource = (reference: string): ResourceSnapshot => ({
  reference,
  state: 'unknown',
  title: '',
  updatedAt: '',
  revisionMarker: '',
  missing: true,
})
