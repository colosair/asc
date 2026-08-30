// Binding 자동 제안 (P1-G).
//
// Profile 은 **팀이 정한 것**을 담는다. 그런데 지금까지는 발견하면 알 수 있는 사실까지
// 거기 적어야 했다 — 원격이 하나뿐이고 그 원격을 다룰 adapter 도 하나뿐인데도, 누가
// bindings 에 적어 주기 전에는 아무 통로가 서지 않았다.
//
// 여기서 하는 일은 그 한 가지뿐이다: **후보가 유일할 때만** 역할을 제안한다. 저장하지
// 않고, Profile 을 고치지 않으며, 둘 이상이면 고르지 않는다 — 고르는 것은 사람의 일이고,
// 틀린 연결은 없는 연결보다 나쁘다.

import type { BindingPlan, Capability, ResolvedBinding } from '../core/binding/types.ts'

export type BindingProposal = {
  /**
   * capability → 이 통로를 맡을 adapter.
   *
   * **조립에 밀어 넣는 값이 아니다.** 후보가 유일하면 capability 해석은 스스로 풀리므로,
   * 여기서 역할을 박으면 선언과 제안이 같은 자리에 섞인다. 이 표는 "무엇이 무엇을 맡게
   * 됐는지"를 사람에게 말하기 위한 것이다.
   */
  roles: Partial<Record<Capability, string>>
  /** 사람이 읽는 근거. 제안이라는 사실을 문장 안에 남긴다. */
  reasons: string[]
  /** 후보가 갈려 제안하지 않은 것들. */
  conflicts: string[]
}

const USABLE = new Set(['AVAILABLE', 'DEGRADED'])

/**
 * 선언이 하나도 없을 때만 부른다. 선언이 있으면 그것이 답이고, 여기서 다시 정하지 않는다.
 */
export function proposeBindings(plan: BindingPlan): BindingProposal {
  const proposal: BindingProposal = { roles: {}, reasons: [], conflicts: [] }
  const usable = plan.bindings.filter((binding) => USABLE.has(binding.state))
  const byCapability = new Map<Capability, ResolvedBinding[]>()

  for (const binding of usable) {
    for (const capability of binding.provides) {
      byCapability.set(capability, [...(byCapability.get(capability) ?? []), binding])
    }
  }

  for (const [capability, candidates] of byCapability) {
    const distinct = new Map(candidates.map((c) => [`${c.adapterId}:${c.resource}`, c]))
    if (distinct.size !== 1) {
      proposal.conflicts.push(
        `${capability}: 후보가 ${distinct.size}개다 (${[...distinct.keys()].join(', ')}) — 어느 쪽인지는 사람이 정한다`,
      )
      continue
    }
    const only = [...distinct.values()][0]!
    const role = only.role ?? only.adapterId
    proposal.roles[capability] = role
    proposal.reasons.push(`${capability} ← ${only.adapterId}:${only.resource} (유일한 후보라 제안한다 — Profile 에 저장하지 않는다)`)
  }

  return proposal
}
