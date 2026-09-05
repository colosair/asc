// Composition Root — 실제 Adapter를 아는 유일한 자리 (C-09 §6).
//
// **이 파일은 `core/` 밖이다.** Core는 adapter를 import하지 않고, adapter id로 분기하지도
// 않는다. 여기서 조립한 BindingPlan만 Core로 넘어간다.
//
// 정적 registry로 충분하다 (C-09 §6.2). 동적 로더·marketplace·서명·버전 협상은 만들지
// 않는다 — 두세 개의 실제 adapter에서 같은 구조가 반복되는 것을 본 뒤에 검토한다.
// 지금 만들면 쓰이지 않는 확장점의 유지 비용만 남는다.

import type { AdapterRuntime, BindingPlan, ResolvedBinding } from '../core/binding/types.ts'
import type { Adapter, DiscoveryContext, ProbeResult } from '../ports/adapter.ts'
import { GitHubAdapter } from '../adapters/github/adapter.ts'
import { GitLabAdapter } from '../adapters/gitlab/adapter.ts'
import { JamAdapter } from '../adapters/jam/adapter.ts'

/**
 * 이 빌드에 들어 있는 adapter. 여기 없는 것은 존재하지 않는다.
 *
 * 목록에 있다고 켜지는 것이 아니다 — discover가 후보를 찾지 못하거나 probe가 쓸 수
 * 없다고 하면 그 갈래는 조립되지 않는다 (C-09 §7).
 */
export function defaultAdapters(): Adapter[] {
  return [new GitHubAdapter(), new GitLabAdapter(), new JamAdapter()]
}

export type BindingRole = { adapterId: string; resource: string; role: string }

export type ComposeInput = {
  context: DiscoveryContext
  /** 없으면 이 빌드의 기본 목록. 테스트가 다른 조합을 물릴 수 있다. */
  adapters?: readonly Adapter[]
  /**
   * Profile이 선언한 역할 배정. **역할은 사람이 정한다** — 어느 binding이 code-primary인지
   * ASC가 추론하지 않는다 (C-09 §3.1).
   */
  roles?: readonly BindingRole[]
}

/**
 * describe → discover → probe → BindingPlan.
 *
 * provider 목록을 순회하는 코드가 아니다 — 등록된 adapter가 스스로 후보를 찾고,
 * adapter가 없으면 그 갈래는 애초에 없다 (C-09 §7).
 */
export async function composeBindings(input: ComposeInput): Promise<BindingPlan> {
  const adapters = input.adapters ?? defaultAdapters()
  const bindings: ResolvedBinding[] = []
  const runtimes: AdapterRuntime[] = []

  // Profile 이 선언한 것을 발견 단계에 알려 준다. adapter 가 지역 흔적을 못 찾아도
  // 사람이 적어 둔 결정은 후보가 될 수 있다 — 되는지는 여전히 probe 가 정한다 (C-09 §3.1).
  const context: DiscoveryContext = {
    ...input.context,
    ...(input.roles?.length
      ? { declared: input.roles.map((role) => ({ adapterId: role.adapterId, resource: role.resource })) }
      : {}),
  }

  for (const adapter of adapters) {
    // 도구가 쓸 수 있는가와 이 프로젝트가 그 도구에 붙어 있는가는 다른 사실이다.
    // 합치면 사람이 "설치할 일인지 붙일 일인지"를 알 수 없다.
    if (adapter.runtime) {
      const status = await adapter
        .runtime(context)
        .catch((error: unknown) => ({ state: 'UNAVAILABLE' as const, detail: String(error) }))
      runtimes.push({ adapterId: adapter.describe().id, ...status })
    }

    const candidates = await adapter.discover(context).catch(() => [])
    for (const candidate of candidates) {
      // probe가 터지는 것과 "안 된다"는 다르다. 예외를 UNAVAILABLE로 옮겨 적되
      // 이유를 남긴다 — 조용히 후보에서 빼면 왜 안 보이는지 알 수 없다.
      const result: ProbeResult = await adapter
        .probe(candidate, context)
        .catch((error: unknown) => ({ state: 'UNAVAILABLE' as const, detail: String(error) }))

      const role = input.roles?.find(
        (r) => r.adapterId === candidate.adapterId && r.resource === candidate.resource,
      )?.role

      bindings.push({
        ...candidate,
        ...(result.provides ? { provides: result.provides } : {}),
        state: result.state,
        ...(result.detail ? { detail: result.detail } : {}),
        ...(role ? { role } : {}),
      })
    }
  }

  return { bindings, ...(runtimes.length > 0 ? { runtimes } : {}) }
}

/** 설치된 adapter가 정적으로 선언하는 것. 네트워크도 파일 접근도 없다. */
export function describeAll(adapters: readonly Adapter[] = defaultAdapters()) {
  return adapters.map((adapter) => adapter.describe())
}
