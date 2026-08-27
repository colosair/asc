// Profile이 요구하는 Core 버전 범위를 판정한다 (OM §4.10).
//
// 전체 semver range 문법(캐럿·틸드·`||`·x-range)을 지원하지 않는다. Profile이 적는 것은
// "이 범위의 Core에서 돌아간다"는 하한과 상한이고, 그 이상은 필요하지 않았다.
// 대신 문법 밖은 통과시키지 않고 실패로 돌려준다 — 읽지 못한 요구를 만족한 것으로
// 넘기면 호환되지 않는 Core에서 그냥 돌아가 버린다.
//
// 지원: `>=0.1`, `<1.0`, `>1.2.3`, `<=2.0`, `=1.0.0`, 그리고 공백으로 이어 붙인 AND.

export type Version = readonly [number, number, number]

export function parseVersion(text: string): Version | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(text.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1
  }
  return 0
}

export type RangeCheck =
  | { ok: true }
  | { ok: false; reason: 'UNPARSEABLE_RANGE'; detail: string }
  | { ok: false; reason: 'UNPARSEABLE_VERSION'; detail: string }
  | { ok: false; reason: 'OUT_OF_RANGE'; detail: string }

/**
 * `version`이 `range`를 만족하는가.
 * 판정할 수 없으면 만족한 것으로 넘기지 않는다 — 모르면 막는 쪽이 맞다.
 */
export function satisfies(version: string, range: string): RangeCheck {
  const current = parseVersion(version)
  if (!current) return { ok: false, reason: 'UNPARSEABLE_VERSION', detail: version }

  const clauses = range.trim().split(/\s+/).filter(Boolean)
  if (clauses.length === 0) return { ok: false, reason: 'UNPARSEABLE_RANGE', detail: range }

  for (const clause of clauses) {
    const match = /^(>=|<=|>|<|=)?\s*(\d+\.\d+(?:\.\d+)?)$/.exec(clause)
    if (!match) return { ok: false, reason: 'UNPARSEABLE_RANGE', detail: clause }

    const operator = match[1] ?? '='
    const bound = parseVersion(match[2]!)!
    const order = compare(current, bound)

    const satisfied =
      operator === '>=' ? order >= 0
      : operator === '<=' ? order <= 0
      : operator === '>' ? order > 0
      : operator === '<' ? order < 0
      : order === 0

    if (!satisfied) return { ok: false, reason: 'OUT_OF_RANGE', detail: `${version} 은 ${clause} 를 만족하지 않는다` }
  }
  return { ok: true }
}
