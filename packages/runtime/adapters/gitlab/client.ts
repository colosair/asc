// GitLab REST 최소 클라이언트.
//
// GitHub 쪽과 같은 모양을 일부러 유지한다 — 두 adapter가 비슷하게 생겼다는 사실이
// "Core가 바뀌지 않는다"를 보여주는 근거의 일부다. 토큰은 여기서 만들지도 저장하지도
// 않는다 (OM §4.5).
//
// fetch를 주입받는 이유는 테스트 때문이다. 실 네트워크에 기대는 테스트는 남의 사정으로
// 깨지고, 그러면 아무도 안 보게 된다.

export type Fetch = typeof globalThis.fetch

export type GitLabClientDeps = {
  token: string
  fetch?: Fetch
  /** self-hosted가 흔하다. 기본값은 공개 인스턴스. */
  baseUrl?: string
}

export type GitLabResponse<T> = {
  ok: boolean
  status: number
  data: T | null
  /** 다음 페이지 번호. 없으면 끝이다. */
  nextPage?: string
  error?: string
}

/** 환경변수에서만 찾는다. 값을 파일이나 Profile에 남기지 않는다. */
export function discoverToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.ASC_GITLAB_TOKEN ?? env.GITLAB_TOKEN ?? null
}

/**
 * 이미 로그인된 `glab` 을 통로로 쓸 수 있는가 (P1-H).
 *
 * 토큰을 꺼내 오지 않는다 — 꺼낼 수 있어도 하지 않는다. 자격은 그 도구 안에 있고, ASC 는
 * 그 도구에게 **요청을 대신 보내 달라고** 부탁할 뿐이다. env 토큰이 있으면 그쪽이 먼저다:
 * 명시적으로 준 것이 추론보다 앞선다.
 */
export type ProcessRunner = (command: string, args: readonly string[]) => Promise<string>

export async function glabAvailable(run: ProcessRunner): Promise<boolean> {
  try {
    await run('glab', ['auth', 'status'])
    return true
  } catch {
    return false
  }
}

/**
 * `glab api` 를 읽기 통로로 감싼 클라이언트. GET 만 다룬다 — 쓰기는 Grant 를 지나야 하고,
 * 그 경로를 우회하는 통로를 여기에 만들지 않는다.
 */
export class GlabApiClient implements GitLabReader {
  #run: ProcessRunner

  constructor(run: ProcessRunner) {
    this.#run = run
  }

  async get<T>(path: string): Promise<GitLabResponse<T>> {
    try {
      // 페이지 헤더는 `glab api` 가 돌려주지 않는다. 다음 페이지를 모르는 채로
      // 있다고 말하지 않는다 — nextPage 를 비워 두면 호출측이 한 페이지로 끝낸다.
      const stdout = await this.#run('glab', ['api', path.replace(/^\//, '')])
      return { ok: true, status: 200, data: JSON.parse(stdout) as T }
    } catch (error) {
      return { ok: false, status: 0, data: null, error: String((error as Error).message ?? error).slice(0, 200) }
    }
  }
}

/**
 * 읽기 통로. GitLabClient(토큰)와 GlabApiClient(로그인된 도구) 둘 다 이것이다 —
 * Port 들은 어느 쪽인지 몰라야 한다. 통로가 바뀌었다고 조회 코드가 바뀌면, 통로를 늘릴
 * 때마다 같은 코드가 갈라진다.
 */
export interface GitLabReader {
  get<T>(path: string): Promise<GitLabResponse<T>>
}

export class GitLabClient implements GitLabReader {
  #token: string
  #fetch: Fetch
  #baseUrl: string

  constructor(deps: GitLabClientDeps) {
    this.#token = deps.token
    this.#fetch = deps.fetch ?? globalThis.fetch
    this.#baseUrl = deps.baseUrl ?? 'https://gitlab.com/api/v4'
  }

  async get<T>(path: string): Promise<GitLabResponse<T>> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      headers: { accept: 'application/json', 'private-token': this.#token },
    })
    const nextPage = response.headers.get('x-next-page') ?? undefined
    if (!response.ok) {
      return { ok: false, status: response.status, data: null, error: `HTTP ${response.status}` }
    }
    return {
      ok: true,
      status: response.status,
      data: (await response.json()) as T,
      // 빈 문자열은 "다음 없음"이다 — 그대로 실어 보내면 0페이지를 영원히 돈다.
      ...(nextPage ? { nextPage } : {}),
    }
  }
}

/** `group/sub/project!19` 또는 `group/project#7` 을 쪼갠다. */
export function parseRef(reference: string): { project: string; kind: 'change' | 'issue'; iid: number } | null {
  const match = /^(.+?)([!#])(\d+)$/.exec(reference.trim())
  if (!match) return null
  return { project: match[1]!, kind: match[2] === '!' ? 'change' : 'issue', iid: Number(match[3]) }
}

/** 경로를 URL 조각으로. GitLab은 프로젝트 경로를 통째로 인코딩해 받는다. */
export const encodeProject = (project: string): string => encodeURIComponent(project)
