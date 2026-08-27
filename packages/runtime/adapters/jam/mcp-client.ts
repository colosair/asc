// stdio MCP 최소 클라이언트.
//
// SDK를 들이지 않는다 (C-09 §8). 필요한 것은 줄 단위 JSON-RPC 왕복 하나뿐이고, 그것 때문에
// 의존성을 늘리면 "외부 의존이 Core로 전파되지 않는다"는 목표가 adapter 층에서부터 흔들린다.
//
// 프로토콜은 실측으로 확인했다 — Content-Length 프레이밍이 아니라 **개행 구분 JSON**이고,
// 서버는 stderr에 자기 로그를 쓴다.
//
// 지켜야 할 것 둘:
//   stderr를 프로토콜로 읽지 않는다 — 진단용으로만 쓰고, 그것도 길이를 제한한다
//   자격 값을 절대 기록하지 않는다 — 이 파일은 토큰을 받지도, 보지도, 남기지도 않는다

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export type McpRequest = { method: string; params?: unknown }

export type McpFailure = {
  kind: 'SPAWN_FAILED' | 'TIMEOUT' | 'PROCESS_EXITED' | 'PROTOCOL_ERROR' | 'TOOL_ERROR'
  detail: string
}

export type McpResult<T> = { ok: true; value: T } | { ok: false } & McpFailure

/** MCP tool 하나의 응답. JAM은 결과를 text content 한 덩어리에 담아 준다. */
export type ToolResponse = { content?: { type: string; text?: string }[]; isError?: boolean }

export type JamMcpClientDeps = {
  /** JAM 실행 경로. 값을 문서·Profile·repo에 남기지 않는다 — 환경에서만 온다. */
  command: string
  args?: readonly string[]
  /** JAM은 프로젝트 선언(.jira-agent/project.yaml)이 있는 디렉터리에서 떠야 한다. */
  cwd?: string
  /** 한 요청이 이보다 오래 걸리면 끊는다. 매달린 자식이 회차를 통째로 잡아먹지 않게. */
  timeoutMs?: number
  /**
   * 프로세스를 띄우는 통로. 테스트가 실제 자식을 띄우지 않기 위한 주입점이다 —
   * 실 프로세스에 기대는 테스트는 남의 사정으로 깨진다.
   */
  spawnProcess?: () => ChildProcessWithoutNullStreams
}

const PROTOCOL_VERSION = '2024-11-05'
/** 진단으로 남길 stderr 최대 길이. 무한히 모으면 그 자체가 새는 곳이 된다. */
const STDERR_KEEP = 2000

export class JamMcpClient {
  #deps: JamMcpClientDeps
  #child: ChildProcessWithoutNullStreams | null = null
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: McpFailure) => void }>()
  #buffer = ''
  #stderr = ''
  #nextId = 1
  #exited: McpFailure | null = null
  #ready = false

  constructor(deps: JamMcpClientDeps) {
    this.#deps = deps
  }

  /** 띄우고 악수까지. 여기서 실패하면 tool 호출을 시도조차 하지 않는다. */
  async start(): Promise<McpResult<{ name: string; version: string }>> {
    if (this.#ready && this.#child) return { ok: true, value: { name: '', version: '' } }

    try {
      this.#child = this.#deps.spawnProcess
        ? this.#deps.spawnProcess()
        : spawn(this.#deps.command, [...(this.#deps.args ?? [])], {
            stdio: ['pipe', 'pipe', 'pipe'],
            ...(this.#deps.cwd ? { cwd: this.#deps.cwd } : {}),
          })
    } catch (error) {
      return { ok: false, kind: 'SPAWN_FAILED', detail: String(error) }
    }

    const child = this.#child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.#onStdout(chunk))
    // 서버의 자기 로그다. 프로토콜로 읽지 않고, 실패했을 때 사람에게 보여줄 만큼만 남긴다.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_KEEP)
    })
    child.on('error', (error) => this.#fail({ kind: 'SPAWN_FAILED', detail: String(error) }))
    // 자식이 먼저 죽으면 기다리던 요청이 영원히 매달린다. 전부 깨워서 이유를 준다.
    child.on('exit', (code, signal) =>
      this.#fail({
        kind: 'PROCESS_EXITED',
        detail: `JAM이 먼저 종료했다 (code=${code ?? 'null'}, signal=${signal ?? 'null'})${this.#tail()}`,
      }),
    )

    const handshake = await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'asc', version: '0.1.0' },
    })
    if (!handshake.ok) return handshake

    const info = handshake.value as {
      protocolVersion?: string
      serverInfo?: { name?: string; version?: string }
    }
    // 버전이 다르면 조용히 계속하지 않는다 — 뒤에서 모양이 어긋나면 원인을 못 찾는다.
    if (info?.protocolVersion !== PROTOCOL_VERSION) {
      return {
        ok: false,
        kind: 'PROTOCOL_ERROR',
        detail: `protocol 버전이 다르다 — 기대 ${PROTOCOL_VERSION}, 받음 ${String(info?.protocolVersion)}`,
      }
    }

    this.#notify('notifications/initialized')
    this.#ready = true
    return {
      ok: true,
      value: { name: info.serverInfo?.name ?? '', version: info.serverInfo?.version ?? '' },
    }
  }

  /** tool 하나를 부르고 text content를 JSON으로 푼다. */
  async callTool<T>(name: string, args: Record<string, unknown>): Promise<McpResult<T>> {
    if (!this.#ready) {
      const started = await this.start()
      if (!started.ok) return started
    }

    const response = await this.#request('tools/call', { name, arguments: args })
    if (!response.ok) return response

    const payload = response.value as ToolResponse
    const text = payload?.content?.find((part) => part.type === 'text')?.text
    if (typeof text !== 'string') {
      return { ok: false, kind: 'PROTOCOL_ERROR', detail: `${name}: text content가 없다` }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, kind: 'PROTOCOL_ERROR', detail: `${name}: 응답이 JSON이 아니다` }
    }

    // 서버가 실패를 알린 것과 우리가 못 읽은 것은 다르다. 앞의 것은 서버 말을 그대로 옮긴다.
    if (payload.isError) {
      const error = (parsed as { error?: { code?: string; message?: string } })?.error
      return {
        ok: false,
        kind: 'TOOL_ERROR',
        detail: error?.code ? `${error.code}: ${error.message ?? ''}` : `${name} 실패`,
      }
    }
    return { ok: true, value: parsed as T }
  }

  /** 자식을 정리한다. 여러 번 불러도 안전하다. */
  async stop(): Promise<void> {
    const child = this.#child
    this.#child = null
    this.#ready = false
    if (!child || child.exitCode !== null) return
    child.stdin.end()
    child.kill()
  }

  // ── 내부 ──────────────────────────────────────────────────────────────────

  #request(method: string, params: unknown): Promise<McpResult<unknown>> {
    const child = this.#child
    if (!child) return Promise.resolve({ ok: false, kind: 'SPAWN_FAILED', detail: '프로세스가 없다' })
    if (this.#exited) return Promise.resolve({ ok: false, ...this.#exited })

    const id = this.#nextId++
    return new Promise<McpResult<unknown>>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        resolve({
          ok: false,
          kind: 'TIMEOUT',
          detail: `${method}: ${this.#deps.timeoutMs ?? 30_000}ms 안에 답하지 않았다${this.#tail()}`,
        })
      }, this.#deps.timeoutMs ?? 30_000)

      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve({ ok: true, value })
        },
        reject: (failure) => {
          clearTimeout(timer)
          resolve({ ok: false, ...failure })
        },
      })

      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (error) {
        this.#pending.delete(id)
        clearTimeout(timer)
        resolve({ ok: false, kind: 'PROCESS_EXITED', detail: String(error) })
      }
    })
  }

  #notify(method: string): void {
    try {
      this.#child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
    } catch {
      // 알림은 답을 기다리지 않는다. 못 보냈으면 다음 요청이 어차피 실패로 말해 준다.
    }
  }

  /** 개행 구분 JSON. 한 줄이 깨져도 그 줄만 버리고 스트림을 통째로 포기하지 않는다. */
  #onStdout(chunk: string): void {
    this.#buffer += chunk
    for (;;) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line.length === 0) continue

      let message: { id?: number; result?: unknown; error?: { code?: number; message?: string } }
      try {
        message = JSON.parse(line)
      } catch {
        // 서버가 stdout에 프로토콜이 아닌 것을 흘렸다. 기다리는 요청을 매달아 두는 것보다
        // 이유를 주고 끊는 편이 낫다.
        this.#fail({ kind: 'PROTOCOL_ERROR', detail: '응답 한 줄이 JSON이 아니다' })
        continue
      }

      if (typeof message.id !== 'number') continue // 알림이다 — 기다리는 쪽이 없다
      const waiting = this.#pending.get(message.id)
      if (!waiting) continue // 이미 시간이 지나 포기한 요청
      this.#pending.delete(message.id)

      if (message.error) {
        waiting.reject({
          kind: 'PROTOCOL_ERROR',
          detail: `JSON-RPC 오류 ${message.error.code ?? ''}: ${message.error.message ?? ''}`,
        })
      } else {
        waiting.resolve(message.result)
      }
    }
  }

  /** 기다리는 요청 전부를 같은 이유로 깨운다. */
  #fail(failure: McpFailure): void {
    this.#exited = failure
    for (const waiting of this.#pending.values()) waiting.reject(failure)
    this.#pending.clear()
  }

  /** 진단 꼬리표. 서버 로그의 마지막 조각만 붙인다 — 자격 값은 애초에 여기 오지 않는다. */
  #tail(): string {
    const tail = this.#stderr.trim().split('\n').at(-1)
    return tail ? ` — 서버 마지막 출력: ${tail.slice(0, 200)}` : ''
  }
}
