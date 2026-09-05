// Persistent Runtime Port — 사용자가 켜지 않아도 도는 자리 (설계 §4·§5).
//
// C-12 는 상시성을 "상태를 지속시키고 계산을 짧게 돌리는 것"으로 정의했고, 불변식 ④ 는
// **Core 에 scheduler 제품을 박지 말라**고 했다. 그 둘을 함께 지키는 방법은 하나다:
// Core 는 "무엇을 등록해야 하는가"만 말하고, launchd·Task Scheduler·systemd 는 그 말을
// 자기 형식으로 옮기는 adapter 뒤에 둔다.
//
//   Core        이 기계에 ASC runtime 하나가 등록돼 있어야 한다
//   Adapter     그것을 이 OS 에서 어떻게 표현하는가
//
// **workspace 마다 하나가 아니다.** 사용자/기계당 하나이고, 그 하나가 여러 workspace 를
// 돌본다 (설계 §4.1) — workspace 가 늘 때마다 OS 서비스가 늘면 그것은 제품이 아니라 짐이다.
//
// root daemon 으로 올리지 않는다. 사용자 로그인 이후가 이 계약의 경계다 (설계 §4.3).

/** 이 기계에서 ASC 가 소유하는 등록물 하나. 이름이 곧 소유권 증거다. */
export const SERVICE_LABEL = 'com.asc-agent.runtime'

/**
 * 등록물이 실행할 명령.
 *
 * **한 회차만 돈다** (`runtime tick`). 계속 도는 프로세스를 등록하지 않는 이유는 셋이다:
 * OS 가 이미 주기를 관리할 줄 알고, 죽었을 때 되살리는 것도 OS 가 더 잘하며, 짧게 도는
 * 프로세스는 죽어 있는 동안 자원을 쓰지 않는다.
 */
export type ServiceCommand = {
  /** 실행 파일. 보통 지금 도는 node. */
  program: string
  /** 인자. 첫 항목이 ASC 진입점이다. */
  args: readonly string[]
  /** 회차 간격(초). Core 상수가 아니다 — 호출자가 정한다 (C-12 불변식 ③). */
  intervalSeconds: number
}

/** 지금 이 기계의 등록 상태. */
export type ServiceState =
  /** 등록된 적이 없다. */
  | { kind: 'ABSENT' }
  /** 지금 우리가 쓰려는 것과 같다. */
  | { kind: 'CURRENT'; detail?: string }
  /** 우리 것인데 낡았다 — 경로나 간격이 달라졌다. 수렴시킨다. */
  | { kind: 'STALE'; detail: string }
  /** 이 OS 에서는 등록할 방법을 모른다. 없는 것을 있는 척하지 않는다. */
  | { kind: 'UNSUPPORTED'; detail: string }

/**
 * OS 하나가 지켜야 할 계약.
 *
 * `uninstall` 은 **ASC 가 소유한 등록물만** 지운다. 사람이 만든 같은 이름의 무언가가
 * 있으면 그것은 사람의 것이다 (C-03 §5.1 의 소유권 규칙과 같은 선).
 */
export type PersistentRuntimeAdapter = {
  id: 'launchd' | 'schtasks' | 'systemd-user'
  /** 이 기계에서 쓸 수 있는가. 쓸 수 없으면 install 을 시도하지 않는다. */
  supported(): Promise<boolean>
  status(command: ServiceCommand): Promise<ServiceState>
  install(command: ServiceCommand): Promise<void>
  uninstall(): Promise<void>
}

/**
 * 무엇을 해야 하는가 — **아무것도 하지 않는다.**
 *
 * setup 의 detect→plan→apply 와 같은 모양이다: 판정과 실행을 나누고, 계획에 없는 것은
 * 일어나지 않는다 (C-14 불변식 ⑩).
 */
export type PersistentRuntimePlan =
  | { action: 'none'; state: ServiceState }
  | { action: 'install'; state: ServiceState }
  | { action: 'unsupported'; state: Extract<ServiceState, { kind: 'UNSUPPORTED' }> }

export async function planPersistentRuntime(
  adapter: PersistentRuntimeAdapter,
  command: ServiceCommand,
): Promise<PersistentRuntimePlan> {
  if (!(await adapter.supported())) {
    return {
      action: 'unsupported',
      state: { kind: 'UNSUPPORTED', detail: `${adapter.id} is not usable on this machine` },
    }
  }
  const state = await adapter.status(command)
  switch (state.kind) {
    case 'CURRENT':
      return { action: 'none', state }
    case 'UNSUPPORTED':
      return { action: 'unsupported', state }
    // 없는 것과 낡은 것은 다른 사실이지만 할 일은 같다 — 지금 형태로 수렴시킨다.
    case 'ABSENT':
    case 'STALE':
      return { action: 'install', state }
  }
}

/** 사람이 읽는 한 줄. 왜 그 판정인지가 함께 와야 한다. */
export function persistentRuntimeLine(id: string, plan: PersistentRuntimePlan): string {
  switch (plan.action) {
    case 'none':
      return `Persistent runtime: registered with ${id}${plan.state.kind === 'CURRENT' && plan.state.detail ? ` (${plan.state.detail})` : ''}`
    case 'install':
      return plan.state.kind === 'STALE'
        ? `Persistent runtime: registration is behind — ${plan.state.detail}`
        : `Persistent runtime: not registered yet`
    case 'unsupported':
      // 못 하는 것을 "안 해도 된다"로 적지 않는다
      return `Persistent runtime: this machine has no user-scope service manager ASC knows — ${plan.state.detail}`
  }
}
