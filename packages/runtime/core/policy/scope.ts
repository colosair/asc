// ASC scope grammar와 두 가지 판정.
//
// 이 둘은 다른 질문이고 다른 답을 준다. 섞으면 권한이 새어 나간다:
//   pathInScope   — "이 파일을 써도 되는가"           (경로 대 패턴)
//   isScopeSubset — "이 범위가 저 범위 안에 드는가"   (패턴 대 패턴, 집합 포함)
//
// glob 매처로 패턴 대 패턴을 판정하면 안 된다. `node:path`의 matchesGlob으로
// `frontend/**`가 `frontend/*`의 부분집합인지 물으면 true가 나온다 — `**`가 리터럴처럼
// 매칭되기 때문이다. 재귀 범위가 1단계 범위 안에 든다는 답은 곧 권한 확장 통과다.
// 그래서 문법을 좁히고 집합 포함을 직접 계산한다.
//
// 허용 문법 (이외는 전부 거부):
//   **              모든 경로
//   <prefix>/**     prefix 이하 전부 (재귀)
//   <prefix>/*      prefix의 직속 자식만 (1단계)
//   <path>          정확히 그 경로 하나

export type ParsedScope =
  | { kind: 'all' }
  | { kind: 'recursive'; segments: string[] }
  | { kind: 'children'; segments: string[] }
  | { kind: 'exact'; segments: string[] }

/** 문법 밖 패턴은 null이다 — 호출자는 이를 위반으로 다뤄야 하며, 통과시켜서는 안 된다. */
export function parseScope(scope: string): ParsedScope | null {
  if (scope.length === 0) return null
  if (scope === '**') return { kind: 'all' }

  const segments = scope.split('/')
  const last = segments.at(-1)!
  const head = segments.slice(0, -1)

  // 와일드카드는 마지막 세그먼트에만, 그리고 그 세그먼트 전체여야 한다.
  // 'frontend/*/studio'나 'src/*.ts'는 집합 포함을 단순 계산할 수 없어 거부한다.
  if (head.some((s) => s.includes('*') || s.length === 0)) return null

  if (last === '**') return head.length > 0 ? { kind: 'recursive', segments: head } : null
  if (last === '*') return head.length > 0 ? { kind: 'children', segments: head } : null
  if (last.includes('*') || last.length === 0) return null
  return { kind: 'exact', segments }
}

const startsWith = (path: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length <= path.length && prefix.every((segment, i) => path[i] === segment)

const sameSegments = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((segment, i) => segment === b[i])

/** 실제 경로가 이 범위들 중 하나에 드는가. */
export function pathInScope(path: string, scopes: readonly string[]): boolean {
  const segments = path.split('/')
  return scopes.some((scope) => {
    const parsed = parseScope(scope)
    if (!parsed) return false // 잘못 쓴 범위는 아무것도 허용하지 않는다
    switch (parsed.kind) {
      case 'all':
        return true
      case 'recursive':
        return startsWith(segments, parsed.segments) && segments.length > parsed.segments.length
      case 'children':
        return startsWith(segments, parsed.segments) && segments.length === parsed.segments.length + 1
      case 'exact':
        return sameSegments(segments, parsed.segments)
    }
  })
}

/**
 * sub가 가리키는 경로 집합이 sup 안에 전부 들어가는가.
 * 판정 불가(문법 밖)면 false — 모르면 거부한다.
 */
export function isScopeSubset(sub: string, sup: string): boolean {
  const a = parseScope(sub)
  const b = parseScope(sup)
  if (!a || !b) return false

  if (b.kind === 'all') return true
  if (a.kind === 'all') return false // 전체는 어떤 부분범위에도 들어가지 않는다

  switch (b.kind) {
    case 'recursive':
      if (!startsWith(a.segments, b.segments)) return false
      // `p/**`는 p 아래를 뜻하지 p 자신이 아니다 — pathInScope도 같은 규칙이므로,
      // exact 'frontend'가 'frontend/**'의 부분집합이 되면 두 판정이 어긋난다.
      return a.kind === 'exact' ? a.segments.length > b.segments.length : true
    case 'children':
      // 1단계만 허용하는 범위에 재귀 범위는 들어갈 수 없다 — 이것이 matchesGlob이 놓친 지점이다.
      if (a.kind === 'recursive') return false
      if (a.kind === 'children') return sameSegments(a.segments, b.segments)
      return a.segments.length === b.segments.length + 1 && startsWith(a.segments, b.segments)
    case 'exact':
      return a.kind === 'exact' && sameSegments(a.segments, b.segments)
  }
}

/** 여러 상위 범위 중 하나라도 sub를 품으면 통과다. */
export function isWithinScopes(sub: string, supers: readonly string[]): boolean {
  return supers.some((sup) => isScopeSubset(sub, sup))
}
