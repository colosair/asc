// 설계 §9.2~§9.4 — Profile 이 JAM 을 선언했으면 다시 묻지 않는다.
//
// 지키는 문장 셋:
//   진단도 수리도 JAM 이 한다 — ASC 는 언제 부를지만 정한다
//   버전을 지어내지 않는다 — JAM 이 말한 자기 버전을 그대로 쓴다
//   사람만 할 수 있는 것 앞에서는 멈춘다

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { healJam, healLine, jamBootstrapCommand } from '../adapters/jam/setup.ts'
import { applySetupPlan, computeSetupPlan } from '../core/attach/setup-plan.ts'

type Call = { command: string; args: string[] }

const runner = (replies: Record<string, unknown>) => {
  const calls: Call[] = []
  const exec = async (command: string, args: readonly string[]): Promise<string> => {
    calls.push({ command, args: [...args] })
    const key = args.includes('apply') ? 'apply' : 'plan'
    const reply = replies[key]
    if (reply === undefined) throw new Error(`unexpected ${key}`)
    return JSON.stringify(reply)
  }
  return { calls, exec }
}

describe('JAM self-heal — 공식 경로로만 고친다', () => {
  it('버전은 JAM 이 말한 것을 그대로 핀으로 쓴다', () => {
    const { command, args } = jamBootstrapCommand('1.4.5', ['setup', 'plan', '--json'])
    assert.equal(command, 'npx')
    // @latest 금지 · 정확한 핀. 그 값을 ASC 가 정하지 않는다.
    assert.deepEqual(args, ['--yes', '@jam-mcp/bootstrap@1.4.5', 'setup', 'plan', '--json'])
  })

  it('고칠 것이 없으면 아무것도 실행하지 않는다', async () => {
    const { calls, exec } = runner({ plan: { status: 'ready_to_apply', requiresUserAction: false, changes: [] } })
    assert.deepEqual(await healJam({ cwd: '/p', version: '1.4.5', exec }), { kind: 'ALREADY_READY' })
    assert.equal(calls.length, 1, 'plan 만 보고 끝난다')
  })

  it('사람이 필요 없으면 계획을 그대로 적용한다 — 다시 묻지 않는다', async () => {
    const { calls, exec } = runner({
      // 실측한 모양 그대로다: host 등록이 낡아 두 건이 바뀐다
      plan: { status: 'ready_to_apply', requiresUserAction: false, changes: [{ target: 'host-mcp' }, { target: 'host-mcp' }] },
      apply: { status: 'applied', requiresUserAction: false },
    })
    assert.deepEqual(await healJam({ cwd: '/p', version: '1.4.5', exec }), { kind: 'HEALED', changes: 2 })
    assert.deepEqual(calls.map((call) => call.args.slice(2)), [
      ['setup', 'plan', '--json'],
      ['setup', 'apply', '--non-interactive', '--json'],
    ])
  })

  it('사람이 필요하면 적용하지 않는다 — 자격은 ASC 가 대신하지 않는다', async () => {
    const { calls, exec } = runner({
      plan: { status: 'blocked', requiresUserAction: true, code: 'JAM_AUTH_REQUIRED' },
    })
    const outcome = await healJam({ cwd: '/p', version: '1.4.5', exec })
    assert.deepEqual(outcome, { kind: 'NEEDS_HUMAN', detail: 'JAM_AUTH_REQUIRED' })
    assert.equal(calls.length, 1, 'apply 를 부르지 않았다')
    assert.match(healLine(outcome), /does not sign in for you/)
  })

  it('적용 뒤에도 사람이 필요하다고 하면 그렇게 전한다', async () => {
    const { exec } = runner({
      plan: { status: 'ready_to_apply', requiresUserAction: false, changes: [{ target: 'host-mcp' }] },
      apply: { status: 'blocked', requiresUserAction: true, code: 'JAM_PROJECT_SELECTION_REQUIRED' },
    })
    assert.deepEqual(await healJam({ cwd: '/p', version: '1.4.5', exec }), {
      kind: 'NEEDS_HUMAN',
      detail: 'JAM_PROJECT_SELECTION_REQUIRED',
    })
  })

  it('읽지 못한 것을 "고쳤다"로 적지 않는다', async () => {
    const exec = async () => 'not json'
    const outcome = await healJam({ cwd: '/p', version: '1.4.5', exec })
    assert.equal(outcome.kind, 'FAILED')
  })

  it('토큰을 다루는 경로가 없다', async () => {
    const source = await (await import('node:fs/promises')).readFile(
      new URL('../adapters/jam/setup.ts', import.meta.url),
      'utf8',
    )
    assert.doesNotMatch(source, /token|apiToken|password|credential=/i)
  })
})

// 설계 §9.3 — Profile 이 이미 정한 것을 setup 이 다시 묻지 않는다.
describe('setup plan — 선언된 작업 도구의 준비 상태', () => {
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

  it('고칠 수 있으면 계획에 담는다 — 사람에게 되묻지 않는다', () => {
    const plan = computeSetupPlan({
      ...base,
      workBinding: { adapter: 'jam', resource: 'WORK', ready: false, remedy: 'SELF_HEAL', version: '1.4.5' },
    })
    assert.equal(plan.requiresUserAction, false)
    const change = plan.changes.find((c) => c.target === 'work-binding-setup')
    assert.ok(change, '계획에 담긴다')
    assert.equal(change.target === 'work-binding-setup' && change.version, '1.4.5')
  })

  it('사람만 할 수 있는 것 앞에서는 멈춘다 — 자격은 ASC 가 대신하지 않는다', () => {
    const plan = computeSetupPlan({
      ...base,
      workBinding: { adapter: 'jam', resource: 'WORK', ready: false, remedy: 'HUMAN', detail: 'JAM_AUTH_REQUIRED' },
    })
    assert.equal(plan.status, 'user_action_required')
    assert.equal(plan.code, 'ASC_WORK_BINDING_NEEDS_USER')
    assert.equal(plan.changes.some((c) => c.target === 'work-binding-setup'), false)
  })

  it('다시 돌려도 소용없는 것은 계획에 담지 않는다', () => {
    const plan = computeSetupPlan({
      ...base,
      workBinding: { adapter: 'jam', resource: 'WORK', ready: false, remedy: 'HARD', detail: 'bad config' },
    })
    assert.equal(plan.changes.some((c) => c.target === 'work-binding-setup'), false)
    assert.equal(plan.requiresUserAction, false, '고칠 수 없다고 setup 전체를 세우지 않는다')
  })

  it('버전을 모르면 부르지 않는다 — 지어내지 않는다', () => {
    const plan = computeSetupPlan({
      ...base,
      workBinding: { adapter: 'jam', resource: 'WORK', ready: false, remedy: 'SELF_HEAL' },
    })
    assert.equal(plan.changes.some((c) => c.target === 'work-binding-setup'), false)
  })

  it('준비돼 있으면 아무 변경도 만들지 않는다', () => {
    const plan = computeSetupPlan({
      ...base,
      workBinding: { adapter: 'jam', resource: 'WORK', ready: true },
    })
    assert.equal(plan.changes.some((c) => c.target === 'work-binding-setup'), false)
  })

  it('이 갈래를 모르는 호출자에게는 적용되지 않은 것으로 남는다', async () => {
    const plan = computeSetupPlan({
      ...base,
      workBinding: { adapter: 'jam', resource: 'WORK', ready: false, remedy: 'SELF_HEAL', version: '1.4.5' },
    })
    const result = await applySetupPlan(plan, {
      installRuntime: async () => {},
      attachWorkspace: async () => {},
      installHost: async () => {},
    })
    // 안 한 것을 "했다"로 적지 않는다
    assert.equal(result.applied.some((c) => c.target === 'work-binding-setup'), false)
  })
})
