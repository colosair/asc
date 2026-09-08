// 0.8.4 — 실제 작업이 ASC 정문으로 들어오지 못한 자리들 (C-1 · C-2 · C-10 · C-11).
//
// 정문은 `asc work start <WORK-KEY>` 다. 그 문이 닫혀 있던 이유는 "통로가 없다" 가 아니라
// **"통로가 있는데 아무도 그것을 선언하지 않았고, 어느 화면도 그 사실을 말하지 않았다"** 였다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BindingPlan, Capability, ResolvedBinding } from '../core/binding/types.ts'
import { undeclaredBindings, workItemGap, workItemRoles } from '../composition/runtime.ts'
import { addressableHere, MANAGED_EXTERNAL_ACTIONS } from '../ports/scm.ts'

const CODE: readonly Capability[] = [
  'observe.delta',
  'inventory.enumerate',
  'context.resource',
  'context.thread',
  'context.change',
  'canonical.read',
  'coordination.surface',
]
const WORK: readonly Capability[] = ['observe.delta', 'inventory.enumerate', 'context.resource', 'context.thread']

function binding(patch: Partial<ResolvedBinding> & Pick<ResolvedBinding, 'adapterId' | 'resource'>): ResolvedBinding {
  return { state: 'AVAILABLE', provides: CODE, ...patch }
}

/** 실기계와 같은 모양: 코드는 선언된 원격 하나, 작업 항목은 발견만 된 도구 하나. */
function plan(patch: { workState?: ResolvedBinding['state']; workDetail?: string } = {}): BindingPlan {
  return {
    bindings: [
      binding({ adapterId: 'code-remote', resource: 'group/project', role: 'code-primary', state: 'DEGRADED' }),
      binding({ adapterId: 'mirror', resource: 'other/mirror', discoveredBy: 'git remote' }),
      binding({
        adapterId: 'tracker',
        resource: 'KEY',
        provides: WORK,
        state: patch.workState ?? 'AVAILABLE',
        discoveredBy: 'declaration file',
        ...(patch.workDetail ? { detail: patch.workDetail } : {}),
      }),
    ],
  }
}

const DECLARED = [{ role: 'code-primary', adapter: 'code-remote', resource: 'group/project' }]

describe('C-2 — 발견됐는데 선언되지 않은 것을 침묵으로 두지 않는다', () => {
  it('선언되지 않은 결합을 전부 든다', () => {
    const undeclared = undeclaredBindings(plan(), DECLARED)
    assert.deepEqual(
      undeclared.map((b) => `${b.adapterId}:${b.resource}`).sort(),
      ['mirror:other/mirror', 'tracker:KEY'],
    )
  })

  it('지금 못 쓰는 것도 든다 — 그것을 빼는 것이 곧 그 침묵이었다', () => {
    const undeclared = undeclaredBindings(plan({ workState: 'UNCONFIGURED', workDetail: 'registration stale' }), DECLARED)
    const tracker = undeclared.find((b) => b.adapterId === 'tracker')
    assert.ok(tracker, '못 쓴다는 이유로 사라지면 사람은 그것이 있는 줄도 모른다')
    assert.equal(tracker.state, 'UNCONFIGURED')
    assert.equal(tracker.detail, 'registration stale', '상태만 주면 고칠 수가 없다')
  })

  it('capability 모양으로 자리를 가른다 — provider 이름으로 가르지 않는다', () => {
    const undeclared = undeclaredBindings(plan(), DECLARED)
    assert.equal(undeclared.find((b) => b.adapterId === 'tracker')?.shape, 'work-item')
    assert.equal(undeclared.find((b) => b.adapterId === 'mirror')?.shape, 'code')
  })

  it('붙이는 방법을 함께 준다', () => {
    const tracker = undeclaredBindings(plan(), DECLARED).find((b) => b.adapterId === 'tracker')!
    assert.deepEqual(tracker.declaration, { role: 'work', adapter: 'tracker', resource: 'KEY' })
  })

  it('선언된 것은 이 목록에 없다', () => {
    const undeclared = undeclaredBindings(plan(), DECLARED)
    assert.equal(undeclared.some((b) => b.adapterId === 'code-remote'), false)
  })
})

describe('C-1 — 작업 항목 통로가 비어 있다는 사실과 그 이유가 함께 나온다', () => {
  it('선언이 없으면 배정되지 않고, 후보를 이름으로 든다', () => {
    const gap = workItemGap(plan(), DECLARED)
    assert.equal(gap.assigned, false, '이것이 "미확인 work-item" 의 실제 원인이다')
    assert.deepEqual(gap.candidates.map((c) => c.adapterId), ['tracker'])
  })

  it('선언하면 배정된다 — 코드가 이미 그렇게 되어 있었다', () => {
    const declared = [...DECLARED, { role: 'work', adapter: 'tracker', resource: 'KEY' }]
    const withRole: BindingPlan = {
      bindings: plan().bindings.map((b) => (b.adapterId === 'tracker' ? { ...b, role: 'work' } : b)),
    }
    assert.equal(workItemGap(withRole, declared).assigned, true)
    assert.equal(workItemRoles(withRole, declared)['context.resource'], 'work')
  })

  it('못 쓰는 후보도 후보로 든다 — 붙일 수 없는 것과 안 붙인 것은 다른 문제다', () => {
    const gap = workItemGap(plan({ workState: 'UNCONFIGURED', workDetail: 'registration stale' }), DECLARED)
    assert.equal(gap.assigned, false)
    assert.equal(gap.candidates[0]?.state, 'UNCONFIGURED')
  })
})

describe('C-10 — dead-end 는 이 workspace 가 실제로 쓰는 것만 센다', () => {
  const known = new Set(['gitlab', 'github', 'jam'])

  it('선언하지 않은 provider 의 행위는 세지 않는다', () => {
    assert.equal(
      addressableHere('github.issue_comment.create', { declared: new Set(['gitlab']), known }),
      false,
      'GitLab 하나만 선언한 저장소가 영영 하지 않을 행위다',
    )
  })

  it('선언한 provider 의 행위는 센다', () => {
    assert.equal(addressableHere('gitlab.mr.create', { declared: new Set(['gitlab']), known }), true)
  })

  it('provider 중립 행위는 언제나 센다', () => {
    for (const action of ['git.push', 'coordination.publish']) {
      assert.equal(addressableHere(action, { declared: new Set(['gitlab']), known }), true)
    }
  })

  it('scope 를 모르면 좁히지 않는다 — 0.8.3 의 계산을 그대로 둔다', () => {
    for (const action of MANAGED_EXTERNAL_ACTIONS) assert.equal(addressableHere(action), true)
  })

  it('provider hardcode 로 되돌아가지 않는다', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../ports/scm.ts', import.meta.url), 'utf8')
    const predicate = source.slice(source.indexOf('export function addressableHere'))
    for (const name of ['gitlab', 'github', 'jam']) {
      assert.doesNotMatch(predicate, new RegExp(`'${name}'`), `${name} 이 판정 안에 박혀 있다`)
    }
  })
})
