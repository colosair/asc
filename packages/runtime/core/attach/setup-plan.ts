// Setup — detect → plan → apply → verify (C-14 §6).
//
// **하나의 판단을 두 진입이 나눠 쓴다.** 사람이 보는 화면과 agent가 파싱하는 JSON은
// 표현이 다를 뿐 같은 plan에서 나온다. 둘이 각자 판단하면 그 둘은 반드시 갈라진다.
//
// 이 파일은 **순수하다** — network·subprocess·clock·파일에 손대지 않는다. 세상의 사실은
// caller가 관측해 `SetupState` 로 넘긴다. 그래야 "이 명령이 무엇을 바꿀 것인가"를
// 아무것도 바꾸지 않고 물어볼 수 있다.

import { portableCommand, RUNTIME_PACKAGE, shorthandCommand } from '../distribution/release.ts'
import type { StableInstallState } from '../distribution/runtime-install.ts'

/** 세상의 스냅샷. 읽기만 해서 만든다. */
export type SetupState = {
  /**
   * 이 판단이 **어느 실행물 안에서** 나오는가 (C-14 §3.4).
   *
   * `runtime` 이면 지금 도는 것이 곧 설치된 `asc` 다 — 그 사실은 관측할 것이 아니라
   * 이미 아는 것이다. 예전에는 이 축이 없어 `stableRuntime` 의 부재를 "설치 안 됨"으로
   * 읽었고, 그래서 설치된 `asc` 가 자기를 bootstrap이라고 말하며 agent에게 `npx …` 를
   * 돌려줬다 (v0.2.0 registry 관측). 진입점 자체가 이미 답의 일부다.
   */
  entry: 'runtime' | 'bootstrap'
  projectRoot: string
  git: boolean
  /** 이미 붙어 있으면 그 runtime 뿌리. 없으면 안 붙은 것이다. */
  ascRoot?: string
  /**
   * runtime 디렉터리는 있는데 profile.lock을 읽지 못하는 상태 — 붙이다 만 것이다.
   *
   * 이것을 "붙어 있음"으로 읽으면 plan은 `applied`를 답하면서 실패할 `asc proceed`를
   * 다음 행동으로 준다 (SSAFESTA Windows 실측 ASC-2: 파일 잠금이 빈 skeleton만 남긴
   * 경우). 붙이다 만 상태는 붙일 것이 남은 상태다 — repair가 plan에 드러나야 한다.
   */
  attachmentBroken?: boolean
  /** 붙어 있다면 무엇으로 붙었는가. */
  attachedProfile?: string
  /** 사람이 `--profile` 로 지정한 것. */
  requestedProfile?: string
  /** 이 설치본이 아는 Profile 후보. */
  profileCandidates: readonly string[]
  /** 채택 범위. 기본은 개인이다 (C-11 §2). */
  scope: 'local' | 'project'
  /** Host 설치 상태 — L-5 판정을 그대로 쓴다. */
  host: { id: string; status: string }[]
  /**
   * 이 machine에 stable `asc` 가 있는가 (C-14 §3).
   *
   * **bootstrap이 들고 온 임시 runtime과 다른 축이다** — 없으면 이 축을 그리지 않고,
   * 그때는 설치된 `asc` 를 전제하지 않는다.
   */
  stableRuntime?: StableInstallState
  /**
   * 이 기계의 지속 등록 상태 (설계 §6, Gate 7).
   *
   * **별도 onboarding 을 만들지 않는다.** 사용자가 `runtime enable` 을 따로 치게 하면
   * 그것이 곧 "켜는 행위"가 되고, 이 제품이 없애려던 바로 그 단계다. 같은 plan 이
   * runtime·host·workspace 와 함께 판단한다.
   */
  persistentRuntime?: { action: 'none' | 'install' | 'unsupported'; adapter: string; detail?: string }
  /**
   * Profile 이 선언한 작업 항목 결합의 준비 상태 (설계 §9.3).
   *
   * **선언은 이미 내려진 결정이다.** 그런데 그 도구가 준비되지 않았다는 이유로 setup 이
   * 사람에게 "그 도구를 설정할까요?"라고 되물으면, 사람은 자기가 이미 적어 둔 것을 다시
   * 답하게 된다. 고칠 수 있는 것은 고치고, 사람만 할 수 있는 것에서만 멈춘다.
   */
  workBinding?: {
    adapter: string
    resource: string
    /** 지금 쓸 수 있는가. 쓸 수 있으면 아래 값들은 보지 않는다. */
    ready: boolean
    /** 고칠 수 있는가, 사람이 해야 하는가, 다시 돌려도 소용없는가. */
    remedy?: 'SELF_HEAL' | 'HUMAN' | 'HARD'
    detail?: string
    /** 그 도구가 말한 자기 버전. 없으면 부를 수 없다 — 버전을 지어내지 않는다. */
    version?: string
  }
}

export type SetupChange =
  /**
   * 이 machine에 stable `asc` 를 놓는다 (C-14 §3.1).
   *
   * **설치도 plan에 드러나는 mutation이다** — bootstrap이 몰래 하지 않는다 (불변식 ⑩).
   */
  | { target: 'runtime-install'; package: string; version: string; strategy: 'npm-global'; from: string }
  /** 이 checkout에 runtime을 붙인다. local scope면 저장소에는 아무것도 만들지 않는다. */
  | { target: 'attach-workspace'; scope: 'local' | 'project'; profile: string }
  /** Host 설치물을 지금 source에 맞춘다. 왜 필요한지까지 든다. */
  | { target: 'host-install'; host: string; from: string }
  /**
   * Profile 이 선언한 작업 도구를 **그 도구의 공식 setup 으로** 되살린다 (설계 §9.3).
   *
   * ASC 가 그 도구의 설정을 손으로 조립하지 않는다 — 부르기만 한다.
   */
  | { target: 'work-binding-setup'; adapter: string; resource: string; version: string }
  /**
   * 이 기계에 ASC runtime 을 등록한다 (설계 §4).
   *
   * **workspace 마다가 아니라 기계당 하나다.** 그래서 이 변경은 프로젝트와 무관하고,
   * 붙는 것과 같은 계획에 함께 실린다.
   */
  | { target: 'persistent-runtime'; adapter: string }

export type SetupStatus = 'already_configured' | 'ready_to_apply' | 'user_action_required'

export type SetupCode =
  /** 후보가 여럿이거나 없다 — 고르는 것은 사람이다 (C-06 §2). */
  | 'ASC_PROFILE_SELECTION_REQUIRED'
  /** 저장소에 두는 것은 팀의 결정이다 (C-11 불변식 ⑤). */
  | 'ASC_PROJECT_SCOPE_REQUIRES_CONSENT'
  /** 설치물을 사람이 고쳤다 — 덮는 것은 사람이 정한다 (L-5). */
  | 'ASC_HOST_INSTALL_MODIFIED'
  /**
   * 작업 도구가 사람을 기다린다 — 자격 입력처럼 ASC 가 대신할 수 없는 것 (설계 §9.4).
   * ASC 는 토큰을 받지도 저장하지도 않는다.
   */
  | 'ASC_WORK_BINDING_NEEDS_USER'

/**
 * 다음에 할 일 하나. **두 형태를 함께 든다** (C-14 §3.4, 불변식 ⑯).
 *
 * `display` 는 사람이 읽는 짧은 형태이고, `portable` 은 **지금 이 machine 상태에서
 * 그대로 실행되는** 형태다. runtime이 아직 없으면 둘이 다르고, 설치된 뒤에는 같다.
 * agent는 `portable` 만 실행하면 되고, 산문을 읽을 필요가 없다.
 */
export type NextAction = {
  type: 'select_profile' | 'adopt_profile' | 'install_runtime' | 'apply_setup' | 'proceed' | 'force_host_install'
  display: string
  portable: string
}

export type SetupPlan = {
  status: SetupStatus
  code?: SetupCode
  /** apply가 할 일. 여기 없는 변경은 일어나지 않는다 (C-14 불변식 ⑩). */
  changes: SetupChange[]
  requiresUserAction: boolean
  /** 사람이 골라야 할 때 무엇 중에서 고르는가. 대신 고르지 않는다. */
  profiles?: readonly string[]
  /**
   * 명령 문자열. **설치 이전에는 `asc …` 를 전제하지 않는다** — 아래 `actions` 의
   * `portable` 과 같은 값이다. 기존 소비자를 위해 유지한다.
   */
  nextActions: string[]
  /** 같은 것을 두 형태로. agent는 `portable`, 사람은 `display`. */
  actions: NextAction[]
  /** 지금 명령을 어디서 실행하고 있는가 — 설치 전이면 bootstrap이다. */
  executionMode: 'bootstrap' | 'installed-runtime'
  /** 왜 이 판정인가. 산문이 아니라 사실이다. */
  evidence: string[]
}

/**
 * 무엇을 바꿀 것인가. **아무것도 바꾸지 않는다.**
 *
 * 사람이 답해야 하는 것(profile 선택·project 채택·설치물 수정)은 여기서 멈춘다 —
 * agent라고 해서 대신 추측하지 않는다 (C-13 · C-14 §7.1).
 */
export function computeSetupPlan(state: SetupState): SetupPlan {
  const evidence: string[] = [
    `project=${state.projectRoot}`,
    state.git ? 'git=yes' : 'git=no',
    state.ascRoot
      ? `attached=${state.ascRoot}${state.attachmentBroken ? ' (BROKEN — profile.lock unreadable)' : ''}`
      : 'attached=no',
    `scope=${state.scope}`,
  ]

  // 지금 명령이 어디서 도는가. 설치된 `asc` 가 없으면 bootstrap이고, 그때 agent에게
  // `asc …` 를 실행하라고 주면 안 된다 (C-14 §3.4 · 불변식 ⑯).
  //
  // **진입점이 먼저다.** `asc` 로 들어왔다면 그 `asc` 는 이미 이 machine에 있다 — 그것을
  // npm에게 물어볼 이유가 없다. bootstrap으로 들어왔을 때만 설치 축이 판정에 쓰인다.
  const mode: SetupPlan['executionMode'] =
    state.entry === 'runtime' || state.stableRuntime?.status === 'CURRENT'
      ? 'installed-runtime'
      : 'bootstrap'
  const command = (args: readonly string[]): { display: string; portable: string } => {
    // portable은 **agent가 그대로 실행하는 것**이므로 기계가 읽을 수 있는 형태로 끝나야
    // 한다. `--json` 이 빠져 있으면 agent는 자기가 실행한 명령의 답을 산문으로 받는다 —
    // "산문을 파싱하지 마라"고 적어 놓고 산문을 주는 꼴이었다. display는 사람 형태 그대로.
    const machine = args.includes('--json') ? args : [...args, '--json']
    return {
      display: shorthandCommand(args),
      portable: mode === 'installed-runtime' ? shorthandCommand(machine) : portableCommand(machine),
    }
  }

  const changes: SetupChange[] = []

  // stable runtime은 **프로젝트와도, profile 선택과도 무관하다.** 사람이 profile을
  // 고르는 중이어도 이 설치는 안전한 준비이고, 그것 때문에 통째로 WAIT 하지 않는다
  // (C-13 dependency-local progress와 같은 태도).
  if (state.stableRuntime) {
    const runtime = state.stableRuntime
    evidence.push(`runtime=${runtime.status}${runtime.installedVersion ? ` (${runtime.installedVersion})` : ''}`)
    if (runtime.status !== 'CURRENT') {
      changes.push({
        target: 'runtime-install',
        package: RUNTIME_PACKAGE,
        version: runtime.expectedVersion,
        strategy: 'npm-global',
        from: runtime.status,
      })
    }
  }

  // Host는 붙어 있든 아니든 판정할 수 있다 — user-owned이고 프로젝트와 무관하다.
  for (const host of state.host) {
    if (host.status === 'INSTALLED_MODIFIED') {
      evidence.push(`host:${host.id}=${host.status}`)
      return {
        status: 'user_action_required',
        code: 'ASC_HOST_INSTALL_MODIFIED',
        // 사람이 고친 것을 덮는 것은 사람이 정한다 — plan에 담아 몰래 적용하지 않는다.
        // 다만 runtime 설치처럼 이 결정과 무관한 준비는 계획에 남는다.
        changes,
        requiresUserAction: true,
        ...actions(mode, evidence, [
          { type: 'force_host_install', ...command(['host', host.id, 'install', '--force']) },
        ]),
      }
    }
    if (host.status !== 'INSTALLED_CURRENT') {
      evidence.push(`host:${host.id}=${host.status}`)
      changes.push({ target: 'host-install', host: host.id, from: host.status })
    }
  }

  // 이 기계의 지속 등록. 프로젝트와 무관하므로 profile 선택을 기다리지 않는다 —
  // stable runtime 설치와 같은 자리다.
  if (state.persistentRuntime) {
    const persistent = state.persistentRuntime
    evidence.push(`persistent=${persistent.action} (${persistent.adapter})`)
    // 쓸 수 없는 OS 에서는 계획에 담지 않는다. 못 하는 것을 "할 일"로 적지 않는다.
    if (persistent.action === 'install') {
      changes.push({ target: 'persistent-runtime', adapter: persistent.adapter })
    }
  }

  // Profile 이 선언한 작업 도구. **다시 묻지 않는다** — 결정은 이미 Profile 에 있다.
  if (state.workBinding && !state.workBinding.ready) {
    const work = state.workBinding
    evidence.push(`work:${work.adapter}=${work.remedy ?? 'NOT_READY'}`)
    if (work.remedy === 'HUMAN') {
      return {
        status: 'user_action_required',
        code: 'ASC_WORK_BINDING_NEEDS_USER',
        changes,
        requiresUserAction: true,
        ...actions(mode, evidence, [{ type: 'proceed', ...command(['setup', 'status']) }]),
      }
    }
    // 고칠 수 있는 것만 계획에 담는다. HARD 는 담지 않는다 — 다시 돌려도 달라지지 않는다.
    if (work.remedy === 'SELF_HEAL' && work.version) {
      changes.push({
        target: 'work-binding-setup',
        adapter: work.adapter,
        resource: work.resource,
        version: work.version,
      })
    }
  }

  if (state.ascRoot && !state.attachmentBroken) {
    // 붙어 있어도 **무엇을 고를 수 있었는지**는 사실이다. 사용자 소유 Profile을 새로 놓고
    // 계획을 물었을 때 그것이 어디에도 안 보이면, 놓은 사람은 경로를 의심하게 된다.
    if (state.profileCandidates.length > 0) {
      evidence.push(`profile candidates=${state.profileCandidates.join(', ')}`)
    }
    return finish(changes, evidence, state, mode, command)
  }

  // 아직 안 붙었거나, 붙이다 말았다(BROKEN). 무엇으로 붙을지는 사람이 정한다 —
  // BROKEN이면 같은 선택으로 다시 붙이는 것이 repair다.
  const profile = state.requestedProfile ?? soleCandidate(state.profileCandidates)
  if (!profile) {
    evidence.push(`profile candidates=${state.profileCandidates.join(', ') || '(none)'}`)
    return {
      status: 'user_action_required',
      code: 'ASC_PROFILE_SELECTION_REQUIRED',
      changes,
      requiresUserAction: true,
      profiles: state.profileCandidates,
      // 고를 것이 **없을** 수도 있다 — 배포본이 들고 있는 것은 예시뿐이고, 이 프로젝트를
      // 설명하는 Profile은 아직 아무도 만들지 않았다. 그때 "골라라"만 주면 막다른 길이
      // 된다(FAIL 회차에서 agent가 사람에게 되물은 자리). 만드는 길을 함께 든다.
      //
      // 순서는 **지금 무엇이 실제로 길을 여는가**로 정한다. 첫 action이 늘 같으면
      // agent는 첫 줄만 보고 막힌 길로 간다.
      ...actions(
        mode,
        evidence,
        state.profileCandidates.length > 0
          ? [
              { type: 'select_profile', ...command(['setup', 'apply', '--profile', '<id>']) },
              { type: 'adopt_profile', ...command(['profile', 'adopt', '--json']) },
            ]
          : [
              { type: 'adopt_profile', ...command(['profile', 'adopt', '--json']) },
              { type: 'select_profile', ...command(['setup', 'apply', '--profile', '<id>']) },
            ],
      ),
    }
  }

  if (state.scope === 'project') {
    // 저장소 안에 두는 것은 팀의 결정이고, 명시로만 표현된다. 여기서는 확인만 하고
    // 그대로 계획에 담는다 — 사람이 이미 `--scope project` 라고 말했기 때문이다.
    evidence.push('adoption=project (explicit)')
  }

  changes.push({ target: 'attach-workspace', scope: state.scope, profile })
  evidence.push(`profile=${profile}${state.requestedProfile ? ' (given)' : ' (sole candidate)'}`)
  return finish(changes, evidence, state, mode, command)
}

/** 후보가 하나뿐이어도 대신 고르지 않는다 — 여기서 돌려주는 것은 "고를 것이 없다"뿐이다. */
function soleCandidate(candidates: readonly string[]): string | undefined {
  return candidates.length === 1 ? candidates[0] : undefined
}

/**
 * 같은 것을 두 형태로 싣는다. `nextActions` 에는 **portable** 을 넣는다 —
 * 기존 소비자가 그것을 실행 가능한 문자열로 읽고 있고, 설치 전에는 그것만 실제로 돈다.
 */
function actions(
  mode: SetupPlan['executionMode'],
  evidence: string[],
  list: NextAction[],
): Pick<SetupPlan, 'nextActions' | 'actions' | 'executionMode' | 'evidence'> {
  return {
    nextActions: list.map((action) => action.portable),
    actions: list,
    executionMode: mode,
    evidence,
  }
}

function finish(
  changes: SetupChange[],
  evidence: string[],
  state: SetupState,
  mode: SetupPlan['executionMode'],
  command: (args: readonly string[]) => { display: string; portable: string },
): SetupPlan {
  if (changes.length === 0) {
    return {
      status: 'already_configured',
      changes,
      requiresUserAction: false,
      ...actions(
        mode,
        evidence,
        state.ascRoot ? [{ type: 'proceed', ...command(['proceed']) }] : [],
      ),
    }
  }
  return {
    status: 'ready_to_apply',
    changes,
    requiresUserAction: false,
    ...actions(mode, evidence, [{ type: 'apply_setup', ...command(['setup', 'apply']) }]),
  }
}

/** apply가 실제로 부를 것들. Core는 무엇이 그것을 하는지 모른다. */
export type SetupEffects = {
  installRuntime(change: Extract<SetupChange, { target: 'runtime-install' }>): Promise<void>
  attachWorkspace(change: Extract<SetupChange, { target: 'attach-workspace' }>): Promise<void>
  installHost(change: Extract<SetupChange, { target: 'host-install' }>): Promise<void>
  /** 작업 도구의 공식 setup 을 부른다. ASC 가 그 설정을 조립하지 않는다. */
  setupWorkBinding?(change: Extract<SetupChange, { target: 'work-binding-setup' }>): Promise<void>
  /** 이 기계에 runtime 을 등록한다. OS 별 형식은 adapter 뒤에 있다. */
  registerPersistentRuntime?(change: Extract<SetupChange, { target: 'persistent-runtime' }>): Promise<void>
}

export type ApplyResult = {
  applied: SetupChange[]
  changesApplied: boolean
}

/**
 * plan에 적힌 것만 실행한다. **다시 판단하지 않는다** (C-14 불변식 ⑩).
 *
 * 여기서 상태를 다시 보고 마음을 바꾸면, 사람이 승인한 plan과 실제로 일어난 일이
 * 달라진다. 그 순간 plan은 아무것도 보장하지 않는 문서가 된다.
 */
export async function applySetupPlan(plan: SetupPlan, effects: SetupEffects): Promise<ApplyResult> {
  const applied: SetupChange[] = []
  for (const change of plan.changes) {
    switch (change.target) {
      case 'runtime-install':
        await effects.installRuntime(change)
        break
      case 'attach-workspace':
        await effects.attachWorkspace(change)
        break
      case 'host-install':
        await effects.installHost(change)
        break
      case 'persistent-runtime':
        // 이 갈래를 모르는 호출자에게는 이 변경이 없던 것으로 남는다.
        if (!effects.registerPersistentRuntime) continue
        await effects.registerPersistentRuntime(change)
        break
      case 'work-binding-setup':
        // 이 갈래를 모르는 호출자에게는 이 변경이 없던 것으로 남는다 —
        // 안 한 것을 "했다"로 적지 않는다.
        if (!effects.setupWorkBinding) continue
        await effects.setupWorkBinding(change)
        break
    }
    applied.push(change)
  }
  return { applied, changesApplied: applied.length > 0 }
}

/** 사람이 읽는 줄. 같은 plan에서 나온다 — agent가 보는 JSON과 다른 판단이 아니다. */
export function renderSetupPlan(plan: SetupPlan): string[] {
  const lines = [`Status: ${plan.status}${plan.code ? ` (${plan.code})` : ''}`]
  if (plan.changes.length === 0) lines.push('  nothing to change')
  for (const change of plan.changes) {
    lines.push(changeLine(change))
  }
  if (plan.profiles && plan.profiles.length > 0) lines.push(`  choose one: ${plan.profiles.join(', ')}`)
  else if (plan.profiles) lines.push('  nothing to choose — this installation has no profile candidates')
  // 사람에게는 짧은 형태를 보인다. agent가 실행하는 것은 `actions[].portable` 이다.
  if (plan.actions.length > 0) lines.push(`  next: ${plan.actions.map((a) => a.display).join(' · ')}`)
  return lines
}

function changeLine(change: SetupChange): string {
  switch (change.target) {
    case 'runtime-install':
      return `  install ${change.package}@${change.version} globally (currently ${change.from})`
    case 'attach-workspace':
      return `  attach: ${change.profile} · scope ${change.scope}`
    case 'host-install':
      return `  converge host installation: ${change.host} (currently ${change.from})`
    case 'work-binding-setup':
      return `  repair ${change.adapter} for ${change.resource} through its own setup (${change.version})`
    case 'persistent-runtime':
      return `  register this machine's ASC runtime with ${change.adapter}`
  }
}
