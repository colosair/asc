// Ownership Map — 누가 어디를 쓰고 무엇을 결정하는가의 선언 (C-04 §6).
//
// 여기는 **선언을 읽는 곳**이지 판정하는 곳이 아니다. "이 세션을 막을 것인가"는 발급과
// preflight가 정하고, 이 모듈은 Profile이 뭐라고 적었는지만 돌려준다.
//
// 결정권자가 갈리는 경우를 조용히 하나로 좁히지 않는다. 두 역할이 같은 결정을 자기
// 것이라 적었다면 그건 프로젝트가 아직 정하지 않았다는 뜻이고, 그 사실이 답이다 —
// 이름이 비슷하다는 이유로 하나를 고르면 사람은 그 선택을 영영 보지 못한다.

import { isWithinScopes } from './scope.ts'

/** decision domain 이름 문법. 소문자 kebab-case — 문서·CLI·JSON에서 같은 모양으로 읽힌다. */
export const DECISION_DOMAIN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type OwnershipSpec = {
  /** 이 역할의 쓰기 영역. 결정만 하는 역할(product 등)은 비어 있을 수 있다. */
  paths: string[]
  /** 이 역할이 최종 결정권을 갖는 decision domain 목록. */
  authorities: string[]
}

export type OwnershipMap = Record<string, OwnershipSpec>

export type AuthorityLookup =
  | { kind: 'RESOLVED'; role: string }
  /** 아무도 자기 것이라 적지 않았다. */
  | { kind: 'UNDECLARED' }
  /** 둘 이상이 자기 것이라 적었다. 고르지 않는다 — 후보를 그대로 돌려준다. */
  | { kind: 'AMBIGUOUS'; candidates: string[] }

/** 이 decision domain의 결정권자는 누구인가. */
export function lookupAuthority(map: OwnershipMap | undefined, domain: string): AuthorityLookup {
  const candidates = Object.entries(map ?? {})
    .filter(([, spec]) => spec.authorities.includes(domain))
    .map(([role]) => role)
    .sort()

  if (candidates.length === 0) return { kind: 'UNDECLARED' }
  if (candidates.length > 1) return { kind: 'AMBIGUOUS', candidates }
  return { kind: 'RESOLVED', role: candidates[0]! }
}

/** 선언된 decision domain 전체. 정렬해 돌려주므로 렌더 순서가 흔들리지 않는다. */
export function decisionDomains(map: OwnershipMap | undefined): string[] {
  return [...new Set(Object.values(map ?? {}).flatMap((spec) => spec.authorities))].sort()
}

export type OwnerLookup =
  | { kind: 'RESOLVED'; role: string }
  /** 쓰기 범위를 통째로 품는 역할이 없다. 두 파트에 걸쳐 있거나 지도 밖이다. */
  | { kind: 'UNDECLARED' }
  | { kind: 'AMBIGUOUS'; candidates: string[] }

/**
 * 이 쓰기 범위는 누구 영역인가. **전부**를 품는 역할만 후보다 — 일부만 품는 역할을
 * owner로 세우면 나머지 경로가 남의 영역인 채로 세션이 굴러간다.
 *
 * 범위가 비어 있으면(쓰지 않는 세션) 판정하지 않는다. 아무 역할이나 답이 되기 때문이다.
 */
export function lookupOwnerByPaths(
  map: OwnershipMap | undefined,
  writeBoundary: readonly string[],
): OwnerLookup {
  if (writeBoundary.length === 0) return { kind: 'UNDECLARED' }

  const candidates = Object.entries(map ?? {})
    .filter(([, spec]) => spec.paths.length > 0 && writeBoundary.every((s) => isWithinScopes(s, spec.paths)))
    .map(([role]) => role)
    .sort()

  if (candidates.length === 0) return { kind: 'UNDECLARED' }
  if (candidates.length > 1) return { kind: 'AMBIGUOUS', candidates }
  return { kind: 'RESOLVED', role: candidates[0]! }
}
