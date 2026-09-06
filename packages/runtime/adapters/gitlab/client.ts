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
export class GlabApiClient implements GitLabReader, GitLabWriter {
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

  async post<T>(path: string, body: Record<string, unknown>): Promise<GitLabResponse<T>> {
    // 값 하나가 한 필드다. 문자열을 만들어 붙이지 않는다 — 그렇게 하면 본문에 개행이나
    // 따옴표가 있을 때 조용히 다른 것이 나간다.
    const fields = Object.entries(body).flatMap(([key, value]) =>
      value === undefined ? [] : ['-f', `${key}=${String(value)}`],
    )
    try {
      const stdout = await this.#run('glab', ['api', '--method', 'POST', path.replace(/^\//, ''), ...fields])
      return { ok: true, status: 201, data: JSON.parse(stdout) as T }
    } catch (error) {
      return { ok: false, status: 0, data: null, error: String((error as Error).message ?? error).slice(0, 200) }
    }
  }

  async put<T>(path: string, body: Record<string, unknown>): Promise<GitLabResponse<T>> {
    const fields = Object.entries(body).flatMap(([key, value]) =>
      value === undefined ? [] : ['-f', `${key}=${String(value)}`],
    )
    try {
      const stdout = await this.#run('glab', ['api', '--method', 'PUT', path.replace(/^\//, ''), ...fields])
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
/**
 * 쓰기 통로. **읽기와 일부러 갈라 둔다** — 조회 코드가 쓰기를 할 수 있으면 어디서 무엇이
 * 나가는지 아무도 세지 못한다. 이것을 쥔 곳은 조율 표면 하나뿐이고, 거기서 나가는 것은
 * 공개 payload 로 제한돼 있다.
 *
 * 승인(Grant)을 지나는 외부 Action 과는 다른 경로다. 그쪽은 사람이 승인한 단일 행동을
 * 그대로 내보내는 통로이고, 이쪽은 물어본 것이 밖에 실제로 있게 하는 조율 행위다.
 * 둘을 한 통로로 합치면 승인의 의미가 흐려진다.
 */
export interface GitLabWriter {
  post<T>(path: string, body: Record<string, unknown>): Promise<GitLabResponse<T>>
  /**
   * GitLab 의 merge 는 `PUT /merge_requests/:iid/merge` 다 (공식 계약).
   *
   * 예전에는 POST 로 보냈다. 그 경로는 승인이 끝난 뒤에 실패하고, 실패한 것이 정말 나가지
   * 않았는지는 그 자리에서 알 수 없다 — 통로가 없는 것과 잘못된 통로로 부르는 것은 다르고,
   * 후자가 더 나쁘다. 통로가 없으면 없다고 말할 수 있게 optional 로 둔다.
   */
  put?<T>(path: string, body: Record<string, unknown>): Promise<GitLabResponse<T>>
}

export interface GitLabReader {
  get<T>(path: string): Promise<GitLabResponse<T>>
}

export class GitLabClient implements GitLabReader, GitLabWriter {
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

  async post<T>(path: string, body: Record<string, unknown>): Promise<GitLabResponse<T>> {
    return this.#write('POST', path, body)
  }

  async put<T>(path: string, body: Record<string, unknown>): Promise<GitLabResponse<T>> {
    return this.#write('PUT', path, body)
  }

  async #write<T>(
    method: 'POST' | 'PUT',
    path: string,
    body: Record<string, unknown>,
  ): Promise<GitLabResponse<T>> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'private-token': this.#token,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      return { ok: false, status: response.status, data: null, error: `HTTP ${response.status}` }
    }
    return { ok: true, status: response.status, data: (await response.json()) as T }
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
