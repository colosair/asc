// Mattermost transport — HTTP 한 겹 (B-13).
//
// 자격은 **환경에서만** 온다. Profile·lock·docs·log 어디에도 남기지 않는다 (C-11 §8).
// 이 파일이 토큰을 아는 것은 요청 헤더를 만드는 순간뿐이며, 실패 메시지에도 싣지 않는다 —
// 오류 로그가 자격 유출 경로가 되는 것은 흔한 사고다.

import type { MattermostPost, MattermostTransport } from './presentation.ts'

export type MattermostClientDeps = {
  /** `https://mm.example.com` — 팀마다 자체 호스팅이 흔하다. */
  baseUrl: string
  token: string
  /** 요청 통로 주입점. 테스트가 실제 네트워크를 치지 않기 위한 자리다. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** 환경에서만 읽는다. 값의 존재 여부만 밖에 알린다. */
export function discoverToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.ASC_MATTERMOST_TOKEN ?? env.MATTERMOST_TOKEN ?? null
}

export function discoverBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.ASC_MATTERMOST_URL ?? env.MATTERMOST_URL ?? null
}

export class MattermostClient implements MattermostTransport {
  #baseUrl: string
  #token: string
  #fetch: typeof fetch
  #timeoutMs: number

  constructor(deps: MattermostClientDeps) {
    this.#baseUrl = deps.baseUrl.replace(/\/+$/, '')
    this.#token = deps.token
    this.#fetch = deps.fetchImpl ?? fetch
    this.#timeoutMs = deps.timeoutMs ?? 10_000
  }

  async post(payload: MattermostPost): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const controller = new AbortController()
    // 매달린 요청이 회차를 통째로 잡아먹지 않게 한다
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const response = await this.#fetch(`${this.#baseUrl}/api/v4/posts`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      if (!response.ok) {
        // 본문에 토큰이 되비쳐 오는 provider도 있다. 상태 코드까지만 옮긴다.
        return { ok: false, error: `HTTP ${response.status}` }
      }
      const body = (await response.json()) as { id?: string }
      return body.id ? { ok: true, id: body.id } : { ok: false, error: '응답에 post id가 없다' }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // 자격이 메시지에 섞여 나가지 않게 한 번 더 거른다
      return { ok: false, error: detail.replace(this.#token, '<redacted>') }
    } finally {
      clearTimeout(timer)
    }
  }
}
