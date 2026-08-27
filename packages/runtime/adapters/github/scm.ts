// GitHub SCM Adapter — 스레드·정본 조회와, 승인된 단일 행위의 실행.
//
// 쓰기는 `execute` 하나뿐이고, 그 함수는 Grant를 쥔 Executor만 부른다 (OM §11.5).
// Adapter는 권한을 판단하지 않는다 — 판단은 이미 끝났고 여기는 실행만 한다.
// 대신 Grant가 지정한 action 밖의 일은 하지 않는다: 아는 행위가 아니면 거절한다.

import type { CanonicalSnapshot } from '../../core/model/entities.ts'
import type { BaselineQuery, ExternalAction, ExternalActionResult, ScmPort, ThreadSnapshot } from '../../ports/scm.ts'
import type { GitHubClient } from './client.ts'

/** `owner/repo#19` 를 쪼갠다. 다른 형태는 다루지 않는다. */
export function parseThreadRef(reference: string): { owner: string; repo: string; number: number } | null {
  const match = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(reference.trim())
  if (!match) return null
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) }
}

type IssueComment = { id: number; updated_at: string }
type IssuePayload = { updated_at: string; comments: number }
type RefPayload = { object?: { sha?: string }; sha?: string }

export type GitHubScmDeps = {
  client: GitHubClient
  /** `owner/repo`. 짧은 참조(`#19`)를 풀 때 쓴다. */
  defaultRepo?: string
  /** canonical source id → git ref. Profile이 채운다 (OM §8). */
  sourceRefs?: Readonly<Record<string, { owner?: string; repo?: string; ref: string }>>
}

export class GitHubScm implements ScmPort {
  readonly id = 'github'
  #client: GitHubClient
  #defaultRepo: string | undefined
  #sourceRefs: Readonly<Record<string, { owner?: string; repo?: string; ref: string }>>

  constructor(deps: GitHubScmDeps) {
    this.#client = deps.client
    this.#defaultRepo = deps.defaultRepo
    this.#sourceRefs = deps.sourceRefs ?? {}
  }

  /**
   * 스레드의 현재 상태를 하나의 표식으로 만든다. Drift Guard가 이 값으로 "승인 이후 뭔가
   * 달라졌는가"를 판단하므로, 조회가 실패하면 변화 없음으로 넘기지 않고 missing으로
   * 돌려준다 — 모르면 실행하지 않는 쪽이 맞다 (OM §11.9).
   *
   * 표식은 세 조각을 묶는다:
   *   issue의 updated_at  — 제목·본문 수정을 잡는다
   *   댓글 수             — 추가·삭제를 잡는다
   *   마지막 댓글의 id·updated_at — 새 댓글과 그 수정을 잡는다
   *
   * 마지막 댓글은 `per_page=1&page=<댓글 수>`로 직접 집는다. 첫 page만 보면 댓글이 100개를
   * 넘는 순간 새 댓글을 못 보고 오래된 초안이 그대로 나간다.
   *
   * ponytail: 중간 댓글 하나만 수정된 경우는 이 표식으로 잡히지 않는다. 전부 잡으려면
   * 모든 댓글을 훑어 해시를 내야 하는데 스레드마다 매번 그러기엔 비싸다. 필요해지면
   * 마지막 N개만 해시하는 쪽으로 좁혀서 올린다.
   */
  async getThread(reference: string): Promise<ThreadSnapshot> {
    const ref = parseThreadRef(this.#expand(reference))
    if (!ref) return { reference, lastEventId: '', missing: true }

    const base = `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`
    const issue = await this.#client.get<IssuePayload>(base)
    if (!issue.ok || !issue.data) return { reference, lastEventId: '', missing: true }

    const count = issue.data.comments
    const marker = `issue:${issue.data.updated_at}|c${count}`
    if (count === 0) return { reference, lastEventId: marker }

    const last = await this.#client.get<IssueComment[]>(`${base}/comments?per_page=1&page=${count}`)
    if (!last.ok || !last.data) {
      // 댓글이 있다는데 못 읽었다. 안다고 답할 수 없으므로 실행을 막는다.
      return { reference, lastEventId: '', missing: true }
    }
    const tail = last.data.at(-1)
    return {
      reference,
      lastEventId: tail ? `${marker}|${tail.id}:${tail.updated_at}` : marker,
    }
  }

  /** source별 현재 baseline. 하나라도 못 읽으면 그 source는 `unknown`으로 남는다. */
  async getBaselines(queries: readonly BaselineQuery[]): Promise<CanonicalSnapshot[]> {
    const out: CanonicalSnapshot[] = []
    for (const query of queries) {
      const configured = this.#sourceRefs[query.sourceId]
      const ref = query.ref ?? configured?.ref
      const repo = this.#repoOf(configured)
      if (!ref || !repo) {
        out.push({ sourceId: query.sourceId, baseline: 'unknown' })
        continue
      }
      const response = await this.#client.get<RefPayload>(`/repos/${repo}/commits/${encodeURIComponent(ref)}`)
      const sha = response.data?.sha ?? response.data?.object?.sha
      out.push({ sourceId: query.sourceId, baseline: sha ?? 'unknown' })
    }
    return out
  }

  /**
   * 승인된 단일 행위. 아는 action만 수행하며, 그 외에는 아무것도 하지 않는다 —
   * Grant의 allowedWrites 검사(Executor)에 더해 Adapter도 자기 몫으로 닫아 둔다.
   */
  async execute(action: ExternalAction): Promise<ExternalActionResult> {
    if (action.action !== 'github.issue_comment.create') {
      return { ok: false, error: `unsupported action: ${action.action}` }
    }
    const ref = parseThreadRef(this.#expand(action.target))
    if (!ref) return { ok: false, error: `unrecognized target: ${action.target}` }

    const response = await this.#client.post<{ html_url: string }>(
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`,
      { body: action.payload },
    )
    if (!response.ok || !response.data) return { ok: false, error: response.error ?? `HTTP ${response.status}` }
    return { ok: true, resultRef: response.data.html_url }
  }

  #expand(reference: string): string {
    return reference.startsWith('#') && this.#defaultRepo ? `${this.#defaultRepo}${reference}` : reference
  }

  #repoOf(configured?: { owner?: string; repo?: string }): string | null {
    if (configured?.owner && configured.repo) return `${configured.owner}/${configured.repo}`
    return this.#defaultRepo ?? null
  }
}
