// Derived Execution State — 외부 도구의 상태가 아니라 실행의 상태 (C-10 §7).
//
// 외부 작업 추적기가 `진행 중` 이라고 말한다고 지금 착수할 수 있는 것이 아니다. 자격이 없을 수도,
// 정본이 흔들렸을 수도, 앞선 일이 안 끝났을 수도 있다. **외부 work tracker의 상태는
// 입력 증거일 뿐 실행 상태의 정본이 아니다** (불변식 ⑭).
//
// 그래서 저장하지 않고 파생한다. Session·Request 상태 enum은 동결이고(OM §11.2),
// 여기서 만드는 것은 **읽을 때 계산되는 뷰**다 (불변식 ⑮). 같은 증거에서는 같은 값이
// 나와야 한다 — 결정성이 없으면 "어제는 Ready였는데"가 설명되지 않는다.

export const EXECUTION_STATES = ['Ready', 'Conditional', 'Waiting', 'Blocked', 'Done'] as const
export type ExecutionState = (typeof EXECUTION_STATES)[number]

/**
 * 파생의 입력. **아는 것만 넣는다** — 모르는 항목은 `undefined` 이고, 그것은 `false` 와
 * 다르다. 모르는 것을 안 된다로 읽으면 멀쩡한 일이 Blocked가 된다.
 */
export type ExecutionFacts = {
  /** 필수 전제가 깨졌다. 이유가 있어야 한다 — 이유 없는 Blocked는 진단이 아니다. */
  blockers?: readonly string[]
  /** 외부 결정·이벤트·자격을 기다린다. */
  waitingOn?: readonly string[]
  /** 제한된 범위에서는 갈 수 있다. 무엇이 제한인지 적는다. */
  conditions?: readonly string[]
  /** 선언한 완료 조건. 비어 있으면 Done을 말할 근거가 없다. */
  doneCriteria?: readonly string[]
  /** 그중 충족된 것. */
  metCriteria?: readonly string[]
  /** 요구된 검증이 끝났는가. 요구가 없으면 undefined. */
  verificationPassed?: boolean
  /** 외부 도구가 말하는 상태. **증거일 뿐 결론이 아니다.** */
  externalState?: string
}

export type ExecutionVerdict = {
  state: ExecutionState
  /** 왜 그 상태인가. 상태만 주면 사람이 무엇을 해야 할지 모른다. */
  reasons: string[]
  /** 판정에 쓰이지 않은 외부 상태. 있는 그대로 옮긴다. */
  externalState?: string
}

/**
 * 지금 이 일이 어디 있는가.
 *
 * 순서가 곧 우선순위다. 막힌 것이 먼저고, 기다리는 것이 그다음이며, Done은 **근거가
 * 다 찼을 때만** 나온다 — 완료를 쉽게 말하는 것이 가장 비싼 오판이다.
 */
export function deriveExecutionState(facts: ExecutionFacts): ExecutionVerdict {
  const reasons: string[] = []
  const external = facts.externalState ? { externalState: facts.externalState } : {}

  if (facts.blockers && facts.blockers.length > 0) {
    return { state: 'Blocked', reasons: facts.blockers.map((b) => `blocked: ${b}`), ...external }
  }

  // Done은 선언한 조건이 있고, 그것이 다 찼고, 요구된 검증이 통과했을 때만이다.
  const criteria = facts.doneCriteria ?? []
  const met = new Set(facts.metCriteria ?? [])
  const unmet = criteria.filter((item) => !met.has(item))
  if (criteria.length > 0 && unmet.length === 0) {
    if (facts.verificationPassed === false) {
      return { state: 'Waiting', reasons: ['criteria are met but verification has not passed'], ...external }
    }
    if (facts.verificationPassed === undefined && facts.waitingOn && facts.waitingOn.length > 0) {
      return { state: 'Waiting', reasons: facts.waitingOn.map((w) => `waiting on: ${w}`), ...external }
    }
    return {
      state: 'Done',
      reasons: [
        `${criteria.length} done-criteria met`,
        ...(facts.verificationPassed ? ['required verification passed'] : ['no verification required']),
      ],
      ...external,
    }
  }

  // 기다리는 것이 있어도 **갈 수 있는 것이 남아 있으면 멈춘 게 아니다** (C-13 §6).
  // 이 둘을 합쳐 Waiting으로 읽으면 외부 대기 하나가 전체를 세운 것처럼 보인다.
  if (facts.waitingOn && facts.waitingOn.length > 0 && facts.conditions && facts.conditions.length > 0) {
    return {
      state: 'Conditional',
      reasons: [...facts.conditions.map((c) => `limit: ${c}`), ...facts.waitingOn.map((w) => `waiting on: ${w}`)],
      ...external,
    }
  }

  if (facts.waitingOn && facts.waitingOn.length > 0) {
    return { state: 'Waiting', reasons: facts.waitingOn.map((w) => `waiting on: ${w}`), ...external }
  }

  if (facts.conditions && facts.conditions.length > 0) {
    return {
      state: 'Conditional',
      reasons: facts.conditions.map((c) => `limit: ${c}`),
      ...external,
    }
  }

  if (unmet.length > 0) reasons.push(`${unmet.length} done-criteria remaining`)
  reasons.push('nothing blocking, nothing to wait on')
  return { state: 'Ready', reasons, ...external }
}

/**
 * 사람이 읽는 줄.
 *
 * 외부 상태를 **함께 보이되 결론과 섞지 않는다** — 같은 줄에 두면 "저쪽 도구가 그렇다니까"로
 * 읽히고, 그게 이 모듈이 막으려는 것이다.
 */
export function executionLine(verdict: ExecutionVerdict, label = 'Execution state'): string[] {
  const lines = [`${label}: ${verdict.state}`]
  for (const reason of verdict.reasons) lines.push(`  ${reason}`)
  if (verdict.externalState) {
    lines.push(`  (external tool says: ${verdict.externalState} — evidence, not the basis of this verdict)`)
  }
  return lines
}
