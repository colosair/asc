// GitLab SCM — 승인된 단일 외부 행위의 GitLab 인스턴스 (OM §11.5, C-09).
//
// 이 파일이 있는 이유는 실측이다. Grant 실행 경로는 CLI 안에서 GitHub 하나로 못 박혀
// 있었고, 그래서 코드가 GitLab 에 있는 프로젝트에서는 승인이 끝난 뒤에야 "실행할 통로가
// 없다" 가 드러났다. 관측 경로는 진작 provider-neutral 이었는데 실행 경로만 남아 있었다.
//
// **쓰기는 `execute` 하나뿐이고, 그 함수는 Grant 를 쥔 Executor 만 부른다.** Port 자체는
// 권한을 판단하지 않으므로 호출 지점이 좁게 유지되는 것이 계약이다.
//
// `git.push` 가 여기 있는 것이 어색해 보일 수 있다. 그러나 원격에 쓰는 일이고, 그 원격은
// 이 결합이 가리키는 바로 그 프로젝트다 — 승인된 외부 write 하나를 수행한다는 점에서
// MR 생성과 같은 종류의 행위다. Core 는 여전히 어느 것도 해석하지 않는다.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { CanonicalSnapshot } from '../../core/model/entities.ts'
import type {
  BaselineQuery,
  ExternalAction,
  ExternalActionResult,
  ScmPort,
  ThreadSnapshot,
} from '../../ports/scm.ts'
import { encodeProject, parseRef, type GitLabReader, type GitLabWriter } from './client.ts'

const run = promisify(execFile)

/** 이 adapter 가 수행할 수 있는 행위. 목록에 없는 것은 하지 않는다. */
export const GITLAB_ACTIONS = [
  'gitlab.note.create',
  'gitlab.mr.create',
  'gitlab.mr.merge',
  'gitlab.issue.update',
  'git.push',
] as const

export type GitLabScmDeps = {
  reader: GitLabReader
  writer: GitLabWriter
  /** 이 결합이 가리키는 프로젝트. `#7` 처럼 짧게 온 참조를 여기에 붙인다. */
  defaultProject?: string
  /** canonical source id → ref. Profile 이 정한다 — adapter 가 추측하지 않는다. */
  sourceRefs?: Readonly<Record<string, { ref: string }>>
  /** `git.push` 를 수행할 자리. 없으면 push 는 할 수 없다고 답한다. */
  repoRoot?: string
  /** 테스트가 실제 git 을 부르지 않게 하는 통로. */
  git?: (args: readonly string[], cwd: string) => Promise<{ ok: boolean; detail: string }>
}

export class GitLabScm implements ScmPort {
  readonly id = 'gitlab'
  #reader: GitLabReader
  #writer: GitLabWriter
  #project: string | undefined
  #sourceRefs: Readonly<Record<string, { ref: string }>>
  #repoRoot: string | undefined
  #git: NonNullable<GitLabScmDeps['git']>

  constructor(deps: GitLabScmDeps) {
    this.#reader = deps.reader
    this.#writer = deps.writer
    this.#project = deps.defaultProject
    this.#sourceRefs = deps.sourceRefs ?? {}
    this.#repoRoot = deps.repoRoot
    this.#git =
      deps.git ??
      (async (args, cwd) => {
        try {
          const { stdout, stderr } = await run('git', [...args], { cwd })
          return { ok: true, detail: (stdout || stderr).trim() }
        } catch (error) {
          const failure = error as { stderr?: string; message?: string }
          return { ok: false, detail: (failure.stderr || failure.message || String(error)).trim() }
        }
      })
  }

  /**
   * 스레드의 지금 상태. Drift Guard 가 승인 시점과 대조하는 값이다.
   *
   * 마지막 사건은 note 하나로 본다 — 목록의 마지막 id 를 쓰고, 못 읽으면 `missing` 이다.
   * 모르는 것을 "변화 없음" 으로 적으면 오래된 초안이 그대로 나간다.
   */
  async getThread(reference: string): Promise<ThreadSnapshot> {
    const ref = parseRef(this.#expand(reference))
    if (!ref) return { reference, lastEventId: '', missing: true }
    const path = ref.kind === 'change' ? 'merge_requests' : 'issues'
    const response = await this.#reader.get<{ id: number; updated_at?: string }[]>(
      `/projects/${encodeProject(ref.project)}/${path}/${ref.iid}/notes?per_page=1&sort=desc`,
    )
    if (!response.ok || !response.data) return { reference, lastEventId: '', missing: true }
    const latest = response.data[0]
    return { reference, lastEventId: latest ? String(latest.id) : '(none)' }
  }

  /** 정본의 지금 baseline. Profile 이 정한 ref 만 묻는다. */
  async getBaselines(queries: readonly BaselineQuery[]): Promise<CanonicalSnapshot[]> {
    const out: CanonicalSnapshot[] = []
    for (const query of queries) {
      const ref = query.ref ?? this.#sourceRefs[query.sourceId]?.ref
      if (!ref || !this.#project) {
        out.push({ sourceId: query.sourceId, baseline: '(unknown)' })
        continue
      }
      const response = await this.#reader.get<{ commit?: { id?: string } }>(
        `/projects/${encodeProject(this.#project)}/repository/branches/${encodeURIComponent(ref)}`,
      )
      const baseline = response.ok ? (response.data?.commit?.id ?? '(unknown)') : '(unknown)'
      out.push({ sourceId: query.sourceId, baseline })
    }
    return out
  }

  /**
   * 승인된 단일 행위. **아는 것만 한다** — Grant 의 allowedWrites 검사(Executor)에 더해
   * adapter 도 자기 몫으로 닫아 둔다.
   */
  /** 이 통로가 아는 행위. execute 의 분기와 같은 목록이어야 한다. */
  supports(action: string): boolean {
    return (GITLAB_ACTIONS as readonly string[]).includes(action)
  }

  async execute(action: ExternalAction): Promise<ExternalActionResult> {
    switch (action.action) {
      case 'gitlab.note.create':
        return this.#note(action)
      case 'gitlab.mr.create':
        return this.#createChange(action)
      case 'gitlab.mr.merge':
        return this.#mergeChange(action)
      case 'gitlab.issue.update':
        return this.#updateIssue(action)
      case 'git.push':
        return this.#push(action)
      default:
        return { ok: false, error: `unsupported action: ${action.action}` }
    }
  }

  async #note(action: ExternalAction): Promise<ExternalActionResult> {
    const ref = parseRef(this.#expand(action.target))
    if (!ref) return { ok: false, error: `unrecognized target: ${action.target}` }
    const path = ref.kind === 'change' ? 'merge_requests' : 'issues'
    const response = await this.#writer.post<{ id: number }>(
      `/projects/${encodeProject(ref.project)}/${path}/${ref.iid}/notes`,
      { body: action.payload },
    )
    if (!response.ok || !response.data) return { ok: false, error: response.error ?? `HTTP ${response.status}` }
    return { ok: true, resultRef: `${ref.project}${ref.kind === 'change' ? '!' : '#'}${ref.iid}#note_${response.data.id}` }
  }

  /**
   * 변경요청 생성. payload 는 승인된 내용 그대로이므로 여기서 다시 쓰지 않는다 —
   * 필드는 JSON 으로 온다.
   */
  async #createChange(action: ExternalAction): Promise<ExternalActionResult> {
    const project = action.target || this.#project
    if (!project) return { ok: false, error: 'no project for gitlab.mr.create' }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(action.payload) as Record<string, unknown>
    } catch (error) {
      return { ok: false, error: `payload is not JSON: ${error instanceof Error ? error.message : String(error)}` }
    }
    for (const required of ['source_branch', 'target_branch', 'title']) {
      if (typeof body[required] !== 'string') return { ok: false, error: `payload is missing ${required}` }
    }
    const response = await this.#writer.post<{ iid: number; web_url?: string }>(
      `/projects/${encodeProject(project)}/merge_requests`,
      body,
    )
    if (!response.ok || !response.data) return { ok: false, error: response.error ?? `HTTP ${response.status}` }
    return { ok: true, resultRef: response.data.web_url ?? `${project}!${response.data.iid}` }
  }

  async #mergeChange(action: ExternalAction): Promise<ExternalActionResult> {
    const ref = parseRef(this.#expand(action.target))
    if (!ref || ref.kind !== 'change') return { ok: false, error: `unrecognized change: ${action.target}` }
    // GitLab 의 merge 는 PUT 이다. 이 adapter 의 통로는 post 하나이므로, 통로가 넓어지기
    // 전까지는 할 수 없다고 **말한다** — 못 하는 것을 하는 척하지 않는다.
    const response = await this.#writer.post<{ web_url?: string; state?: string }>(
      `/projects/${encodeProject(ref.project)}/merge_requests/${ref.iid}/merge`,
      action.payload ? (JSON.parse(action.payload) as Record<string, unknown>) : {},
    )
    if (!response.ok || !response.data) return { ok: false, error: response.error ?? `HTTP ${response.status}` }
    return { ok: true, resultRef: response.data.web_url ?? `${ref.project}!${ref.iid}` }
  }

  async #updateIssue(action: ExternalAction): Promise<ExternalActionResult> {
    const ref = parseRef(this.#expand(action.target))
    if (!ref || ref.kind !== 'issue') return { ok: false, error: `unrecognized issue: ${action.target}` }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(action.payload) as Record<string, unknown>
    } catch (error) {
      return { ok: false, error: `payload is not JSON: ${error instanceof Error ? error.message : String(error)}` }
    }
    const response = await this.#writer.post<{ web_url?: string }>(
      `/projects/${encodeProject(ref.project)}/issues/${ref.iid}`,
      body,
    )
    if (!response.ok || !response.data) return { ok: false, error: response.error ?? `HTTP ${response.status}` }
    return { ok: true, resultRef: response.data.web_url ?? `${ref.project}#${ref.iid}` }
  }

  /**
   * 원격에 가지를 올린다. target 은 `<remote> <branch>` 또는 `<branch>` 다.
   *
   * `--force` 계열은 받지 않는다 — 되돌릴 수 없는 형태를 승인 한 번으로 열지 않는다.
   */
  async #push(action: ExternalAction): Promise<ExternalActionResult> {
    if (!this.#repoRoot) return { ok: false, error: 'no repository root for git.push' }
    const parts = action.target.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) return { ok: false, error: 'git.push needs a branch' }
    if (parts.some((part) => part.startsWith('-'))) return { ok: false, error: `git.push takes no flags: ${action.target}` }
    const [remote, branch] = parts.length === 1 ? ['origin', parts[0]!] : [parts[0]!, parts[1]!]
    const result = await this.#git(['push', remote, branch], this.#repoRoot)
    return result.ok
      ? { ok: true, resultRef: `${remote}/${branch}` }
      : { ok: false, error: result.detail }
  }

  #expand(reference: string): string {
    if (!this.#project) return reference
    return /^[!#]\d+$/.test(reference.trim()) ? `${this.#project}${reference.trim()}` : reference
  }
}
