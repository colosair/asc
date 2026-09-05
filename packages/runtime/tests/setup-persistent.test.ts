// Gate 7 — 지속 등록이 기존 setup 에 합류한다 (설계 §6).
//
// 지키는 문장 둘:
//   사용자가 켜는 별도 단계를 만들지 않는다 — 같은 plan 이 함께 판단한다
//   못 하는 것을 "할 일"로 적지 않는다

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { applySetupPlan, computeSetupPlan, renderSetupPlan } from '../core/attach/setup-plan.ts'

const base = {
  projectRoot: '/p',
  git: true,
  scope: 'local' as const,
  profileCandidates: ['x'],
  requestedProfile: 'x',
  host: [] as { id: string; status: string }[],
  ascRoot: '/home/me/.asc/workspaces/W-1',
  entry: 'runtime' as const,
}

describe('setup — 지속 등록은 같은 계획에 든다', () => {
  it('등록이 없으면 계획에 담는다 — 사용자가 따로 켜지 않는다', () => {
    const plan = computeSetupPlan({
      ...base,
      persistentRuntime: { action: 'install', adapter: 'launchd' },
    })
    assert.ok(plan.changes.some((change) => change.target === 'persistent-runtime'))
    assert.equal(plan.requiresUserAction, false)
    assert.match(renderSetupPlan(plan).join('\n'), /register this machine's ASC runtime with launchd/)
  })

  it('이미 등록돼 있으면 변경이 없다 — 멱등이다', () => {
    const plan = computeSetupPlan({ ...base, persistentRuntime: { action: 'none', adapter: 'launchd' } })
    assert.equal(plan.changes.some((change) => change.target === 'persistent-runtime'), false)
  })

  it('쓸 수 없는 OS 는 계획에 담지 않고 setup 을 세우지도 않는다', () => {
    const plan = computeSetupPlan({
      ...base,
      persistentRuntime: { action: 'unsupported', adapter: 'none', detail: 'no service manager' },
    })
    assert.equal(plan.changes.some((change) => change.target === 'persistent-runtime'), false)
    assert.equal(plan.requiresUserAction, false)
    // 왜 그런지는 근거에 남는다 — 조용히 빠지지 않는다
    assert.match(plan.evidence.join('\n'), /persistent=unsupported/)
  })

  it('프로젝트를 아직 못 골랐어도 등록은 계획에 남는다', () => {
    // 기계 수준 준비는 profile 선택과 무관하다 — stable runtime 설치와 같은 자리다
    const plan = computeSetupPlan({
      ...base,
      requestedProfile: undefined,
      profileCandidates: ['a', 'b'],
      ascRoot: undefined,
      persistentRuntime: { action: 'install', adapter: 'launchd' },
    })
    assert.equal(plan.status, 'user_action_required')
    assert.ok(plan.changes.some((change) => change.target === 'persistent-runtime'))
  })

  it('이 갈래를 모르는 호출자에게는 적용되지 않은 것으로 남는다', async () => {
    const plan = computeSetupPlan({ ...base, persistentRuntime: { action: 'install', adapter: 'launchd' } })
    const result = await applySetupPlan(plan, {
      installRuntime: async () => {},
      attachWorkspace: async () => {},
      installHost: async () => {},
    })
    assert.equal(result.applied.some((change) => change.target === 'persistent-runtime'), false)
  })

  it('아는 호출자에게는 한 번만 적용된다', async () => {
    let registered = 0
    const plan = computeSetupPlan({ ...base, persistentRuntime: { action: 'install', adapter: 'launchd' } })
    await applySetupPlan(plan, {
      installRuntime: async () => {},
      attachWorkspace: async () => {},
      installHost: async () => {},
      registerPersistentRuntime: async () => {
        registered += 1
      },
    })
    assert.equal(registered, 1)
  })
})

// 등록은 기계 하나를 바꾼다 — 아무 실행에서나 하지 않는다.
describe('등록을 시도해도 되는 실행인가', () => {
  it('checkout 에서 도는 실행은 이 축을 그리지 않는다', async () => {
    // 등록물은 지금 도는 진입점의 절대 경로를 박는다. checkout 경로를 기계에 박으면
    // 그 경로가 사라진 뒤에도 서비스가 남는다.
    const source = await readFile(new URL('../cli/asc.ts', import.meta.url), 'utf8')
    assert.match(source, /runningFromInstalledPackage/)
    assert.match(source, /node_modules\/@asc-agent\/runtime\//)
    // setup 판정이 그 문을 먼저 지난다
    assert.match(source, /if \(!serviceRegistrationAllowed\(\)\) return \{\}/)
  })

  it('격리 검증이 이 축을 끌 수 있다 — HOME 으로는 격리되지 않기 때문이다', async () => {
    const source = await readFile(new URL('../cli/asc.ts', import.meta.url), 'utf8')
    assert.match(source, /ASC_SERVICE === 'off'/)
    const smoke = await readFile(new URL('../../../scripts/tarball-smoke.mjs', import.meta.url), 'utf8')
    assert.match(smoke, /ASC_SERVICE: 'off'/)
  })

  it('등록 실패가 attach 실패가 되지 않는다', async () => {
    const source = await readFile(new URL('../cli/asc.ts', import.meta.url), 'utf8')
    const block = source.slice(source.indexOf('registerPersistentRuntime: async'))
    // 던지면 프로젝트가 붙는 것까지 같이 실패한다 — 다른 축이다
    assert.match(block.slice(0, 700), /catch \(error\)/)
    assert.doesNotMatch(block.slice(0, 700), /throw new Error/)
  })
})
