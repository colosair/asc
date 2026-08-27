// B-27 Gate — 감지와 계획까지다. 결정은 사람이 하고, 계획은 아무것도 쓰지 않는다.
//
// B-21이 명시적으로 제외한 셋(wizard·값 대신 채우기·토큰 대행)을 "Zero-base Entry"라는
// 이름으로 되돌리지 않는지가 이 Gate의 핵심이다.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { POLICY_QUESTIONS, availableProfiles, planBootstrap, renderPlan } from '../core/attach/bootstrap.ts'
import { skillText } from '../adapters/claude-code/skill.ts'

const dirs: string[] = []
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** profiles/<id>/profile.json 만 후보다 — 디렉터리만 있는 것은 후보가 아니다. */
async function fakeInstall(ids: readonly string[], extraDirs: readonly string[] = []): Promise<string> {
  const root = await tempDir('asc-install-')
  for (const id of ids) {
    await mkdir(join(root, 'profiles', id), { recursive: true })
    await writeFile(join(root, 'profiles', id, 'profile.json'), '{}', 'utf8')
  }
  for (const id of extraDirs) await mkdir(join(root, 'profiles', id), { recursive: true })
  return root
}

const REAL_INSTALL = process.cwd()

describe('B-27 Gate — 감지 (C-06 §1)', () => {
  it('git 저장소를 찾고, 아니면 지금 자리를 뿌리로 본다', async () => {
    const withGit = await tempDir('asc-proj-')
    await mkdir(join(withGit, '.git'), { recursive: true })
    await mkdir(join(withGit, 'src'), { recursive: true })
    const found = await planBootstrap({ cwd: join(withGit, 'src'), installRoot: REAL_INSTALL })
    assert.equal(found.git, true)
    assert.equal(found.projectRoot, withGit)

    const bare = await tempDir('asc-bare-')
    const plain = await planBootstrap({ cwd: bare, installRoot: REAL_INSTALL })
    assert.equal(plain.git, false)
    assert.equal(plain.attached, false)
  })

  it('설치 경로의 Profile 후보만 센다 — profile.json 없는 디렉터리는 후보가 아니다', async () => {
    const install = await fakeInstall(['alpha', 'beta'], ['empty-dir'])
    assert.deepEqual(await availableProfiles(install), ['alpha', 'beta'])
    assert.deepEqual(await availableProfiles(join(install, '없는-경로')), [])
  })

  it('이미 붙어 있으면 lock에서 무엇으로 붙었는지 읽는다', async () => {
    const project = await tempDir('asc-attached-')
    await mkdir(join(project, '.asc'), { recursive: true })
    await writeFile(
      join(project, '.asc', 'profile.lock'),
      JSON.stringify({ profile: { id: 'pilot-local' } }),
      'utf8',
    )
    const plan = await planBootstrap({ cwd: project, installRoot: REAL_INSTALL, askPolicy: false })
    assert.equal(plan.attached, true)
    assert.deepEqual(plan.profile, { kind: 'ALREADY_ATTACHED', id: 'pilot-local' })
    assert.deepEqual(plan.undecided, [])
    assert.ok(!plan.steps.some((s) => s.startsWith('asc init')))
    assert.ok(plan.steps.includes('asc proceed'))
  })

  it('붙어 있는데 lock을 읽지 못하면 통과시키지 않는다', async () => {
    const project = await tempDir('asc-broken-')
    await mkdir(join(project, '.asc'), { recursive: true })
    const plan = await planBootstrap({ cwd: project, installRoot: REAL_INSTALL })
    assert.deepEqual(plan.profile, { kind: 'ATTACHED_UNKNOWN' })
    assert.match(plan.undecided[0]!, /붙이다 만 상태다/)
    assert.match(renderPlan(plan), /Profile: 알 수 없음/)
  })
})

describe('B-36 Gate — 붙어 있다고 정책이 정해진 것은 아니다 (지시 §16)', () => {
  it('선언되지 않은 정책은 붙어 있어도 미정으로 남는다', async () => {
    const project = await tempDir('asc-policy-')
    await mkdir(join(project, '.asc'), { recursive: true })
    await writeFile(
      join(project, '.asc', 'profile.lock'),
      JSON.stringify({ profile: { id: 'pilot-local' } }),
      'utf8',
    )
    const plan = await planBootstrap({ cwd: project, installRoot: REAL_INSTALL })
    assert.equal(plan.attached, true)
    assert.equal(plan.undecided.length, POLICY_QUESTIONS.length)
  })

  it('선언된 것만 빠진다 — 나머지는 그대로 묻는다', async () => {
    const project = await tempDir('asc-policy-')
    const plan = await planBootstrap({
      cwd: project,
      installRoot: REAL_INSTALL,
      declaredPolicies: ['canonical', 'ownership'],
    })
    const asked = plan.undecided.join('\n')
    assert.doesNotMatch(asked, /canonical인가/)
    assert.doesNotMatch(asked, /ownership path/)
    // 선언 자리가 없는 것은 언제나 미정이다 — 없는 자리를 있는 척하지 않는다
    assert.match(asked, /작업 항목의 정본/)
    assert.match(asked, /기본 전달 채널/)
  })

  it('정책을 대신 정하지 않는다 — 계획은 물어볼 것만 든다', async () => {
    const project = await tempDir('asc-policy-')
    const plan = await planBootstrap({ cwd: project, installRoot: REAL_INSTALL })
    const asked = plan.undecided.join('\n')
    // 다섯 가지가 전부 물음으로 남는다
    for (const policy of POLICY_QUESTIONS) assert.match(asked, new RegExp(policy.question))
    // 고른 값을 적어 두지 않는다
    assert.doesNotMatch(asked, /선택했다|자동으로 정했다|기본값으로 정함/)
  })
})

describe('B-27 Gate — 감지는 결정이 아니다 (C-06 §2)', () => {
  it('후보가 하나뿐이어도 자동으로 고르지 않는다', async () => {
    const install = await fakeInstall(['only-one'])
    const plan = await planBootstrap({
      cwd: await tempDir('asc-p-'),
      installRoot: install,
      askPolicy: false,
    })
    assert.equal(plan.profile.kind, 'UNDECIDED')
    assert.deepEqual((plan.profile as { candidates: string[] }).candidates, ['only-one'])
    assert.equal(plan.undecided.length, 1)
    assert.match(plan.undecided[0]!, /어떤 Profile로 붙일지/)
  })

  it('후보가 없으면 없다고 말한다 — 만들어 주지 않는다', async () => {
    const install = await fakeInstall([])
    const plan = await planBootstrap({ cwd: await tempDir('asc-p-'), installRoot: install, askPolicy: false })
    assert.match(plan.undecided[0]!, /쓸 수 있는 Profile이 없다/)
    assert.ok(!plan.steps.some((s) => s.startsWith('asc init')))
  })

  it('사람이 지정하면 그대로 쓴다', async () => {
    const plan = await planBootstrap({
      cwd: await tempDir('asc-p-'),
      installRoot: REAL_INSTALL,
      profileId: 'pilot-local',
    })
    assert.deepEqual(plan.profile, { kind: 'GIVEN', id: 'pilot-local' })
    assert.ok(plan.steps.includes('asc init --profile pilot-local'))
    // Profile은 정해졌지만 정책 질문은 남는다 — 찾아 주는 것과 정하는 것은 다르다
    assert.ok(plan.undecided.every((u) => !u.includes('어떤 Profile로 붙일지')))
  })

  it('계획은 아무것도 쓰지 않는다 — 계획일 뿐이다', async () => {
    const project = await tempDir('asc-untouched-')
    const before = await readdir(project)
    await planBootstrap({ cwd: project, installRoot: REAL_INSTALL, profileId: 'pilot-local' })
    assert.deepEqual(await readdir(project), before)
  })

  it('Host는 감지해 알릴 뿐 대신 설치하지 않는다', async () => {
    const plan = await planBootstrap({
      cwd: await tempDir('asc-p-'),
      installRoot: REAL_INSTALL,
      profileId: 'pilot-local',
      hosts: [{ id: 'somehost', installed: false }],
    })
    assert.ok(plan.steps.includes('asc host somehost install'))
    const text = renderPlan(plan)
    assert.match(text, /Host somehost: 설치되지 않음/)
    assert.match(text, /다음 순서:/)
  })

  it('Core는 어떤 Host가 있는지 모른다 — 이름은 Surface가 넘긴다', async () => {
    const source = await readFile(new URL('../core/attach/bootstrap.ts', import.meta.url), 'utf8')
    for (const word of ['claude', 'github', 'mattermost', 'jira']) {
      assert.doesNotMatch(source.toLowerCase(), new RegExp(word))
    }
  })

  it('B-21 제외 항목을 되돌리지 않는다 — 묻지 않고, 채우지 않고, 토큰을 다루지 않는다', async () => {
    const source = await readFile(new URL('../core/attach/bootstrap.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /createInterface|readline|prompt\(/) // 대화형 wizard 없음
    assert.doesNotMatch(source, /writeFile|mkdir|appendFile/) // 값을 대신 채우지 않음
    assert.doesNotMatch(source.toLowerCase(), /token|secret|password/) // 토큰 대행 없음
  })
})

describe('B-27 Gate — 배포 (C-06 §4)', () => {
  it('package.json이 전역 진입과 Node 하한을 선언하고, Profile을 패키지에 담는다', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    // 배포본은 compiled JS다 — `.ts` 를 그대로 실으면 node_modules 아래에서 죽는다 (C-14 §1.1)
    assert.equal(pkg.bin?.asc, './dist/cli/asc.js')
    assert.match(pkg.engines?.node ?? '', />=24/)
    assert.ok(pkg.scripts?.build, 'build 없이 dist를 실을 수 없다')
    assert.ok(pkg.scripts?.prepack, 'pack 직전에 build가 돌지 않으면 낡은 dist가 실린다')
    // 빠지면 attach가 Profile을 못 찾는다 — installRoot 기준으로 읽기 때문이다.
    // 이제 그 자산은 dist 안으로 옮겨지고, 옮기는 주체는 build script다.
    const build = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8')
    for (const asset of ['profiles', 'presets']) {
      assert.match(build, new RegExp(`'${asset}'`), `${asset} 가 build 자산 목록에 없다`)
    }
  })

  it('CLI 진입점이 shebang을 갖는다', async () => {
    const source = await readFile(new URL('../cli/asc.ts', import.meta.url), 'utf8')
    assert.match(source.split('\n')[0]!, /^#!/)
  })
})

describe('B-27 Gate — 진입 프로토콜 (C-06 §3)', () => {
  it('asc skill이 순서를 담되 막힌 것을 대신 열지 않는다', () => {
    const text = skillText()
    assert.match(text, /ASC로 진행해/)
    assert.match(text, /asc setup status/)
    assert.match(text, /a person chooses/)
    assert.match(text, /Do not open what is blocked/)
    assert.match(text, /The user does not need to know this sequence/)
  })
})
