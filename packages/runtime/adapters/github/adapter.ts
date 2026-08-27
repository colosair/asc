// GitHub Adapter 계약 구현 — describe / discover / probe (C-09 §5).
//
// 이 파일이 하는 일은 "내가 무엇을 할 수 있고, 이 프로젝트에서 무엇에 붙을 수 있고,
// 지금 실제로 되는가"를 말하는 것뿐이다. 실제 조회는 event-source·scm·context가 한다.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { AdapterDescriptor, BindingCandidate, Capability } from '../../core/binding/types.ts'
import type { Adapter, DiscoveryContext, ProbeResult } from '../../ports/adapter.ts'
import { discoverToken, GitHubClient } from './client.ts'

const run = promisify(execFile)

const PROVIDES: readonly Capability[] = [
  'observe.delta',
  'inventory.enumerate',
  'context.resource',
  'context.thread',
  'context.change',
  'canonical.read',
  'action.comment',
]

/** `git@host:owner/repo.git` · `https://host/owner/repo(.git)` 에서 `owner/repo`를 뽑는다. */
export function parseRemote(url: string): { host: string; repo: string } | null {
  const ssh = /^[^@]+@([^:]+):(.+?)(?:\.git)?$/.exec(url.trim())
  if (ssh) return { host: ssh[1]!, repo: ssh[2]! }
  const https = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(url.trim())
  if (https) return { host: https[1]!, repo: https[2]! }
  return null
}

export type GitHubAdapterDeps = {
  /** git 실행 통로. 테스트가 격리하기 위한 주입점이며, 없으면 실제 git을 부른다. */
  listRemotes?: (projectRoot: string) => Promise<string[]>
  /** 자격 조회 통로. 값은 probe 안에서만 쓰이고 밖으로 나가지 않는다. */
  findToken?: (env?: NodeJS.ProcessEnv) => Promise<string | null>
  /** 실 접속 확인 통로. 없으면 실제 API를 부른다. */
  reach?: (repo: string, token: string) => Promise<{ ok: boolean; detail?: string }>
  /** 이 host의 remote만 자기 것으로 본다. */
  host?: string
}

export class GitHubAdapter implements Adapter {
  #listRemotes: (projectRoot: string) => Promise<string[]>
  #findToken: (env?: NodeJS.ProcessEnv) => Promise<string | null>
  #reach: ((repo: string, token: string) => Promise<{ ok: boolean; detail?: string }>) | undefined
  #host: string

  constructor(deps: GitHubAdapterDeps = {}) {
    this.#listRemotes = deps.listRemotes ?? defaultListRemotes
    this.#findToken = deps.findToken ?? discoverToken
    this.#reach = deps.reach
    this.#host = deps.host ?? 'github.com'
  }

  describe(): AdapterDescriptor {
    return {
      id: 'github',
      version: '1',
      provides: PROVIDES,
      // 자격이 필요하다는 사실과 이름까지만. 값은 여기에 오지 않는다 (C-09 §5.2).
      requiresCredential: ['ASC_GITHUB_TOKEN | GITHUB_TOKEN | GH_TOKEN | gh auth'],
      prerequisites: ['git remote 가 이 host를 가리켜야 한다'],
    }
  }

  /** 로컬 관찰만 한다 — 네트워크를 치지 않는다. 계획을 세우려고 부르는 함수다. */
  async discover(context: DiscoveryContext): Promise<BindingCandidate[]> {
    const remotes = await this.#listRemotes(context.projectRoot).catch(() => [])
    const found = new Map<string, BindingCandidate>()
    for (const url of remotes) {
      const parsed = parseRemote(url)
      if (!parsed || parsed.host !== this.#host) continue
      found.set(parsed.repo, {
        adapterId: 'github',
        resource: parsed.repo,
        provides: PROVIDES,
        discoveredBy: 'git remote',
      })
    }
    return [...found.values()]
  }

  /**
   * 자격이 없는 것과 닿지 않는 것을 나눠서 돌려준다. 합치면 사람이 무엇을 해야 하는지
   * 알 수 없다 (C-09 §5.1).
   */
  async probe(candidate: BindingCandidate, context: DiscoveryContext): Promise<ProbeResult> {
    const token = await this.#findToken(context.env)
    if (!token) {
      return {
        state: 'UNCONFIGURED',
        detail: '토큰이 없다 — ASC_GITHUB_TOKEN·GITHUB_TOKEN·GH_TOKEN 중 하나를 두거나 `gh auth login` 하라',
      }
    }

    const reach = this.#reach ?? defaultReach
    const result = await reach(candidate.resource, token)
    return result.ok
      ? { state: 'AVAILABLE', provides: candidate.provides }
      : { state: 'UNAVAILABLE', detail: result.detail ?? '저장소에 닿지 못했다' }
  }
}

async function defaultListRemotes(projectRoot: string): Promise<string[]> {
  const { stdout } = await run('git', ['-C', projectRoot, 'remote', '-v'])
  return stdout
    .split('\n')
    .map((line) => line.split(/\s+/)[1])
    .filter((url): url is string => Boolean(url))
}

async function defaultReach(repo: string, token: string): Promise<{ ok: boolean; detail?: string }> {
  const response = await new GitHubClient({ token }).get(`/repos/${repo}`)
  return response.ok ? { ok: true } : { ok: false, detail: `HTTP ${response.status}` }
}
