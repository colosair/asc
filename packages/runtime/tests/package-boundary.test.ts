// 패키지 경계 — 배포본만으로 CLI가 서는가.
//
// B-29에서 `cli/asc.ts` 가 `composition/` 을 import 하기 시작했는데 whitelist는 그대로였다.
// tarball을 풀면 `--help` 조차 죽는 상태가 한동안 있었고, 테스트는 저장소 트리에서 도니까
// 아무도 못 봤다.
//
// 배포본이 compiled dist가 된 뒤에도 같은 결함이 가능하다 — 새 최상위 디렉터리가 생겼는데
// build가 그것을 emit하지 않으면 dist는 없는 파일을 import한다. 그래서 여기서는
// **production import graph가 build 범위 안에 있는지**를 본다. 사람이 기억할 일을 없앤다.

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, it } from 'node:test'

const ROOT = process.cwd()
const ENTRY = join(ROOT, 'cli', 'asc.ts')

/** 코드가 아니라 데이터라서 tsc가 모르는 것. build script가 따로 옮긴다. */
const ASSETS = ['profiles', 'presets']

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(ROOT, path), 'utf8')) as Record<string, unknown>
}

/** entry에서 도달 가능한 모든 로컬 모듈. 상대 import만 따라간다(bare specifier는 의존성). */
async function reachable(entry: string): Promise<Set<string>> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      queue.push(resolve(dirname(file), match[1]!))
    }
  }
  return seen
}

describe('패키지 경계 — 배포본만으로 선다', () => {
  it('production import graph가 build 범위를 벗어나지 않는다', async () => {
    // tsconfig는 주석을 허용하므로 JSON.parse 하지 않는다 — include에 이름이 있는지만 본다
    const build = await readFile(join(ROOT, 'tsconfig.build.json'), 'utf8')
    const outside: string[] = []

    for (const file of await reachable(ENTRY)) {
      const rel = relative(ROOT, file)
      const top = rel.split(sep)[0]!
      if (!build.includes(`"${top}"`)) outside.push(rel)
    }

    assert.deepEqual(
      outside.sort(),
      [],
      'build가 emit하지 않는 파일을 실행 경로가 부른다 — tsconfig.build.json include 에 넣어라',
    )
  })

  it('코드가 아닌 실행 자산은 build script가 옮긴다', async () => {
    const script = await readFile(join(ROOT, 'scripts', 'build.mjs'), 'utf8')
    for (const asset of ASSETS) {
      assert.match(script, new RegExp(`'${asset}'`), `${asset} 가 build script의 자산 목록에 없다`)
    }
    // 실제로 있는 디렉터리인지도 본다 — 오타는 조용히 빈 복사가 된다
    const entries = new Set((await readdir(ROOT, { withFileTypes: true })).map((e) => e.name))
    for (const asset of ASSETS) assert.ok(entries.has(asset), `${asset} 가 저장소에 없다`)
  })

  it('tarball에는 배포본만 담고, bin은 그 안을 가리킨다', async () => {
    const pkg = await json('package.json')
    assert.deepEqual(pkg.files, ['dist', 'README.md'])
    assert.equal((pkg.bin as Record<string, string>).asc, 'dist/cli/asc.js')
    // .ts 를 그대로 실어 node_modules 아래에서 죽던 형태로 돌아가지 않는다 (C-14 §1.1)
    assert.doesNotMatch(JSON.stringify(pkg.bin), /\.ts"/)
  })
})

// C-14 §2 — 패키지가 둘이고, 그 둘의 역할이 섞이지 않는다.
describe('패키지 경계 — 두 패키지의 역할 (C-14 §2)', () => {
  const pkgAt = async (rel: string) =>
    JSON.parse(await readFile(new URL(rel, import.meta.url), 'utf8')) as Record<string, any>

  it('뿌리는 배포 대상이 아니다 (불변식 ⑮)', async () => {
    const root = await pkgAt('../../../package.json')
    assert.equal(root.private, true, '뿌리가 publish 가능하면 언젠가 실수로 나간다')
    assert.deepEqual(root.workspaces, ['packages/*'])
  })

  it('bootstrap은 runtime을 exact version으로 고정한다 (불변식 ⑧)', async () => {
    const runtime = await pkgAt('../../runtime/package.json')
    const bootstrap = await pkgAt('../../bootstrap/package.json')
    const pinned = bootstrap.dependencies?.['@asc-agent/runtime']
    assert.equal(pinned, runtime.version, 'lockstep이 깨졌다')
    // 테스트하지 않은 runtime을 installer가 몰래 부르면 안 된다
    assert.doesNotMatch(String(pinned), /[\^~]|latest|\*/)
  })

  it('의존은 한 방향이다 — runtime은 bootstrap을 모른다', async () => {
    const runtime = await pkgAt('../../runtime/package.json')
    const names = Object.keys({ ...runtime.dependencies, ...runtime.devDependencies })
    assert.equal(names.some((n) => n.includes('bootstrap')), false)
  })

  it('bootstrap에는 setup 정책이 없다 (불변식 ⑦)', async () => {
    const source = await readFile(new URL('../../bootstrap/src/cli.ts', import.meta.url), 'utf8')
    // 넘기는 것 말고 스스로 판단하면 그 판단은 두 번째 구현이다
    assert.match(source, /runAscCommand/)
    assert.doesNotMatch(source, /workspace-index|profile\.lock|identities\.json|escalat/i)
  })

  it('import 만으로 명령이 돌지 않는다 — bootstrap이 불러올 수 있어야 한다', async () => {
    const source = await readFile(new URL('../cli/asc.ts', import.meta.url), 'utf8')
    assert.match(source, /export async function runAscCommand/)
    assert.match(source, /invokedDirectly/)
  })
})
