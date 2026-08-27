// GitHub REST 최소 클라이언트.
//
// 토큰은 여기서 만들지도 저장하지도 않는다. 환경변수나 `gh` 자격 저장소에서 받아오기만
// 하며, 파일이나 Profile에 남기지 않는다 (OM §4.5).
//
// fetch를 주입받는 이유는 테스트 때문이다. 실 네트워크에 기대는 테스트는 남의 사정으로
// 깨지고, 그러면 아무도 안 보게 된다.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type Fetch = typeof globalThis.fetch

export type GitHubClientDeps = {
  token: string
  fetch?: Fetch
  baseUrl?: string
  userAgent?: string
}

export type GitHubResponse<T> = {
  ok: boolean
  status: number
  data: T | null
  /** 304 응답용. 다음 요청에 그대로 실어 보내면 서버가 안 바뀐 것을 싸게 알려준다. */
  lastModified?: string
  etag?: string
  error?: string
}

/**
 * 토큰을 찾는다: 환경변수 우선, 없으면 `gh` 자격 저장소.
 * 둘 다 없으면 null — 호출자는 읽기조차 시도하지 않고 그 사실을 사람에게 말해야 한다.
 */
export async function discoverToken(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const fromEnv = env.ASC_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_TOKEN
  if (fromEnv) return fromEnv
  try {
    const { stdout } = await run('gh', ['auth', 'token'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

export class GitHubClient {
  #token: string
  #fetch: Fetch
  #baseUrl: string
  #userAgent: string

  constructor(deps: GitHubClientDeps) {
    this.#token = deps.token
    this.#fetch = deps.fetch ?? globalThis.fetch
    this.#baseUrl = deps.baseUrl ?? 'https://api.github.com'
    this.#userAgent = deps.userAgent ?? 'asc'
  }

  async get<T>(path: string, options: { ifModifiedSince?: string; etag?: string } = {}): Promise<GitHubResponse<T>> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.#token}`,
      'user-agent': this.#userAgent,
      'x-github-api-version': '2022-11-28',
    }
    if (options.ifModifiedSince) headers['if-modified-since'] = options.ifModifiedSince
    if (options.etag) headers['if-none-match'] = options.etag

    const response = await this.#fetch(`${this.#baseUrl}${path}`, { headers })
    const lastModified = response.headers.get('last-modified') ?? undefined
    const etag = response.headers.get('etag') ?? undefined

    // 304는 실패가 아니다 — "그대로다"라는 값싼 대답이다
    if (response.status === 304) return { ok: true, status: 304, data: null, ...(lastModified ? { lastModified } : {}), ...(etag ? { etag } : {}) }
    if (!response.ok) {
      return { ok: false, status: response.status, data: null, error: await safeText(response) }
    }
    return {
      ok: true,
      status: response.status,
      data: (await response.json()) as T,
      ...(lastModified ? { lastModified } : {}),
      ...(etag ? { etag } : {}),
    }
  }

  async post<T>(path: string, body: unknown): Promise<GitHubResponse<T>> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.#token}`,
        'user-agent': this.#userAgent,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) return { ok: false, status: response.status, data: null, error: await safeText(response) }
    return { ok: true, status: response.status, data: (await response.json()) as T }
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500)
  } catch {
    return `HTTP ${response.status}`
  }
}
