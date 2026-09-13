// 이 작업이 가리키는 원격의 신원 (0.8.0 §K · 0.9.1 fail closed).
//
// **deny-list 가 아니다.** 검수가 "이 대상이 우리가 맡은 그 원격인가" 를 묻기 위한 기준점이고,
// 어긋나면 Agent 가 스스로 범위를 넓히는 대신 사람에게 올라간다.
//
// 결합이 여럿이면 고르지 않는다 — 고르는 순간 그것이 곧 조용한 범위 확장이다. 0.9.0 까지는
// 그때 undefined 를 돌려 검수가 기준점 없이 READY 를 냈고, 그것은 "모르는 것을 정상으로 추정"
// 한 것이었다. 0.9.1 부터는 그 상태를 이름 붙여 돌려주고, 호출자(review · publish · grant
// issue)는 진행하지 않는다. Core identity 모델은 건드리지 않는다 — 여기는 CLI 의 판정이다.

export type DeclaredBinding = { readonly adapter: string; readonly resource: string }

export type BindingIdentity =
  | { kind: 'PINNED'; resource: string }
  /** 이 adapter 로 선언된 결합이 없다 — 기준점이 없을 뿐, 검수는 관측된 사실로 계속된다. */
  | { kind: 'NONE' }
  /** 같은 adapter 로 선언된 결합이 둘 이상이다. 고르지 않고, 진행하지도 않는다. */
  | { kind: 'AMBIGUOUS'; adapterId: string; resources: string[] }

export function bindingIdentity(declared: readonly DeclaredBinding[], adapterId: string): BindingIdentity {
  const mine = declared.filter((binding) => binding.adapter === adapterId)
  if (mine.length === 1) return { kind: 'PINNED', resource: mine[0]!.resource }
  if (mine.length === 0) return { kind: 'NONE' }
  return { kind: 'AMBIGUOUS', adapterId, resources: mine.map((binding) => binding.resource) }
}

/** AMBIGUOUS 일 때 사람이 읽는 줄. 관리 실행은 여기서 멈춘다 — 대상을 모르는 채 나가지 않는다. */
export function ambiguousBindingLines(identity: Extract<BindingIdentity, { kind: 'AMBIGUOUS' }>): string[] {
  return [
    `${identity.resources.length} ${identity.adapterId} bindings are declared (${identity.resources.join(', ')}) — the target resource cannot be pinned.`,
    '  ASC does not pick one for you. Narrow the Profile bindings for this adapter to one and re-lock (asc profile resolve --write),',
    '  or wait for explicit multi-binding selection (planned for 0.10.0). Nothing was reviewed or issued.',
  ]
}
