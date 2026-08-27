// Boundary Preflight — 다른 role에게 일을 넘기기 전에 경로를 맞춰 본다 (B-19).
//
// 근거 사건(B-16 T015): planner가 tasks.md에 산출 경로 `specs/.../quickstart.md`를 적었는데
// 그 일을 할 implementer의 쓰기 범위는 `web-frontend/**`였다. 불일치는 실행 단계에서야
// 드러났고, 해소하는 데 세션을 하나 더 발급해야 했다. 대조 자체는 1초면 되는데 그걸
// 나중에 한 것이 비용이었다.
//
// 이 모듈이 하는 일과 하지 않는 일:
//   한다   — 경로가 대상 범위 안에 드는지 판정하고, 어긋나면 대안을 문장으로 제시
//   안 한다 — 범위 확장, role 변경, 세션 발급. 판정은 여기서, 결정은 Controller가.
//
// 판정 로직은 새로 만들지 않는다. scope.ts의 패턴 대 패턴 판정을 그대로 쓴다 —
// policy.evaluate()를 쓰지 않는 이유는 그쪽이 단수 path + 경로 대 패턴이라
// `specs/**` 같은 패턴 입력을 오판하기 때문이다.

import { lookupAuthority, type AuthorityLookup, type OwnershipMap } from '../policy/ownership.ts'
import { isWithinScopes, parseScope } from '../policy/scope.ts'
import type { ResolvedPolicy, RoleName } from '../policy/policy.ts'

/** 무엇과 대조하는가. role은 최대 범위, session은 실제 계약 — 후자가 더 좁을 수 있다. */
export type PreflightTarget =
  | { kind: 'role'; role: RoleName; maxScope: readonly string[] | undefined }
  | {
      kind: 'session'
      sessionId: string
      role?: RoleName
      writeBoundary: readonly string[]
      /** 책임 축 (C-04 §2). 선언하지 않은 세션에서는 이 축을 판정하지 않는다. */
      owner?: string
      decisionDomains?: readonly string[]
      decisionAuthority?: Readonly<Record<string, string>>
    }

export type PathVerdict =
  | { path: string; verdict: 'OK' }
  /** 문법 밖 경로. 통과시키지 않는다 — 판정할 수 없는 것은 통과가 아니다. */
  | { path: string; verdict: 'INVALID_SCOPE' }
  | { path: string; verdict: 'BOUNDARY_MISMATCH' }
  /** 쓰기 범위 안이지만 owner의 영역 밖이다 — 남의 파트 산출물을 만들고 있다. */
  | { path: string; verdict: 'OWNERSHIP_MISMATCH' }

export type PreflightResult = {
  target: PreflightTarget
  verdicts: PathVerdict[]
  mismatches: PathVerdict[]
  /** 사람이 읽을 대안. 문자열뿐이다 — 실행 가능한 명령을 자동으로 태우지 않는다. */
  suggestions: string[]
  /**
   * 주인이 정해지지 않은 결정 영역. 경로 축(PathVerdict)과 다른 축이라 따로 든다 —
   * 결정은 파일에 붙지 않으므로 경로별 판정에 섞을 수 없다.
   */
  authorityGaps: { domain: string; lookup: AuthorityLookup }[]
  /** 판정이 성립하지 않은 이유. 있으면 결과를 "통과"로 읽으면 안 된다. */
  undecidable?: string
}

export type PreflightInput = {
  paths: readonly string[]
  target: PreflightTarget
  /** role 후보 제안용. 없으면 후보를 내지 않는다. */
  policy?: ResolvedPolicy
  /** Profile이 선언한 책임 지도 (C-04 §6). 없으면 책임 축은 판정 불성립이다. */
  ownership?: OwnershipMap
}

export function preflight(input: PreflightInput): PreflightResult {
  const { paths, target, policy, ownership } = input
  const boundary = target.kind === 'role' ? target.maxScope : target.writeBoundary

  // 정책에 role이 선언돼 있지 않으면 최대 범위를 모른다. 모르는 것을 통과로 만들지 않는다 —
  // Session issue의 SCOPE_ESCALATION 검사도 같은 자리에서 검사를 건너뛰므로(session.ts),
  // preflight까지 조용히 통과시키면 두 곳 다 아무 말이 없게 된다.
  if (boundary === undefined) {
    return {
      target,
      verdicts: [],
      mismatches: [],
      suggestions: [],
      authorityGaps: [],
      undecidable:
        target.kind === 'role'
          ? `Profile에 '${target.role}' 역할의 쓰기 범위가 선언돼 있지 않다 — 대조할 기준이 없다`
          : `${target.sessionId} 의 쓰기 범위를 읽지 못했다`,
    }
  }

  // owner의 영역. 선언한 세션에서만 쓴다 — role 대조에는 owner가 없다.
  const ownerPaths =
    target.kind === 'session' && target.owner ? ownership?.[target.owner]?.paths : undefined

  const verdicts = paths.map((path): PathVerdict => {
    if (parseScope(path) === null) return { path, verdict: 'INVALID_SCOPE' }
    if (!isWithinScopes(path, boundary)) return { path, verdict: 'BOUNDARY_MISMATCH' }
    // 쓰기 범위는 "이 계약이 어디까지 쓸 수 있는가"이고, 여기는 "그게 누구 영역인가"다.
    // 둘 다 통과해야 남의 파트를 대신 만들고 있지 않다고 말할 수 있다.
    if (ownerPaths && ownerPaths.length > 0 && !isWithinScopes(path, ownerPaths)) {
      return { path, verdict: 'OWNERSHIP_MISMATCH' }
    }
    return { path, verdict: 'OK' }
  })
  const mismatches = verdicts.filter((v) => v.verdict !== 'OK')
  const authorityGaps = findAuthorityGaps(target, ownership)

  const result: PreflightResult = {
    target,
    verdicts,
    mismatches,
    authorityGaps,
    suggestions:
      mismatches.length === 0 && authorityGaps.length === 0
        ? []
        : suggest(paths, verdicts, target, boundary, policy, authorityGaps),
  }

  // 책임을 물었는데 지도가 없다. 답이 없는 것과 "괜찮다"는 것을 구분한다.
  if (target.kind === 'session' && !ownership && (target.owner || target.decisionDomains?.length)) {
    result.undecidable = 'Profile에 책임 지도(ownership)가 선언돼 있지 않다 — 책임 축을 대조할 기준이 없다'
  }
  return result
}

/** 주인이 하나로 정해지지 않은 결정 영역만 골라낸다. 고르지는 않는다. */
function findAuthorityGaps(
  target: PreflightTarget,
  ownership: OwnershipMap | undefined,
): { domain: string; lookup: AuthorityLookup }[] {
  if (target.kind !== 'session') return []
  const gaps: { domain: string; lookup: AuthorityLookup }[] = []
  for (const domain of target.decisionDomains ?? []) {
    if (target.decisionAuthority?.[domain]) continue
    const lookup = lookupAuthority(ownership, domain)
    if (lookup.kind !== 'RESOLVED') gaps.push({ domain, lookup })
  }
  return gaps
}

function suggest(
  paths: readonly string[],
  verdicts: readonly PathVerdict[],
  target: PreflightTarget,
  boundary: readonly string[],
  policy: ResolvedPolicy | undefined,
  authorityGaps: readonly { domain: string; lookup: AuthorityLookup }[],
): string[] {
  const out: string[] = []

  for (const gap of authorityGaps) {
    out.push(
      gap.lookup.kind === 'AMBIGUOUS'
        ? `'${gap.domain}' 의 결정권자가 갈려 있다 (${gap.lookup.candidates.join(', ')}) — 발급 전에 하나로 정하라.`
        : `'${gap.domain}' 의 결정권자가 선언되지 않았다 — Profile ownership 에 적거나 세션 계약에 명시하라.`,
    )
  }
  if (authorityGaps.length > 0) {
    out.push('결정권자가 없는 채로 cross-part를 시작하면 답이 Agent 사이를 돈다. 먼저 정한다.')
  }

  if (verdicts.some((v) => v.verdict === 'OWNERSHIP_MISMATCH') && target.kind === 'session') {
    out.push(
      `쓰기 범위 안이지만 '${target.owner}' 의 영역 밖인 경로가 있다 — 남의 파트 산출물이라면 ` +
        '그 파트가 만들고, 이 세션은 필요한 것을 질의로 받는다.',
    )
  }

  if (verdicts.some((v) => v.verdict === 'INVALID_SCOPE')) {
    out.push('문법 밖 경로를 먼저 고쳐라 — 허용 형태는 `**`, `p/**`, `p/*`, 정확한 경로다.')
  }

  // 쓰기 범위가 비면 경로를 옮기는 게 아니라 대상 선택이 잘못된 것이다.
  // 다만 "이 역할은 파일을 만들지 않는다"고 단정하지 않는다 — 그건 역할의 본질이 아니라
  // 지금 정책이 그렇게 정해 둔 상태다. Profile에 값만 있고 설명이 없어 여기서 말해 준다.
  if (boundary.length === 0) {
    out.push(
      target.kind === 'role'
        ? `'${target.role}' 에게 현재 허용된 쓰기 범위가 없다 — 지금 정책에서는 이 역할로 파일을 만들 수 없다. 산출물이 필요하면 다른 역할이 맡거나 정책을 바꿔야 한다.`
        : `${target.sessionId} 에 현재 허용된 쓰기 범위가 없다 — 이 계약으로는 어떤 파일도 만들 수 없다.`,
    )
  }

  const candidates = rolesCovering(paths, policy, target)
  if (candidates.length > 0) {
    out.push(
      `산출 경로 전체를 최대 범위 안에 두는 역할: ${candidates.join(', ')}. ` +
        '다만 이는 **역할의 최대 범위** 기준이다 — 실제 세션의 쓰기 범위는 발급 시 더 좁게 정해질 수 있으므로, ' +
        '발급 후 `asc preflight --session <S-ID>` 로 다시 확인하라.',
    )
  } else if (policy) {
    out.push(
      '이 산출 경로들을 한 역할이 통째로 맡을 수 없다 — 경로별로 세션을 나누거나, ' +
        '산출 경로를 수행 역할의 범위 안으로 옮겨라.',
    )
  }

  out.push('세션을 나눈다 — 범위가 다른 산출물은 각자의 계약으로 발급한다.')
  out.push('산출 경로를 옮긴다 — 수행 역할의 범위 안에 두면 세션을 늘리지 않아도 된다.')
  out.push('쓰기 범위를 넓혀 해소하지 않는다. 권한 확대는 Controller의 명시적 결정이다.')
  return out
}

/**
 * 경로 **전부**를 최대 범위에 담는 역할만 후보다. 일부만 담는 역할을 권하면
 * 그 역할로 바꿔도 다시 갈라져 같은 사건이 반복된다.
 */
function rolesCovering(
  paths: readonly string[],
  policy: ResolvedPolicy | undefined,
  target: PreflightTarget,
): RoleName[] {
  if (!policy) return []
  const valid = paths.filter((p) => parseScope(p) !== null)
  if (valid.length === 0) return []

  return (Object.entries(policy.roleScopes) as [RoleName, string[] | undefined][])
    .filter(([role, scope]) => {
      if (target.kind === 'role' && role === target.role) return false // 지금 어긋난 그 역할
      if (!scope || scope.length === 0) return false
      return valid.every((p) => isWithinScopes(p, scope))
    })
    .map(([role]) => role)
}
