#!/usr/bin/env node
// 실제로 설치된 것을 실행해 본다 — **사용자의 상태를 하나도 빌리지 않고**.
//
// 저장소 트리에서 도는 검사는 이 결함을 못 잡는다. 소스가 옆에 있고, 실 `~/.asc` 에
// workspace가 있고, 실 `~/.claude` 에 Host가 깔려 있으면 깨진 패키지도 멀쩡해 보인다.
// 그래서 HOME·ASC_HOME·cwd·npm cache를 전부 임시로 두고, `node_modules/.bin/asc` 를
// 부른다. 저장소 소스를 직접 실행하는 것은 package smoke로 인정하지 않는다.

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runNpm } from './npm-exec.mjs'
import { PUBLIC_PROFILES } from '../packages/runtime/scripts/public-profiles.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packs = join(root, 'private', 'packs')

/**
 * 사용자의 상태가 새어 들어오지 못하게 막는다.
 *
 * `ASC_*` 와 provider 자격은 통째로 지운다 — 실 토큰이 있으면 "자격 없음" 경로가
 * 검증되지 않고, 없는데 있는 것처럼 통과할 수도 있다.
 */
function isolated(home, extra = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('ASC_') || /GITHUB_TOKEN|GITLAB_TOKEN|MATTERMOST|JIRA_/.test(key)) delete env[key]
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    ASC_HOME: join(home, '.asc'),
    npm_config_cache: join(home, '.npm-cache'),
    NO_COLOR: '1',
    ...extra,
  }
}

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  OK  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const base = await mkdtemp(join(tmpdir(), 'asc-tarball-smoke-'))
try {
  const tarballs = (await readdir(packs)).filter((f) => f.endsWith('.tgz')).map((f) => join(packs, f))
  if (tarballs.length === 0) throw new Error(`${packs} 에 tarball이 없다 — npm run pack:all 을 먼저 하라`)

  const home = join(base, 'home')
  const app = join(base, 'app')
  const work = join(base, 'work')
  for (const dir of [home, app, work]) await mkdir(dir, { recursive: true })
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'asc-smoke', private: true }), 'utf8')

  // 두 tarball을 함께 설치한다 — 서로를 exact version으로 가리키는데 레지스트리에는
  // 아직 아무것도 없다.
  // npm은 shim이 아니라 진입 JS로 부른다 (scripts/npm-exec.mjs).
  runNpm(['install', '--no-audit', '--no-fund', ...tarballs], {
    cwd: app,
    env: isolated(home),
    stdio: 'pipe',
  })
  const bin = join(app, 'node_modules', '.bin')

  /** npm이 놓는 실행물 이름. Windows에서는 `.cmd` shim이다 (C-14 §3.1). */
  const binName = (name) => (process.platform === 'win32' ? `${name}.cmd` : name)

  // git은 실제 실행 파일이라 shell이 필요 없다 — shim은 npm 쪽 이야기다.
  execFileSync('git', ['init', '-q', work])
  await writeFile(join(work, 'README.md'), '# fixture\n', 'utf8')

  const run = (name, args, opts = {}) => {
    try {
      const stdout = execFileSync(join(bin, binName(name)), args, {
        cwd: opts.cwd ?? work,
        env: isolated(home),
        encoding: 'utf8',
        stdio: 'pipe',
        shell: process.platform === 'win32',
      })
      return { code: 0, stdout, stderr: '' }
    } catch (error) {
      return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
    }
  }

  console.log('\nRunning the installed bin — the repository sources are not used')

  const help = run('asc', ['--help'])
  check('asc --help', help.code === 0 && help.stdout.includes('asc proceed'))

  const runtime = run('asc', ['runtime', 'status'])
  check('asc runtime status', runtime.code === 0 && /package/.test(runtime.stdout))

  const plan = run('asc', ['setup', 'plan', '--profile', 'pilot-local', '--json'])
  let parsed
  try {
    parsed = JSON.parse(plan.stdout)
  } catch {
    parsed = null
  }
  check('the whole stdout of setup plan --json is JSON', parsed !== null)
  check('the plan proposes attaching', parsed?.changes?.some((c) => c.target === 'attach-workspace') === true)
  check('plan applies nothing', parsed?.changesApplied === false)

  const apply = run('asc', ['setup', 'apply', '--profile', 'pilot-local', '--agent'])
  const applied = (() => {
    try {
      return JSON.parse(apply.stdout)
    } catch {
      return null
    }
  })()
  check('the whole stdout of setup apply --agent is JSON', applied !== null)
  check('applied, with no changes remaining', applied?.changesApplied === true && applied?.remaining?.length === 0)

  const repoFiles = (await readdir(work)).filter((f) => f !== '.git')
  check('repository footprint is zero', repoFiles.length === 1 && repoFiles[0] === 'README.md', repoFiles.join(', '))

  const front = run('asc', ['front'])
  check('asc front', front.code === 0 && /workspace/.test(front.stdout))

  const issue = run('asc', [
    'session', 'issue', 'S-20260826-01',
    '--role', 'implementer', '--goal', '패키지에서 도는지 본다',
    '--boundary', 'src/**', '--criteria', 'N1', '--criteria', 'N2', '--owner', 'implementer',
  ])
  check('session issue', issue.code === 0)
  check('session start', run('asc', ['session', 'start', 'S-20260826-01']).code === 0)

  const escalate = run('asc', [
    'escalate', 'open', 'S-20260826-01',
    '--predicate', 'ownership_boundary', '--question', 'N2는 남의 소관이다',
    '--blocked', 'N2', '--blocked-scope', 'server/**', '--evidence', '쓰기 경계 src/**',
    '--as', 'controller-main',
  ])
  check('escalate open', escalate.code === 0 && /server\/\*\*/.test(escalate.stdout))
  check('audit shows the blocked boundary', /boundary: server/.test(run('asc', ['session', 'audit', 'S-20260826-01']).stdout))
  check('report', run('asc', ['session', 'report', 'S-20260826-01']).code === 0)

  // Host — 격리된 HOME이므로 실 ~/.claude 는 건드리지 않는다
  check('host install', run('asc', ['host', 'claude', 'install']).code === 0)
  const again = run('asc', ['host', 'claude', 'install'])
  check('a second host install is idempotent', again.code === 0 && /no change/.test(again.stdout))
  const uninstall = run('asc', ['host', 'claude', 'uninstall'])
  check('host uninstall', uninstall.code === 0 && /SKILL\.md/.test(uninstall.stdout))

  const boot = run('asc-bootstrap', ['--help'])
  check('asc-bootstrap --help', boot.code === 0 && /no setup logic of its own/.test(boot.stdout))

  const bootPlan = run('asc-bootstrap', ['setup', 'plan', '--json'])
  check('bootstrap forwards into the runtime', (() => {
    try {
      return typeof JSON.parse(bootPlan.stdout).status === 'string'
    } catch {
      return false
    }
  })())

  // ── 제로베이스 acceptance — URL 하나에서 도는 세션까지 (P0) ─────────────────
  //
  // 되묻지 않고 여기까지 오는가. 위 흐름은 **번들 Profile 이름을 이미 아는 사람**의
  // 경로였고, URL만 받은 agent는 그 이름을 모른다. 그 상태에서 막힌 자리가 FAIL 회차의
  // 자리이므로, 여기서는 아무 이름도 알려 주지 않고 시작한다.
  //
  // 격리는 그대로 쓰되 **작업 디렉터리와 ASC_HOME을 새로 판다** — 위에서 이미 붙여 놓은
  // 상태를 물려받으면 "처음부터"가 아니게 된다.
  console.log('\nZero-base: a repository URL and nothing else')

  const zeroHome = join(base, 'home2')
  const zeroWork = join(base, 'work2')
  for (const dir of [zeroHome, zeroWork]) await mkdir(dir, { recursive: true })
  execFileSync('git', ['init', '-q', zeroWork])
  await writeFile(join(zeroWork, 'README.md'), '# zero base\n', 'utf8')
  // network를 쓰지 않는다 — remote는 주소일 뿐이고 아무도 여기에 접속하지 않는다.
  execFileSync('git', ['-C', zeroWork, 'remote', 'add', 'origin', 'git@github.com:example/fixture.git'])

  const zero = (name, args) => {
    try {
      return {
        code: 0,
        stdout: execFileSync(join(bin, binName(name)), args, {
          cwd: zeroWork,
          env: isolated(zeroHome),
          encoding: 'utf8',
          stdio: 'pipe',
          shell: process.platform === 'win32',
        }),
      }
    } catch (error) {
      return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
    }
  }
  const asJson = (result) => {
    try {
      return JSON.parse(result.stdout)
    } catch {
      return null
    }
  }
  /**
   * 있는 파일 전부. 없으면 빈 표 — "없었다"도 상태다.
   *
   * npm 자신의 cache는 뺀다. ASC가 전역 설치 상태를 조회하려고 npm을 부르면 npm이 거기에
   * 자기 기록을 남긴다 — 그것은 ASC가 남긴 상태가 아니고, 격리 환경이 일부러 그리로
   * 돌려놓은 자리다.
   */
  const treeOf = async (dir) => {
    const found = []
    const walk = async (current, prefix) => {
      let entries
      try {
        entries = await readdir(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (rel === '.npm-cache' || rel.startsWith('.npm-cache/')) continue
        if (entry.isDirectory()) await walk(join(current, entry.name), rel)
        else found.push(rel)
      }
    }
    await walk(dir, '')
    return found.sort().join('\n')
  }

  const beforeRepo = await treeOf(zeroWork)
  const beforeHome = await treeOf(zeroHome)

  // 1. 첫 실행. **AGENTS.md가 주는 canonical 명령 그대로다** — 문서와 여기가 갈리면
  //    검사하는 것은 문서가 아니라 우리의 기억이 된다.
  const init = zero('asc-bootstrap', ['setup', 'apply', '--json'])
  const initPlan = asJson(init)
  check('the canonical entry answers with a plan, not a status rendering', initPlan !== null && Array.isArray(initPlan.changes))
  check(
    'it stops at the profile wall',
    initPlan?.code === 'ASC_PROFILE_SELECTION_REQUIRED' && initPlan?.requiresUserAction === true && init.code === 1,
  )
  // agent가 그대로 실행하는 형태다. 산문으로 답하는 명령을 주면 "산문을 파싱하지 마라"는
  // 지시와 제품이 서로 어긋난다.
  check(
    'every portable answers in JSON, at the exact version',
    (initPlan?.actions ?? []).length > 0 &&
      (initPlan?.actions ?? []).every((action) => /^npx --yes @asc-agent\/bootstrap@\S+ .*--json$/.test(action.portable)),
    (initPlan?.actions ?? []).map((a) => a.portable).join(' | '),
  )
  // 멈췄으면 **아무 데도 남기지 않는다.** setup apply가 알아서 그럴 것이라고 가정하지
  // 않는다 — init이 실제로 도는 경로를 여기서 본다 (저장소 · HOME · ASC_HOME · host 설정).
  check('stopping leaves the repository untouched', (await treeOf(zeroWork)) === beforeRepo)
  check('stopping leaves no user state behind', (await treeOf(zeroHome)) === beforeHome)

  // 2. 벽에서 빠져나오는 길을 plan이 데이터로 준다. **그 문자열을 우리가 조립하지 않는다** —
  //    조립하면 검증되는 것은 우리의 조립이지 제품이 주는 명령이 아니다.
  const adoptAction = initPlan?.actions?.find((action) => action.type === 'adopt_profile')
  check('the plan carries a way to make one', adoptAction !== undefined, initPlan?.actions?.map((a) => a.type).join(', '))
  const portable = adoptAction?.portable ?? ''
  // 설치 전 형태는 `npx --yes <bootstrap>@<version> …` 이다. registry가 없는 이 환경에서
  // 그대로 실행할 수는 없으므로, **앞머리가 그 배포본을 가리키는지 확인하고** 꼬리의
  // 인자들을 설치된 같은 진입으로 넘긴다. 확인하는 것은 문자열 자체다.
  const forwarded = /^npx --yes (@[^@\s]+\/[^@\s]+)@(\S+) (.+)$/.exec(portable)
  check('the portable form names the bootstrap package at an exact version', forwarded !== null, portable)
  const adopt = asJson(zero('asc-bootstrap', (forwarded?.[3] ?? '').split(' ')))
  check('adopt writes a profile for this repository', adopt?.id === 'fixture', JSON.stringify(adopt?.id))
  check('it reads the identity off the remote', adopt?.project?.repository === 'example/fixture')
  check('it says what it left empty', (adopt?.warnings ?? []).some((w) => /canonical\.sources/.test(w)))

  // 3. 그 Profile로 붙는다.
  // adopt가 낸 다음 걸음도 그대로 실행한다 — 여기서도 우리가 명령을 짓지 않는다.
  //
  // 다만 **어느 진입으로 보내는지는 이 환경의 제약이다.** portable의 `npx …` 형태는
  // registry에서 그 버전을 받아오는 것이고, 아직 게시되지 않은 candidate로 도는 여기서는
  // 그것이 성립하지 않는다(그리고 성립하는 척하면 게시 전에 게시 후를 증명했다고 적게 된다).
  // 문자열이 맞는지는 문자열로 확인하고, 실행은 설치된 같은 진입으로 보낸다. registry
  // 경로의 관측은 9B — 게시 뒤에 따로 한다.
  const applyPortable = adopt?.actions?.[0]?.portable ?? ''
  const applyForwarded = /^npx --yes (@[^@\s]+\/[^@\s]+)@(\S+) (.+)$/.exec(applyPortable)
  check("adopt's next step is machine-runnable", applyForwarded !== null && /--json$/.test(applyPortable), applyPortable)
  const zeroApply = asJson(zero('asc', (applyForwarded?.[3] ?? '').split(' ')))
  check('attaching with the adopted profile', zeroApply?.changesApplied === true && zeroApply?.remaining?.length === 0)

  // 4. agent가 스스로 READY를 판정한다.
  const zeroStatus = asJson(zero('asc', ['setup', 'status', '--json']))
  check('status says READY', zeroStatus?.attachment === 'READY')

  // 설치된 `asc` 는 자기를 bootstrap이라 말하지 않는다 (v0.2.0 registry 관측이 찾은 결함).
  const installedPlan = asJson(zero('asc', ['setup', 'plan', '--json']))
  check('the installed asc knows it is installed', installedPlan?.executionMode === 'installed-runtime')
  check(
    'and hands back asc commands, not npx',
    (installedPlan?.actions ?? []).every((action) => action.portable.startsWith('asc ')),
    (installedPlan?.actions ?? []).map((a) => a.portable).join(' | '),
  )
  check('and names where the profile came from', zeroStatus?.profile?.origin === 'external')

  // 5. READY는 **기술적 준비**다 — 바깥 gate가 막혀 있어도 로컬 세션 루프는 선다.
  check('gates are blocked on this bare machine', (zeroStatus?.gates ?? []).some((gate) => gate.state === 'BLOCKED'))
  const zeroIssue = zero('asc', [
    'session', 'issue', 'S-20260827-90',
    '--role', 'implementer', '--goal', 'URL 하나에서 여기까지',
    '--boundary', 'src/**', '--criteria', 'N1', '--criteria', 'N2',
  ])
  check('a session is issued anyway', zeroIssue.code === 0, zeroIssue.stderr)
  check('and starts', zero('asc', ['session', 'start', 'S-20260827-90']).code === 0)

  const zeroFiles = (await readdir(zeroWork)).filter((f) => f !== '.git')
  check('the repository is still untouched', zeroFiles.length === 1 && zeroFiles[0] === 'README.md', zeroFiles.join(', '))

  // ── 배포본에 무엇이 실렸는가 ────────────────────────────────────────────────
  //
  // 설치된 트리가 곧 artifact다. 여기서 보는 것은 "도는가"가 아니라 **남의 것이 실려
  // 나가지 않는가**이며, 그 답은 사람의 눈이 아니라 이 검사가 낸다.
  console.log('\nAuditing what the artifact actually carries')

  /** 사람의 기계 경로 모양. 배포본에 들어갈 이유가 없다 (C-14 불변식 ④). */
  const MACHINE_PATH = /\/Users\/|\/home\/[a-z]|[A-Z]:\\Users\\/

  /** 배포되지 않는 Profile이 들고 있는 식별자. 이름을 이 파일에 적지 않는다. */
  const forbidden = []
  const sourceProfiles = join(root, 'packages', 'runtime', 'profiles')
  for (const entry of await readdir(sourceProfiles, { withFileTypes: true })) {
    if (!entry.isDirectory() || PUBLIC_PROFILES.includes(entry.name)) continue
    const profile = JSON.parse(await readFile(join(sourceProfiles, entry.name, 'profile.json'), 'utf8'))
    forbidden.push(entry.name)
    const repository = profile.project?.repository
    if (typeof repository === 'string') {
      forbidden.push(repository)
      const account = repository.split('/')[0]
      if (account && account.length > 3) forbidden.push(account)
    }
  }
  // 비공개 Profile이 없는 checkout(공개 product repo)에서는 이 목록이 비는 것이 정상이다.
  console.log(`  ..   private identifiers to look for: ${forbidden.length}`)

  const installed = join(app, 'node_modules', '@asc-agent')
  const carried = (await readdir(installed, { recursive: true, withFileTypes: true })).filter((f) => f.isFile())
  const named = (predicate) => carried.filter((f) => predicate(f.name, join(f.parentPath, f.name)))

  check('no raw TypeScript', named((name) => name.endsWith('.ts') && !name.endsWith('.d.ts')).length === 0)
  check('no tests', named((_, path) => /[\/](tests|__tests__)[\/]/.test(path)).length === 0)
  check('no repository-only markers', named((name) => name === '.gitkeep').length === 0)

  const leaks = []
  const machinePaths = []
  for (const file of carried) {
    if (!/\.(js|json|md|txt|map)$/.test(file.name)) continue
    const path = join(file.parentPath, file.name)
    const source = await readFile(path, 'utf8')
    for (const token of forbidden) if (source.includes(token)) leaks.push(`${file.name}: ${token}`)
    if (MACHINE_PATH.test(source)) machinePaths.push(file.name)
  }
  check('no third-party project identifier', leaks.length === 0, leaks.join(', '))
  check('no machine absolute path', machinePaths.length === 0, machinePaths.join(', '))

  const credentials = []
  for (const file of carried) {
    if (!/\.(js|json|md|txt)$/.test(file.name)) continue
    const source = await readFile(join(file.parentPath, file.name), 'utf8')
    // 값의 모양으로 본다 — 이름으로 보면 변수명 하나에 걸린다.
    if (/(ghp_|github_pat_|glpat-|xox[baprs]-|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(source)) {
      credentials.push(file.name)
    }
  }
  check('no credential-shaped string', credentials.length === 0, credentials.join(', '))
} finally {
  await rm(base, { recursive: true, force: true })
}

console.log(failures === 0 ? '\ntarball smoke passed' : `\ntarball smoke failed: ${failures}`)
process.exitCode = failures === 0 ? 0 : 1
