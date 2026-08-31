// Release 일관성과 self-dogfood — 이름·버전이 갈라지지 않고, ASC가 자기 말을 지킨다.
//
// `release:check` 스크립트가 CI/사람의 마지막 관문이라면, 여기는 그 관문이 검사하는
// 불변식 자체를 코드 쪽에서 잠근다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  BOOTSTRAP_PACKAGE,
  BOOTSTRAP_SPEC,
  RELEASE_VERSION,
  RUNTIME_PACKAGE,
  RUNTIME_SPEC,
} from '../core/distribution/release.ts'
import { RUNTIME_PACKAGE as SELECT_RUNTIME_PACKAGE } from '../core/distribution/runtime-select.ts'
// @ts-expect-error — 빌드 스크립트와 같은 allowlist를 본다. 두 벌로 두면 갈라진다.
import { PUBLIC_PROFILES } from '../scripts/public-profiles.mjs'

const REPO = join(import.meta.dirname, '..', '..', '..')
const read = (rel: string) => readFile(join(REPO, rel), 'utf8')
const json = async (rel: string) => JSON.parse(await read(rel)) as Record<string, any>

/** history는 history다 — 그 회차에 실제로 쓴 이름을 거짓으로 바꾸지 않는다. */
const HISTORY_EXEMPT = [
  'docs/pilots/',
  'docs/design/directives/',
  'docs/contracts/C-14_distribution-runtime-entry.md',
  'scripts/release-check.mjs',
  // 이 파일 자신은 옛 이름을 **찾기 위해** 들고 있다.
  'packages/runtime/tests/release-consistency.test.ts',
]

describe('namespace — @asc-agent 정본화', () => {
  it('release 상수가 canonical scope를 쓴다', () => {
    assert.equal(RUNTIME_PACKAGE, '@asc-agent/runtime')
    assert.equal(BOOTSTRAP_PACKAGE, '@asc-agent/bootstrap')
    assert.equal(RUNTIME_SPEC, `@asc-agent/runtime@${RELEASE_VERSION}`)
    assert.equal(BOOTSTRAP_SPEC, `@asc-agent/bootstrap@${RELEASE_VERSION}`)
  })

  it('development checkout 검증자가 같은 이름을 본다 — 두 곳이 갈라지면 엉뚱한 것을 받아들인다', () => {
    assert.equal(SELECT_RUNTIME_PACKAGE, RUNTIME_PACKAGE)
  })

  it('package.json 셋이 일치한다', async () => {
    const runtime = await json('packages/runtime/package.json')
    const bootstrap = await json('packages/bootstrap/package.json')
    const root = await json('package.json')
    assert.equal(runtime.name, RUNTIME_PACKAGE)
    assert.equal(bootstrap.name, BOOTSTRAP_PACKAGE)
    assert.equal(runtime.version, RELEASE_VERSION)
    assert.equal(bootstrap.version, RELEASE_VERSION)
    assert.equal(root.private, true, 'workspace 뿌리는 배포 대상이 아니다')
  })

  it('bootstrap이 runtime을 exact로 고정한다 — floating 금지', async () => {
    const bootstrap = await json('packages/bootstrap/package.json')
    const pinned = String(bootstrap.dependencies?.[RUNTIME_PACKAGE])
    assert.equal(pinned, RELEASE_VERSION)
    assert.doesNotMatch(pinned, /[\^~]|latest|\*/)
  })

  it('의존은 한 방향이다 — runtime은 bootstrap을 모른다', async () => {
    const runtime = await json('packages/runtime/package.json')
    const names = Object.keys({ ...runtime.dependencies, ...runtime.devDependencies })
    assert.equal(names.some((n) => n.includes('bootstrap')), false)
  })

  it('폐기된 scope가 current surface에 남아 있지 않다', async () => {
    const offenders: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(join(REPO, dir), { withFileTypes: true })) {
        const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`
        if (['node_modules', 'dist', 'private', '.git', '.claude'].includes(entry.name)) continue
        if (entry.isDirectory()) {
          await walk(rel)
          continue
        }
        if (!/\.(ts|mjs|json|md)$/.test(entry.name)) continue
        if (HISTORY_EXEMPT.some((prefix) => rel.startsWith(prefix))) continue
        if ((await read(rel)).includes('@asc-control')) offenders.push(rel)
      }
    }
    await walk('.')
    assert.deepEqual(offenders, [], '옛 namespace가 남았다')
  })
})

describe('release:check — drift를 기계가 잡는다', () => {
  const runCheck = () =>
    spawnSync(process.execPath, [join(REPO, 'scripts', 'release-check.mjs')], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    })

  it('지금 저장소에서 통과한다', () => {
    const result = runCheck()
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /release:check passed/)
  })

  it('publish를 하지 않는다 — 검출만 한다', async () => {
    const source = await read('scripts/release-check.mjs')
    assert.doesNotMatch(source, /npm publish|npm\W+publish/)
  })

  it('버전·namespace·문서 명령을 모두 본다', async () => {
    const source = await read('scripts/release-check.mjs')
    for (const concern of ['versions match', 'exact version', 'floating spec', 'documented exact spec']) {
      assert.ok(source.includes(concern), `${concern} 검사가 없다`)
    }
  })
})

describe('self-dogfood — ASC가 자기 저장소에서도 zero-footprint다 (C-11)', () => {
  const tracked = () =>
    spawnSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)

  it('저장소에 repo-local ASC runtime state를 두지 않는다', () => {
    const offenders = tracked().filter((path) =>
      /(^|\/)\.asc(\/|$)|(^|\/)profile\.lock$|(^|\/)identities\.json$|(^|\/)override\.json$|(^|\/)runtime\.json$/.test(path),
    )
    assert.deepEqual(offenders, [], '남에게 zero-footprint라 하면서 자기 저장소에는 두고 있다')
  })

  it('machine-specific 경로를 tracked 파일에 적지 않는다 (C-14 불변식 ④)', async () => {
    const suspects = tracked().filter((path) => /\.(json|md)$/.test(path) && !path.startsWith('docs/'))
    for (const path of suspects) {
      const source = await read(path)
      assert.doesNotMatch(source, /\/Users\/[a-z]+\/|C:\\\\Users\\\\/i, `${path} 에 machine 경로가 있다`)
    }
  })

  it('gitignore가 배포 산출물과 pack 결과를 잡는다', async () => {
    const ignore = await read('.gitignore')
    for (const entry of ['dist/', 'private/', 'node_modules/']) {
      assert.ok(ignore.includes(entry), `${entry} 가 .gitignore 에 없다`)
    }
  })
})

describe('Windows — 정책은 확정, 증거는 fixture까지 (C-14 §3.1)', () => {
  it('ASC가 shell·PATH·shim을 직접 만들지 않는다 (불변식 ⑰)', async () => {
    const surfaces = [
      'packages/runtime/core/distribution/runtime-install.ts',
      'packages/runtime/cli/asc.ts',
    ]
    for (const path of surfaces) {
      const source = await read(path)
      // `--profile` 같은 우연한 부분일치를 피해 실제로 쓸 법한 형태로 본다
      for (const forbidden of ['~/.zshrc', '~/.bashrc', "'.zshrc'", "'.profile'", 'asc.cmd', 'setx ']) {
        assert.ok(!source.includes(forbidden), `${path} 가 ${forbidden} 를 건드린다`)
      }
    }
  })

  it('실행물 조회가 플랫폼에 맞는 명령을 쓴다', async () => {
    const source = await read('packages/runtime/core/distribution/runtime-install.ts')
    assert.match(source, /win32.*\?.*'where'.*:.*'which'/s)
  })

  it('공백 있는 Windows 경로가 runtime 선택에서 왕복한다', async () => {
    const { normalizeSelection } = await import('../core/distribution/runtime-select.ts')
    const source = 'C:\\Program Files\\dev\\asc\\packages\\runtime'
    const selection = normalizeSelection({ version: 1, runtime: { mode: 'development', source } })
    assert.equal(selection?.runtime.mode === 'development' && selection.runtime.source, source)
  })
})

describe('public artifact boundary — 남의 것이 배포본에 실리지 않는다', () => {
  const PROFILES = join(REPO, 'packages', 'runtime', 'profiles')
  const DIST_PROFILES = join(REPO, 'packages', 'runtime', 'dist', 'profiles')

  /** 배포되지 않는 Profile이 들고 있는 식별자. 이 파일에 이름을 하드코딩하지 않는다. */
  const privateIdentifiers = async (): Promise<string[]> => {
    const ids = (await readdir(PROFILES, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !PUBLIC_PROFILES.includes(entry.name))
      .map((entry) => entry.name)
    const tokens: string[] = []
    for (const id of ids) {
      const profile = JSON.parse(
        await readFile(join(PROFILES, id, 'profile.json'), 'utf8'),
      ) as { project?: { repository?: unknown } }
      tokens.push(id)
      const repository = profile.project?.repository
      if (typeof repository === 'string') {
        tokens.push(repository)
        // `<account>/<repo>` 의 앞칸(계정)만으로도 남의 것을 가리킨다.
        const account = repository.split('/')[0]
        if (account && account.length > 3) tokens.push(account)
      }
    }
    return tokens
  }

  it('allowlist에 적힌 Profile만 dist에 실린다', async (t) => {
    if (!existsSync(DIST_PROFILES)) return t.skip('dist가 없다 — npm run build 뒤에 검사한다')
    const shipped = (await readdir(DIST_PROFILES, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    assert.deepEqual(shipped, [...PUBLIC_PROFILES].sort())
  })

  it('제3자 식별자가 dist 어디에도 없다', async (t) => {
    const dist = join(REPO, 'packages', 'runtime', 'dist')
    if (!existsSync(dist)) return t.skip('dist가 없다 — npm run build 뒤에 검사한다')
    const tokens = await privateIdentifiers()
    // 비공개 Profile이 아예 없는 checkout(공개 product repo)에서는 지킬 것이 없다.
    // 조용히 통과시키지 않고 그 사실을 말한다.
    if (tokens.length === 0) return t.skip('비공개 Profile이 없다 — 이 checkout에는 샐 것이 없다')
    for (const file of await readdir(dist, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue
      const path = join(file.parentPath, file.name)
      if (!/\.(js|json|md|txt)$/.test(file.name)) continue
      const source = await readFile(path, 'utf8')
      for (const token of tokens) {
        assert.ok(!source.includes(token), `${path} 가 ${token} 를 담고 있다`)
      }
    }
  })

  it('배포 대상 파일 목록이 문서·테스트·소스를 싣지 않는다', async () => {
    const runtime = await json('packages/runtime/package.json')
    const bootstrap = await json('packages/bootstrap/package.json')
    for (const [label, pkg] of [
      ['runtime', runtime],
      ['bootstrap', bootstrap],
    ] as const) {
      assert.deepEqual(pkg.files, ['dist', 'README.md'], `${label} files allowlist`)
    }
  })

  it('있는 Profile은 allowlist 아니면 비공개다 — 중간 상태를 두지 않는다', async () => {
    // 실 Profile을 익명화해 "반쯤 공개"로 만들지 않는다. 내용을 고치면 profile digest가
    // 바뀌고 이미 붙어 있는 workspace가 LOCK_DRIFT로 멈춘다. Profile은 둘 중 하나다 —
    // allowlist에 적혀 배포되거나, 적히지 않아 이 checkout에만 있거나.
    const ids = (await readdir(PROFILES, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    assert.ok(ids.length > 0, 'Profile이 하나도 없다')
    for (const id of ids) {
      const profile = JSON.parse(await readFile(join(PROFILES, id, 'profile.json'), 'utf8')) as {
        id: string
      }
      assert.equal(profile.id, id, `${id} 의 선언된 id가 디렉터리 이름과 다르다`)
    }
  })
})
