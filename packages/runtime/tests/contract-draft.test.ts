// Session Contract Drafting — 설치 검증과 실제 업무를 갈라 놓는다.
//
// 이 파일이 지키는 것 둘:
//
//   ① **설치를 증명하려고 세션을 만들지 않는다.** attachment READY가 setup의 끝이고,
//      거기에 세션을 하나 붙여 초록 줄을 만드는 것은 없는 계약을 지어내는 것이다.
//   ② 실제 업무가 들어오면, 근거가 충분한 만큼은 agent가 스스로 채우고, **진짜 경계만**
//      사람에게 남긴다. 부족하다고 넷을 통째로 되묻지 않는다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { planSessionContract, type SessionContractDraft } from '../core/operator/contract-draft.ts'
import type { OwnershipMap } from '../core/policy/ownership.ts'
import type { ResolvedPolicy } from '../core/policy/policy.ts'

const CLI = join(import.meta.dirname, '..', 'cli', 'asc.ts')

const policy = (roleScopes: Record<string, string[]>, delegated?: string[]): ResolvedPolicy =>
  ({
    hardDeny: [],
    softDeny: [],
    allow: [],
    roleScopes,
    settings: {},
    lockedSettings: [],
    // Profile은 `policy.unionLists` 로 선언하고, 계층 병합이 끝나면 여기로 온다.
    lists: delegated ? { issuanceDelegation: delegated } : {},
    requiredCapabilities: [],
    optionalCapabilities: [],
    layers: ['test'],
  }) as unknown as ResolvedPolicy

const ownership: OwnershipMap = {
  frontend: { paths: ['src/**'], authorities: ['client-ui'] },
  backend: { paths: ['server/**'], authorities: ['api-contract'] },
}

const draft = (over: Partial<SessionContractDraft> = {}): SessionContractDraft => ({
  id: 'S-20260828-01',
  role: 'implementer',
  goal: 'implement the thing the issue describes',
  boundary: ['src/**'],
  criteria: ['acceptance in the issue', 'existing tests pass'],
  ...over,
})

describe('Case B — 근거가 충분하면 질문 0으로 발급까지 간다', () => {
  it('구조와 경계가 다 맞으면 READY_TO_ISSUE다', () => {
    const plan = planSessionContract({ draft: draft(), policy: policy({ implementer: ['src/**'] }), ownership })
    assert.equal(plan.status, 'READY_TO_ISSUE')
    assert.deepEqual(plan.unresolved, [], '물을 것이 없는데 물었다')
    assert.deepEqual(plan.invalid, [])
  })

  it('출처를 적으면 사실과 제안이 갈린다 — 적지 않으면 사실로 올리지 않는다', () => {
    const plan = planSessionContract({
      draft: draft({
        provenance: [
          { field: 'id', status: 'FACT', source: 'user' },
          { field: 'goal', status: 'FACT', source: 'work_item' },
          { field: 'boundary', status: 'PROPOSAL', source: 'repository', reason: 'issue touches the client only' },
        ],
      }),
      policy: policy({ implementer: ['src/**'] }),
      ownership,
    })
    assert.deepEqual(
      plan.facts.map((f) => f.field).sort(),
      ['goal', 'id'],
    )
    // role·criteria는 출처를 안 적었다 — 사실이 아니라 제안으로 센다.
    const proposed = plan.proposals.map((p) => p.field)
    assert.ok(proposed.includes('role') && proposed.includes('criteria'))
    assert.ok(
      plan.proposals.some((p) => p.field === 'role' && p.reason === 'source not declared'),
      '어디서 왔는지 모르는 값을 조용히 사실로 만들었다',
    )
  })

  // OM §450 — 발급 권한은 사람의 것이다. 위임은 그 문장을 뒤집는 것이 아니라,
  // "매번 사람이 직접 쳐야 한다"는 해석만 푸는 것이다.
  it('계약이 성립해도 위임이 없으면 발급은 Controller의 것이다', () => {
    const plan = planSessionContract({ draft: draft(), policy: policy({ implementer: ['src/**'] }), ownership })
    assert.equal(plan.status, 'READY_TO_ISSUE')
    assert.equal(plan.issuance.authority, 'controller')
    assert.deepEqual(plan.issuance.delegatedRoles, [])
  })

  it('Controller가 그 역할을 위임했으면 agent가 발급한다', () => {
    const plan = planSessionContract({
      draft: draft(),
      policy: policy({ implementer: ['src/**'] }, ['implementer']),
      ownership,
    })
    assert.equal(plan.issuance.authority, 'delegated')
  })

  it('위임은 역할별이다 — 다른 역할까지 따라오지 않는다', () => {
    const plan = planSessionContract({
      draft: draft({ role: 'verifier' }),
      policy: policy({ verifier: ['src/**'] }, ['implementer']),
      ownership,
    })
    assert.equal(plan.issuance.authority, 'controller')
    assert.match(plan.issuance.detail, /not for verifier/)
  })

  it('owner를 안 적었어도 경계로 주인이 정해지면 질문이 아니라 제안이다', () => {
    const plan = planSessionContract({ draft: draft(), policy: policy({ implementer: ['src/**'] }), ownership })
    assert.ok(plan.proposals.some((p) => p.field === 'owner' && /frontend/.test(p.reason ?? '')))
    assert.equal(plan.unresolved.length, 0)
  })
})

describe('Case C — 부족하면 결정 지점만 묻는다', () => {
  it('빈 초안이어도 무엇이 없는지 필드별로 말한다 — 서식을 내밀지 않는다', () => {
    const plan = planSessionContract({ draft: {} })
    assert.equal(plan.status, 'NEEDS_DECISION')
    assert.deepEqual(
      plan.unresolved.map((u) => u.field).sort(),
      ['boundary', 'criteria', 'goal', 'id', 'role'],
    )
    for (const item of plan.unresolved) assert.equal(item.reason, 'missing_input')
  })

  it('주인 후보가 여럿이면 고르지 않고 추천과 함께 선택지를 준다', () => {
    const plan = planSessionContract({
      draft: draft({ boundary: ['src/**'] }),
      policy: policy({ implementer: ['src/**'] }),
      ownership: { a: { paths: ['src/**'], authorities: [] }, b: { paths: ['src/**'], authorities: [] } },
    })
    const question = plan.unresolved.find((u) => u.field === 'owner')
    assert.ok(question, '후보가 여럿인데 조용히 하나를 골랐다')
    assert.equal(question.reason, 'multiple_options')
    assert.deepEqual(question.options, ['a', 'b'])
    assert.equal(question.recommended, 0, '선택지만 주고 추천이 없으면 판단을 떠넘긴 것이다')
  })

  it('여러 후보는 escalation 사유가 아니다 — 그 자체로 사람에게 올리지 않는다', () => {
    const plan = planSessionContract({
      draft: draft(),
      policy: policy({ implementer: ['src/**'] }),
      ownership: { a: { paths: ['src/**'], authorities: [] }, b: { paths: ['src/**'], authorities: [] } },
    })
    // 판정은 NEEDS_DECISION이되, 사유는 경계 침범이 아니라 "고를 것이 여럿"이다.
    assert.equal(plan.status, 'NEEDS_DECISION')
    assert.ok(plan.unresolved.every((u) => u.reason !== 'ownership_boundary'))
  })
})

describe('Case D — 진짜 경계면 fail-closed', () => {
  it('role 최대 범위 밖은 넓혀서 해소하지 않는다', () => {
    const plan = planSessionContract({
      draft: draft({ boundary: ['server/**'] }),
      policy: policy({ implementer: ['src/**'] }),
      ownership,
    })
    assert.equal(plan.status, 'NEEDS_DECISION')
    const blocked = plan.unresolved.find((u) => u.field === 'boundary')
    assert.ok(blocked)
    assert.equal(blocked.reason, 'ownership_boundary')
    assert.match(blocked.options?.[0] ?? '', /narrow the boundary/, '첫 제안이 범위 확장이면 안 된다')
  })

  it('남의 파트 산출물을 만들고 있으면 preflight가 그렇게 말한다', () => {
    const plan = planSessionContract({
      draft: draft({ boundary: ['src/**'], owner: 'backend' }),
      policy: policy({ implementer: ['src/**'] }),
      ownership,
    })
    assert.ok(plan.unresolved.some((u) => u.reason === 'ownership_boundary'))
  })

  it('결정 주인이 정해지지 않은 영역은 발급 전에 멈춘다', () => {
    const plan = planSessionContract({
      draft: draft({ decisionDomains: ['pricing-policy'] }),
      policy: policy({ implementer: ['src/**'] }),
      ownership,
    })
    assert.equal(plan.status, 'NEEDS_DECISION')
    assert.ok(plan.unresolved.some((u) => u.field === 'owner' && /no part declares authority/.test(u.detail)))
  })

  it('문법이 깨진 초안은 계약이 아니다 — 경계를 따지기 전에 INVALID다', () => {
    // `/abs/path` 는 scope 문법 밖이다. (`../escape` 는 문법으로는 통과하고 범위 대조에서
    // 걸린다 — 문법 검사와 경계 검사는 서로 다른 자물쇠다.)
    const plan = planSessionContract({ draft: draft({ id: 'not-an-id', boundary: ['/abs/path'] }) })
    assert.equal(plan.status, 'INVALID')
    assert.ok(plan.invalid.some((i) => i.field === 'id'))
    assert.ok(plan.invalid.some((i) => i.field === 'boundary'))
    assert.equal(plan.preflight, undefined, '성립하지 않는 초안의 경계를 따졌다')
  })

  it('이미 있는 id는 미리 말한다 — 발급에서 처음 알게 하지 않는다', () => {
    const plan = planSessionContract({ draft: draft(), existingIds: ['S-20260828-01'] })
    assert.equal(plan.status, 'INVALID')
    assert.ok(plan.invalid.some((i) => /already exists/.test(i.detail)))
  })
})

describe('Case A — 설치만 했으면 세션은 0이다', () => {
  async function scratch(): Promise<{ repo: string; env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
    const base = await mkdtemp(join(tmpdir(), 'asc-draft-'))
    const repo = join(base, 'repo')
    spawnSync('git', ['init', '-q', repo])
    await writeFile(join(repo, 'a.txt'), 'x\n', 'utf8')
    return {
      repo,
      env: {
        ...process.env,
        HOME: join(base, 'home'),
        USERPROFILE: join(base, 'home'),
        ASC_HOME: join(base, 'asc'),
        NO_COLOR: '1',
      },
      cleanup: () => rm(base, { recursive: true, force: true }),
    }
  }

  const run = (cwd: string, env: NodeJS.ProcessEnv, args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' })

  it('attach만 하면 READY이고, 세션은 하나도 만들어지지 않는다', async () => {
    const { repo, env, cleanup } = await scratch()
    try {
      assert.equal(run(repo, env, ['setup', 'apply', '--profile', 'pilot-local', '--json']).status, 0)

      const status = JSON.parse(run(repo, env, ['setup', 'status', '--json']).stdout)
      assert.equal(status.attachment, 'READY', 'setup의 끝은 READY다')

      // **여기가 이 테스트의 요점이다.** setup은 세션을 만들지 않는다.
      const listed = run(repo, env, ['session', 'list'])
      assert.equal(listed.status, 0)
      assert.match(listed.stdout, /No sessions/, '설치를 증명하려고 세션을 만들었다')
    } finally {
      await cleanup()
    }
  })

  it('plan은 초안을 재기만 한다 — 세션을 만들지 않는다', async () => {
    const { repo, env, cleanup } = await scratch()
    try {
      run(repo, env, ['setup', 'apply', '--profile', 'pilot-local', '--json'])
      const out = run(repo, env, [
        'session', 'plan', '--json',
        '--id', 'S-20260828-01', '--role', 'implementer', '--goal', 'work',
        '--boundary', 'src/**', '--criteria', 'tests pass',
      ])
      const plan = JSON.parse(out.stdout)
      assert.equal(plan.status, 'READY_TO_ISSUE')
      assert.equal(out.status, 0)
      // 계약이 성립해도 발급은 사람의 것이다 — 위임이 없으면 실행 명령을 주지 않는다.
      assert.equal(plan.issuance.authority, 'controller')
      assert.deepEqual(plan.actions, [], '위임 없이 발급 명령을 실행 목록에 넣었다')
      assert.match(plan.forController.display, /^asc session issue S-20260828-01 /)

      assert.match(run(repo, env, ['session', 'list']).stdout, /No sessions/, 'plan이 세션을 만들었다')
    } finally {
      await cleanup()
    }
  })

  it('사람이 정할 것이 남으면 1로 끝나고 실행할 명령을 주지 않는다', async () => {
    const { repo, env, cleanup } = await scratch()
    try {
      run(repo, env, ['setup', 'apply', '--profile', 'pilot-local', '--json'])
      const out = run(repo, env, ['session', 'plan', '--json', '--role', 'implementer', '--goal', 'work'])
      const plan = JSON.parse(out.stdout)
      assert.equal(plan.status, 'NEEDS_DECISION')
      assert.equal(out.status, 1)
      assert.deepEqual(plan.actions, [], '아직 성립하지 않은 초안의 발급 명령을 줬다')
    } finally {
      await cleanup()
    }
  })

  it('저장소에는 아무것도 남지 않는다', async () => {
    const { repo, env, cleanup } = await scratch()
    try {
      run(repo, env, ['setup', 'apply', '--profile', 'pilot-local', '--json'])
      run(repo, env, ['session', 'plan', '--id', 'S-20260828-01', '--role', 'implementer', '--goal', 'w'])
      assert.deepEqual((await readdir(repo)).filter((f) => f !== '.git'), ['a.txt'])
    } finally {
      await cleanup()
    }
  })
})
