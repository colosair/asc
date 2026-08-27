// Policy Layer — 무엇이 자율이고 무엇이 금지인지, 그리고 계층을 합칠 때의 규칙.
// 정본: OM §5(3등급·상속·DENY 접촉 시 동작), §4.7(merge semantics).
//
// 핵심 불변식 둘:
//  - 하위 계층은 상위보다 넓은 권한을 가질 수 없다. 권한 범위는 lower-wins가 아니라 교집합이다.
//  - HARD DENY는 하위가 해제할 수 없다. Policy Exception으로도, Session Prompt로도 안 된다.

import type { ActorRole } from '../model/entities.ts'
import { isWithinScopes, parseScope, pathInScope } from './scope.ts'

/** OM §5.1. Green/Yellow/Red를 정책 계층으로 승격한 것. */
export type Verdict = 'ALLOW' | 'SOFT_DENY' | 'HARD_DENY'

export type RoleName = Exclude<ActorRole, 'controller'> | 'planner' | 'researcher' | 'implementer' | 'verifier'

/**
 * 한 계층이 기여하는 정책 조각. 계층 순서는 Resolver가 정한다
 * (Vanilla Defaults → Project Profile → Operational Preset → User Local Override).
 */
export type PolicyLayer = {
  id: string
  /** 해제 불가 금지 항목. 하위 계층은 추가만 할 수 있다 (union·immutable). */
  hardDeny?: readonly string[]
  /** 기본 금지. Controller의 Policy Exception으로만 개별 허용된다 (union). */
  softDeny?: readonly string[]
  /**
   * 명시 허용. HARD DENY 항목을 여기 적으면 해제 시도로 보고 resolve를 실패시킨다 —
   * 조용히 무시하면 계약과 실권한이 어긋난 채로 굴러간다.
   */
  allow?: readonly string[]
  /** Role별 최대 쓰기 범위. 하위 계층은 이보다 좁혀야 한다 (intersection). */
  roleScopes?: Partial<Record<RoleName, readonly string[]>>
  /** scalar 설정. `lockedSettings`에 걸린 키는 하위 값이 무시된다. */
  settings?: Readonly<Record<string, string | number | boolean>>
  lockedSettings?: readonly string[]
  /** 하위 값으로 통째 교체되는 목록. */
  replaceLists?: Readonly<Record<string, readonly string[]>>
  /** 상위+하위가 합쳐지는 목록. */
  unionLists?: Readonly<Record<string, readonly string[]>>
  requiredCapabilities?: readonly string[]
  optionalCapabilities?: readonly string[]
}

export type ResolvedPolicy = {
  hardDeny: string[]
  softDeny: string[]
  roleScopes: Partial<Record<RoleName, string[]>>
  settings: Record<string, string | number | boolean>
  lockedSettings: string[]
  lists: Record<string, string[]>
  requiredCapabilities: string[]
  optionalCapabilities: string[]
  /** 어떤 계층이 어떤 순서로 합쳐졌는지 — 재현성 기록(B-10 profile.lock)의 입력이다. */
  layers: string[]
}

export type PolicyViolation = {
  layer: string
  kind: 'HARD_DENY_ESCAPE' | 'SOFT_DENY_ESCAPE' | 'SCOPE_ESCALATION' | 'INVALID_SCOPE' | 'LOCKED_SETTING'
  detail: string
}

// ── merge semantics (OM §4.7) ───────────────────────────────────────────────

/** scalar — 잠기지 않은 키만 하위 값이 이긴다. */
export function mergeScalar<T>(upper: T | undefined, lower: T | undefined, locked: boolean): T | undefined {
  if (locked) return upper ?? lower
  return lower ?? upper
}

/** replace-list — 하위가 있으면 통째로 교체. */
export function mergeReplaceList(upper: readonly string[] = [], lower?: readonly string[]): string[] {
  return [...(lower ?? upper)]
}

/** union-list — 합치고 중복 제거. 순서는 상위 먼저. */
export function mergeUnionList(upper: readonly string[] = [], lower: readonly string[] = []): string[] {
  return [...new Set([...upper, ...lower])]
}

/**
 * permission scope — lower-wins가 아니라 교집합이다.
 * 하위가 상위 범위를 벗어나면 조용히 좁히지 않고 위반으로 보고한다. 조용한 clamp는
 * 계약서에 적힌 범위와 실제 권한이 다른 상태를 만든다 (OM §4.7).
 * 문법 밖 패턴은 판정할 수 없으므로 통과시키지 않고 따로 보고한다.
 */
export function intersectScopes(
  upper: readonly string[] | undefined,
  lower: readonly string[] | undefined,
): { scopes: string[]; escalations: string[]; invalid: string[] } {
  const invalid = [...(lower ?? []), ...(upper ?? [])].filter((pattern) => parseScope(pattern) === null)
  if (!lower) return { scopes: [...(upper ?? [])], escalations: [], invalid }
  if (!upper) return { scopes: [...lower], escalations: [], invalid }

  const valid = lower.filter((pattern) => parseScope(pattern) !== null)
  const escalations = valid.filter((pattern) => !isWithinScopes(pattern, upper))
  return { scopes: valid.filter((pattern) => isWithinScopes(pattern, upper)), escalations, invalid }
}

// ── 계층 병합 ───────────────────────────────────────────────────────────────

/**
 * 상위 → 하위 순으로 받은 계층들을 하나의 정책으로 합친다.
 * 위반(HARD DENY 해제 시도·범위 확장·잠긴 설정 덮어쓰기)은 예외가 아니라 목록으로
 * 돌려준다 — Resolver가 전부 모아 한 번에 보고할 수 있어야 하기 때문이다.
 */
export function mergePolicyLayers(layers: readonly PolicyLayer[]): {
  policy: ResolvedPolicy
  violations: PolicyViolation[]
} {
  const violations: PolicyViolation[] = []
  const policy: ResolvedPolicy = {
    hardDeny: [],
    softDeny: [],
    roleScopes: {},
    settings: {},
    lockedSettings: [],
    lists: {},
    requiredCapabilities: [],
    optionalCapabilities: [],
    layers: [],
  }

  for (const layer of layers) {
    policy.layers.push(layer.id)

    // 금지는 union이며 제거 연산이 없다. 상속된 금지를 allow로 뚫으려는 시도는 위반이다.
    // SOFT DENY도 마찬가지다 — 그 해제는 Controller가 특정 Session에 주는 Policy
    // Exception으로만 일어나고, 구성 계층이 미리 풀어둘 수 있는 것이 아니다 (OM §5.1).
    for (const item of layer.allow ?? []) {
      if (policy.hardDeny.includes(item)) {
        violations.push({
          layer: layer.id,
          kind: 'HARD_DENY_ESCAPE',
          detail: `'${item}' is HARD DENY and cannot be re-allowed by a lower layer`,
        })
      } else if (policy.softDeny.includes(item)) {
        violations.push({
          layer: layer.id,
          kind: 'SOFT_DENY_ESCAPE',
          detail: `'${item}' is SOFT DENY — only a controller policy exception can permit it`,
        })
      }
    }
    policy.hardDeny = mergeUnionList(policy.hardDeny, layer.hardDeny)
    // 상위가 금지하지 않은 항목이라도 하위가 조일 수 있다 — 강화 방향은 언제나 열려 있다.
    policy.softDeny = mergeUnionList(policy.softDeny, layer.softDeny).filter((i) => !policy.hardDeny.includes(i))

    for (const [role, requested] of Object.entries(layer.roleScopes ?? {}) as [RoleName, readonly string[]][]) {
      const { scopes, escalations, invalid } = intersectScopes(policy.roleScopes[role], requested)
      if (escalations.length > 0) {
        violations.push({
          layer: layer.id,
          kind: 'SCOPE_ESCALATION',
          detail: `${role} requested ${escalations.join(', ')} outside the inherited scope`,
        })
      }
      if (invalid.length > 0) {
        violations.push({
          layer: layer.id,
          kind: 'INVALID_SCOPE',
          detail: `${role} scope ${invalid.join(', ')} is not valid ASC scope grammar`,
        })
      }
      policy.roleScopes[role] = scopes
    }

    for (const [key, value] of Object.entries(layer.settings ?? {})) {
      const locked = policy.lockedSettings.includes(key)
      if (locked && policy.settings[key] !== value) {
        violations.push({ layer: layer.id, kind: 'LOCKED_SETTING', detail: `'${key}' is locked by an upper layer` })
      }
      const merged = mergeScalar(policy.settings[key], value, locked)
      if (merged !== undefined) policy.settings[key] = merged
    }
    policy.lockedSettings = mergeUnionList(policy.lockedSettings, layer.lockedSettings)

    for (const [key, values] of Object.entries(layer.replaceLists ?? {})) {
      policy.lists[key] = mergeReplaceList(policy.lists[key], values)
    }
    for (const [key, values] of Object.entries(layer.unionLists ?? {})) {
      policy.lists[key] = mergeUnionList(policy.lists[key], values)
    }

    policy.requiredCapabilities = mergeUnionList(policy.requiredCapabilities, layer.requiredCapabilities)
    policy.optionalCapabilities = mergeUnionList(policy.optionalCapabilities, layer.optionalCapabilities)
  }

  return { policy, violations }
}

// ── 판정 ────────────────────────────────────────────────────────────────────

export type PolicyQuery = {
  /** 'external.write' · 'dependency.add' 같은 행위 키. */
  action: string
  /** 파일을 쓰는 행위면 대상 경로. */
  path?: string
  role?: RoleName
  /** Session Contract가 실제로 허용받은 쓰기 범위 (Profile 범위보다 좁아야 한다). */
  writeBoundary?: readonly string[]
  /**
   * Controller가 이 Session에 한해 허용한 SOFT DENY 항목 (OM §5.1).
   * Execution Grant와는 다른 것이다 — 이건 기존 Session 안의 제한적 허용일 뿐이다.
   */
  policyExceptions?: readonly string[]
}

export type PolicyDecision = { verdict: Verdict; reason: string }

export function evaluate(policy: ResolvedPolicy, query: PolicyQuery): PolicyDecision {
  if (policy.hardDeny.includes(query.action)) {
    // Policy Exception이 있어도 뚫리지 않는다. 외부 write 같은 항목은 별도 Execution
    // Grant라는 다른 계약으로만 수행된다 (OM §5.2).
    return { verdict: 'HARD_DENY', reason: `'${query.action}' is HARD DENY` }
  }

  if (query.path !== undefined) {
    const boundary = query.writeBoundary ?? policy.roleScopes[query.role ?? 'implementer'] ?? []
    if (!pathInScope(query.path, boundary)) {
      return { verdict: 'HARD_DENY', reason: `'${query.path}' is outside the write boundary` }
    }
  }

  if (policy.softDeny.includes(query.action)) {
    if (query.policyExceptions?.includes(query.action)) {
      return { verdict: 'ALLOW', reason: `'${query.action}' allowed by policy exception` }
    }
    return { verdict: 'SOFT_DENY', reason: `'${query.action}' requires a policy exception` }
  }

  return { verdict: 'ALLOW', reason: 'within contract' }
}

/**
 * DENY에 닿았을 때 세션이 무엇을 해야 하는지 (OM §5.3).
 * 세션 전체를 즉시 중단하는 것이 기본이 아니다 — Goal 달성 가능 여부로 갈린다.
 */
export type DenyResponse = 'CONTINUE' | 'DEFER_AND_CONTINUE' | 'RECORD_UNRESOLVED_AND_CONTINUE' | 'CHECKPOINT_AND_RETURN'

export function denyResponse(verdict: Verdict, blocksGoal: boolean): DenyResponse {
  if (verdict === 'ALLOW') return 'CONTINUE'
  if (verdict === 'HARD_DENY') return blocksGoal ? 'CHECKPOINT_AND_RETURN' : 'RECORD_UNRESOLVED_AND_CONTINUE'
  return blocksGoal ? 'CHECKPOINT_AND_RETURN' : 'DEFER_AND_CONTINUE'
}
