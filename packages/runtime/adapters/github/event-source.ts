// GitHub polling Event Source.
//
// 하는 일은 "무슨 일이 있었는지" 모아 오는 것까지다. 무엇이 중요한지, 누구에게 알릴지는
// Monitor가 정한다 (B-09) — 여기서 우선순위를 매기기 시작하면 Profile 없이 프로젝트
// 사정을 아는 Adapter가 되어버린다.
//
// cursor는 호출자가 갱신한다. Phase B가 중간에 실패했을 때 cursor를 전진시키지 않고
// 다시 받는 편이 안전하기 때문이다 — 누락보다 중복이 낫고, 중복은 event key가 거른다
// (OM §10.5).

import type { Cursor, EventBatch, EventSource, RawEvent } from '../../ports/event-source.ts'
import type { GitHubClient } from './client.ts'

type Notification = {
  id: string
  updated_at: string
  reason: string
  subject: { title: string; type: string; url: string | null }
  repository: { full_name: string }
}

type Comment = {
  id: number
  created_at: string
  updated_at: string
  html_url: string
  user: { login: string } | null
  body: string
  issue_url?: string
  pull_request_url?: string
}

/**
 * cursor에 담기는 것. 엔드포인트마다 기준선이 달라 한 값으로 못 묶는다.
 * 문자열로 직렬화해 Port 계약(Cursor = string | null)에 맞춘다.
 *
 * `since`는 경계를 포함하므로 마지막 항목이 다음 회차에 다시 온다. 그대로 둔다 —
 * 1초를 밀어 중복을 없애면 같은 시각에 달린 다른 댓글이 통째로 사라진다.
 * 누락보다 중복이 안전하고, 중복은 event key exact lookup이 거른다 (OM §10.5).
 *
 * `page`는 한 배치가 perPage를 꽉 채웠을 때만 세워진다. 같은 시각 이벤트가 한 페이지를
 * 넘겨도 다음 회차가 이어서 받도록 하는 장치다.
 */
export type GitHubCursor = {
  notificationsSince?: string
  notificationsLastModified?: string
  notificationsPage?: number
  commentsSince?: string
  commentsPage?: number
  reviewCommentsSince?: string
  reviewCommentsPage?: number
}

/**
 * 다음 조회를 어디서부터 시작할지. 마지막 항목보다 조금 **뒤로** 잡는다.
 *
 * `since`는 그 시각 이후를 주므로, 마지막 항목의 시각을 그대로 쓰면 그 직후 같은 초에
 * 달린 이벤트가 영영 안 온다. 앞으로 미는 것(bump)은 더 나쁘고, 정확히 맞추는 것도
 * 초 단위 경계에서는 불가능하다. 그래서 조금 겹쳐 읽고 중복은 key로 거른다.
 */
const OVERLAP_MS = 1000

function watermark(timestamp: string): string {
  return new Date(new Date(timestamp).getTime() - OVERLAP_MS).toISOString()
}

/**
 * 한 페이지를 읽고 나서 기준선과 페이지를 어떻게 옮길지 정한다.
 * 꽉 찬 페이지는 뒤가 더 있다는 뜻이므로 기준선을 건드리지 않고 페이지만 넘긴다 —
 * 같은 시각 이벤트가 페이지 경계에 걸려도 잃지 않는다.
 */
function advance(
  rowCount: number,
  perPage: number,
  since: string | undefined,
  page: number,
  lastTimestamp: string | undefined,
): { since?: string; page?: number } {
  if (rowCount >= perPage) return { ...(since !== undefined ? { since } : {}), page: page + 1 }
  if (lastTimestamp !== undefined) return { since: watermark(lastTimestamp) }
  return since !== undefined ? { since } : {}
}

export function parseCursor(cursor: Cursor): GitHubCursor {
  if (!cursor) return {}
  try {
    return JSON.parse(cursor) as GitHubCursor
  } catch {
    return {}
  }
}

export type GitHubEventSourceDeps = {
  client: GitHubClient
  /** `owner/repo`. 알림도 댓글도 이 저장소 것만 본다. */
  repo: string
  /** 한 번에 가져올 최대 개수. 폭주해도 한 배치가 감당 가능한 크기로 끊는다. */
  perPage?: number
}

export class GitHubEventSource implements EventSource {
  readonly id = 'github-poll'
  #client: GitHubClient
  #repo: string
  #perPage: number

  constructor(deps: GitHubEventSourceDeps) {
    this.#client = deps.client
    this.#repo = deps.repo
    this.#perPage = deps.perPage ?? 50
  }

  /** 세 갈래 모두 같은 시점부터 본다. 페이지 상태는 비워 둔다 — 아직 아무것도 읽지 않았다. */
  cursorFrom(since: string): Cursor {
    return JSON.stringify({ notificationsSince: since, commentsSince: since, reviewCommentsSince: since })
  }

  async drain(cursor: Cursor): Promise<EventBatch> {
    const state = parseCursor(cursor)
    const events: RawEvent[] = []
    const next: GitHubCursor = { ...state }

    // 1. 알림 — mention·assign·review_requested가 여기로 온다.
    //    전역이 아니라 저장소 한정으로 묻는다. `.asc/`는 프로젝트마다 따로 있으므로
    //    다른 저장소의 알림이 이 Runtime에 섞이면 안 된다 (OM §3.2).
    //    all=true인 이유는 감지가 사람의 읽음 처리에 좌우되면 안 되기 때문이다 —
    //    GitHub 웹에서 먼저 읽었다는 이유로 Monitor가 그 사건을 놓치면 안 된다.
    const notificationPage = state.notificationsPage ?? 1
    const notifications = await this.#client.get<Notification[]>(
      `/repos/${this.#repo}/notifications?all=true&per_page=${this.#perPage}&page=${notificationPage}` +
        (state.notificationsSince ? `&since=${state.notificationsSince}` : ''),
      // 페이지를 이어받는 중이면 조건부 요청을 쓰지 않는다. 304가 오면 남은 페이지를
      // 영영 못 받기 때문이다.
      state.notificationsLastModified && state.notificationsPage === undefined
        ? { ifModifiedSince: state.notificationsLastModified }
        : {},
    )
    if (notifications.ok && notifications.data) {
      for (const item of notifications.data) {
        events.push({
          eventKey: `notification:${item.id}:${item.updated_at}`,
          detectedAt: item.updated_at,
          reference: referenceOf(item),
          hints: { actors: [], labels: [] },
          raw: { kind: 'notification', reason: item.reason, subjectType: item.subject.type, title: item.subject.title },
        })
      }
      const rows = notifications.data
      const moved = advance(
        rows.length,
        this.#perPage,
        state.notificationsSince,
        notificationPage,
        rows.at(-1)?.updated_at,
      )
      if (moved.since !== undefined) next.notificationsSince = moved.since
      if (moved.page === undefined) delete next.notificationsPage
      else next.notificationsPage = moved.page
      // 마지막 페이지까지 읽었을 때만 조건부 요청 기준을 갱신한다
      if (notifications.lastModified && moved.page === undefined) {
        next.notificationsLastModified = notifications.lastModified
      }
    }

    // 2. 이슈 댓글 — 알림이 오지 않는 참여 스레드의 움직임까지 본다
    const comments = await this.#drainComments('issues', state.commentsSince, state.commentsPage)
    for (const comment of comments.rows) {
      events.push({
        eventKey: `comment:${comment.id}`,
        detectedAt: comment.updated_at,
        reference: issueRefOf(comment, this.#repo),
        hints: { actors: comment.user ? [comment.user.login] : [] },
        raw: { kind: 'issue_comment', url: comment.html_url, body: comment.body },
      })
    }
    if (comments.read) {
      if (comments.since !== undefined) next.commentsSince = comments.since
      if (comments.page === undefined) delete next.commentsPage
      else next.commentsPage = comments.page
    }

    // 3. PR 리뷰 댓글 — 코드 줄에 달린 것들
    const reviewComments = await this.#drainComments('pulls', state.reviewCommentsSince, state.reviewCommentsPage)
    for (const comment of reviewComments.rows) {
      events.push({
        eventKey: `review_comment:${comment.id}`,
        detectedAt: comment.updated_at,
        reference: pullRefOf(comment, this.#repo),
        hints: { actors: comment.user ? [comment.user.login] : [] },
        raw: { kind: 'review_comment', url: comment.html_url, body: comment.body },
      })
    }
    if (reviewComments.read) {
      if (reviewComments.since !== undefined) next.reviewCommentsSince = reviewComments.since
      if (reviewComments.page === undefined) delete next.reviewCommentsPage
      else next.reviewCommentsPage = reviewComments.page
    }

    // review 제출(승인/변경요청) 자체는 여기서 긁지 않는다. 본인이 관련된 것은 알림으로
    // 들어오고, 그 밖의 것까지 보려면 열린 PR을 전부 순회해야 해서 값이 비싸다.
    // 필요해지면 `/repos/{repo}/pulls/{n}/reviews`로 `review:<id>` key를 만든다.

    events.sort((a, b) => a.detectedAt.localeCompare(b.detectedAt))

    const hasMore =
      next.notificationsPage !== undefined ||
      next.commentsPage !== undefined ||
      next.reviewCommentsPage !== undefined
    return { events, cursor: JSON.stringify(next), hasMore }
  }

  /** 댓글 한 페이지를 받고 기준선을 옮긴다 (`advance` 참조). */
  async #drainComments(
    kind: 'issues' | 'pulls',
    since: string | undefined,
    page: number | undefined,
  ): Promise<{ read: boolean; rows: Comment[]; since?: string; page?: number }> {
    const current = page ?? 1
    const response = await this.#client.get<Comment[]>(
      `/repos/${this.#repo}/${kind}/comments?per_page=${this.#perPage}&sort=updated&direction=asc&page=${current}` +
        (since ? `&since=${since}` : ''),
    )
    if (!response.ok || !response.data) return { read: false, rows: [] }

    const rows = response.data
    return { read: true, rows, ...advance(rows.length, this.#perPage, since, current, rows.at(-1)?.updated_at) }
  }
}

function referenceOf(item: Notification): string {
  const number = item.subject.url?.match(/\/(\d+)$/)?.[1]
  return number ? `${item.repository.full_name}#${number}` : item.repository.full_name
}

function issueRefOf(comment: Comment, repo: string): string {
  const number = comment.issue_url?.match(/\/(\d+)$/)?.[1]
  return number ? `${repo}#${number}` : repo
}

function pullRefOf(comment: Comment, repo: string): string {
  const number = comment.pull_request_url?.match(/\/(\d+)$/)?.[1]
  return number ? `${repo}#${number}` : repo
}

/**
 * GitHub notification의 `reason` 어휘를 Generic Signal로 옮기는 매핑.
 *
 * Core에 두지 않는 이유는 이것이 GitHub의 말이기 때문이다. `mention`·`review_requested`는
 * 이 provider가 쓰는 단어이고, 다른 곳은 다른 단어를 쓴다. Adapter가 자기 어휘를 내놓고
 * Profile이 그것을 고르면, Core는 끝까지 신호의 이름만 알면 된다 (OM §10.6).
 */
export const GITHUB_REASON_SIGNALS = {
  assign: 'assigned_to_me',
  mention: 'mentioned_me',
  team_mention: 'mentioned_me',
  review_requested: 'review_requested',
  author: 'my_pr_reviewed',
  comment: 'participated_thread_changed',
  subscribed: 'participated_thread_changed',
  state_change: 'participated_thread_changed',
} as const
