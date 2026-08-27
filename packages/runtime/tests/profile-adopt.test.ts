// P0 — URL만 받은 agent가 되묻지 않고 여기까지 온다.
//
// 검사의 초점 둘:
//
//   ① adopt는 **추론 가능한 것만** 적는다 — 정본 branch도 role 경계도 짓지 않는다.
//      지어내면 세션 발급이 없는 정본을 읽으려다 죽거나, 지어낸 경계가 사람을 막는다.
//   ② Profile gate에서 멈출 때 **아무 데도 남기지 않는다** — 저장소도, ASC_HOME도.
//      `setup apply` 가 알아서 그럴 것이라고 가정하지 않고 그 경로 자체를 본다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { describe, it } from 'node:test'

import { AdoptError, buildAdoptedProfile, toProfileId } from '../core/attach/adopt.ts'
import { ProjectProfile } from '../schemas/profile.ts'

const CLI = join(import.meta.dirname, '..', 'cli', 'asc.ts')

describe('P0 — adopt는 remote가 증명하는 것만 적는다', () => {
  it('remote에서 owner/repo 가 나오고, scm 이름은 host를 아는 쪽이 준다', () => {
    const input = {
      dirName: 'anything',
      remotes: [{ name: 'origin', url: 'git@example.com:example/fixture.git' }],
    }
    const adopted = buildAdoptedProfile(input)
    assert.equal(adopted.id, 'fixture')
    assert.deepEqual(ProjectProfile.parse(adopted.profile).project, {
      // provider를 모르면 `git` 이다. core가 host 이름으로 갈라지지 않는다 (C-09 §6.1).
      scm: 'git',
      repository: 'example/fixture',
    })

    const named = buildAdoptedProfile({ ...input, scmForHost: (host) => `scm-for-${host}` })
    assert.equal(ProjectProfile.parse(named.profile).project.scm, 'scm-for-example.com')
  })

  it('정본 branch도 role 경계도 짓지 않는다 — 모르는 것은 비운다', () => {
    const adopted = buildAdoptedProfile({
      dirName: 'fixture',
      remotes: [{ name: 'origin', url: 'https://gitlab.example.com/group/thing.git' }],
    })
    const parsed = ProjectProfile.parse(adopted.profile)
    // 정본을 지어내면 세션 발급이 그것을 실제로 읽으려 하고, 자격 없는 기계에서 죽는다.
    assert.deepEqual(parsed.canonical.sources, [])
    // 경계를 지어내면 그 경계가 곧 사람이 겪는 SCOPE_ESCALATION이 된다.
    assert.deepEqual(parsed.policy.roleScopes, {})
    assert.equal(parsed.project.scm, 'git', '아는 host가 아니면 provider를 단정하지 않는다')
    assert.ok(
      adopted.warnings.some((w) => w.includes('canonical.sources')),
      '비운 것을 말하지 않으면 사람은 비었다는 것을 모른다',
    )
  })

  it('remote가 없으면 local 프로젝트라고 말하고, 그 사실을 경고로 남긴다', () => {
    const adopted = buildAdoptedProfile({ dirName: 'my-repo', remotes: [] })
    const parsed = ProjectProfile.parse(adopted.profile)
    assert.equal(adopted.id, 'my-repo')
    assert.equal(parsed.project.scm, 'local')
    assert.equal(parsed.project.repository, 'local/my-repo')
    assert.ok(adopted.warnings.some((w) => w.includes('no remote')))
  })

  it("origin이 아닌 이름을 골랐으면 그렇다고 말한다 — 조용히 고르지 않는다", () => {
    const adopted = buildAdoptedProfile({
      dirName: 'x',
      remotes: [
        { name: 'fork', url: 'git@github.com:me/fork.git' },
        { name: 'upstream', url: 'git@github.com:them/upstream.git' },
      ],
    })
    assert.equal(adopted.id, 'fork', 'origin이 없으면 첫 번째다')
    assert.ok(adopted.warnings.some((w) => w.includes("No 'origin' remote")))
  })

  it('origin이 있으면 알파벳 순서와 무관하게 origin이다', () => {
    const adopted = buildAdoptedProfile({
      dirName: 'x',
      remotes: [
        { name: 'fork', url: 'git@github.com:me/fork.git' },
        { name: 'origin', url: 'git@github.com:them/real.git' },
      ],
    })
    assert.equal(adopted.id, 'real')
    assert.equal(ProjectProfile.parse(adopted.profile).project.repository, 'them/real')
  })

  it('id로 쓸 수 없는 이름은 조용히 만들어 내지 않고 멈춘다', () => {
    assert.equal(toProfileId('../escape'), 'escape')
    assert.equal(toProfileId('...'), null)
    assert.throws(
      () => buildAdoptedProfile({ dirName: '...', remotes: [] }),
      (error: unknown) => error instanceof AdoptError && error.code === 'NO_USABLE_ID',
    )
  })
})

describe('P0 — 제로베이스 경로 (CLI)', () => {
  async function scratch(remote?: string): Promise<{
    repo: string
    ascHome: string
    env: NodeJS.ProcessEnv
    cleanup: () => Promise<void>
  }> {
    const base = await mkdtemp(join(tmpdir(), 'asc-adopt-'))
    const repo = join(base, 'work', 'fixture')
    spawnSync('git', ['init', '-q', repo])
    await writeFile(join(repo, 'a.txt'), 'x\n', 'utf8')
    if (remote) spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', remote])
    const ascHome = join(base, 'asc')
    return {
      repo,
      ascHome,
      env: {
        ...process.env,
        HOME: join(base, 'home'),
        USERPROFILE: join(base, 'home'),
        ASC_HOME: ascHome,
        NO_COLOR: '1',
      },
      cleanup: () => rm(base, { recursive: true, force: true }),
    }
  }

  const run = (cwd: string, env: NodeJS.ProcessEnv, args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' })

  /** 있는 것 전부를 내용까지. 없으면 빈 표 — "없었다"도 상태다. */
  async function snapshot(root: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {}
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        const rel = relative(root, full).split(sep).join('/')
        if (entry.isDirectory()) await walk(full)
        else files[rel] = entry.isSymbolicLink() ? '(symlink)' : await readFile(full, 'utf8').catch(() => '(unreadable)')
      }
    }
    await walk(root)
    return files
  }

  it('붙기 전에도 돈다 — attach를 요구하지 않는다', async () => {
    const { repo, env, ascHome, cleanup } = await scratch('git@github.com:example/fixture.git')
    try {
      const out = run(repo, env, ['profile', 'adopt', '--json'])
      assert.equal(out.status, 0, out.stderr)
      const parsed = JSON.parse(out.stdout)
      assert.equal(parsed.id, 'fixture')
      assert.deepEqual(parsed.project, { scm: 'github', repository: 'example/fixture' })
      // 사용자 소유 공간에 쓴다. 저장소가 아니다.
      assert.equal(parsed.path, join(ascHome, 'profiles', 'fixture', 'profile.json'))
      const written = JSON.parse(await readFile(parsed.path, 'utf8'))
      ProjectProfile.parse(written)
    } finally {
      await cleanup()
    }
  })

  it('adopt는 저장소에 아무것도 남기지 않는다', async () => {
    const { repo, env, cleanup } = await scratch('git@github.com:example/fixture.git')
    try {
      const before = await snapshot(repo)
      run(repo, env, ['profile', 'adopt', '--json'])
      assert.deepEqual(await snapshot(repo), before)
    } finally {
      await cleanup()
    }
  })

  it('이미 있으면 덮지 않고 멈춘다 — 남의 Profile을 조용히 갈아 끼우지 않는다', async () => {
    const { repo, env, ascHome, cleanup } = await scratch('git@github.com:example/fixture.git')
    try {
      assert.equal(run(repo, env, ['profile', 'adopt', '--json']).status, 0)
      const before = await snapshot(join(ascHome, 'profiles'))
      const again = run(repo, env, ['profile', 'adopt', '--json'])
      assert.equal(again.status, 1)
      assert.match(again.stderr, /already there/)
      assert.match(again.stderr, /--id/, '다음에 무엇을 할 수 있는지 말한다')
      assert.deepEqual(await snapshot(join(ascHome, 'profiles')), before)
    } finally {
      await cleanup()
    }
  })

  it('adopt한 Profile로 붙고, status가 READY와 external을 말한다', async () => {
    const { repo, env, cleanup } = await scratch('git@github.com:example/fixture.git')
    try {
      run(repo, env, ['profile', 'adopt', '--json'])

      const plan = JSON.parse(run(repo, env, ['setup', 'plan', '--json']).stdout)
      assert.ok(plan.profiles.includes('fixture'), '만든 것이 후보로 보여야 한다')

      const applied = JSON.parse(run(repo, env, ['setup', 'apply', '--profile', 'fixture', '--agent']).stdout)
      assert.equal(applied.changesApplied, true)
      assert.deepEqual(applied.remaining, [])

      const status = JSON.parse(run(repo, env, ['setup', 'status', '--json']).stdout)
      assert.equal(status.attachment, 'READY')
      assert.deepEqual(status.profile, { id: 'fixture', origin: 'external' })

      // READY는 **기술적 준비**다 — 바깥으로 나가는 gate가 막혀 있어도 로컬 세션 루프는 선다.
      assert.ok(status.gates.some((gate: { state: string }) => gate.state === 'BLOCKED'))
      const issued = run(repo, env, [
        'session', 'issue', 'S-20260827-01',
        '--role', 'implementer', '--goal', 'check',
        '--boundary', 'src/**', '--criteria', 'N1', '--criteria', 'N2',
      ])
      assert.equal(issued.status, 0, issued.stderr)
      assert.equal(run(repo, env, ['session', 'start', 'S-20260827-01']).status, 0)
    } finally {
      await cleanup()
    }
  })

  it('고를 Profile이 없으면 만드는 길을 함께 준다', async () => {
    const { repo, env, cleanup } = await scratch()
    try {
      const out = run(repo, env, ['setup', 'apply', '--agent'])
      const plan = JSON.parse(out.stdout)
      assert.equal(plan.code, 'ASC_PROFILE_SELECTION_REQUIRED')
      const adopt = plan.actions.find((action: { type: string }) => action.type === 'adopt_profile')
      assert.ok(adopt, '고를 것이 없을 때 "골라라"만 주면 막다른 길이다')
      assert.match(adopt.portable, /profile adopt --json$/)
    } finally {
      await cleanup()
    }
  })

  it('Profile gate에서 멈출 때 어디에도 남기지 않는다 (repo · ASC_HOME · host)', async () => {
    const { repo, env, ascHome, cleanup } = await scratch()
    try {
      const home = env.HOME as string
      const before = {
        repo: await snapshot(repo),
        ascHome: await snapshot(ascHome),
        home: await snapshot(home),
      }
      const out = run(repo, env, ['setup', 'apply', '--agent'])
      assert.equal(out.status, 1)
      assert.deepEqual(JSON.parse(out.stdout).changesApplied, false)

      assert.deepEqual(await snapshot(repo), before.repo, '저장소에 남았다')
      assert.deepEqual(await snapshot(ascHome), before.ascHome, 'ASC_HOME에 남았다')
      // host 설치는 hook·settings.json 을 사람의 HOME에 쓴다. 여기서 멈췄다면 그것도 없어야 한다.
      assert.deepEqual(await snapshot(home), before.home, 'host 설정에 남았다')
      await assert.rejects(stat(join(repo, '.asc')), 'init이 반쯤 만들어 놓았다')
    } finally {
      await cleanup()
    }
  })
})
