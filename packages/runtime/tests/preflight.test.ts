// B-19 Gate — 산출 경로를 넘기기 전에 맞춰 보는 검사가 실제 사건(T015)을 잡는지.
//
// Gate 목록:
//   T015 재현 / 복수 output은 전부 품는 role만 후보 / 후보 표현이 세션 권한을 보장하지 않음 /
//   role·session 양 모드 / 자동 권한 확대 0 / undefined(미선언) vs [](쓰기 없음) /
//   INVALID_SCOPE 미통과 / Core provider 어휘 0

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { mergePolicyLayers } from '../core/policy/policy.ts'
import { preflight } from '../core/operator/preflight.ts'

/** B-16 당시 예시와 같은 모양 — implementer만 좁혀져 있고 verifier는 쓰기가 없다. */
const { policy } = mergePolicyLayers([
  {
    id: 'vanilla',
    hardDeny: ['external.write'],
    softDeny: ['dependency.add'],
    roleScopes: { planner: ['**'], researcher: ['**'], implementer: ['**'], verifier: [] },
  },
  { id: 'profile:example-team', roleScopes: { implementer: ['web-frontend/**'] } },
])

const roleTarget = (role: 'planner' | 'researcher' | 'implementer' | 'verifier') =>
  ({ kind: 'role', role, maxScope: policy.roleScopes[role] }) as const

describe('B-19 Gate — T015 재현', () => {
  it('implementer 범위 밖 산출 경로를 발급 전에 잡는다', () => {
    const result = preflight({
      paths: ['specs/001-auth-user/FE/quickstart.md'],
      target: roleTarget('implementer'),
      policy,
    })

    assert.equal(result.mismatches.length, 1)
    assert.equal(result.verdicts[0]?.verdict, 'BOUNDARY_MISMATCH')
    assert.equal(result.undecidable, undefined)
    // 대안에 그 경로를 품는 다른 역할이 들어 있다 (planner/researcher는 ** 를 가진다)
    assert.match(result.suggestions.join('\n'), /planner/)
  })

  it('범위 안이면 조용히 통과한다', () => {
    const result = preflight({
      paths: ['web-frontend/src/features/auth/model/returnTo.ts'],
      target: roleTarget('implementer'),
      policy,
    })
    assert.deepEqual(result.mismatches, [])
    assert.deepEqual(result.suggestions, [])
  })
})

describe('B-19 Gate — role 후보 산출 규칙', () => {
  it('일부만 품는 역할은 후보가 아니다 — 전부 품는 역할만 제안한다', () => {
    // implementer는 web-frontend/** 만, planner는 ** 다.
    // 두 경로가 섞이면 implementer는 후보가 될 수 없다.
    const { policy: split } = mergePolicyLayers([
      {
        id: 'vanilla',
        hardDeny: [],
        softDeny: [],
        roleScopes: { planner: ['**'], implementer: ['**'], researcher: ['**'] },
      },
      {
        id: 'profile',
        roleScopes: { implementer: ['web-frontend/**'], researcher: ['docs/**'] },
      },
    ])

    const result = preflight({
      paths: ['web-frontend/src/a.ts', 'docs/b.md'],
      target: { kind: 'role', role: 'implementer', maxScope: split.roleScopes.implementer },
      policy: split,
    })

    const text = result.suggestions.join('\n')
    assert.ok(result.mismatches.length > 0)
    assert.match(text, /planner/) // 둘 다 품는다
    assert.ok(!/researcher/.test(text.split('산출 경로 전체를')[1]?.split('\n')[0] ?? ''),
      'docs/** 만 품는 researcher가 후보로 나왔다')
  })

  it('한 역할로 묶이지 않으면 후보를 비우고 세션 분리를 말한다', () => {
    const { policy: narrow } = mergePolicyLayers([
      {
        id: 'vanilla',
        hardDeny: [],
        softDeny: [],
        roleScopes: { planner: ['**'], implementer: ['**'], researcher: ['**'] },
      },
      {
        id: 'profile',
        roleScopes: { planner: ['specs/**'], implementer: ['web-frontend/**'], researcher: ['docs/**'] },
      },
    ])

    const result = preflight({
      paths: ['web-frontend/src/a.ts', 'docs/b.md'],
      target: { kind: 'role', role: 'implementer', maxScope: narrow.roleScopes.implementer },
      policy: narrow,
    })

    const text = result.suggestions.join('\n')
    assert.ok(!text.includes('산출 경로 전체를 최대 범위 안에 두는 역할'))
    assert.match(text, /한 역할이 통째로 맡을 수 없다/)
    assert.match(text, /세션을 나누/)
  })

  it('후보는 최대 범위 기준일 뿐 — 세션 권한을 보장한다고 말하지 않는다', () => {
    const result = preflight({
      paths: ['specs/001-auth-user/FE/quickstart.md'],
      target: roleTarget('implementer'),
      policy,
    })
    const text = result.suggestions.join('\n')
    assert.match(text, /최대 범위/)
    assert.match(text, /발급 시 더 좁게 정해질 수 있으므로/)
    assert.ok(!/이 역할이면 쓸 수 있다/.test(text))
  })

  it('policy가 없으면 역할 후보를 지어내지 않는다', () => {
    const result = preflight({
      paths: ['specs/x.md'],
      target: { kind: 'role', role: 'implementer', maxScope: ['web-frontend/**'] },
    })
    assert.ok(result.mismatches.length > 0)
    assert.ok(!result.suggestions.join('\n').includes('최대 범위 안에 두는 역할'))
  })
})

describe('B-19 Gate — 양 모드', () => {
  it('세션 계약이 역할 최대 범위보다 좁으면 세션 모드에서만 잡힌다', () => {
    const paths = ['web-frontend/src/pages/login/LoginPage.tsx']

    const byRole = preflight({ paths, target: roleTarget('implementer'), policy })
    assert.deepEqual(byRole.mismatches, [], '역할 최대 범위로는 통과해야 한다')

    // 실제 세션은 features/auth 만 잡고 발급됐다
    const bySession = preflight({
      paths,
      target: {
        kind: 'session',
        sessionId: 'S-20260823-53',
        role: 'implementer',
        writeBoundary: ['web-frontend/src/features/auth/**'],
      },
      policy,
    })
    assert.equal(bySession.mismatches.length, 1, '세션 계약 밖인데 통과했다')
  })
})

describe('B-19 Gate — 판정 불성립과 빈 범위를 구분한다', () => {
  it('역할이 정책에 선언되지 않았으면 통과가 아니라 판정 불가다', () => {
    const result = preflight({
      paths: ['anything.md'],
      target: { kind: 'role', role: 'planner', maxScope: undefined },
      policy,
    })
    assert.match(result.undecidable ?? '', /선언돼 있지 않다/)
    assert.deepEqual(result.verdicts, [])
    assert.deepEqual(result.mismatches, [])
  })

  it('쓰기 범위가 빈 역할은 전부 불일치 — 역할의 본질이 아니라 현재 정책 상태로 설명한다', () => {
    const result = preflight({
      paths: ['report.md'],
      target: roleTarget('verifier'),
      policy,
    })
    assert.equal(result.undecidable, undefined)
    assert.equal(result.mismatches.length, 1)
    const text = result.suggestions.join('\n')
    assert.match(text, /현재 허용된 쓰기 범위가 없다/)
    assert.match(text, /지금 정책에서는/)
    // 역할 자체를 규정하지 않는다 — 정책이 바뀌면 달라질 수 있는 상태다
    assert.ok(!text.includes('파일을 만들지 않는 역할'))
  })
})

describe('B-19 Gate — 문법과 권한 경계', () => {
  it('문법 밖 경로는 통과시키지 않는다', () => {
    const result = preflight({
      paths: ['web-frontend/**/deep/**', ''],
      target: roleTarget('implementer'),
      policy,
    })
    assert.ok(result.verdicts.every((v) => v.verdict !== 'OK'))
    assert.ok(result.verdicts.some((v) => v.verdict === 'INVALID_SCOPE'))
    assert.match(result.suggestions.join('\n'), /문법 밖 경로를 먼저 고쳐라/)
  })

  it('결과에 권한을 넓히는 값이 없다 — 제안은 문장뿐이다', () => {
    const result = preflight({
      paths: ['specs/x.md'],
      target: roleTarget('implementer'),
      policy,
    })
    // suggestions는 사람이 읽는 문자열이고, 적용 가능한 boundary 값을 담지 않는다
    for (const s of result.suggestions) assert.equal(typeof s, 'string')
    assert.ok(!('boundary' in result), '결과가 새 boundary를 들고 있다')
    assert.ok(!('grantedScope' in result))
    // 대조 기준(입력)은 그대로 되돌려줄 뿐 변형되지 않는다
    assert.deepEqual(result.target, roleTarget('implementer'))
    assert.match(result.suggestions.join('\n'), /권한 확대는 Controller의 명시적 결정/)
  })
})

describe('B-19 Gate — Core 독립성', () => {
  it('preflight에 provider 어휘가 없다', async () => {
    const source = await readFile(new URL('../core/operator/preflight.ts', import.meta.url), 'utf8')
    for (const word of ['claude', 'Claude', 'gpt', 'sonnet', 'opus', 'haiku', 'anthropic']) {
      assert.ok(!source.includes(word), `preflight.ts 에 provider 어휘 '${word}' 가 있다`)
    }
  })
})

// B-24 Gate — 책임 축. 경로가 맞아도 "누가 결정하는가"가 비어 있으면 시작하지 않는다.
describe('B-24 Gate — Responsibility Preflight (C-04 §2)', () => {
  const ownership = {
    frontend: { paths: ['web-frontend/**'], authorities: ['client-ui'] },
    backend: { paths: ['backend/**'], authorities: ['api-contract'] },
    product: { paths: [], authorities: ['product-policy'] },
  }
  const sessionTarget = (extra: Record<string, unknown> = {}) =>
    ({
      kind: 'session',
      sessionId: 'S-20260826-01',
      role: 'implementer',
      writeBoundary: ['web-frontend/**'],
      ...extra,
    }) as const

  it('결정 영역을 선언하지 않으면 책임 축은 아무것도 걸리지 않는다', () => {
    // 대부분의 구현 세션은 cross-part 결정을 요구하지 않는다 — 그런 세션까지 막지 않는다
    const result = preflight({ paths: ['web-frontend/src/a.ts'], target: sessionTarget(), policy, ownership })
    assert.deepEqual(result.authorityGaps, [])
    assert.equal(result.mismatches.length, 0)
    assert.equal(result.undecidable, undefined)
  })

  it('결정권자가 하나로 풀리면 통과한다', () => {
    const result = preflight({
      paths: ['web-frontend/src/a.ts'],
      target: sessionTarget({ owner: 'frontend', decisionDomains: ['client-ui'] }),
      policy,
      ownership,
    })
    assert.deepEqual(result.authorityGaps, [])
  })

  it('아무도 주장하지 않은 결정은 UNDECLARED로 남는다 — 가까운 역할에 붙이지 않는다', () => {
    const result = preflight({
      paths: ['web-frontend/src/a.ts'],
      target: sessionTarget({ owner: 'frontend', decisionDomains: ['oauth-policy'] }),
      policy,
      ownership,
    })
    assert.deepEqual(result.authorityGaps, [{ domain: 'oauth-policy', lookup: { kind: 'UNDECLARED' } }])
    assert.match(result.suggestions.join('\n'), /결정권자가 선언되지 않았다/)
    assert.match(result.suggestions.join('\n'), /답이 Agent 사이를 돈다/)
  })

  it('둘이 주장하면 고르지 않고 갈렸다고 말한다', () => {
    const contested = {
      frontend: { paths: ['web-frontend/**'], authorities: ['auth-flow'] },
      backend: { paths: ['backend/**'], authorities: ['auth-flow'] },
    }
    const result = preflight({
      paths: ['web-frontend/src/a.ts'],
      target: sessionTarget({ owner: 'frontend', decisionDomains: ['auth-flow'] }),
      policy,
      ownership: contested,
    })
    assert.deepEqual(result.authorityGaps[0]?.lookup, { kind: 'AMBIGUOUS', candidates: ['backend', 'frontend'] })
  })

  it('세션이 이번에 한해 정한 결정권자는 지도를 대신한다', () => {
    const result = preflight({
      paths: ['web-frontend/src/a.ts'],
      target: sessionTarget({
        owner: 'frontend',
        decisionDomains: ['oauth-policy'],
        decisionAuthority: { 'oauth-policy': 'product' },
      }),
      policy,
      ownership,
    })
    assert.deepEqual(result.authorityGaps, [])
  })

  it('쓰기 범위 안이어도 owner 영역 밖이면 OWNERSHIP_MISMATCH다', () => {
    // 계약이 넓게 열려 있어도 그것이 "내 파트"라는 뜻은 아니다
    const result = preflight({
      paths: ['backend/src/auth.ts'],
      target: sessionTarget({ owner: 'frontend', writeBoundary: ['**'] }),
      policy,
      ownership,
    })
    assert.equal(result.verdicts[0]?.verdict, 'OWNERSHIP_MISMATCH')
    assert.match(result.suggestions.join('\n'), /남의 파트 산출물이라면/)
  })

  it('책임을 물었는데 지도가 없으면 통과가 아니라 판정 불성립이다', () => {
    const result = preflight({
      paths: ['web-frontend/src/a.ts'],
      target: sessionTarget({ owner: 'frontend', decisionDomains: ['client-ui'] }),
      policy,
    })
    assert.match(result.undecidable ?? '', /책임 지도\(ownership\)가 선언돼 있지 않다/)
  })

  it('책임을 묻지 않은 세션은 지도가 없어도 판정이 성립한다', () => {
    const result = preflight({ paths: ['web-frontend/src/a.ts'], target: sessionTarget(), policy })
    assert.equal(result.undecidable, undefined)
    assert.equal(result.mismatches.length, 0)
  })

  it('role 대조에는 책임 축이 붙지 않는다 — 역할에는 owner가 없다', () => {
    const result = preflight({ paths: ['web-frontend/src/a.ts'], target: roleTarget('implementer'), policy, ownership })
    assert.deepEqual(result.authorityGaps, [])
    assert.equal(result.undecidable, undefined)
  })
})
