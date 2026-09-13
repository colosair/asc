// 0.9.1 — 관리 실행의 대상 신원을 확정하지 못하면 진행하지 않는다 (fail closed).
//
// 0.9.0 까지 같은 adapter 결합이 둘이면 `bindingIdentity` 가 undefined 를 돌렸고, review 는
// 기준점 없이 READY 를, grant issue 는 basis.resource 없이 발급을 냈다. BINDING_MISMATCH 가
// 조용히 빠진 것이다. 여기서는 세 상태를 이름으로 가르고, CLI 가 AMBIGUOUS 를 만나면 검수도
// 발급도 하지 않고 exit 2 로 끝난다는 사실을 소스 경로로 고정한다. Core 는 건드리지 않는다.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { ambiguousBindingLines, bindingIdentity } from '../cli/binding-identity.ts'

const gl = (resource: string) => ({ adapter: 'gitlab', resource })

describe('bindingIdentity — 하나면 고정, 없으면 없음, 둘이면 AMBIGUOUS', () => {
  it('선언된 결합이 하나면 그것이 기준점이다', () => {
    assert.deepEqual(bindingIdentity([gl('team/project')], 'gitlab'), { kind: 'PINNED', resource: 'team/project' })
  })

  it('다른 adapter 의 결합은 세지 않는다', () => {
    assert.deepEqual(
      bindingIdentity([gl('team/project'), { adapter: 'jam', resource: 'PROJ' }], 'gitlab'),
      { kind: 'PINNED', resource: 'team/project' },
    )
  })

  it('선언이 없으면 NONE — 기준점 없음은 모호함과 다른 사실이다', () => {
    assert.deepEqual(bindingIdentity([], 'gitlab'), { kind: 'NONE' })
    assert.deepEqual(bindingIdentity([{ adapter: 'jam', resource: 'PROJ' }], 'gitlab'), { kind: 'NONE' })
  })

  it('같은 adapter 결합이 둘이면 고르지 않는다 — AMBIGUOUS 와 후보 전부', () => {
    const identity = bindingIdentity([gl('team/project'), gl('team/mirror')], 'gitlab')
    assert.deepEqual(identity, { kind: 'AMBIGUOUS', adapterId: 'gitlab', resources: ['team/project', 'team/mirror'] })
    const lines = ambiguousBindingLines(identity as Extract<typeof identity, { kind: 'AMBIGUOUS' }>).join('\n')
    assert.match(lines, /2 gitlab bindings are declared/)
    assert.match(lines, /does not pick one/)
    assert.match(lines, /Nothing was reviewed or issued/)
  })
})

describe('CLI 는 AMBIGUOUS 에서 멈춘다 — 검수 전에, 발급 전에', () => {
  it('work publish 의 검수와 grant issue 가 AMBIGUOUS 를 먼저 보고 2 로 끝난다', async () => {
    const source = await readFile(new URL('../cli/asc.ts', import.meta.url), 'utf8')
    // publish: identity 판정이 outward.review 호출보다 앞에 있고, AMBIGUOUS 면 return 2
    const publishAt = source.indexOf("const identity = bindingIdentity(runtime, outward.id)\n      if (identity.kind === 'AMBIGUOUS') {")
    assert.ok(publishAt > 0, 'publish 경로에 AMBIGUOUS 분기가 없다')
    const reviewAt = source.indexOf('await outward.review(action)', publishAt)
    const returnAt = source.indexOf('return 2', publishAt)
    assert.ok(returnAt > publishAt && returnAt < reviewAt, 'AMBIGUOUS 거절이 검수 호출보다 앞에 있어야 한다')
    // grant issue: AMBIGUOUS 면 발급 전에 2
    const issueAt = source.indexOf("if (identity.kind === 'AMBIGUOUS' && !(values.basis")
    assert.ok(issueAt > 0, 'grant issue 경로에 AMBIGUOUS 분기가 없다')
    const issueForSessionAt = source.indexOf('grants.issueForSession(', issueAt)
    const issueReturnAt = source.indexOf('return 2', issueAt)
    assert.ok(issueReturnAt > issueAt && issueReturnAt < issueForSessionAt, '발급 전에 거절해야 한다')
    // 어디에서도 undefined 로 뭉개지 않는다
    assert.doesNotMatch(source, /bindingIdentity\([^)]*\)\s*\?\?\s*undefined/)
  })
})
