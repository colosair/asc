// Profile Resolver 골격 — 구성 계층을 정해진 순서로 합쳐 Resolved Profile을 만든다
// (OM §4.1·§4.7·§4.8). Resolved Profile은 Derived View다: 지워도 다시 만들 수 있어야 하고,
// 누구도 직접 손대지 않는다.
//
// 여기 없는 것: profile.lock 기록·대조(B-10), YAML 로딩(B-10), ASC.md 생성(B-10).
// 이 단계의 목적은 계층 순서와 병합·검증 규칙이 실제로 성립하는지 확인하는 것이다.

import { mergePolicyLayers, type PolicyLayer, type PolicyViolation, type ResolvedPolicy } from '../policy/policy.ts'

/** 계층 종류. 순서가 곧 우선순위이며, 아래로 갈수록 하위 계층이다 (OM §4.1). */
export const LAYER_ORDER = ['vanilla', 'profile', 'preset', 'override'] as const
export type LayerKind = (typeof LAYER_ORDER)[number]

export type ConfigLayer = PolicyLayer & {
  kind: LayerKind
  /** Core 호환 요구 (OM §4.10). 형식은 B-10에서 semver로 확정한다. */
  requires?: { asc?: string }
}

export type ResolvedProfile = {
  policy: ResolvedPolicy
  /** 실제로 켜진 capability — required 전부 + 제공되는 optional. */
  capabilities: string[]
  /** 요구했지만 Adapter가 제공하지 못해 꺼진 것. 기능 비활성 사유로 사람에게 보인다. */
  degradedCapabilities: string[]
}

export type ResolveFailure =
  | { kind: 'LAYER_ORDER'; detail: string }
  | { kind: 'MISSING_CAPABILITY'; detail: string }
  | { kind: 'POLICY'; violation: PolicyViolation }

export type ResolveResult =
  | { ok: true; profile: ResolvedProfile; degraded: string[] }
  | { ok: false; failures: ResolveFailure[] }

/**
 * 계층을 병합해 Resolved Profile을 만든다.
 * @param layers 상위→하위 순으로 정렬되어 있어야 한다. 어긋나면 실패로 보고한다.
 * @param available Adapter가 실제로 제공하는 capability 집합.
 */
export function resolveProfile(
  layers: readonly ConfigLayer[],
  available: readonly string[] = [],
): ResolveResult {
  const failures: ResolveFailure[] = []

  let previous = -1
  for (const layer of layers) {
    const rank = LAYER_ORDER.indexOf(layer.kind)
    if (rank < previous) {
      failures.push({
        kind: 'LAYER_ORDER',
        detail: `'${layer.id}' (${layer.kind}) appears after a lower-precedence layer`,
      })
    }
    previous = Math.max(previous, rank)
  }

  const { policy, violations } = mergePolicyLayers(layers)
  for (const violation of violations) failures.push({ kind: 'POLICY', violation })

  const provided = new Set(available)
  // required 미충족은 bootstrap 실패다 — 없는 기능을 있는 척 굴리지 않는다 (OM §4.7).
  for (const capability of policy.requiredCapabilities) {
    if (!provided.has(capability)) {
      failures.push({ kind: 'MISSING_CAPABILITY', detail: `required capability '${capability}' is not available` })
    }
  }
  // optional은 없으면 그 기능만 끈다. Messenger가 없어도 Local 경로는 살아 있어야 한다 (OM §11.3).
  const degradedCapabilities = policy.optionalCapabilities.filter((capability) => !provided.has(capability))

  if (failures.length > 0) return { ok: false, failures }

  const capabilities = [
    ...policy.requiredCapabilities,
    ...policy.optionalCapabilities.filter((capability) => provided.has(capability)),
  ]
  return {
    ok: true,
    profile: { policy, capabilities, degradedCapabilities },
    degraded: degradedCapabilities,
  }
}
