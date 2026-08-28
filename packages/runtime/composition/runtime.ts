// Runtime 조립 — Binding에서 실제 Port 구현을 만든다 (C-09 §6).
//
// CLI가 adapter를 직접 `new` 하면 Surface가 provider를 아는 지점이 흩어지고, adapter를
// 바꿀 때마다 호출부를 전부 고쳐야 한다. 조립을 여기 한 곳에 모으면 교체가 이 파일의
// 변경으로 끝난다 — 그것이 "provider 교체는 Binding 교체" 의 실제 모습이다.
//
// **Core는 이 파일을 import하지 않는다.** 방향은 언제나 Composition → Core다.

import type { Capability, BindingPlan, ResolvedBinding } from '../core/binding/types.ts'
import { resolveCapability } from '../core/binding/types.ts'
import type { ChangeContextPort } from '../ports/change-context.ts'
import type { EventSource } from '../ports/event-source.ts'
import type { InventoryPort } from '../ports/inventory.ts'
import type { ResourceContextPort } from '../ports/resource-context.ts'
import type { ScmPort } from '../ports/scm.ts'
import { GitHubClient, discoverToken } from '../adapters/github/client.ts'
import { GitHubChangeContext, GitHubInventory, GitHubResourceContext } from '../adapters/github/context.ts'
import { GitHubEventSource } from '../adapters/github/event-source.ts'
import { GitHubScm } from '../adapters/github/scm.ts'
import { GitLabClient, discoverToken as discoverGitLabToken } from '../adapters/gitlab/client.ts'
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
    const client = new GitLabClient({ token, ...(baseUrl ? { baseUrl } : {}) })
    const project = binding.resource
    return {
      eventSource: new GitLabEventSource({ client, project, perPage: input.perPage ?? 30 }),
      inventory: new GitLabInventory({ client, project }),
      resourceContext: new GitLabResourceContext({ client, project }),
      changeContext: new GitLabChangeContext({ client, project }),
      // canonical·외부 write 통로는 아직 없다. 없는 것을 있는 척하지 않는다.
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
}

/**
 * capability가 필요한 자리마다 어느 binding이 맡을지 정해 Port를 만든다.
 *
 * 후보가 갈리면 만들지 않는다 — `AMBIGUOUS_BINDING`은 사람이 정할 문제이고, 여기서 하나를
 * 고르면 그 선택을 아무도 보지 못한다 (C-09 §4.2).
 */
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

export async function buildRuntimePorts(input: BuildInput): Promise<RuntimePorts> {
  const ports: RuntimePorts = { unavailable: [] }
  // 자격은 adapter마다 다른 곳에 있다. Core는 이 사실을 모르고, 여기서만 안다.
  const findToken =
    input.findToken ??
    (async (adapterId: string) =>
      adapterId === 'gitlab' ? discoverGitLabToken() : await discoverToken())

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
