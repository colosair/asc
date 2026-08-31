// B-69 Gate — 사람과 agent가 같은 판단을 나눠 쓴다 (C-14 §6·§7, 불변식 ①·⑩·⑫).
//
// 가장 중요한 검사 둘: **plan은 아무것도 바꾸지 않는다**, 그리고 **apply는 plan에 없는
// 것을 하지 않는다.** 이 둘이 깨지면 plan은 아무것도 보장하지 않는 문서가 된다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { describe, it } from 'node:test'

import {
  applySetupPlan,
  computeSetupPlan,
  renderSetupPlan,
  type SetupChange,
  type SetupState,
} from '../core/attach/setup-plan.ts'

const CLI = join(import.meta.dirname, '..', 'cli', 'asc.ts')
/** ESC 를 리터럴로 적지 않는다 — 소스에 제어문자를 남기지 않기 위해서다. */
const ANSI = new RegExp(String.fromCharCode(27) + '\\[')

const state = (over: Partial<SetupState> = {}): SetupState => ({
  entry: 'bootstrap',
  projectRoot: '/tmp/project',
  git: true,
  profileCandidates: ['pilot-local'],
  scope: 'local',
  host: [{ id: 'claude', status: 'INSTALLED_CURRENT' }],
  ...over,
})

describe('B-69 Gate — plan은 순수하다 (C-14 §6)', () => {
  it('붙지 않았고 후보가 하나면 붙일 계획을 낸다', () => {
    const plan = computeSetupPlan(state())
    assert.equal(plan.status, 'ready_to_apply')
    assert.deepEqual(plan.changes, [{ target: 'attach-workspace', scope: 'local', profile: 'pilot-local' }])
    assert.equal(plan.requiresUserAction, false)
  })

  it('후보가 여럿이면 고르지 않고 멈춘다 (C-06 §2)', () => {
    const plan = computeSetupPlan(state({ profileCandidates: ['pilot-local', 'example-team'] }))
    assert.equal(plan.code, 'ASC_PROFILE_SELECTION_REQUIRED')
    assert.equal(plan.requiresUserAction, true)
    assert.deepEqual(plan.profiles, ['pilot-local', 'example-team'])
    assert.equal(plan.changes.some((c) => c.target === 'attach-workspace'), false)
  })

  it('후보가 없어도 아무거나 만들지 않는다', () => {
    const plan = computeSetupPlan(state({ profileCandidates: [] }))
    assert.equal(plan.code, 'ASC_PROFILE_SELECTION_REQUIRED')
    assert.deepEqual(plan.profiles, [])
  })

  it('사람이 지정하면 후보가 여럿이어도 진행한다', () => {
    const plan = computeSetupPlan(
      state({ profileCandidates: ['pilot-local', 'example-team'], requestedProfile: 'example-team' }),
    )
    assert.equal(plan.status, 'ready_to_apply')
    assert.equal(plan.changes.find((c) => c.target === 'attach-workspace')?.profile, 'example-team')
  })

  it('붙어 있고 Host가 최신이면 바꿀 것이 없다', () => {
    const plan = computeSetupPlan(state({ ascRoot: '/home/u/.asc/workspaces/W-1' }))
    assert.equal(plan.status, 'already_configured')
    assert.deepEqual(plan.changes, [])
  })

  it('Host가 뒤처졌으면 맞추는 계획을 낸다 (L-5)', () => {
    const plan = computeSetupPlan(
      state({ ascRoot: '/w', host: [{ id: 'claude', status: 'INSTALLED_STALE' }] }),
    )
    assert.deepEqual(plan.changes, [{ target: 'host-install', host: 'claude', from: 'INSTALLED_STALE' }])
  })

  it('사람이 고친 설치물은 계획에 담지 않고 멈춘다 (불변식 ⑭)', () => {
    const plan = computeSetupPlan(
      state({ ascRoot: '/w', host: [{ id: 'claude', status: 'INSTALLED_MODIFIED' }] }),
    )
    assert.equal(plan.code, 'ASC_HOST_INSTALL_MODIFIED')
    assert.equal(plan.requiresUserAction, true)
    assert.deepEqual(plan.changes, [], '덮는 것은 사람이 정한다 — 몰래 계획에 넣지 않는다')
    assert.match(plan.nextActions.join(' '), /--force/)
  })

  it('사람이 읽는 줄과 JSON이 같은 plan에서 나온다 (불변식 ①)', () => {
    const plan = computeSetupPlan(state())
    const rendered = renderSetupPlan(plan).join('\n')
    assert.match(rendered, /ready_to_apply/)
    assert.match(rendered, /pilot-local/)
  })
})

describe('B-69 Gate — apply는 plan에 적힌 것만 한다 (불변식 ⑩)', () => {
  it('계획된 변경을 정확히 그만큼 실행한다', async () => {
    const done: SetupChange[] = []
    const plan = computeSetupPlan(state({ host: [{ id: 'claude', status: 'BROKEN' }] }))
    const outcome = await applySetupPlan(plan, {
      installRuntime: async (c) => void done.push(c),
      attachWorkspace: async (c) => void done.push(c),
      installHost: async (c) => void done.push(c),
    })
    assert.deepEqual(done, plan.changes)
    assert.equal(outcome.changesApplied, true)
  })

  it('빈 계획에는 아무것도 하지 않는다', async () => {
    const plan = computeSetupPlan(state({ ascRoot: '/w' }))
    const outcome = await applySetupPlan(plan, {
      installRuntime: async () => assert.fail('계획에 없는 변경'),
      attachWorkspace: async () => assert.fail('계획에 없는 변경'),
      installHost: async () => assert.fail('계획에 없는 변경'),
    })
    assert.equal(outcome.changesApplied, false)
  })
})

describe('B-69 Gate — agent 표면 (C-14 §7, 불변식 ⑫)', () => {
  async function scratch(): Promise<{ repo: string; env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
    const base = await mkdtemp(join(tmpdir(), 'asc-setup-'))
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

  const run = (repo: string, env: NodeJS.ProcessEnv, args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: 'utf8' })

  /** 저장소 전체를 훑는다. `.git` 은 보지 않는다. */
  async function snapshot(repo: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {}
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        const rel = relative(repo, full).split(sep).join('/')
        if (rel === '.git' || rel.startsWith('.git/')) continue
        if (entry.isDirectory()) await walk(full)
        else files[rel] = await readFile(full, 'utf8')
      }
    }
    await walk(repo)
    return files
  }

  it('stdout 전체가 하나의 JSON 문서다 — 일부만 뽑아내지 않는다', async () => {
    const { repo, env, cleanup } = await scratch()
    try {
      const out = run(repo, env, ['setup', 'plan', '--profile', 'pilot-local', '--json'])
      const parsed = JSON.parse(out.stdout)
      assert.equal(parsed.changesApplied, false)
      assert.ok(Array.isArray(parsed.changes))
      // ANSI가 섞이면 파이프·로그를 지나며 깨진다
      assert.doesNotMatch(out.stdout, ANSI)
    } finally {
      await cleanup()
    }
  })

  it('plan은 저장소를 한 바이트도 바꾸지 않는다', async () => {
    const { repo, env, cleanup } = await scratch()
    try {
      const before = await snapshot(repo)
      run(repo, env, ['setup', 'plan', '--profile', 'pilot-local', '--json'])
      assert.deepEqual(await snapshot(repo), before)
    } finally {
      await cleanup()
    }
  })

  it('apply --json 도 stdout은 JSON 하나이고, 저장소 footprint는 0이다', async () => {
    const { repo, env, cleanup } = await scratch()
    try {
      const before = await snapshot(repo)
      const out = run(repo, env, ['setup', 'apply', '--profile', 'pilot-local', '--json'])
      const parsed = JSON.parse(out.stdout)
      assert.equal(parsed.changesApplied, true)
      assert.deepEqual(parsed.remaining, [], 'apply 뒤에는 남은 변경이 없어야 한다 (멱등)')
      assert.deepEqual(await snapshot(repo), before, 'local scope는 저장소를 건드리지 않는다 (C-11)')
    } finally {
      await cleanup()
    }
  })

  // `--agent` 는 문서에서 사라졌지만 **동작은 남는다.** 0.2.0을 읽고 그 형태를 저장해 둔
  // agent가 다음 릴리스에서 갑자기 실패하면, 그것은 우리가 문서를 정리한 대가를 사용자가
  // 무는 것이다. canonical은 `--json` 하나이고, 이 검사는 옛 형태가 살아 있음을 고정한다.
  it('--agent 는 --json apply의 살아 있는 alias다 — 같은 판단, 같은 출력', async () => {
    const { repo, env, cleanup } = await scratch()
    try {
      const viaAgent = run(repo, env, ['setup', 'apply', '--profile', 'pilot-local', '--agent'])
      const viaJson = run(repo, env, ['setup', 'plan', '--profile', 'pilot-local', '--json'])
      assert.equal(JSON.parse(viaAgent.stdout).status, 'applied')
      assert.equal(JSON.parse(viaJson.stdout).status, 'already_configured', 'apply가 실제로 붙였어야 한다')
    } finally {
      await cleanup()
    }
  })

  it('사람이 답해야 하면 코드로 말한다 — 산문을 읽게 하지 않는다', async () => {
    const { repo, env, cleanup } = await scratch()
    try {
      const out = run(repo, env, ['setup', 'apply', '--json'])
      const parsed = JSON.parse(out.stdout)
      assert.equal(parsed.requiresUserAction, true)
      assert.equal(parsed.code, 'ASC_PROFILE_SELECTION_REQUIRED')
      assert.equal(parsed.changesApplied, false)
      assert.equal(out.status, 1)
    } finally {
      await cleanup()
    }
  })
})

describe('ASC-2 — 붙이다 만 상태는 붙일 것이 남은 상태다 (SSAFESTA Windows 실측)', () => {
  it('BROKEN attachment는 repair(attach-workspace)를 계획에 싣는다', () => {
    const plan = computeSetupPlan(
      state({ ascRoot: '/w', attachmentBroken: true, requestedProfile: 'pilot-local' }),
    )
    assert.equal(plan.status, 'ready_to_apply')
    assert.deepEqual(
      plan.changes.filter((c) => c.target === 'attach-workspace'),
      [{ target: 'attach-workspace', scope: 'local', profile: 'pilot-local' }],
    )
    assert.match(plan.evidence.join(' '), /BROKEN/)
  })

  it('BROKEN인데 고를 profile이 없으면 applied가 아니라 선택 요구로 멈춘다', () => {
    const plan = computeSetupPlan(
      state({ ascRoot: '/w', attachmentBroken: true, profileCandidates: [] }),
    )
    assert.equal(plan.code, 'ASC_PROFILE_SELECTION_REQUIRED')
    assert.equal(plan.requiresUserAction, true)
    // 실패할 proceed를 다음 행동으로 주지 않는다 — 그것이 ASC-2의 사고 형태였다.
    assert.equal(plan.actions.some((a) => a.type === 'proceed'), false)
  })

  it('BROKEN + 단일 후보면 그 후보로 다시 붙인다', () => {
    const plan = computeSetupPlan(state({ ascRoot: '/w', attachmentBroken: true }))
    assert.equal(plan.status, 'ready_to_apply')
    assert.equal(plan.changes.find((c) => c.target === 'attach-workspace')?.profile, 'pilot-local')
  })
})
