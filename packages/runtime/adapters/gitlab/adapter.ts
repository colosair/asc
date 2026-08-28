// GitLab Adapter 계약 — describe / discover / probe (C-09 §5).
//
// GitHub adapter와 같은 세 함수를 갖되 내용은 다르다. 그 "같은 모양 다른 내용"이
// Adapter 계약이 실제로 계약이라는 증거다.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { AdapterDescriptor, BindingCandidate, Capability } from '../../core/binding/types.ts'
import type { Adapter, DiscoveryContext, ProbeResult } from '../../ports/adapter.ts'
import { GitLabClient, discoverToken, encodeProject, glabAvailable, type ProcessRunner } from './client.ts'

const run = promisify(execFile)

const PROVIDES: readonly Capability[] = [
  'observe.delta',
  'inventory.enumerate',
  'context.resource',
  'context.thread',
  'context.change',
]

/**
 * 이 host는 다른 adapter가 맡는다. 여기서 후보로 잡으면 같은 remote를 둘이 주장한다.
 *
 * 목록이 아니라 **판정**이므로 짧게 유지한다 — 여기가 길어지기 시작하면 그건 adapter가
 * provider 목록을 아는 물건이 됐다는 뜻이다.
 */
const CLAIMED_ELSEWHERE = new Set(['github.com'])

export type GitLabAdapterDeps = {
  listRemotes?: (projectRoot: string) => Promise<string[]>
  findToken?: (env?: NodeJS.ProcessEnv) => string | null
  reach?: (project: string, token: string) => Promise<{ ok: boolean; detail?: string }>
  /**
   * 명시 override. **필수가 아니다** — 기본은 remote에서 host를 읽는다.
   * 자체 호스팅 주소를 코드나 문서에 박지 않기 위해서다 (지시 §12).
   */
  host?: string
  /** 프로세스 실행 통로. 테스트가 실제 `glab` 을 부르지 않기 위한 주입점. */
  run?: ProcessRunner
}

/** 기본 실행 통로. 실패는 예외로 올린다 — 호출측이 "없다"와 "터졌다"를 구분한다. */
const defaultRun: ProcessRunner = async (command, args) => {
  const { stdout } = await run(command, [...args])
  return stdout
}

export class GitLabAdapter implements Adapter {
  #listRemotes: (projectRoot: string) => Promise<string[]>
  #findToken: (env?: NodeJS.ProcessEnv) => string | null
  #reach: ((project: string, token: string) => Promise<{ ok: boolean; detail?: string }>) | undefined
  #host: string | undefined
  /**
   * 후보를 찾을 때 본 host. probe가 어디로 물어봐야 하는지 알아야 하는데 후보 자체는
   * 경로만 들고 있다 — Core 타입에 자리를 만드는 대신 여기 둔다.
   *
   * discover와 probe를 같은 인스턴스가 이어서 부르는 것이 조립 순서다(composition).
   * 그렇지 않은 호출자는 `ASC_GITLAB_URL` 로 명시하면 된다.
   */
  #endpoints = new Map<string, string>()
  #run: ProcessRunner

  constructor(deps: GitLabAdapterDeps = {}) {
    this.#run = deps.run ?? defaultRun
    this.#listRemotes = deps.listRemotes ?? defaultListRemotes
    this.#findToken = deps.findToken ?? discoverToken
    this.#reach = deps.reach
    this.#host = deps.host
  }

  describe(): AdapterDescriptor {
    return {
      id: 'gitlab',
      version: '1',
      provides: PROVIDES,
      requiresCredential: ['ASC_GITLAB_TOKEN | GITLAB_TOKEN, 또는 로그인된 glab (읽기 전용)'],
      prerequisites: ['git remote 가 이 host를 가리켜야 한다'],
    }
  }

  /**
   * remote **전부**를 본다. `origin` 하나만 보면 origin이 코드 정본이 아닌 프로젝트에서
   * 아무것도 못 찾는다 (지시 §13).
   *
   * host를 미리 알고 있지 않다 — 자체 호스팅이 흔하고, 주소를 코드에 박으면 그 프로젝트
   * 하나를 위한 adapter가 된다. 대신 **다른 adapter가 맡는 host만 비켜** 나머지를 후보로
   * 올린다. 후보는 추측이 아니라 후보이며, 실제로 되는지는 probe가 정한다.
   */
  async discover(context: DiscoveryContext): Promise<BindingCandidate[]> {
    const remotes = await this.#listRemotes(context.projectRoot).catch(() => [])
    const override = this.#host ?? context.env?.ASC_GITLAB_HOST
    const found = new Map<string, BindingCandidate>()

    for (const url of remotes) {
      const parsed = parseRemote(url)
      if (!parsed) continue
      if (override ? parsed.host !== override : CLAIMED_ELSEWHERE.has(parsed.host)) continue
      // 하위 그룹이 흔하다 — `group/sub/project` 를 통째로 자원 이름으로 쓴다.
      this.#endpoints.set(parsed.project, `https://${parsed.host}/api/v4`)
      found.set(parsed.project, {
        adapterId: 'gitlab',
        resource: parsed.project,
        provides: PROVIDES,
        discoveredBy: `git remote (${parsed.host})`,
      })
    }
    return [...found.values()]
  }

  async probe(candidate: BindingCandidate, context: DiscoveryContext): Promise<ProbeResult> {
    const token = this.#findToken(context.env)
    if (!token) {
      // 토큰이 없다고 통로가 없는 것은 아니다 — 사람이 이미 `glab` 에 로그인해 뒀다면
      // 그 도구에게 요청을 대신 보내 달라고 할 수 있다. 토큰을 꺼내 오지는 않는다.
      if (await glabAvailable(this.#run)) {
        return {
          state: 'DEGRADED',
          provides: candidate.provides,
          detail: '토큰은 없지만 로그인된 glab 를 통로로 쓴다 (읽기 전용)',
        }
      }
      return {
        state: 'UNCONFIGURED',
        detail: '토큰이 없다 — ASC_GITLAB_TOKEN 또는 GITLAB_TOKEN 을 두거나, `glab auth login` 을 해 두어라',
      }
    }
    const baseUrl = context.env?.ASC_GITLAB_URL ?? this.#endpoints.get(candidate.resource)
    const reach = this.#reach ?? ((project: string, secret: string) => defaultReach(project, secret, baseUrl))
    const result = await reach(candidate.resource, token)
    return result.ok
      ? { state: 'AVAILABLE', provides: candidate.provides }
      : { state: 'UNAVAILABLE', detail: result.detail ?? '프로젝트에 닿지 못했다' }
  }

  /** 이 후보가 어느 주소를 가리키는지. composition이 Port를 만들 때 같은 값을 써야 한다. */
  endpointFor(resource: string): string | undefined {
    return this.#endpoints.get(resource)
  }
}

export function parseRemote(url: string): { host: string; project: string } | null {
  const ssh = /^[^@]+@([^:]+):(.+?)(?:\.git)?$/.exec(url.trim())
  if (ssh) return { host: ssh[1]!, project: ssh[2]! }
  const https = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(url.trim())
  if (https) return { host: https[1]!, project: https[2]! }
  return null
}

async function defaultListRemotes(projectRoot: string): Promise<string[]> {
  const { stdout } = await run('git', ['-C', projectRoot, 'remote', '-v'])
  return stdout
    .split('\n')
    .map((line) => line.split(/\s+/)[1])
    .filter((url): url is string => Boolean(url))
}

async function defaultReach(
  project: string,
  token: string,
  baseUrl?: string,
): Promise<{ ok: boolean; detail?: string }> {
  const client = new GitLabClient({ token, ...(baseUrl ? { baseUrl } : {}) })
  const response = await client.get(`/projects/${encodeProject(project)}`)
  return response.ok ? { ok: true } : { ok: false, detail: `HTTP ${response.status}` }
}
