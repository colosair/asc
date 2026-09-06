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
import type { RemoteFacts } from '../../core/execution/remote-review.ts'
import { normalize } from '../../core/execution/remote-review.ts'
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
  // 조율 게시. 실행은 CoordinationSurface 가 하고, 이 통로는 **그 행위가 승인될 수
  // 있다는 것**만 안다 — 발급 시점에 "할 수 없는 일을 승인시키지 않는다" 가 성립하려면
  // 이 목록이 그 사실을 담아야 한다.
  'coordination.publish',
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
  /** 이 결합이 가리키는 원격 이름. 검수가 URL·신원을 읽을 자리다. */
  remoteName?: string
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
  #remote: string
  #git: NonNullable<GitLabScmDeps['git']>

  constructor(deps: GitLabScmDeps) {
    this.#reader = deps.reader
    this.#writer = deps.writer
    this.#project = deps.defaultProject
    this.#sourceRefs = deps.sourceRefs ?? {}
    this.#repoRoot = deps.repoRoot
    this.#remote = deps.remoteName ?? 'origin'
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

  /**
   * 나가기 **전에** 읽히는 사실 (0.8.0 §D·§L·§M·§N). 판정은 하지 않는다 — Core 의
   * Remote Review 가 이 사실로 판정한다. 여기서 쓰는 것은 하나도 없다.
   */
  async review(action: ExternalAction): Promise<RemoteFacts> {
    const capability = this.supports(action.action)
    switch (action.action) {
      case 'git.push':
        return this.#reviewPush(action, capability)
      case 'gitlab.mr.create':
        return this.#reviewCreateChange(action, capability)
      case 'gitlab.mr.merge':
        return this.#reviewMergeChange(action, capability)
      default: {
        const ref = parseRef(this.#expand(action.target))
        return {
          provider: this.id,
          capability,
          target: action.target,
          ...(ref ? { resource: ref.project } : this.#project ? { resource: this.#project } : {}),
        }
      }
    }
  }

  /**
   * 나간 **뒤에** 밖에서 읽히는 사실. 명령이 0 으로 끝났다는 것은 성공이 아니다.
   */
  async verify(
    action: ExternalAction,
    result: { resultRef: string },
  ): Promise<{ observed: Record<string, string | undefined>; unsupported?: boolean }> {
    switch (action.action) {
      case 'git.push': {
        if (!this.#repoRoot) return { observed: {}, unsupported: true }
        const [remote, branch] = this.#pushTarget(action.target)
        const listed = await this.#git(['ls-remote', remote, `refs/heads/${branch}`], this.#repoRoot)
        return { observed: { sha: listed.ok ? listed.detail.split(/\s+/)[0] : undefined, target: `${remote}/${branch}` } }
      }
      case 'gitlab.mr.create': {
        const iid = /!(\d+)/.exec(result.resultRef)?.[1]
        const project = this.#projectOf(action.target)
        if (!iid || !project) return { observed: {}, unsupported: true }
        const mr = await this.#change(project, Number(iid))
        return {
          observed: {
            resource: project,
            sha: mr?.sha,
            source: mr?.source_branch,
            target: mr?.target_branch,
            title: mr?.title,
            state: mr?.state,
          },
        }
      }
      case 'gitlab.mr.merge': {
        const ref = parseRef(this.#expand(action.target))
        if (!ref || ref.kind !== 'change') return { observed: {}, unsupported: true }
        const mr = await this.#change(ref.project, ref.iid)
        return {
          observed: {
            resource: ref.project,
            state: mr?.state,
            sha: mr?.sha,
            merge_commit: mr?.merge_commit_sha ?? mr?.squash_commit_sha,
          },
        }
      }
      default:
        return { observed: {}, unsupported: true }
    }
  }

  /** 올릴 가지의 지금 상태 — 이름이 아니라 SHA 로 본다 (§L). */
  async #reviewPush(action: ExternalAction, capability: boolean): Promise<RemoteFacts> {
    if (!this.#repoRoot) {
      return { provider: this.id, capability: false, target: action.target, unknown: ['no repository root for git.push'] }
    }
    const [remote, branch] = this.#pushTarget(action.target)
    const unknown: string[] = []
    const url = await this.#git(['remote', 'get-url', remote], this.#repoRoot)
    if (!url.ok) unknown.push(`remote url for ${remote}`)
    const head = await this.#git(['rev-parse', 'HEAD'], this.#repoRoot)
    if (!head.ok) unknown.push('local HEAD')
    const listed = await this.#git(['ls-remote', remote, `refs/heads/${branch}`], this.#repoRoot)
    if (!listed.ok) unknown.push(`remote ref ${branch}`)
    const remoteSha = listed.ok ? (listed.detail.split(/\s+/)[0] ?? '') : ''

    // 되감기가 필요한 상태인가. 조상이 아니면 이 push 는 남의 것을 덮는 형태가 된다.
    let divergence: string | undefined
    if (head.ok && remoteSha) {
      const ancestor = await this.#git(['merge-base', '--is-ancestor', remoteSha, head.detail], this.#repoRoot)
      divergence = ancestor.ok ? 'fast-forward' : 'diverged'
    } else if (head.ok && listed.ok && !remoteSha) {
      divergence = 'new-branch'
    }

    return {
      provider: this.id,
      capability,
      target: `${remote}/${branch}`,
      ...(url.ok ? { resource: identityOf(url.detail) } : {}),
      observed: {
        'remote.name': remote,
        'remote.url': url.ok ? url.detail : undefined,
        'remote.sha': remoteSha || undefined,
        'local.head': head.ok ? head.detail : undefined,
        branch,
        ...(divergence ? { divergence } : {}),
      },
      ...(divergence === 'diverged'
        ? { ambiguity: [`${remote}/${branch} is not an ancestor of this HEAD — this push would not fast-forward`] }
        : {}),
      ...(unknown.length > 0 ? { unknown } : {}),
    }
  }

  /** 만들려는 변경요청의 자리 — 같은 것이 이미 있으면 그것이 모호함이다 (§M). */
  async #reviewCreateChange(action: ExternalAction, capability: boolean): Promise<RemoteFacts> {
    const project = this.#projectOf(action.target)
    if (!project) return { provider: this.id, capability: false, unknown: ['no project for gitlab.mr.create'] }
    let body: Record<string, unknown> = {}
    const unknown: string[] = []
    try {
      body = JSON.parse(action.payload) as Record<string, unknown>
    } catch {
      unknown.push('payload is not JSON')
    }
    const source = typeof body['source_branch'] === 'string' ? (body['source_branch'] as string) : undefined
    const target = typeof body['target_branch'] === 'string' ? (body['target_branch'] as string) : undefined

    const ambiguity: string[] = []
    if (source) {
      const open = await this.#reader.get<{ iid: number; target_branch?: string }[]>(
        `/projects/${encodeProject(project)}/merge_requests?state=opened&source_branch=${encodeURIComponent(source)}`,
      )
      if (!open.ok) unknown.push('open merge requests for this source branch')
      for (const existing of open.data ?? []) {
        ambiguity.push(`!${existing.iid} is already open from ${source} into ${existing.target_branch ?? '(unknown)'}`)
      }
    } else {
      unknown.push('source_branch')
    }
    if (!target) unknown.push('target_branch')

    const sha = source ? await this.#branchSha(project, source) : undefined
    const baseline = target ? await this.#branchSha(project, target) : undefined

    return {
      provider: this.id,
      capability,
      resource: project,
      target: action.target,
      observed: {
        source,
        target,
        'local.head': sha,
        'remote.sha': baseline,
        title: typeof body['title'] === 'string' ? (body['title'] as string) : undefined,
      },
      ...(ambiguity.length > 0 ? { ambiguity } : {}),
      ...(unknown.length > 0 ? { unknown } : {}),
    }
  }

  /** 합치려는 변경요청의 지금 — 무엇을 어디로, 어느 SHA 에서 (§N). */
  async #reviewMergeChange(action: ExternalAction, capability: boolean): Promise<RemoteFacts> {
    const ref = parseRef(this.#expand(action.target))
    if (!ref || ref.kind !== 'change') {
      return { provider: this.id, capability: false, target: action.target, unknown: ['unrecognized change reference'] }
    }
    const mr = await this.#change(ref.project, ref.iid)
    if (!mr) {
      return { provider: this.id, capability, resource: ref.project, target: action.target, unknown: ['the merge request'] }
    }
    const ambiguity: string[] = []
    if (mr.state !== 'opened') ambiguity.push(`!${ref.iid} is ${mr.state ?? '(unknown state)'}, not open`)
    if (mr.merge_status && mr.merge_status !== 'can_be_merged') ambiguity.push(`merge status is ${mr.merge_status}`)
    if (mr.has_conflicts) ambiguity.push('the merge request reports conflicts')
    if (mr.draft) ambiguity.push('the merge request is a draft')

    return {
      provider: this.id,
      capability,
      resource: ref.project,
      target: action.target,
      observed: {
        state: mr.state,
        source: mr.source_branch,
        target: mr.target_branch,
        'local.head': mr.sha,
        merge_status: mr.merge_status,
        pipeline: mr.pipeline?.status,
      },
      ...(ambiguity.length > 0 ? { ambiguity } : {}),
    }
  }

  async #change(project: string, iid: number): Promise<ChangeFacts | null> {
    const response = await this.#reader.get<ChangeFacts>(
      `/projects/${encodeProject(project)}/merge_requests/${iid}`,
    )
    return response.ok ? (response.data ?? null) : null
  }

  async #branchSha(project: string, branch: string): Promise<string | undefined> {
    const response = await this.#reader.get<{ commit?: { id?: string } }>(
      `/projects/${encodeProject(project)}/repository/branches/${encodeURIComponent(branch)}`,
    )
    return response.ok ? response.data?.commit?.id : undefined
  }

  #projectOf(target: string): string | undefined {
    if (!target.trim()) return this.#project
    const ref = parseRef(this.#expand(target))
    return ref?.project ?? (target.includes('/') ? target.trim() : this.#project)
  }

  #pushTarget(target: string): [string, string] {
    const parts = target.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) return [this.#remote, '']
    return parts.length === 1 ? [this.#remote, parts[0]!] : [parts[0]!, parts[1]!]
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
      case 'coordination.publish':
        // 이 행위는 CoordinationSurface 가 수행한다. 계약은 여기서 승인될 수 있지만
        // 실행은 그쪽 통로다 — 두 곳이 같은 글을 올리지 않게 여기서는 하지 않는다.
        return { ok: false, error: 'coordination.publish runs through the coordination surface' }
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
    // GitLab 의 merge 는 `PUT /merge_requests/:iid/merge` 다. 예전에 POST 로 보낸 것은
    // 계약 위반이었고, 그 실패는 승인이 끝난 **뒤에** 났다.
    if (!this.#writer.put) {
      return { ok: false, error: 'this write channel cannot send PUT — gitlab.mr.merge needs it' }
    }
    const response = await this.#writer.put<{ web_url?: string; state?: string }>(
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
    const [remote, branch] = parts.length === 1 ? [this.#remote, parts[0]!] : [parts[0]!, parts[1]!]
    // **가지 이름이 아니라 commit 을 올린다** (§L). 승인은 그 SHA 에 대한 것이었고, 그
    // 사이에 HEAD 가 움직였다면 같은 명령이 다른 내용을 내보낸다. HEAD 를 못 읽으면
    // 이름으로 밀지 않고 그 사실을 말한다.
    const head = await this.#git(['rev-parse', 'HEAD'], this.#repoRoot)
    if (!head.ok) return { ok: false, error: `could not read HEAD: ${head.detail}` }
    const result = await this.#git(['push', remote, `${head.detail}:refs/heads/${branch}`], this.#repoRoot)
    return result.ok
      ? { ok: true, resultRef: `${remote}/${branch}@${head.detail}` }
      : { ok: false, error: result.detail }
  }

  #expand(reference: string): string {
    if (!this.#project) return reference
    return /^[!#]\d+$/.test(reference.trim()) ? `${this.#project}${reference.trim()}` : reference
  }
}

/** 검수가 읽는 변경요청의 사실들. 이 adapter 밖으로 그대로 나가지 않는다. */
type ChangeFacts = {
  state?: string
  source_branch?: string
  target_branch?: string
  sha?: string
  title?: string
  merge_status?: string
  has_conflicts?: boolean
  draft?: boolean
  merge_commit_sha?: string
  squash_commit_sha?: string
  pipeline?: { status?: string }
}

/**
 * 원격 URL 에서 프로젝트 신원만 꺼낸다 — `git@host:group/p.git` 도 `https://host/group/p` 도
 * 같은 `group/p` 다. 결합과 견주는 값이므로 형태가 아니라 신원이어야 한다.
 */
export function identityOf(url: string): string {
  const trimmed = url.trim()
  const ssh = /^[^@\s]+@[^:]+:(.+)$/.exec(trimmed)
  const path = ssh ? ssh[1]! : trimmed.replace(/^[a-z+]+:\/\/[^/]+\//i, '')
  return normalize(path)
}
