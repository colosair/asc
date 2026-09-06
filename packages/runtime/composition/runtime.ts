// Runtime 조립 — Binding에서 실제 Port 구현을 만든다 (C-09 §6).
//
// CLI가 adapter를 직접 `new` 하면 Surface가 provider를 아는 지점이 흩어지고, adapter를
// 바꿀 때마다 호출부를 전부 고쳐야 한다. 조립을 여기 한 곳에 모으면 교체가 이 파일의
// 변경으로 끝난다 — 그것이 "provider 교체는 Binding 교체" 의 실제 모습이다.
//
// **Core는 이 파일을 import하지 않는다.** 방향은 언제나 Composition → Core다.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { Capability, BindingPlan, ResolvedBinding } from '../core/binding/types.ts'
import { resolveCapability } from '../core/binding/types.ts'
import type { ChangeContextPort } from '../ports/change-context.ts'
import type { EventSource } from '../ports/event-source.ts'
import type { InventoryPort } from '../ports/inventory.ts'
import type { ResourceContextPort } from '../ports/resource-context.ts'
import type { ScmPort } from '../ports/scm.ts'
import type { CoordinationSurfacePort } from '../ports/coordination-surface.ts'
import { GitHubClient, discoverToken } from '../adapters/github/client.ts'
import { GitHubChangeContext, GitHubInventory, GitHubResourceContext } from '../adapters/github/context.ts'
import { GitHubEventSource } from '../adapters/github/event-source.ts'
import { GitHubScm } from '../adapters/github/scm.ts'
import {
  GitLabClient,
  GlabApiClient,
  discoverToken as discoverGitLabToken,
  glabAvailable,
  type ProcessRunner,
} from '../adapters/gitlab/client.ts'
import { GitLabCoordinationSurface } from '../adapters/gitlab/coordination.ts'
import {
  GitLabChangeContext,
  GitLabEventSource,
  GitLabInventory,
  GitLabResourceContext,
} from '../adapters/gitlab/ports.ts'
import { JamMcpClient } from '../adapters/jam/mcp-client.ts'
import { JamEventSource } from '../adapters/jam/event-source.ts'
import { JamInventory, JamResourceContext } from '../adapters/jam/ports.ts'

export type RuntimePorts = {
  eventSource?: EventSource
  scm?: ScmPort
  inventory?: InventoryPort
  resourceContext?: ResourceContextPort
  changeContext?: ChangeContextPort
  /** 밖에 물은 것이 실제로 있게 하는 통로 (C-04·C-10). 없으면 게시는 일어나지 않는다. */
  coordinationSurface?: CoordinationSurfacePort
  /** 무엇을 왜 못 만들었는지. 조용히 빠지면 사람이 이유를 알 수 없다. */
  unavailable: string[]
}

export type BuildInput = {
  plan: BindingPlan
  /**
   * capability별로 어느 역할이 맡는지 (C-09 §4). Profile의 `bindings[]` 선언이 여기 온다.
   * 역할을 주면 같은 capability를 여럿이 제공해도 갈리지 않는다.
   */
  roles?: Partial<Record<Capability, string>>
  /** JAM 같은 도구형 adapter를 조립하기 위한 통로. 없으면 그 갈래는 만들지 않는다. */
  jam?: {
    command: string
    args?: readonly string[]
    cwd?: string
    /**
     * JQL 날짜 리터럴을 해석할 Jira 계정 timezone(IANA). 선언하지 않으면 adapter가
     * UTC로 읽는다 — 기계의 timezone을 쓰지 않는다(adapters/jam/ports.ts).
     */
    timezone?: string
  }
  /** canonical source id → ref. Profile이 준다. */
  sourceRefs?: Readonly<Record<string, { ref: string }>>
  /** 이벤트 조회 페이지 크기. */
  perPage?: number
  /** 자격 조회 통로 주입점(테스트용). adapter id를 받아 그 adapter의 자격을 돌려준다. */
  findToken?: (adapterId: string) => Promise<string | null>
  /** 이 binding이 어느 주소를 가리키는지. 발견 단계가 알아낸 값을 그대로 잇는다. */
  endpointFor?: (binding: ResolvedBinding) => string | undefined
}

/** adapter id → 실제 구현 생성. **여기가 provider 이름을 아는 유일한 자리다.** */
type Factory = (binding: ResolvedBinding, input: BuildInput, token: string) => Partial<RuntimePorts>

const FACTORIES: Record<string, Factory> = {
  gitlab(binding, input, token) {
    // 자체 호스팅이 흔하다. 어디를 가리키는지는 발견 단계가 이미 알아냈으므로 같은 값을 쓴다.
    const baseUrl = input.endpointFor?.(binding)
    // 토큰이 빈 문자열이면 자격이 도구 안에 있다는 뜻이다 (P1-H). 값을 꺼내 오지 않고
    // 그 도구에게 요청을 대신 보내 달라고 한다 — 읽기 전용이다.
    const client = token === '' ? new GlabApiClient(defaultGlabRun) : new GitLabClient({ token, ...(baseUrl ? { baseUrl } : {}) })
    const project = binding.resource
    return {
      eventSource: new GitLabEventSource({ client, project, perPage: input.perPage ?? 30 }),
      inventory: new GitLabInventory({ client, project }),
      resourceContext: new GitLabResourceContext({ client, project }),
      changeContext: new GitLabChangeContext({ client, project }),
      // 조율 표면. 토큰 통로일 때만 쓰기가 가능하다 — 도구를 통로로 쓰는 경우도 POST 를
      // 대신 보내 준다. 둘 다 아니면 create 가 그 사실을 그대로 말한다.
      coordinationSurface: new GitLabCoordinationSurface({ reader: client, writer: client, project }),
      // canonical 통로는 아직 없다. 없는 것을 있는 척하지 않는다.
    }
  },
  github(binding, input, token) {
    const client = new GitHubClient({ token })
    const repo = binding.resource
    return {
      eventSource: new GitHubEventSource({ client, repo, perPage: input.perPage ?? 30 }),
      scm: new GitHubScm({ client, defaultRepo: repo, sourceRefs: input.sourceRefs ?? {} }),
      inventory: new GitHubInventory({ client, defaultRepo: repo }),
      resourceContext: new GitHubResourceContext({ client, defaultRepo: repo }),
      changeContext: new GitHubChangeContext({ client, defaultRepo: repo }),
    }
  },
  jam(binding, input) {
    // JAM은 토큰을 받지 않는다 — 자격은 도구가 자기 안에서 관리하고 ASC는 상태만 읽는다.
    if (!input.jam) return {}
    const client = registerToolClient(
      new JamMcpClient({
      command: input.jam.command,
      ...(input.jam.args ? { args: input.jam.args } : {}),
        ...(input.jam.cwd ? { cwd: input.jam.cwd } : {}),
      }),
    )
    const projectKey = binding.resource
    const timezone = input.jam.timezone
    const inventory = new JamInventory({ client, projectKey, ...(timezone ? { timezone } : {}) })
    return {
      inventory,
      resourceContext: new JamResourceContext({
        client,
        projectKey,
        ...(timezone ? { timezone } : {}),
      }),
      // 푸시가 아니라 updated-since 증분 조회다 (C-07 §1.1) — adapter 주석 참조
      eventSource: new JamEventSource({ inventory }),
    }
  },
}

const execFileAsync = promisify(execFile)

/** glab 실행 통로. 실패는 예외로 올라가고, 호출측이 "없다"로 접는다. */
const defaultGlabRun: ProcessRunner = async (command, args) => {
  const { stdout } = await execFileAsync(command, [...args])
  return stdout
}

/**
 * gitlab 자격 찾기. env 토큰이 먼저고, 없으면 로그인된 `glab` 을 통로로 인정해 빈 문자열을
 * 돌려준다 — **값이 아니라 "통로가 있다"는 사실이다.** 둘 다 없으면 null 이고, 그때만
 * 조립하지 않는다.
 */
const discoverGitLabAccess = async (): Promise<string | null> => {
  const token = discoverGitLabToken()
  if (token) return token
  return (await glabAvailable(defaultGlabRun)) ? '' : null
}

/** 이 adapter는 토큰 없이 조립된다. 자격은 도구가 자기 안에서 진다. */
const TOKENLESS = new Set(['jam'])

/**
 * 자식 프로세스를 띄우는 도구 클라이언트들. 명령이 끝나면 닫아야 한다 — 안 닫으면
 * CLI 가 할 일을 다 하고도 종료하지 못하고 서버 프로세스가 남는다(실제로 그렇게 됐다).
 */
const toolClients = new Set<{ stop(): Promise<void> }>()

function registerToolClient<T extends { stop(): Promise<void> }>(client: T): T {
  toolClients.add(client)
  return client
}

/** 이 프로세스가 띄운 도구 자식들을 정리한다. 여러 번 불러도 안전하다. */
export async function closeToolClients(): Promise<void> {
  const clients = [...toolClients]
  toolClients.clear()
  await Promise.all(clients.map((client) => client.stop().catch(() => undefined)))
}

/**
 * capability와 Port의 대응. **이 표가 없으면 조립이 덮어쓰기가 된다** —
 * 두 binding이 각각 다른 capability를 맡았는데 나중 것이 앞 것의 Port까지 밀어낸다.
 */
const PORT_OF: Partial<Record<Capability, keyof Omit<RuntimePorts, 'unavailable'>>> = {
  'observe.delta': 'eventSource',
  'inventory.enumerate': 'inventory',
  'context.change': 'changeContext',
  'context.resource': 'resourceContext',
  'canonical.read': 'scm',
  'coordination.surface': 'coordinationSurface',
}

/**
 * capability가 필요한 자리마다 어느 binding이 맡을지 정해 Port를 만든다.
 *
 * 후보가 갈리면 만들지 않는다 — `AMBIGUOUS_BINDING`은 사람이 정할 문제이고, 여기서 하나를
 * 고르면 그 선택을 아무도 보지 못한다 (C-09 §4.2).
 */
/**
 * 작업 항목을 읽는 통로의 역할 이름 (P0 F7).
 *
 * `rolesFor` 는 **선언된 binding 이 하나일 때만** 역할을 정한다. 그래서 code binding 과
 * work binding 이 둘 다 `context.resource` 를 제공하면 아무 역할도 서지 않고, 작업 항목
 * 조회는 "통로가 없다" 로 끝난다 — 실기계에서 감시는 되는데 `proceed --work` 만 실패한
 * 자리가 여기다. 없는 것이 아니라 **누구에게 물을지 정하지 않은 것**이었다.
 *
 * 가르는 기준은 provider 이름이 아니라 capability 모양이다: 작업 항목 통로는 목록과 자원을
 * 알고 **변경을 모른다**. 코드 통로는 변경을 안다. 그 차이가 곧 두 축의 정의다
 * (C-09 §2.1 — Port 를 좁게 나눈 이유가 그것이다).
 */
export function workItemRoles(
  plan: BindingPlan,
  declared: readonly { role: string; adapter: string; resource: string }[],
): Partial<Record<Capability, string>> {
  const candidates = plan.bindings
    .filter((binding) => binding.role !== undefined)
    .filter((binding) => declared.some((d) => d.adapter === binding.adapterId && d.resource === binding.resource))
    .filter(
      (binding) =>
        binding.provides.includes('context.resource') &&
        binding.provides.includes('inventory.enumerate') &&
        !binding.provides.includes('context.change'),
    )
  const roles = new Set(candidates.map((binding) => binding.role!))
  // 갈리면 고르지 않는다 — 그것은 사람이 정할 문제다 (C-09 §4.2).
  if (roles.size !== 1) return {}
  const role = [...roles][0]!
  return { 'context.resource': role, 'inventory.enumerate': role, 'context.thread': role, 'context.history': role }
}

/**
 * Profile이 선언한 역할 배정을 capability별 역할로 옮긴다 (C-09 §3.1·§4).
 *
 * **추론하지 않는다.** 선언된 binding이 그 capability를 제공한다고 plan에 적혀 있을 때만
 * 그 역할을 쓴다. 둘 이상이 같은 capability를 제공하면 고르지 않고 비워 둔다 —
 * 그러면 resolve가 AMBIGUOUS로 표면화한다. 여기서 하나를 고르면 사람이 그걸 못 본다.
 */
export function rolesFor(
  plan: BindingPlan,
  declared: readonly { role: string; adapter: string; resource: string }[],
): Partial<Record<Capability, string>> {
  const roles: Partial<Record<Capability, string>> = {}
  const tagged = plan.bindings.filter((b) => b.role !== undefined)

  const capabilities = new Set<Capability>(tagged.flatMap((b) => [...b.provides]))
  for (const capability of capabilities) {
    const owners = new Set(
      tagged
        .filter((b) => b.provides.includes(capability))
        .filter((b) => declared.some((d) => d.adapter === b.adapterId && d.resource === b.resource))
        .map((b) => b.role!),
    )
    if (owners.size === 1) roles[capability] = [...owners][0]!
  }
  return roles
}

/**
 * 관측 capability — 이 셋은 **하나를 고르는 문제가 아니다** (설계 §8).
 *
 * 코드가 GitLab 에 있고 작업 항목이 Jira 에 있는 프로젝트에서 둘 다 봐야 한다는 것은
 * 요구이지 모호함이 아니다. 그런데 지금까지는 같은 capability 를 둘이 제공한다는
 * 이유만으로 AMBIGUOUS 가 되어 감시가 통째로 서지 않았다.
 *
 * 그래서 capability 를 두 부류로 가른다:
 *
 *   singular    canonical.read 처럼 **한 곳이어야** 의미가 서는 것 → 역할로 하나를 고른다
 *   observation observe.delta · inventory.enumerate · context.resource → binding 마다 하나씩
 */
const OBSERVATION_CAPABILITIES: readonly Capability[] = [
  'observe.delta',
  'inventory.enumerate',
  'context.resource',
]

/**
 * 한 binding 이 여는 관측 통로 하나.
 *
 * **Monitor Core 는 이것을 여러 개 받는 것이 아니라, 하나씩 여러 번 받는다** — 채널마다
 * 자기 cursor·coverage·observation ledger 를 갖는 별개의 Run 이다. 그래서 Core 에
 * provider 분기도, multi-source 개념도 생기지 않는다 (설계 §8.1).
 */
export type ObservationChannel = {
  /** Profile 이 선언한 역할. 선언이 없으면 발견된 자리라는 뜻으로 비어 있다. */
  role?: string
  adapterId: string
  resource: string
  /** DEGRADED 도 채널이다 — 일부만 되는 것과 안 되는 것은 다르다. */
  state: ResolvedBinding['state']
  detail?: string
  eventSource: EventSource
  inventory?: InventoryPort
  resourceContext?: ResourceContextPort
  changeContext?: ChangeContextPort
}

export type ObservationChannels = {
  channels: ObservationChannel[]
  /** 무엇을 왜 못 열었는지. 조용히 빠지면 사람이 이유를 알 수 없다. */
  unavailable: string[]
}

/**
 * 선언된 binding 마다 관측 통로를 하나씩 연다.
 *
 * **선언이 있으면 선언만 본다.** 과거 mirror 로 남은 remote 가 발견됐다는 이유로 채널이
 * 하나 더 생기면, 사람이 고르지 않은 곳을 감시하게 된다 — 발견은 후보이지 결합이 아니다
 * (C-11 §7). 선언이 하나도 없으면 발견된 것을 쓰되, 그때는 갈리면 갈린다고 말한다.
 */
export async function buildObservationChannels(input: BuildInput): Promise<ObservationChannels> {
  const usable = input.plan.bindings.filter(
    (binding) =>
      (binding.state === 'AVAILABLE' || binding.state === 'DEGRADED') &&
      OBSERVATION_CAPABILITIES.some((capability) => binding.provides.includes(capability)),
  )
  const declared = usable.filter((binding) => binding.role !== undefined)
  const chosen = declared.length > 0 ? declared : usable

  const channels: ObservationChannel[] = []
  const unavailable: string[] = []

  if (chosen.length === 0) {
    const blocked = input.plan.bindings.filter((binding) =>
      OBSERVATION_CAPABILITIES.some((capability) => binding.provides.includes(capability)),
    )
    unavailable.push(
      blocked.length > 0
        ? `관측 통로를 제공하는 binding 이 있으나 지금 쓸 수 없다 (${blocked
            .map((binding) => `${binding.adapterId}: ${binding.state}`)
            .join(', ')})`
        : '관측 통로를 제공하는 binding 이 없다',
    )
    return { channels, unavailable }
  }

  const findToken =
    input.findToken ??
    (async (adapterId: string) =>
      adapterId === 'gitlab' ? await discoverGitLabAccess() : await discoverToken())

  for (const binding of chosen) {
    const where = `${binding.adapterId}:${binding.resource}`
    const factory = FACTORIES[binding.adapterId]
    if (!factory) {
      unavailable.push(`${where}: 이 빌드에 조립 경로가 없다`)
      continue
    }
    const token = TOKENLESS.has(binding.adapterId) ? '' : await findToken(binding.adapterId)
    if (token === null) {
      // 자격이 없는 것은 "변화 없음"이 아니다 — 그 채널만 빠지고 이유가 남는다
      unavailable.push(`${where}: 자격이 없어 관측 통로를 만들지 않았다`)
      continue
    }
    const made = factory(binding, input, token)
    if (!made.eventSource) {
      unavailable.push(`${where}: ${binding.adapterId} 가 관측 통로를 만들지 않았다`)
      continue
    }
    channels.push({
      ...(binding.role ? { role: binding.role } : {}),
      adapterId: binding.adapterId,
      resource: binding.resource,
      state: binding.state,
      ...(binding.detail ? { detail: binding.detail } : {}),
      eventSource: made.eventSource,
      ...(made.inventory ? { inventory: made.inventory } : {}),
      ...(made.resourceContext ? { resourceContext: made.resourceContext } : {}),
      ...(made.changeContext ? { changeContext: made.changeContext } : {}),
    })
  }

  return { channels, unavailable }
}

export async function buildRuntimePorts(input: BuildInput): Promise<RuntimePorts> {
  const ports: RuntimePorts = { unavailable: [] }
  // 자격은 adapter마다 다른 곳에 있다. Core는 이 사실을 모르고, 여기서만 안다.
  const findToken =
    input.findToken ??
    (async (adapterId: string) =>
      adapterId === 'gitlab' ? await discoverGitLabAccess() : await discoverToken())

  // capability마다 따로 푼다. 한 binding이 여럿을 제공해도, 서로 다른 binding이 나눠
  // 맡아도 같은 경로로 조립된다 — 어느 갈래가 어디서 왔는지가 Port마다 정확해야 한다.
  const wanted = Object.keys(PORT_OF) as Capability[]
  const built = new Map<string, Partial<RuntimePorts>>()

  for (const capability of wanted) {
    const role = input.roles?.[capability]
    const resolution = resolveCapability(input.plan, { capability, ...(role ? { role } : {}) })
    if (resolution.kind !== 'RESOLVED') {
      ports.unavailable.push(
        resolution.kind === 'AMBIGUOUS'
          ? `${capability}: 후보가 둘 이상이라 고르지 않았다 (${resolution.candidates
              .map((c) => `${c.adapterId}:${c.resource}`)
              .join(', ')}) — Profile bindings 로 역할을 정하라`
          : `${capability}: ${resolution.detail}`,
      )
      continue
    }

    const binding = resolution.binding
    const key = `${binding.adapterId}:${binding.resource}`
    let made = built.get(key)
    if (!made) {
      const factory = FACTORIES[binding.adapterId]
      if (!factory) {
        ports.unavailable.push(`${binding.adapterId}: 이 빌드에 조립 경로가 없다`)
        continue
      }
      const token = TOKENLESS.has(binding.adapterId) ? '' : await findToken(binding.adapterId)
      if (token === null) {
        ports.unavailable.push(`${binding.adapterId}: 자격이 없어 외부 조회를 만들지 않았다`)
        continue
      }
      made = factory(binding, input, token)
      built.set(key, made)
    }

    // **그 capability에 해당하는 Port만 가져온다.** 통째로 assign하면 다른 binding이
    // 맡기로 한 갈래까지 덮어쓴다 — multi-binding이 조용히 single-binding이 된다.
    const portKey = PORT_OF[capability]!
    const port = made[portKey]
    if (port === undefined) {
      ports.unavailable.push(`${capability}: ${binding.adapterId} 가 이 갈래를 만들지 않았다`)
      continue
    }
    Object.assign(ports, { [portKey]: port })
  }

  return ports
}
