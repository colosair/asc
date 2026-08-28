// JAM Adapter 계약 — describe / discover / probe / runtime.
//
// 이 adapter가 지키는 선 하나: **자격을 대신 다루지 않는다.** JAM은 사람이 직접 로그인하게
// 설계돼 있고, 에이전트에게는 "됐는지 아닌지"만 알려 준다. ASC가 토큰을 받아 넘기거나
// 로그인을 대신 실행하면 그 설계를 우회하는 것이다 — 하지 않는다.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { AdapterDescriptor, BindingCandidate, Capability } from '../../core/binding/types.ts'
import type { Adapter, DiscoveryContext, ProbeResult, RuntimeStatus } from '../../ports/adapter.ts'

const run = promisify(execFile)

/**
 * 실제로 되는 것만 적는다 (C-09 §1.1).
 *
 * 빠진 둘에 이유가 있다:
 *   context.history  provider가 변경 이력을 주지 않는다 — 요청 경로 자체가 없다
 *
 * `observe.delta` 는 연다. **푸시가 있다는 뜻이 아니다** — C-07 §1.1이 Delta를
 * "webhook / incremental polling / provider notification / updated-since" 로 정의하고
 * 그 안에 시각 기준 증분 조회를 명시적으로 포함한다. JAM에는 webhook이 없고, 여기서
 * 여는 것은 `updated >= watermark` 조회다 (adapters/jam/event-source.ts).
 * push와 같은 말로 쓰면 "실시간이다"라는 잘못된 기대가 생기므로 그 구분을 여기 남긴다.
 */
const PROVIDES: readonly Capability[] = [
  'observe.delta',
  'inventory.enumerate',
  'context.resource',
  'context.thread',
]

/** 프로젝트가 어느 작업 항목 묶음에 붙어 있는지 선언하는 파일. 팀이 채택했을 때 저장소에 생긴다. */
const DECLARATION = join('.jira-agent', 'project.yaml')

/**
 * 같은 선언의 **개인 자리**. 저장소를 건드리지 않고 붙여 쓰는 것이 provider 의 기본값이라,
 * 저장소 안만 보면 "붙어 있는데 안 붙은 것으로 보이는" 경우가 생긴다. 그 상태에서 조사를
 * 포기하면 읽을 수 있는 것을 안 읽은 것이 된다 — 그래서 여기도 본다.
 *
 * 개인 선언은 remote 로 맞춘다(파일의 `path` 는 출처 기록일 뿐이다).
 */
const PERSONAL_BINDINGS = join('.jam', 'projects.yaml')

export type JamAdapterDeps = {
  /**
   * JAM 실행 명령. 아직 패키지로 배포되지 않아 경로가 환경마다 다르다 —
   * 그래서 환경에서 받고, 값을 문서·Profile·저장소에 남기지 않는다.
   */
  command?: string
  args?: readonly string[]
  /** 상태 조회 통로. 테스트가 실제 프로세스를 띄우지 않기 위한 주입점. */
  authStatus?: (context: DiscoveryContext) => Promise<AuthStatus>
  /** 선언 파일 읽기 통로. */
  readDeclaration?: (projectRoot: string) => Promise<string | null>
  /** 개인 선언 파일 읽기 통로. */
  readPersonalBindings?: (home: string) => Promise<string | null>
  /** 이 저장소의 remote 들. 개인 선언과 맞출 때만 쓴다. */
  listRemotes?: (projectRoot: string) => Promise<string[]>
}

/** `jam auth status --json` 의 응답. **토큰 값은 여기 오지 않는다.** */
export type AuthStatus = {
  status?: 'configured' | 'not_configured'
  code?: string
  source?: string
  /** 어느 인스턴스인지. 사람이 "맞는 곳인가"를 확인하는 데 쓴다. */
  baseUrl?: string
  /** 실행 자체가 안 됐을 때의 이유. */
  error?: string
}

/**
 * 어떻게 실행할 것인가.
 *
 * 아직 패키지로 배포되지 않아 환경마다 형태가 다르다 — 실행 파일일 수도, 스크립트 경로일
 * 수도 있다. 스크립트면 지금 도는 것과 같은 런타임으로 부른다.
 *
 * composition도 같은 규칙을 써야 probe와 실제 호출이 같은 곳을 가리킨다.
 */
export function resolveJamCommand(
  env: NodeJS.ProcessEnv | undefined,
  fallbackCommand = 'jam',
  fallbackArgs: readonly string[] = [],
): { command: string; args: string[] } {
  const path = env?.ASC_JAM_PATH
  if (!path) return { command: fallbackCommand, args: [...fallbackArgs] }
  return path.endsWith('.js') || path.endsWith('.mjs')
    ? { command: process.execPath, args: [path] }
    : { command: path, args: [] }
}

/** `project.yaml` 에서 key만 꺼낸다. YAML 파서를 들이지 않는다 — 읽을 것이 한 줄이다. */
export function parseProjectKey(text: string): string | null {
  const match = /^\s*key:\s*["']?([A-Za-z][A-Za-z0-9_]*)["']?\s*$/m.exec(text)
  return match ? match[1]! : null
}

export class JamAdapter implements Adapter {
  #command: string
  #args: readonly string[]
  #authStatus: ((context: DiscoveryContext) => Promise<AuthStatus>) | undefined
  #readDeclaration: (projectRoot: string) => Promise<string | null>
  #readPersonalBindings: (home: string) => Promise<string | null>
  #listRemotes: (projectRoot: string) => Promise<string[]>

  constructor(deps: JamAdapterDeps = {}) {
    this.#command = deps.command ?? 'jam'
    this.#args = deps.args ?? []
    this.#authStatus = deps.authStatus
    this.#readDeclaration = deps.readDeclaration ?? defaultRead
    this.#readPersonalBindings = deps.readPersonalBindings ?? defaultReadPersonal
    this.#listRemotes = deps.listRemotes ?? defaultListRemotes
  }

  describe(): AdapterDescriptor {
    return {
      id: 'jam',
      version: '1',
      provides: PROVIDES,
      // 자격이 필요하다는 사실과 **사람이 해야 한다는 사실**까지. 값은 오지 않는다.
      requiresCredential: ['사람이 직접 `jam auth login` — ASC가 대신 로그인하지 않는다'],
      prerequisites: [
        '프로젝트 루트에 .jira-agent/project.yaml 이 있어야 한다',
        'JAM 실행 경로를 ASC_JAM_PATH 로 알려 줘야 한다 (아직 패키지로 배포되지 않았다)',
      ],
    }
  }

  /**
   * 선언 파일이 있을 때만 후보를 만든다.
   *
   * 다른 저장소의 선언이나 코드 저장소 이름에서 키를 **추측하지 않는다.** 이름이 비슷하다는
   * 것은 연결됐다는 뜻이 아니고, 틀린 연결은 없는 연결보다 나쁘다.
   */
  async discover(context: DiscoveryContext): Promise<BindingCandidate[]> {
    const text = await this.#readDeclaration(context.projectRoot)
    const key = text ? parseProjectKey(text) : null
    if (key) return [{ adapterId: 'jam', resource: key, provides: PROVIDES, discoveredBy: DECLARATION }]

    // 저장소에 선언이 없다고 붙어 있지 않은 것은 아니다 — 개인 자리를 본다.
    const personal = await this.#personalKey(context)
    if (!personal) return []
    return [{ adapterId: 'jam', resource: personal, provides: PROVIDES, discoveredBy: PERSONAL_BINDINGS }]
  }

  /** 개인 선언에서 이 저장소의 키를 찾는다. remote 가 일치할 때만 — 이름이 비슷한 것은 근거가 아니다. */
  async #personalKey(context: DiscoveryContext): Promise<string | null> {
    const home = context.env?.ASC_JAM_HOME ?? context.env?.HOME ?? homedir()
    const text = await this.#readPersonalBindings(home)
    if (!text) return null
    const remotes = await this.#listRemotes(context.projectRoot).catch(() => [])
    const mine = new Set(remotes.map(normalizeWorkspace).filter((value): value is string => value !== null))
    if (mine.size === 0) return null
    for (const entry of parsePersonalBindings(text)) {
      if (mine.has(entry.workspace)) return entry.key
    }
    return null
  }

  async probe(candidate: BindingCandidate, context: DiscoveryContext): Promise<ProbeResult> {
    const status = await this.#status(context)
    if (status.state !== 'AVAILABLE') return { state: status.state, ...(status.detail ? { detail: status.detail } : {}) }
    return { state: 'AVAILABLE', provides: candidate.provides }
  }

  /** 프로젝트와 무관하게 "도구가 지금 쓸 수 있는가". binding 유무와 별개 사실이다. */
  async runtime(context: DiscoveryContext): Promise<RuntimeStatus> {
    return this.#status(context)
  }

  async #status(context: DiscoveryContext): Promise<RuntimeStatus> {
    const read = this.#authStatus ?? ((ctx: DiscoveryContext) => this.#defaultAuthStatus(ctx))
    const status = await read(context).catch((error: unknown) => ({ error: String(error) }) as AuthStatus)

    if (status.error) {
      return { state: 'UNAVAILABLE', detail: `JAM을 실행하지 못했다 — ${status.error}` }
    }
    if (status.status === 'configured') {
      return { state: 'AVAILABLE', ...(status.baseUrl ? { detail: `연결 대상 ${status.baseUrl}` } : {}) }
    }
    // 설정이 안 된 것은 고장이 아니다. 사람이 할 일이 남았다는 뜻이고, 그 일을 알려 준다.
    return {
      state: 'UNCONFIGURED',
      detail: '자격이 없다 — 사람이 직접 `jam auth login` 을 실행해야 한다 (ASC가 대신하지 않는다)',
    }
  }

  async #defaultAuthStatus(context: DiscoveryContext): Promise<AuthStatus> {
    const { command, args } = resolveJamCommand(context.env, this.#command, this.#args)
    try {
      const { stdout } = await run(command, [...args, 'auth', 'status', '--json'])
      return JSON.parse(stdout) as AuthStatus
    } catch (error) {
      // 실행 실패와 "자격 없음"을 합치지 않는다. 전자는 설치·경로 문제다.
      const stdout = (error as { stdout?: string }).stdout
      if (stdout) {
        try {
          return JSON.parse(stdout) as AuthStatus
        } catch {
          // 아래로 떨어뜨린다
        }
      }
      return { error: String((error as { message?: string }).message ?? error).slice(0, 200) }
    }
  }
}

async function defaultRead(projectRoot: string): Promise<string | null> {
  try {
    return await readFile(join(projectRoot, DECLARATION), 'utf8')
  } catch {
    return null
  }
}

async function defaultReadPersonal(home: string): Promise<string | null> {
  try {
    return await readFile(join(home, PERSONAL_BINDINGS), 'utf8')
  } catch {
    return null
  }
}

async function defaultListRemotes(projectRoot: string): Promise<string[]> {
  const { stdout } = await run('git', ['-C', projectRoot, 'remote', '-v'])
  return stdout
    .split('\n')
    .map((line) => line.split(/\s+/)[1])
    .filter((url): url is string => Boolean(url))
}

/**
 * 개인 선언에서 `workspace` 와 `key` 짝만 꺼낸다. YAML 파서를 들이지 않는다 —
 * 읽을 것이 두 줄이고, 의존성 하나가 그 값보다 비싸다.
 */
export function parsePersonalBindings(text: string): { workspace: string; key: string }[] {
  const found: { workspace: string; key: string }[] = []
  let workspace: string | null = null
  for (const line of text.split('\n')) {
    const w = /^\s*-?\s*workspace:\s*"?([^"\n]+?)"?\s*$/.exec(line)
    if (w?.[1]) {
      workspace = w[1]
      continue
    }
    const k = /^\s*key:\s*"?([^"\n]+?)"?\s*$/.exec(line)
    if (k?.[1] && workspace) {
      found.push({ workspace: normalizeWorkspace(workspace) ?? workspace, key: k[1] })
      workspace = null
    }
  }
  return found
}

/** `git:host/group/project` 형태로 맞춘다. remote URL 도 같은 형태로 접어 비교한다. */
export function normalizeWorkspace(value: string): string | null {
  const raw = value.trim().replace(/^git:/, '')
  const ssh = /^[^@]+@([^:]+):(.+?)(?:\.git)?$/.exec(raw)
  const https = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(raw)
  const plain = /^([^/]+)\/(.+?)(?:\.git)?$/.exec(raw)
  const match = ssh ?? https ?? plain
  if (!match) return null
  return `git:${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`
}
