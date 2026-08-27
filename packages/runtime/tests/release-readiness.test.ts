// Release readiness — 게시 직전에 틀리면 되돌리기 어려운 것들.
//
// `release:check` 스크립트가 사람과 CI가 부르는 관문이라면, 여기는 그 관문이 지키는
// 불변식을 테스트로도 잠근다. 둘 다 있는 이유는 하나가 빠져도 다른 하나가 잡기 때문이다.

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { RELEASE_VERSION } from '../core/distribution/release.ts'

const REPO = join(import.meta.dirname, '..', '..', '..')
const read = (rel: string) => readFile(join(REPO, rel), 'utf8')
const json = async (rel: string) => JSON.parse(await read(rel)) as Record<string, any>

const PACKAGES = [
  { label: 'runtime', dir: 'packages/runtime', name: '@asc-agent/runtime' },
  { label: 'bootstrap', dir: 'packages/bootstrap', name: '@asc-agent/bootstrap' },
]

describe('release — package metadata (게시 후에는 못 고친다)', () => {
  it('두 package가 같은 license를 싣고, LICENSE 실물이 있다', async () => {
    const root = await read('LICENSE')
    const rootPkg = await json('package.json')
    for (const { label, dir } of PACKAGES) {
      const pkg = await json(`${dir}/package.json`)
      assert.equal(pkg.license, rootPkg.license, `${label} license`)
      assert.equal(await read(`${dir}/LICENSE`), root, `${label} 가 다른 LICENSE를 싣는다`)
      assert.ok(root.startsWith(`${pkg.license} License`), 'LICENSE 본문과 선언이 다르다')
    }
  })

  it('publish 대상만 public이고, workspace 뿌리는 아니다', async () => {
    assert.equal((await json('package.json')).private, true)
    for (const { label, dir } of PACKAGES) {
      const pkg = await json(`${dir}/package.json`)
      assert.equal(pkg.publishConfig?.access, 'public', `${label} publishConfig`)
      assert.notEqual(pkg.private, true, `${label} 가 private면 게시되지 않는다`)
    }
  })

  it('repository 좌표가 실제 위치를 가리킨다 — public 전환 뒤 깨진 링크가 없어야 한다', async () => {
    for (const { label, dir } of PACKAGES) {
      const pkg = await json(`${dir}/package.json`)
      assert.equal(pkg.repository?.directory, dir, `${label} repository.directory`)
      assert.match(String(pkg.repository?.url), /github\.com\/colosair\/asc/, `${label} repository.url`)
      assert.match(String(pkg.homepage), /^https:\/\/github\.com\/colosair\/asc/, `${label} homepage`)
      assert.match(String(pkg.bugs?.url), /^https:\/\/github\.com\/colosair\/asc/, `${label} bugs`)
    }
  })

  it('Node 하한이 workspace와 어긋나지 않는다', async () => {
    const root = await json('package.json')
    for (const { label, dir } of PACKAGES) {
      const pkg = await json(`${dir}/package.json`)
      assert.equal(pkg.engines?.node, root.engines?.node, `${label} engines.node`)
    }
  })

  it('버전이 release 상수와 lockstep이다', async () => {
    for (const { label, dir } of PACKAGES) {
      assert.equal((await json(`${dir}/package.json`)).version, RELEASE_VERSION, `${label} version`)
    }
    const bootstrap = await json('packages/bootstrap/package.json')
    assert.equal(bootstrap.dependencies?.['@asc-agent/runtime'], RELEASE_VERSION)
  })

  it('배포본은 compiled JS다 — raw TS를 소비자에게 요구하지 않는다', async () => {
    for (const { label, dir } of PACKAGES) {
      const pkg = await json(`${dir}/package.json`)
      assert.doesNotMatch(JSON.stringify(pkg.bin), /\.ts"/, `${label} bin`)
      assert.ok((pkg.files as string[]).includes('dist'), `${label} files`)
    }
  })
})

describe('release — 배포본에 들어가면 안 되는 것 (build 산출물 기준)', () => {
  /** dist가 없으면 이 검사는 의미가 없다 — build 뒤에만 판정한다. */
  const distOf = (dir: string) => join(REPO, dir, 'dist')
  const walk = async (dir: string, acc: string[] = []): Promise<string[]> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, acc)
      else acc.push(full)
    }
    return acc
  }

  it('raw .ts · 테스트 · 저장소 표식이 dist에 없다', async () => {
    for (const { label, dir } of PACKAGES) {
      let files: string[]
      try {
        files = await walk(distOf(dir))
      } catch {
        continue // 아직 빌드 전이면 건너뛴다 — pack/smoke가 실물을 본다
      }
      const offenders = files.filter(
        (path) =>
          (path.endsWith('.ts') && !path.endsWith('.d.ts')) ||
          /\.gitkeep$|\.test\.|\.env$|\.pem$|\.map$|DS_Store/.test(path),
      )
      assert.deepEqual(offenders.map((p) => p.replace(REPO, '')), [], `${label} dist`)
    }
  })

  it('dist 안에 machine 절대경로가 굳어 있지 않다 (C-14 불변식 ④)', async () => {
    for (const { dir } of PACKAGES) {
      let files: string[]
      try {
        files = await walk(distOf(dir))
      } catch {
        continue
      }
      for (const path of files.filter((p) => /\.(js|json)$/.test(p))) {
        const source = await readFile(path, 'utf8')
        assert.doesNotMatch(source, /\/Users\/[a-z]+\//i, `${path.replace(REPO, '')} 에 machine 경로`)
      }
    }
  })
})

describe('release — 절차가 문서로 고정돼 있다', () => {
  it('checklist가 runtime을 bootstrap보다 먼저 게시한다', async () => {
    const checklist = await read('docs/release/v0.1.0-checklist.md')
    const runtime = checklist.indexOf('publish @asc-agent/runtime')
    const bootstrap = checklist.indexOf('publish @asc-agent/bootstrap')
    assert.ok(runtime > -1 && bootstrap > -1, 'publish 단계가 없다')
    assert.ok(runtime < bootstrap, 'bootstrap을 먼저 게시하면 첫 설치가 깨진다')
  })

  it('checklist에 human boundary와 immutability가 적혀 있다', async () => {
    const checklist = await read('docs/release/v0.1.0-checklist.md')
    assert.match(checklist, /HUMAN RELEASE BOUNDARY/)
    assert.match(checklist, /immutable/i)
    assert.match(checklist, /0\.1\.1/, '결함이 나면 어디로 가는지 적혀 있어야 한다')
  })

  it('SECURITY.md가 없는 연락처를 지어내지 않는다', async () => {
    const security = await read('SECURITY.md')
    assert.match(security, /private vulnerability reporting/i)
    assert.match(security, /do not include/i)
    assert.doesNotMatch(security, /security@|@example\.com/, '읽는 사람이 없는 주소를 적었다')
  })

  it('README가 아직 게시되지 않았다는 사실을 말한다', async () => {
    const readme = await read('README.md')
    assert.match(readme, /not published to npm yet/i, 'registry 현실을 과장하고 있다')
    assert.match(readme, new RegExp(`@asc-agent/bootstrap@${RELEASE_VERSION.replace(/\./g, '\\.')}`))
  })

  it('CI가 검증만 하고 게시하지 않는다', async () => {
    const workflow = await read('.github/workflows/ci.yml')
    for (const step of ['npm ci', 'npm run typecheck', 'npm test', 'npm run release:check', 'npm run smoke']) {
      assert.ok(workflow.includes(step), `CI에 ${step} 가 없다`)
    }
    assert.doesNotMatch(workflow, /npm publish|softprops\/action-gh-release|gh release create/)
  })
})
