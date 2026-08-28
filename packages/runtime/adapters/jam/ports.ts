// JAM 작업 항목 Adapter — Inventory · ResourceContext.
//
// ASC는 이 파일 밖에서 Jira를 알지 못한다. REST·자격·문서 포맷·pagination 정책은 전부
// JAM 뒤에 있고, 여기서는 tool 세 개의 응답을 Port 모양으로 옮기기만 한다.
//
// 이 adapter가 **제공하지 않는 것**이 제공하는 것만큼 중요하다:
//   context.history  JAM이 changelog를 주지 않는다. 없는 것을 있는 척하지 않는다
//   observe.delta    푸시가 없다. `updated >= …` 조회는 EventSource가 아니라 회수 경로다

import type {
  InventoryItem,
  InventoryPage,
  InventoryPort,
  InventoryQuery,
} from '../../ports/inventory.ts'
import type {
  CommentQuery,
  ContextComment,
  ResourceContextPort,
  ResourceSnapshot,
} from '../../ports/resource-context.ts'
import type { JamMcpClient } from './mcp-client.ts'

/** JAM이 모든 결과에 붙여 주는 완결성 표식. 이 값을 접으면 잘린 목록이 "전체"가 된다. */
export type JamMeta = {
  complete?: boolean
  commentsComplete?: boolean
  overflow?: string[]
  missingKeys?: string[]
  reason?: string
  notes?: string[]
}

type JamIssue = {
  key: string
  summary: string
  status: string
  updated: string
  labels?: string[]
  components?: string[]
  assignee?: string
  priority?: string
  description?: string
  links?: { issue?: { key?: string } }[]
  parent?: { key?: string }
  subtasks?: { key?: string }[]
  comments?: { id: string; created: string; updated?: string; body: string; author?: string }[]
}

type JamPayload = { issues?: JamIssue[]; meta?: JamMeta }

/**
 * `updated` 는 분 단위 정밀도라 기준선을 그대로 쓰면 같은 분에 몰린 변경을 놓친다.
 * 조금 뒤로 물려 겹쳐 읽는다 — 누락보다 중복이 안전하고, 중복은 revision 비교가 거른다
 * (OM §10.5, event-source의 overlap과 같은 이유).
 */
const OVERLAP_MS = 60_000

/**
 * JQL이 시각을 읽는 timezone. **JQL 날짜 리터럴에는 offset을 적을 자리가 없다** —
 * `"2026/08/26 09:04"` 는 Jira 계정의 timezone으로 해석된다. 그래서 이 값은 ASC가 도는
 * 기계의 timezone이 아니라 **Jira 쪽 timezone**이며, 선언하지 않으면 UTC로 읽는다.
 *
 * 기본값을 host timezone으로 두지 않는 이유: 같은 순간이 기계마다 다른 JQL이 되고,
 * 그 차이는 조회 결과의 차이라 조용히 누락으로 나타난다(3-OS CI에서 실제로 드러났다).
 *
 * 잘못 선언했을 때의 방향도 남긴다 — 실제 Jira보다 **동쪽**을 선언하면 기준선이 앞으로
 * 밀려 그만큼을 놓치고, **서쪽**을 선언하면 겹쳐 읽어 중복이 는다. 모를 때의 UTC는
 * 한국·일본처럼 동쪽 계정에 대해 안전한 쪽(중복)으로 틀린다.
 */
const DEFAULT_TIMEZONE = 'UTC'

/**
 * JQL 리터럴로 안전한 시각 문자열. JAM은 JQL을 그대로 통과시키므로 여기서 다듬는다.
 *
 * 같은 순간은 어느 기계에서 불러도 같은 문자열이어야 한다 — 그래서 `Date` 의 host 기준
 * getter(`getHours()` 등)를 쓰지 않고 timezone을 명시해 서식한다.
 */
function jqlTime(iso: string, timeZone: string): string {
  const at = new Date(new Date(iso).getTime() - OVERLAP_MS)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at)
  const of = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  // `hour12: false` 로도 자정을 `24` 로 주는 구현이 있다 — 그대로 두면 JQL이 거절한다.
  const hour = of('hour') === '24' ? '00' : of('hour')
  return `${of('year')}/${of('month')}/${of('day')} ${hour}:${of('minute')}`
}

export type JamPortsDeps = {
  client: JamMcpClient
  /** Jira project key. `.jira-agent/project.yaml` 이 선언한 값이며 추측하지 않는다. */
  projectKey: string
  /**
   * JQL 날짜 리터럴을 해석할 timezone(IANA). **Jira 계정의 timezone이며 기계의 것이
   * 아니다.** 선언하지 않으면 `DEFAULT_TIMEZONE`.
   */
  timezone?: string
}

class JamBase {
  readonly id = 'jam'
  protected client: JamMcpClient
  protected projectKey: string
  protected timezone: string

  constructor(deps: JamPortsDeps) {
    this.client = deps.client
    this.projectKey = deps.projectKey
    this.timezone = deps.timezone ?? DEFAULT_TIMEZONE
  }
}

/**
 * 상태 무관 열거. 여기서 `scope` 를 고르는 규칙이 이 adapter의 핵심 판단이다.
 *
 * 이 Port의 소비자는 회수 경로(Reconcile·Census)이고 그 둘은 **빠짐없음이 성립해야**
 * 의미가 있다. 그래서 항상 `complete` 로 부른다 — "호출이 작아 보이니 preview" 같은
 * 추측으로 정하지 않는다. 값싼 훑기(preview)는 쓸 자리가 생기면 그때 연다.
 */
export class JamInventory extends JamBase implements InventoryPort {
  async enumerate(query: InventoryQuery, cursor?: string): Promise<InventoryPage> {
    // JAM은 cursor를 노출하지 않는다. 페이지 순회는 JAM 안에서 끝나므로 ASC가 이어받을
    // 지점이 없다 — 두 번째 페이지 요청은 성립하지 않는다.
    if (cursor) return { items: [], complete: true }

    const clauses = [`project = ${this.projectKey}`]
    if (query.updatedSince)
      clauses.push(`updated >= "${jqlTime(query.updatedSince, this.timezone)}"`)

    const response = await this.client.callTool<JamPayload>('jira_search', {
      jql: `${clauses.join(' AND ')} ORDER BY updated ASC`,
      scope: 'complete',
    })
    // 못 읽은 것을 "없다"로 돌려주면 census가 멀쩡한 항목을 사라졌다고 본다.
    if (!response.ok) return { items: [], complete: false }

    const { issues = [], meta = {} } = response.value
    return {
      items: issues.map((issue): InventoryItem => ({
        reference: issue.key,
        state: issue.status,
        updatedAt: issue.updated,
        // 이 provider가 주는 유일한 변화 신호다. 필드 단위 delta는 알 수 없다.
        revisionMarker: issue.updated,
        title: issue.summary,
        assignees: issue.assignee ? [issue.assignee] : [],
        labels: [...(issue.labels ?? []), ...(issue.components ?? [])],
      })),
      // JAM이 완결을 부인하면 그대로 옮긴다. Core가 이 값을 보고 상실 판정·기준선 이동을
      // 모두 보류한다 (C-07 §1.5·§8.2).
      complete: meta.complete === true,
    }
  }
}

export class JamResourceContext extends JamBase implements ResourceContextPort {
  /**
   * `jira_context` 가 아니라 `jira_full` 을 부른다.
   *
   * context 단계는 본문(description)을 싣지 않는다. 그런데 ResourceSnapshot 의 `body` 는
   * 조사와 계약 초안이 완료 조건을 읽는 유일한 자리다 — 그것을 비운 채 넘기면 "작업 항목에
   * 완료 조건이 없다"는 **거짓 사실**이 만들어지고, 없는 조건을 사람에게 되묻게 된다.
   * provider 자신의 지침도 계약·합의 판정에는 full 을 쓰라고 말한다.
   */
  async getResource(reference: string): Promise<ResourceSnapshot> {
    const response = await this.client.callTool<JamPayload>('jira_full', { issueKeys: [reference] })
    if (!response.ok) return missing(reference)

    const issue = response.value.issues?.[0]
    // 안 돌아온 키는 없는 것일 수도, 안 보이는 것일 수도 있다. provider가 둘을 합쳐 주므로
    // 우리도 합쳐진 사실 이상을 지어내지 않는다.
    if (!issue) return missing(reference)

    const related = [
      ...(issue.parent?.key ? [issue.parent.key] : []),
      ...(issue.subtasks ?? []).flatMap((sub) => (sub.key ? [sub.key] : [])),
      ...(issue.links ?? []).flatMap((link) => (link.issue?.key ? [link.issue.key] : [])),
    ]

    return {
      reference,
      state: issue.status,
      title: issue.summary,
      ...(issue.description ? { body: issue.description } : {}),
      ...(issue.assignee ? { assignees: [issue.assignee] } : {}),
      labels: [...(issue.labels ?? []), ...(issue.components ?? [])],
      updatedAt: issue.updated,
      revisionMarker: issue.updated,
      ...(related.length > 0 ? { related } : {}),
    }
  }

  /**
   * 논의는 full에만 실린다.
   *
   * **`commentsComplete === false` 를 "댓글 없음"으로 접지 않는다.** 예산을 넘기면 JAM이
   * 오래된 것부터 떨어뜨리는데, 그것을 조용히 받으면 조사 단계가 "논의를 다 봤다"고
   * 착각한다. 그래서 잘렸다는 사실을 항목 하나로 끼워 넣어 사람이 보게 한다.
   */
  async getComments(reference: string, query: CommentQuery = {}): Promise<ContextComment[]> {
    const response = await this.client.callTool<JamPayload>('jira_full', { issueKeys: [reference] })
    if (!response.ok) return []

    const issue = response.value.issues?.[0]
    if (!issue) return []

    const comments = (issue.comments ?? []).slice(0, query.limit ?? 20).map((comment): ContextComment => ({
      id: comment.id,
      author: comment.author ?? '(unknown)',
      at: comment.updated ?? comment.created,
      body: comment.body,
    }))

    if (response.value.meta?.commentsComplete === false) {
      comments.push({
        id: 'jam:incomplete',
        author: '(ASC)',
        at: new Date(0).toISOString(),
        body: '이 논의는 일부만 받았다 — provider가 예산 안에서 잘라 보냈다. 전부 보려면 원본을 열어라.',
      })
    }
    return comments
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

/**
 * tracker 가 "끝났다"고 말하는가. **판정이 아니라 어휘 번역이다** — Core 는 Jira 상태
 * 문자열을 알면 안 되고(C-09 §6.1), 그렇다고 상태 문자열을 아무도 안 읽으면 "진행 중인데
 * 이미 병합됨"을 알아볼 수 없다. 그 번역을 adapter 자리에서 한 줄로 한다.
 *
 * 모르는 어휘는 undefined 로 남긴다 — 모르는 것을 "안 끝났다"로 읽으면 없는 stale 을 만든다.
 *
 * ponytail: 닫힘 상태 목록은 휴리스틱이다. JAM 이 statusCategory 를 실어 주면 그것으로 바꾼다.
 */
const DONE_STATUSES = new Set(['done', 'closed', 'resolved', 'complete', 'completed', '완료', '닫힘', '해결됨'])
const OPEN_STATUSES = new Set([
  'to do',
  'todo',
  'open',
  'in progress',
  'in review',
  'backlog',
  '해야 할 일',
  '진행 중',
  '검토 중',
])

export function statusIndicatesDone(status: string | undefined): boolean | undefined {
  if (!status) return undefined
  const normalized = status.trim().toLowerCase()
  if (DONE_STATUSES.has(normalized)) return true
  if (OPEN_STATUSES.has(normalized)) return false
  return undefined
}
