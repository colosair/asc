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
  /** 진단 통로. 테스트가 실제 프로세스를 띄우지 않기 위한 주입점. */
  doctor?: (context: DiscoveryContext) => Promise<JamDoctor>
  /** 선언 파일 읽기 통로. */
  readDeclaration?: (projectRoot: string) => Promise<string | null>
  /** 개인 선언 파일 읽기 통로. */
  readPersonalBindings?: (home: string) => Promise<string | null>
  /** 이 저장소의 remote 들. 개인 선언과 맞출 때만 쓴다. */
  listRemotes?: (projectRoot: string) => Promise<string[]>
}

/**
 * `doctor --json` 의 응답에서 우리가 읽는 부분. **토큰 값은 여기 오지 않는다.**
 *
 * JAM 이 진단의 정본이다 (설계 §9.2). ASC 는 그 판정을 다시 만들지 않고 번역만 한다 —
 * 예전에는 `auth status` 하나만 보고 준비 상태를 정했는데, 그러면 자격은 멀쩡한데
 * 프로젝트 결합이나 host 등록이 어긋난 상태를 "쓸 수 있다"로 읽는다.
 */
export type JamDoctor = {
  status?: 'ready' | 'failed' | string
  diagnosis?: Record<string, { state?: string; code?: string; detail?: string }>
  axes?: Record<string, string>
  /** 실행 자체가 안 됐을 때의 이유. */
  error?: string
}

/** 되살릴 수 있는가, 사람이 해야 하는가 (설계 §9.4). */
export type JamRemedy =
  /** 사람만 할 수 있다 — 자격 입력. ASC 는 토큰을 받지도 저장하지도 않는다. */
  | { kind: 'HUMAN'; code: string; detail: string }
  /** ASC 가 JAM 의 공식 setup 으로 스스로 고칠 수 있다. */
  | { kind: 'SELF_HEAL'; code: string; detail: string }
  /** 다시 돌려도 달라지지 않는다. */
  | { kind: 'HARD'; code: string; detail: string }

/**
 * doctor 판정을 ASC 가 쓰는 세 갈래로 옮긴다.
 *
 * **코드로만 분기한다** — JAM 이 산문을 바꿔도 판정이 흔들리지 않아야 하고, 우리가 모르는
 * 코드는 사람에게 넘긴다(조용히 자가 치유를 시도하지 않는다).
 */
export function remedyFor(doctor: JamDoctor): JamRemedy | null {
  if (doctor.status === 'ready') return null
  const failed = Object.entries(doctor.diagnosis ?? {}).filter(([, axis]) => axis.state === 'FAILED')
  if (failed.length === 0) return null

  for (const [axis, value] of failed) {
    const code = value.code ?? axis
    const detail = value.detail ?? axis
    // 자격은 사람 몫이다. JAM 이 그렇게 설계돼 있고 ASC 가 그것을 우회하지 않는다.
    if (code === 'JAM_AUTH_REQUIRED' || axis === 'credentials' || axis === 'jiraAuthentication') {
      return { kind: 'HUMAN', code, detail }
    }
  }

  const [firstAxis, first] = failed[0]!
  const code = first.code ?? firstAxis
  const detail = first.detail ?? firstAxis
  // 프로젝트 결합·runtime 설정·host 등록은 JAM 의 공식 setup 이 고친다.
  const healable = new Set([
    'JAM_PROJECT_SELECTION_REQUIRED',
    'JAM_RUNTIME_CONFIG_MISSING',
    'HOST_REGISTRATION_STALE',
    'HOST_REGISTRATION_MISSING',
  ])
  if (healable.has(code)) return { kind: 'SELF_HEAL', code, detail }
  return { kind: 'HARD', code, detail }
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
  #doctor: ((context: DiscoveryContext) => Promise<JamDoctor>) | undefined
  #readDeclaration: (projectRoot: string) => Promise<string | null>
  #readPersonalBindings: (home: string) => Promise<string | null>
  #listRemotes: (projectRoot: string) => Promise<string[]>

  constructor(deps: JamAdapterDeps = {}) {
    this.#command = deps.command ?? 'jam'
    this.#args = deps.args ?? []
    this.#doctor = deps.doctor
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
      requiresCredential: ['사람이 직접 JAM 에 로그인해야 한다 — ASC가 대신 로그인하지 않는다'],
      prerequisites: [
        // 개인 결합이 기본값이다. 저장소에 파일을 두는 것은 팀이 채택했을 때뿐이다.
        'JAM 이 이 workspace 를 Jira 프로젝트에 결합하고 있어야 한다 (개인 결합이 기본, 팀 채택 시 .jira-agent/project.yaml)',
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
    if (personal) {
      return [{ adapterId: 'jam', resource: personal, provides: PROVIDES, discoveredBy: PERSONAL_BINDINGS }]
    }

    // 지역 흔적이 없어도 **Profile 이 이미 정해 둔 것**은 후보다 (설계 §9.3).
    // 이것은 추측이 아니다 — 사람이 적은 결정이고, 실제로 되는지는 probe 가 정한다.
    // 이 갈래가 없으면 "선언은 있는데 아무 일도 일어나지 않는" 상태가 남는다.
    const declared = (context.declared ?? []).filter((entry) => entry.adapterId === 'jam')
    return declared.map((entry) => ({
      adapterId: 'jam' as const,
      resource: entry.resource,
      provides: PROVIDES,
      discoveredBy: 'Profile bindings',
    }))
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

  /** 마지막 진단. setup 경로가 자가 치유 여부를 정할 때 읽는다 — 다시 돌리지 않기 위해서다. */
  #lastRemedy: JamRemedy | null = null

  /** 직전 진단이 무엇을 요구했는가. 없으면 문제 없거나 아직 안 물어봤다. */
  lastRemedy(): JamRemedy | null {
    return this.#lastRemedy
  }

  async #status(context: DiscoveryContext): Promise<RuntimeStatus> {
    const read = this.#doctor ?? ((ctx: DiscoveryContext) => this.#defaultDoctor(ctx))
    const doctor = await read(context).catch((error: unknown) => ({ error: String(error) }) as JamDoctor)

    if (doctor.error) {
      this.#lastRemedy = null
      return { state: 'UNAVAILABLE', detail: `JAM을 실행하지 못했다 — ${doctor.error}` }
    }

    const remedy = remedyFor(doctor)
    this.#lastRemedy = remedy
    if (!remedy) return { state: 'AVAILABLE', ...(jamTarget(doctor) ? { detail: jamTarget(doctor)! } : {}) }

    switch (remedy.kind) {
      case 'HUMAN':
        // 설정이 안 된 것은 고장이 아니다. 사람이 할 일이 남았다는 뜻이고, 그 일을 알려 준다.
        return {
          state: 'UNCONFIGURED',
          detail: `${remedy.code} — 사람이 직접 JAM 에 로그인해야 한다 (ASC가 대신하지 않는다): ${remedy.detail}`,
        }
      case 'SELF_HEAL':
        // 고칠 수 있는 것을 "못 쓴다"로 적지 않는다 — 그 판단이 setup 을 멈추게 만든다.
        return { state: 'UNCONFIGURED', detail: `${remedy.code} — JAM 공식 setup 으로 고칠 수 있다: ${remedy.detail}` }
      case 'HARD':
        return { state: 'UNAVAILABLE', detail: `${remedy.code} — ${remedy.detail}` }
    }
  }

  async #defaultDoctor(context: DiscoveryContext): Promise<JamDoctor> {
    const { command, args } = resolveJamCommand(context.env, this.#command, this.#args)
    try {
      const { stdout } = await run(command, [...args, 'doctor', '--json'], { cwd: context.projectRoot })
      return JSON.parse(stdout) as JamDoctor
    } catch (error) {
      // 실행 실패와 "준비 안 됨"을 합치지 않는다. 전자는 설치·경로 문제다.
      // doctor 는 준비되지 않았을 때 0 이 아닌 코드로 끝나면서도 JSON 을 낸다.
      const stdout = (error as { stdout?: string }).stdout
      if (stdout) {
        try {
          return JSON.parse(stdout) as JamDoctor
        } catch {
          // 아래로 떨어뜨린다
        }
      }
      return { error: String((error as { message?: string }).message ?? error).slice(0, 200) }
    }
  }
}

/** 어느 인스턴스에 붙었는지. 사람이 "맞는 곳인가"를 확인하는 데 쓴다. */
function jamTarget(doctor: JamDoctor): string | null {
  const detail = doctor.diagnosis?.credentials?.detail ?? doctor.diagnosis?.jiraAuthentication?.detail
  return detail ? `연결 확인됨 (${detail})` : null
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
