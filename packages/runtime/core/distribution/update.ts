// Update — 갈아 끼우되, 돌던 것을 잃지 않는다 (C-14 §3 의 연장).
//
// 이 파일이 있는 이유는 실측이다. 한 라운드에 설치본을 다섯 번 갈아 끼웠고, 매번 사람이
// 이런 것을 손으로 했다:
//
//   npm uninstall -g …          구본을 먼저 지운다 — 실패하면 아무것도 안 남는 순서다
//   rm -rf ~/.npm/_npx/*        캐시를 지운다
//   setup apply 를 다시 실행     profile·binding·정본을 **다시 추론**한다
//
// 마지막 것이 가장 나쁘다. 업데이트는 설정을 다시 정하는 행위가 아니다. 이미 정해진 것
// 위에서 실행본만 바꾸는 일이고, 그래서 순서가 정해져 있다:
//
//   놓는다 → 선 것을 확인한다 → 갈아 끼운다 → 다시 확인한다
//
// 지우는 단계는 없다. npm 전역 설치는 같은 자리를 덮으므로 치울 구본이 없고, 치울 것이
// 있다고 적으면 그 단계는 언젠가 지우지 말아야 할 것을 지운다.
//
// **모르는 것을 최신으로 읽지 않는다.** registry 를 못 물었을 때 "최신입니다" 라고 답하면
// 그 답이 곧 사람이 업데이트를 건너뛰는 근거가 된다.

import { majorOf, MINIMUM_NODE_MAJOR, type NodeCandidate } from './node-runtime.ts'

export type UpdateState =
  /** 설치본이 registry 의 최신과 같다. */
  | 'CURRENT'
  | 'UPDATE_AVAILABLE'
  /** 대상이 요구하는 Node 가 이 기계에 없다 — 설치하지 않는다. */
  | 'INCOMPATIBLE'
  /** 설치는 돼 있는데 실행물이 보이지 않는다. 새 것을 얹기 전에 그 사실을 말한다. */
  | 'BROKEN'
  /** registry 를 물어보지 못했다. **아무 주장도 하지 않는다.** */
  | 'UNKNOWN'

/**
 * 실행 순서. **지우는 단계가 없다** — 위 주석의 이유다.
 */
export type UpdateStep =
  | 'install'
  | 'verify-install'
  /** 버전마다 skill·hook 내용이 바뀐다. 새 runtime 에 낡은 hook 을 남기지 않는다. */
  | 'refresh-host'
  /** 등록물이 낡았으면 지금 형태로 수렴시킨다. 기존 STALE→수렴 경로를 그대로 쓴다. */
  | 'converge-service'
  | 'verify-health'

export const UPDATE_ORDER: readonly UpdateStep[] = [
  'install',
  'verify-install',
  'refresh-host',
  'converge-service',
  'verify-health',
]

export type UpdateInput = {
  /** 전역에 실제로 있는 버전. 없으면 설치된 적이 없다. */
  installed?: string
  /** 그 실행물이 이 프로세스에서 보이는가. */
  executableVisible: boolean
  /** registry 가 말한 최신. 못 물었으면 없다 — 그때는 아무 판정도 하지 않는다. */
  latest?: string
  /** 대상이 요구하는 Node 하한. 모르면 이 build 의 하한을 쓴다. */
  requiredNodeMajor?: number
  /** 지금 이 프로세스의 Node 버전. */
  nodeVersion: string
  /** 이 기계에서 찾은 다른 Node 들. 지금 것이 낮을 때만 본다. */
  nodeCandidates?: readonly NodeCandidate[]
}

export type UpdatePlan = {
  state: UpdateState
  from?: string
  to?: string
  /** 할 일. `INCOMPATIBLE`·`UNKNOWN`·`CURRENT` 에서는 비어 있다. */
  steps: readonly UpdateStep[]
  /**
   * 되돌릴 대상. **설치되어 있던 버전이 있을 때만** 채운다 — 없던 것으로 되돌릴 수는 없다.
   */
  rollbackTo?: string
  detail?: string
}

/** 이 기계가 그 Node 하한을 만족하는가. 지금 것이 낮으면 다른 후보를 본다. */
function nodeSatisfies(input: UpdateInput, required: number): boolean {
  const current = majorOf(input.nodeVersion)
  if (current !== null && current >= required) return true
  return (input.nodeCandidates ?? []).some((candidate) => {
    const major = majorOf(candidate.version)
    return major !== null && major >= required
  })
}

/**
 * 무엇을 할 것인가. **아무것도 하지 않는다** — 사실은 호출자가 관측해 넘긴다.
 */
export function planUpdate(input: UpdateInput): UpdatePlan {
  if (!input.latest) {
    return {
      state: 'UNKNOWN',
      steps: [],
      ...(input.installed ? { from: input.installed } : {}),
      detail: 'the registry could not be asked — nothing is claimed about being up to date',
    }
  }

  const required = input.requiredNodeMajor ?? MINIMUM_NODE_MAJOR
  if (!nodeSatisfies(input, required)) {
    return {
      state: 'INCOMPATIBLE',
      ...(input.installed ? { from: input.installed } : {}),
      to: input.latest,
      steps: [],
      detail: `${input.latest} needs Node ${required} or newer, and this machine has none — nothing was installed`,
    }
  }

  // 설치는 됐는데 부를 수 없다. 새 것을 얹으면 그 사실이 덮이므로 먼저 말한다.
  if (input.installed && !input.executableVisible) {
    return {
      state: 'BROKEN',
      from: input.installed,
      to: input.latest,
      steps: [...UPDATE_ORDER],
      rollbackTo: input.installed,
      detail: `${input.installed} is installed but its executable is not visible — updating will reinstall it`,
    }
  }

  if (input.installed === input.latest) {
    return { state: 'CURRENT', from: input.installed, to: input.latest, steps: [] }
  }

  return {
    state: 'UPDATE_AVAILABLE',
    ...(input.installed ? { from: input.installed, rollbackTo: input.installed } : {}),
    to: input.latest,
    steps: [...UPDATE_ORDER],
  }
}

/** 사람이 읽는 한 줄. 왜 그 판정인지가 함께 와야 한다. */
export function updateLine(plan: UpdatePlan): string {
  switch (plan.state) {
    case 'CURRENT':
      return `Up to date — ${plan.to}`
    case 'UPDATE_AVAILABLE':
      return plan.from ? `Update available — ${plan.from} → ${plan.to}` : `Not installed — ${plan.to} is available`
    case 'INCOMPATIBLE':
    case 'UNKNOWN':
    case 'BROKEN':
      return `${plan.state}: ${plan.detail ?? '(no detail)'}`
  }
}

/**
 * `engines.node` 가 말하는 하한. `">=24"` · `">=24.0.0 <27"` 같은 형태를 읽는다.
 *
 * **못 읽으면 `undefined` 다** — 0 으로 뭉개면 아무 Node 나 통과하고, 큰 수로 뭉개면
 * 멀쩡한 기계가 INCOMPATIBLE 이 된다. 모르는 것은 모른다고 하고 호출자가 이 build 의
 * 하한을 쓴다.
 */
export function requiredMajorFrom(engines: string | undefined): number | undefined {
  if (!engines) return undefined
  const match = /(\d+)/.exec(engines.replace(/^[^\d]*/, ''))
  return match ? Number(match[1]) : undefined
}
