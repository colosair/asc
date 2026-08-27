// B-03 Gate ③④ — 권한이 교집합으로 좁혀지는지, HARD DENY를 하위 계층이 못 뚫는지.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  denyResponse,
  evaluate,
  intersectScopes,
  mergePolicyLayers,
  mergeReplaceList,
  mergeScalar,
  mergeUnionList,
  type PolicyLayer,
} from '../core/policy/policy.ts'
import { isScopeSubset, parseScope, pathInScope } from '../core/policy/scope.ts'
import { resolveProfile, type ConfigLayer } from '../core/resolver/resolve.ts'

const vanilla: PolicyLayer = {
  id: 'vanilla',
  hardDeny: ['external.write', 'canonical.modify', 'policy.change'],
  softDeny: ['dependency.add', 'shared-module.change'],
  roleScopes: { implementer: ['**'], verifier: [] },
}

describe('merge semantics — 필드 유형별 규칙 (OM §4.7)', () => {
  it('scalar는 잠기지 않은 키만 하위가 이긴다', () => {
    assert.equal(mergeScalar('balanced', 'autonomous', false), 'autonomous')
    assert.equal(mergeScalar('balanced', 'autonomous', true), 'balanced')
    assert.equal(mergeScalar(undefined, 'autonomous', true), 'autonomous')
  })

  it('replace-list는 통째 교체, union-list는 합집합', () => {
    assert.deepEqual(mergeReplaceList(['a', 'b'], ['c']), ['c'])
    assert.deepEqual(mergeReplaceList(['a', 'b'], undefined), ['a', 'b'])
    assert.deepEqual(mergeUnionList(['a', 'b'], ['b', 'c']), ['a', 'b', 'c'])
  })

  it('permission scope는 lower-wins가 아니라 교집합이다', () => {
    const narrowed = intersectScopes(['frontend/**'], ['frontend/src/studio/**'])
    assert.deepEqual(narrowed.scopes, ['frontend/src/studio/**'])
    assert.deepEqual(narrowed.escalations, [])
  })

  it('상위 범위를 벗어난 요청은 조용히 좁히지 않고 위반으로 보고한다', () => {
    const escalated = intersectScopes(['frontend/**'], ['frontend/src/**', 'backend/**'])
    assert.deepEqual(escalated.scopes, ['frontend/src/**'])
    assert.deepEqual(escalated.escalations, ['backend/**'])
  })

  it('문법 밖 범위는 통과시키지 않고 따로 보고한다', () => {
    const result = intersectScopes(['frontend/**'], ['frontend/*/studio/**', 'frontend/src/**'])
    assert.deepEqual(result.invalid, ['frontend/*/studio/**'])
    assert.deepEqual(result.scopes, ['frontend/src/**'])
  })
})

describe('scope 판정 — 경로 매칭과 집합 포함은 다른 질문이다', () => {
  it('재귀 범위는 1단계 범위의 부분집합이 아니다', () => {
    // glob 매처로 패턴끼리 비교하면 여기서 true가 나와 권한 확장이 통과한다
    assert.equal(isScopeSubset('frontend/**', 'frontend/*'), false)
    assert.equal(isScopeSubset('frontend/*', 'frontend/**'), true)
  })

  it('같은 prefix의 깊은 재귀 범위는 얕은 재귀 범위 안이다', () => {
    assert.equal(isScopeSubset('frontend/src/studio/**', 'frontend/**'), true)
    assert.equal(isScopeSubset('frontend/**', 'frontend/src/**'), false)
    assert.equal(isScopeSubset('backend/**', 'frontend/**'), false)
  })

  it('`**`는 모두를 품지만 아무것에도 담기지 않는다', () => {
    assert.equal(isScopeSubset('frontend/**', '**'), true)
    assert.equal(isScopeSubset('**', 'frontend/**'), false)
    assert.equal(isScopeSubset('**', '**'), true)
  })

  it('재귀 범위는 prefix 자신을 품지 않는다', () => {
    // pathInScope('frontend', ['frontend/**'])가 false이므로 subset 판정도 같아야 한다
    assert.equal(isScopeSubset('frontend', 'frontend/**'), false)
    assert.equal(isScopeSubset('frontend/a.ts', 'frontend/**'), true)
    assert.equal(isScopeSubset('frontend/src/a.ts', 'frontend/**'), true)
    assert.equal(pathInScope('frontend', ['frontend/**']), false)
  })

  it('정확 경로는 자기 자신과 상위 범위에만 든다', () => {
    assert.equal(isScopeSubset('frontend/src/a.ts', 'frontend/**'), true)
    assert.equal(isScopeSubset('frontend/a.ts', 'frontend/*'), true)
    assert.equal(isScopeSubset('frontend/src/a.ts', 'frontend/*'), false) // 1단계를 넘는다
    assert.equal(isScopeSubset('frontend/a.ts', 'frontend/a.ts'), true)
    assert.equal(isScopeSubset('frontend/**', 'frontend/a.ts'), false)
  })

  it('경로 매칭은 깊이를 구분한다', () => {
    assert.equal(pathInScope('frontend/src/a.ts', ['frontend/**']), true)
    assert.equal(pathInScope('frontend/src/a.ts', ['frontend/*']), false)
    assert.equal(pathInScope('frontend/a.ts', ['frontend/*']), true)
    assert.equal(pathInScope('frontend', ['frontend/**']), false) // 디렉터리 자신은 이하가 아니다
    assert.equal(pathInScope('backend/a.ts', ['**']), true)
  })

  it('중간 와일드카드·확장자 패턴은 문법 밖이라 아무것도 허용하지 않는다', () => {
    for (const bad of ['frontend/*/studio/**', 'src/*.ts', '*', '', 'frontend/**/*.ts']) {
      assert.equal(parseScope(bad), null, bad)
      assert.equal(pathInScope('frontend/x/studio/a.ts', [bad]), false, bad)
      assert.equal(isScopeSubset(bad, '**'), false, bad)
    }
  })
})

describe('계층 병합', () => {
  it('HARD DENY는 union이고 하위가 늘릴 수만 있다', () => {
    const { policy } = mergePolicyLayers([vanilla, { id: 'profile', hardDeny: ['release.tag'] }])
    assert.deepEqual(policy.hardDeny, ['external.write', 'canonical.modify', 'policy.change', 'release.tag'])
  })

  it('하위 계층이 HARD DENY를 allow로 뚫으려 하면 위반이다', () => {
    const { violations } = mergePolicyLayers([vanilla, { id: 'override:local', allow: ['external.write'] }])
    assert.equal(violations.length, 1)
    assert.equal(violations[0]!.kind, 'HARD_DENY_ESCAPE')
    assert.match(violations[0]!.detail, /external\.write/)
  })

  it('상속된 SOFT DENY도 하위 계층이 allow로 풀 수 없다', () => {
    // 해제는 Controller가 특정 Session에 주는 Policy Exception으로만 일어난다
    const escaped = mergePolicyLayers([vanilla, { id: 'preset', allow: ['dependency.add'] }])
    assert.equal(escaped.policy.softDeny.includes('dependency.add'), true)
    assert.equal(escaped.violations[0]!.kind, 'SOFT_DENY_ESCAPE')
  })

  it('금지 강화 방향은 언제나 열려 있다', () => {
    const tightened = mergePolicyLayers([vanilla, { id: 'preset', softDeny: ['test.skip'] }])
    assert.equal(tightened.policy.softDeny.includes('test.skip'), true)
    assert.deepEqual(tightened.violations, [])
  })

  it('상속되지 않은 항목의 allow 선언은 무해하다', () => {
    const declared = mergePolicyLayers([vanilla, { id: 'preset', allow: ['test.add'] }])
    assert.deepEqual(declared.violations, [])
  })

  it('role scope는 계층을 내려갈수록 좁아진다', () => {
    const { policy, violations } = mergePolicyLayers([
      vanilla,
      { id: 'profile', roleScopes: { implementer: ['frontend/**', 'specs/**'] } },
      { id: 'preset', roleScopes: { implementer: ['frontend/src/**'] } },
    ])
    assert.deepEqual(policy.roleScopes.implementer, ['frontend/src/**'])
    assert.deepEqual(violations, [])
  })

  it('잠긴 설정은 하위가 덮어쓰지 못한다', () => {
    const { policy, violations } = mergePolicyLayers([
      { id: 'vanilla', settings: { independentVerifier: true }, lockedSettings: ['independentVerifier'] },
      { id: 'override', settings: { independentVerifier: false } },
    ])
    assert.equal(policy.settings.independentVerifier, true)
    assert.equal(violations[0]!.kind, 'LOCKED_SETTING')
  })
})

describe('판정 (OM §5)', () => {
  const { policy } = mergePolicyLayers([vanilla, { id: 'profile', roleScopes: { implementer: ['frontend/**'] } }])

  it('계약 안의 행위는 자율이다', () => {
    assert.equal(evaluate(policy, { action: 'code.edit', path: 'frontend/src/a.ts', role: 'implementer' }).verdict, 'ALLOW')
  })

  it('SOFT DENY는 Policy Exception으로 열린다', () => {
    assert.equal(evaluate(policy, { action: 'dependency.add' }).verdict, 'SOFT_DENY')
    assert.equal(
      evaluate(policy, { action: 'dependency.add', policyExceptions: ['dependency.add'] }).verdict,
      'ALLOW',
    )
  })

  it('HARD DENY는 Policy Exception으로도 열리지 않는다', () => {
    const forced = evaluate(policy, { action: 'external.write', policyExceptions: ['external.write'] })
    assert.equal(forced.verdict, 'HARD_DENY')
  })

  it('Write Boundary 밖 경로는 거절한다', () => {
    const outside = evaluate(policy, {
      action: 'code.edit',
      path: 'backend/src/a.java',
      writeBoundary: ['frontend/src/studio/**'],
    })
    assert.equal(outside.verdict, 'HARD_DENY')
    assert.match(outside.reason, /outside the write boundary/)
  })

  it('DENY 접촉 시 동작은 Goal 차단 여부로 갈린다 (OM §5.3)', () => {
    assert.equal(denyResponse('HARD_DENY', true), 'CHECKPOINT_AND_RETURN')
    assert.equal(denyResponse('HARD_DENY', false), 'RECORD_UNRESOLVED_AND_CONTINUE')
    assert.equal(denyResponse('SOFT_DENY', false), 'DEFER_AND_CONTINUE')
    assert.equal(denyResponse('SOFT_DENY', true), 'CHECKPOINT_AND_RETURN')
    assert.equal(denyResponse('ALLOW', true), 'CONTINUE')
  })
})

describe('Profile Resolver', () => {
  const layers: ConfigLayer[] = [
    { ...vanilla, kind: 'vanilla', requiredCapabilities: ['scm.github'], optionalCapabilities: ['messenger.mattermost'] },
    { id: 'profile:example-team', kind: 'profile', roleScopes: { implementer: ['frontend/**'] } },
    { id: 'preset:balanced', kind: 'preset', settings: { deepAnalysisP2: false } },
    { id: 'override:local', kind: 'override', settings: { realtimeMonitor: true } },
  ]

  it('계층을 병합하고 켜진 capability를 계산한다', () => {
    const result = resolveProfile(layers, ['scm.github'])
    assert.ok(result.ok)
    assert.deepEqual(result.profile.policy.layers, ['vanilla', 'profile:example-team', 'preset:balanced', 'override:local'])
    assert.deepEqual(result.profile.capabilities, ['scm.github'])
    // Messenger가 없어도 실패하지 않는다 — 그 기능만 꺼진다 (OM §11.3)
    assert.deepEqual(result.degraded, ['messenger.mattermost'])
  })

  it('required capability가 없으면 bootstrap이 실패한다', () => {
    const result = resolveProfile(layers, [])
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.failures.some((f) => f.kind === 'MISSING_CAPABILITY'))
  })

  it('계층 순서가 뒤집히면 실패한다', () => {
    const result = resolveProfile([layers[3]!, layers[0]!], ['scm.github'])
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.failures.some((f) => f.kind === 'LAYER_ORDER'))
  })

  it('정책 위반은 전부 모아서 한 번에 보고한다', () => {
    const result = resolveProfile(
      [
        { ...vanilla, kind: 'vanilla' },
        { id: 'profile:example-team', kind: 'profile', roleScopes: { implementer: ['frontend/**'] } },
        { id: 'override:local', kind: 'override', allow: ['external.write'], roleScopes: { implementer: ['backend/**'] } },
      ],
      [],
    )
    assert.ok(!result.ok)
    const violations = result.failures.filter((f) => f.kind === 'POLICY').map((f) => f.violation.kind)
    // 첫 위반에서 멈추지 않고 HARD DENY 해제 시도와 범위 확장을 모두 보고한다
    assert.deepEqual(violations.sort(), ['HARD_DENY_ESCAPE', 'SCOPE_ESCALATION'])
  })
})
