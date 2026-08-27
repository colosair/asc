// Adapter / Binding 어휘 — Core가 외부 시스템을 모른 채 조립을 판정하기 위한 타입 (C-09).
//
// 여기에는 provider 이름이 없다. adapter id는 **문자열로 실려 지나갈 뿐** Core가 그 값으로
// 행동을 바꾸지 않는다 (C-09 §6.1). 실제 adapter를 import하고 조립하는 곳은 Core 밖이다.
//
// 두 개념을 계속 구분한다 (C-09 §1):
//   Interface(Port)  행동 계약 — 무엇을 어떻게 부르는가
//   Capability       availability descriptor — 그 행동을 지금 이 Binding에서 쓸 수 있는가

/**
 * provider-neutral semantic operation (C-09 §1.1). 이 목록이 정본이다.
 *
 * 여기에 provider 이름을 넣지 않는다 — `scm.<제품>` 같은 값은 capability가 아니라
 * adapter identity이며, 그것으로 갈라지기 시작하면 Core가 provider를 아는 셈이 된다.
 */
export const CAPABILITIES = [
  'observe.delta',
  'inventory.enumerate',
  'context.resource',
  'context.thread',
  'context.change',
  'context.history',
  'canonical.read',
  'action.comment',
  'action.update',
  'presentation.digest',
  'presentation.priority',
  'approval.interactive',
  'identity.resolve',
] as const
export type Capability = (typeof CAPABILITIES)[number]

/** describe() 산출물 — 호출도 네트워크도 없는 정적 선언 (C-09 §5). */
export type AdapterDescriptor = {
  id: string
  version: string
  provides: readonly Capability[]
  /**
   * 자격이 필요하다는 **사실과 이름**까지만. 값은 여기에도, Profile에도 오지 않는다
   * (OM §4.2·§4.5).
   */
  requiresCredential?: readonly string[]
  /** 실행 전제(외부 실행파일·프로세스 경계 등)를 사람이 읽을 문장으로. */
  prerequisites?: readonly string[]
}

/**
 * probe 결과. Boolean이 아닌 이유: "내가 설정을 안 한 것"과 "저쪽이 안 되는 것"을
 * 합치면 사람이 무엇을 해야 할지 알 수 없다 (C-09 §5.1).
 */
export type ProbeState = 'AVAILABLE' | 'DEGRADED' | 'UNCONFIGURED' | 'UNAVAILABLE'

/** discover()가 찾아낸 후보 하나. 아직 쓸 수 있는지는 모른다. */
export type BindingCandidate = {
  adapterId: string
  /** 어느 리소스인가. 문법은 adapter 소관이고 Core는 문자열로만 다룬다. */
  resource: string
  /** 이 후보가 실제로 제공할 수 있다고 말하는 capability. describe의 부분집합이다. */
  provides: readonly Capability[]
  /** 어떻게 찾았는지 — 사람이 "이게 왜 후보인가"를 알 수 있어야 한다. */
  discoveredBy?: string
}

/** probe까지 마친 Binding. role은 사람이 정한다 — Core가 추론하지 않는다. */
export type ResolvedBinding = BindingCandidate & {
  state: ProbeState
  /** DEGRADED·UNCONFIGURED·UNAVAILABLE의 이유. 상태만 주면 고칠 수가 없다. */
  detail?: string
  /** 'code-primary' | 'work' | 'presentation' … Profile이 선언한 역할 이름. */
  role?: string
}

/**
 * adapter 자체의 상태. **binding과 별개 사실이다** — 도구는 쓸 수 있는데 이 프로젝트가
 * 붙어 있지 않을 수 있고, 그 둘은 사람이 할 일이 다르다.
 */
export type AdapterRuntime = {
  adapterId: string
  state: ProbeState
  detail?: string
}

export type BindingPlan = {
  bindings: readonly ResolvedBinding[]
  /** 상태를 보고하는 adapter만 실린다. */
  runtimes?: readonly AdapterRuntime[]
}

export type CapabilityResolution =
  | { capability: Capability; kind: 'RESOLVED'; binding: ResolvedBinding }
  /** 아무 binding도 제공하지 않는다 — 그 기능만 끈다 (조용한 통과가 아니다). */
  | { capability: Capability; kind: 'UNAVAILABLE'; detail: string }
  /** 둘 이상이 제공하는데 고를 수 없다. 임의 선택하지 않는다 (C-09 §4.2). */
  | { capability: Capability; kind: 'AMBIGUOUS'; candidates: readonly ResolvedBinding[] }

/** 한 작업이 필요로 하는 것. "provider가 뭐냐"가 아니라 이것으로 묻는다 (C-09 §4.1). */
export type CapabilityRequirement = {
  capability: Capability
  /** 이 역할의 binding에서만 찾는다. 없으면 전체에서 찾는다. */
  role?: string
}

/**
 * 요구 하나를 푼다.
 *
 * **쓸 수 있는 것만 후보다** — UNAVAILABLE·UNCONFIGURED는 애초에 세지 않는다.
 * DEGRADED는 후보로 남긴다: 일부만 되는 것과 안 되는 것은 다르고, 어느 쪽을 쓸지는
 * 호출자가 detail을 보고 정한다.
 */
export function resolveCapability(
  plan: BindingPlan,
  requirement: CapabilityRequirement,
): CapabilityResolution {
  const usable = plan.bindings.filter(
    (b) =>
      (b.state === 'AVAILABLE' || b.state === 'DEGRADED') &&
      b.provides.includes(requirement.capability) &&
      (requirement.role === undefined || b.role === requirement.role),
  )

  if (usable.length === 0) {
    // 후보가 아예 없는 것과, 있었는데 지금 못 쓰는 것을 구분해 말해 준다.
    const blocked = plan.bindings.filter((b) => b.provides.includes(requirement.capability))
    return {
      capability: requirement.capability,
      kind: 'UNAVAILABLE',
      detail:
        blocked.length > 0
          ? `'${requirement.capability}' 를 제공하는 binding이 있으나 지금 쓸 수 없다 (${blocked
              .map((b) => `${b.adapterId}: ${b.state}`)
              .join(', ')})`
          : `'${requirement.capability}' 를 제공하는 binding이 없다`,
    }
  }

  // 하나로 좁혀지지 않으면 고르지 않는다. 임의 선택은 그 선택을 사람이 영영 보지 못하게 한다.
  if (usable.length > 1) {
    return { capability: requirement.capability, kind: 'AMBIGUOUS', candidates: usable }
  }
  return { capability: requirement.capability, kind: 'RESOLVED', binding: usable[0]! }
}

/** 여러 요구를 한 번에. 하나라도 못 풀면 그 사실이 결과에 남는다 — 부분 성공을 감추지 않는다. */
export function resolveAll(
  plan: BindingPlan,
  requirements: readonly CapabilityRequirement[],
): CapabilityResolution[] {
  return requirements.map((r) => resolveCapability(plan, r))
}

/** 지금 실제로 쓸 수 있는 capability 목록. setup·bootstrap 표면이 사람에게 보여준다. */
export function availableCapabilities(plan: BindingPlan): Capability[] {
  const found = new Set<Capability>()
  for (const binding of plan.bindings) {
    if (binding.state !== 'AVAILABLE' && binding.state !== 'DEGRADED') continue
    for (const capability of binding.provides) found.add(capability)
  }
  return [...found].sort()
}
