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

export class GitLabClient {
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
