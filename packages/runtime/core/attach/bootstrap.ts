// Bootstrap Resolver — 붙이기 전에 무엇이 있고 무엇이 정해지지 않았는지 본다 (C-06).
//
// 두 진입(CLI의 `asc init` / 자연어 "ASC로 진행해")이 여기서 만난다. 진입만 다르고 판정은 하나여야
// 한다 — 자연어 경로가 CLI 경로보다 더 할 수 있는 것도, 덜 할 수 있는 것도 없다.
//
// 이 모듈은 **아무것도 쓰지 않는다.** 감지하고, 무엇을 할지 적고, 돌려준다. 실행은 기존
// 표면(init / host install / profile resolve)이 그대로 한다 — 새 orchestration 계층을
// 만들면 같은 일을 하는 경로가 둘이 되고, 그때부터 둘이 조금씩 달라진다.
//
// 후보를 찾아 주는 것과 그중 하나를 대신 고르는 것은 다른 일이다. 후보가 하나뿐이어도
// 고르지 않는다 (C-06 §2) — Profile 선택은 그 프로젝트가 어떤 규칙 아래 돌지를 정하는
// 결정이고, 그건 사람 몫이다.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AdapterRuntime, BindingPlan, Capability, ResolvedBinding } from '../binding/types.ts'
import { availableCapabilities } from '../binding/types.ts'
import { listProfileLocations } from '../resolver/profile-source.ts'
import { discoverProjectRoot, exists } from './init.ts'

export type ProfileChoice =
  /** 사람이 지정했다. */
  | { kind: 'GIVEN'; id: string }
  /** 이미 붙어 있고 lock이 무엇으로 붙었는지 안다. */
  | { kind: 'ALREADY_ATTACHED'; id: string }
  /** 후보는 있는데 정해지지 않았다. 하나뿐이어도 여기 머문다. */
  | { kind: 'UNDECIDED'; candidates: string[] }
  /** 붙어 있는데 무엇으로 붙었는지 읽지 못했다. 붙이다 만 상태다. */
  | { kind: 'ATTACHED_UNKNOWN' }

export type HostState = { id: string; installed: boolean }

/**
 * 정책은 사람이 정한다 (C-09 §7.1). adapter가 찾아 주는 것과 그것이 무슨 뜻인지 정하는 것은
 * 다른 일이며, 후자를 대신 정하면 그건 wizard다 (C-06 §2).
 */
export const POLICY_QUESTIONS = [
  { id: 'canonical', question: '어느 branch·ref가 canonical인가' },
  { id: 'work-ssot', question: '작업 항목의 정본이 어디인가' },
  { id: 'ownership', question: 'ownership path는 무엇인가' },
  { id: 'authority', question: 'decision authority는 누구인가' },
  { id: 'digest-channel', question: '기본 전달 채널은 무엇인가' },
] as const

export type PolicyId = (typeof POLICY_QUESTIONS)[number]['id']

export type BootstrapPlan = {
  projectRoot: string
  git: boolean
  attached: boolean
  profile: ProfileChoice
  hosts: HostState[]
  /** 발견된 외부 연결 후보와 실측 상태 (C-09 §7). 없으면 로컬 루프만 도는 것이다. */
  bindings: readonly ResolvedBinding[]
  /**
   * adapter 자체의 상태. binding과 나눠서 보여 준다 — "도구는 쓸 수 있는데 이 프로젝트가
   * 아직 붙어 있지 않다"와 "도구가 없다"는 사람이 할 일이 다르다.
   */
  runtimes: readonly AdapterRuntime[]
  /** 지금 실제로 쓸 수 있는 semantic capability. adapter 이름이 아니라 할 수 있는 일이다. */
  capabilities: readonly Capability[]
  /** 사람이 실행할 다음 명령. 문자열이다 — 자동으로 태우지 않는다. */
  steps: string[]
  /** 사람이 정해야 남은 것. 비어 있지 않으면 계획은 아직 계획일 뿐이다. */
  undecided: string[]
}

export type BootstrapInput = {
  cwd: string
  /** ASC 설치 경로. 내장 `profiles/` 를 여기서 읽는다. */
  installRoot: string
  /**
   * 사용자 소유 Profile 디렉터리(보통 `ASC_HOME/profiles`). **Surface가 정해서 넘긴다** —
   * Core가 홈 경로를 스스로 알면 그 순간 저장소·사용자 공간의 경계를 Core가 쥐게 된다.
   */
  externalProfileRoot?: string
  /**
   * 이 위치가 붙어 있다면 그 runtime 뿌리. **Surface가 정해서 넘긴다** — Core가 여기서
   * 다시 찾으면 저장소 안의 `.asc` 만 보게 되고, 그것이 기본이 아닌 지금은
   * local scope로 붙은 workspace를 "안 붙었다"고 답하게 된다 (C-11 §3).
   */
  ascRoot?: string
  /** 사람이 지정한 Profile. 없으면 후보만 제시한다. */
  profileId?: string
  /**
   * Host 설치 상태. Core는 어떤 Host가 있는지 모른다 — Surface가 알아내 넘긴다.
   * 이름이 이 파일에 들어오는 순간 Core가 provider를 아는 셈이 된다.
   */
  hosts?: readonly HostState[]
  /**
   * Composition이 조립한 Binding Plan (C-09 §7). 같은 이유로 여기서 adapter를 부르지 않는다 —
   * 이 파일은 결과를 계획에 싣기만 한다.
   */
  bindings?: BindingPlan
  /**
   * 이미 선언된 정책. **붙어 있다는 것이 정책이 전부 정해졌다는 뜻은 아니다** —
   * Profile이 무엇을 선언했는지는 Surface가 읽어 알려 주고, 남은 것을 여기서 묻는다.
   */
  declaredPolicies?: readonly PolicyId[]
  /** 정책 질문 자체를 생략할지. 계획만 보려는 호출용이다. */
  askPolicy?: boolean
}

/**
 * 지금 고를 수 있는 Profile. 설치된 배포본 안과 **사용자 소유 공간** 둘 다 본다 —
 * 팀이 나눠 갖는 실 Profile은 배포본에 들어가지 않으므로 후자가 없으면 후보가 없다.
 *
 * 없으면 빈 목록이다 — 그것도 사람이 알아야 할 사실이다.
 */
export async function availableProfiles(
  installRoot: string,
  externalProfileRoot?: string,
): Promise<string[]> {
  const found = await listProfileLocations({
    installRoot,
    ...(externalProfileRoot ? { externalRoot: externalProfileRoot } : {}),
  })
  return [...new Set(found.map((location) => location.id))].sort()
}

/** 붙어 있다면 무엇으로 붙었는가. lock을 읽지 못하면 붙이다 만 상태로 본다. */
async function attachedProfile(ascRoot: string): Promise<string | null> {
  try {
    const lock = JSON.parse(await readFile(join(ascRoot, 'profile.lock'), 'utf8')) as {
      profile?: { id?: unknown }
    }
    return typeof lock.profile?.id === 'string' ? lock.profile.id : null
  } catch {
    return null
  }
}

/** 감지하고 계획을 세운다. 파일은 하나도 건드리지 않는다. */
export async function planBootstrap(input: BootstrapInput): Promise<BootstrapPlan> {
  const { root: projectRoot, git } = await discoverProjectRoot(input.cwd)
  // 넘겨받은 것이 없을 때만 저장소 안을 본다 — 옛 경로를 계속 지원하되 기본으로 두지 않는다.
  const ascRoot = input.ascRoot ?? join(projectRoot, '.asc')
  const attached = await exists(ascRoot)
  const candidates = await availableProfiles(input.installRoot, input.externalProfileRoot)
  const hosts = [...(input.hosts ?? [])]
  const plan: BindingPlan = input.bindings ?? { bindings: [] }
  const locked = attached ? await attachedProfile(ascRoot) : null

  const profile: ProfileChoice = input.profileId
    ? { kind: 'GIVEN', id: input.profileId }
    : locked
      ? { kind: 'ALREADY_ATTACHED', id: locked }
      : attached
        ? { kind: 'ATTACHED_UNKNOWN' }
        : { kind: 'UNDECIDED', candidates }

  const steps: string[] = []
  const undecided: string[] = []

  if (profile.kind === 'UNDECIDED') {
    undecided.push(
      candidates.length === 0
        ? '쓸 수 있는 Profile이 없다 — 설치 경로에 profiles/<id>/profile.json 이 있어야 한다'
        : `어떤 Profile로 붙일지 (후보: ${candidates.join(', ')})`,
    )
    if (candidates.length > 0) steps.push('asc init --profile <위 후보 중 하나>')
  } else if (profile.kind === 'ATTACHED_UNKNOWN') {
    // 통과시키면 무엇으로 도는지 모르는 채 굴러간다 — bootstrapGuard가 막는 것과 같은 상태다
    undecided.push('.asc/ 는 있는데 profile.lock 을 읽지 못했다 — 붙이다 만 상태다')
    steps.push('asc init --profile <id> 로 다시 붙이거나 asc profile resolve --write 로 고정한다')
  } else if (!attached) {
    steps.push(`asc init --profile ${profile.id}`)
  }

  for (const host of hosts) {
    if (!host.installed) steps.push(`asc host ${host.id} install`)
  }

  // 설정만 채우면 열리는 것과 지금 닿지 않는 것을 나눠 말한다 — 합치면 사람이 무엇을
  // 해야 하는지 알 수 없다 (C-09 §5.1).
  for (const binding of plan.bindings) {
    if (binding.state === 'UNCONFIGURED') {
      undecided.push(`${binding.adapterId} (${binding.resource}): ${binding.detail ?? '설정이 필요하다'}`)
    }
  }
  if (input.askPolicy !== false) {
    const declared = new Set(input.declaredPolicies ?? [])
    for (const policy of POLICY_QUESTIONS) {
      if (!declared.has(policy.id)) undecided.push(policy.question)
    }
  }

  steps.push('asc setup status')
  if (attached) steps.push('asc proceed')

  return {
    projectRoot,
    git,
    attached,
    profile,
    hosts,
    bindings: plan.bindings,
    runtimes: plan.runtimes ?? [],
    capabilities: availableCapabilities(plan),
    steps,
    undecided,
  }
}

/** 사람이 읽는 계획. 무엇이 정해지지 않았는지가 먼저 오도록 짠다. */
export function renderPlan(plan: BootstrapPlan): string {
  const lines: string[] = []
  lines.push(`프로젝트: ${plan.projectRoot}${plan.git ? '' : ' (git 저장소가 아니다)'}`)
  lines.push(plan.attached ? 'ASC: 이미 붙어 있다' : 'ASC: 아직 붙지 않았다')

  if (plan.profile.kind === 'UNDECIDED') {
    lines.push(
      plan.profile.candidates.length > 0
        ? `Profile 후보: ${plan.profile.candidates.join(', ')}`
        : 'Profile 후보: 없음',
    )
  } else if (plan.profile.kind === 'ATTACHED_UNKNOWN') {
    lines.push('Profile: 알 수 없음 (profile.lock 을 읽지 못했다)')
  } else {
    lines.push(`Profile: ${plan.profile.id}`)
  }

  for (const host of plan.hosts) {
    lines.push(`Host ${host.id}: ${host.installed ? '설치됨' : '설치되지 않음'}`)
  }

  if (plan.runtimes.length > 0) {
    lines.push('', '도구 상태 (이 프로젝트와 무관한 사실):')
    for (const runtime of plan.runtimes) {
      lines.push(`  ${runtime.adapterId}  ${runtime.state}${runtime.detail ? ` — ${runtime.detail}` : ''}`)
    }
  }

  lines.push('', '발견된 외부 연결:')
  if (plan.bindings.length === 0) {
    lines.push('  (없음)')
  } else {
    for (const binding of plan.bindings) {
      const role = binding.role ? ` [${binding.role}]` : ''
      const detail = binding.detail ? ` — ${binding.detail}` : ''
      lines.push(`  ${binding.adapterId} ${binding.resource}${role}  ${binding.state}${detail}`)
    }
  }

  // 도구는 되는데 이 프로젝트가 안 붙어 있는 경우를 따로 말한다. 그러지 않으면
  // "도구는 쓸 수 있다는데 왜 아무것도 안 보이지"에서 사람이 멈춘다.
  for (const runtime of plan.runtimes) {
    if (runtime.state !== 'AVAILABLE') continue
    if (plan.bindings.some((binding) => binding.adapterId === runtime.adapterId)) continue
    lines.push(`  ${runtime.adapterId}  NOT DISCOVERED — 도구는 쓸 수 있으나 이 프로젝트에 연결 선언이 없다`)
  }

  lines.push('', `지금 쓸 수 있는 것: ${plan.capabilities.join(', ') || '없음'}`)

  if (plan.undecided.length > 0) {
    lines.push('', '정해지지 않은 것 (ASC가 대신 정하지 않는다):')
    for (const item of plan.undecided) lines.push(`  - ${item}`)
  }

  lines.push('', '다음 순서:')
  for (const step of plan.steps) lines.push(`  ${step}`)
  return lines.join('\n')
}
