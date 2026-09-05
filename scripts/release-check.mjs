#!/usr/bin/env node
// Release 일관성 preflight — publish를 대신하지 않는다.
//
// **Publish는 사람이 한다. Drift 검출은 기계가 한다.** 버전이 어긋난 채, 혹은 문서가
// 옛 exact 명령을 들고 있는 채 나가는 것을 막는 것이 전부다.
//
// JAM에서 실제로 겪은 계열의 문제를 선제적으로 닫는다 — 문서의 명령과 실제 release가
// 갈라지면 사용자가 존재하지 않는 버전을 부른다.

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const SCOPE = '@asc-agent'
const RUNTIME = `${SCOPE}/runtime`
const BOOTSTRAP = `${SCOPE}/bootstrap`
/** 과거 이름. current canonical surface에는 남아 있으면 안 된다. */
const RETIRED_SCOPE = '@asc-control'
/**
 * 이 검사에서 제외하는 곳.
 *
 * history는 history다 — 그 회차에 실제로 쓴 이름을 거짓으로 바꾸지 않는다. 그리고 이
 * 검사기 자신은 옛 이름을 **찾기 위해** 들고 있다.
 */
const EXEMPT = [
  'docs/pilots/',
  'docs/design/directives/',
  'docs/contracts/C-14_distribution-runtime-entry.md',
  'scripts/release-check.mjs',
  'packages/runtime/tests/release-consistency.test.ts',
]

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  OK  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const json = async (path) => JSON.parse(await readFile(join(root, path), 'utf8'))
const text = async (path) => readFile(join(root, path), 'utf8')

const runtimePkg = await json('packages/runtime/package.json')
const bootstrapPkg = await json('packages/bootstrap/package.json')
const rootPkg = await json('package.json')
const release = await text('packages/runtime/core/distribution/release.ts')

const version = runtimePkg.version

console.log(`\nrelease consistency — ${RUNTIME}@${version}`)

// ── identity ───────────────────────────────────────────────────────────────
check(rootPkg.private === true, 'workspace root is private (not a publish target)')
check(runtimePkg.name === RUNTIME, 'runtime package name', runtimePkg.name)
check(bootstrapPkg.name === BOOTSTRAP, 'bootstrap package name', bootstrapPkg.name)

// ── lockstep ───────────────────────────────────────────────────────────────
check(bootstrapPkg.version === version, 'runtime and bootstrap versions match', `${version} / ${bootstrapPkg.version}`)
const pinned = bootstrapPkg.dependencies?.[RUNTIME]
check(pinned === version, 'bootstrap pins runtime at the exact version', String(pinned))

// ── release constants agree with package.json ──────────────────────────────
check(release.includes(`RELEASE_VERSION = '${version}'`), 'release.ts version matches package.json')
check(release.includes(`RUNTIME_PACKAGE = '${RUNTIME}'`), 'release.ts runtime package matches')
check(release.includes(`BOOTSTRAP_PACKAGE = '${BOOTSTRAP}'`), 'release.ts bootstrap package matches')

// ── no floating specs anywhere executable ──────────────────────────────────
const executableSurfaces = [
  'packages/runtime/core/distribution/release.ts',
  'packages/runtime/core/distribution/runtime-install.ts',
  'packages/runtime/core/distribution/runtime-select.ts',
  'packages/runtime/cli/asc.ts',
  'packages/bootstrap/src/cli.ts',
  'scripts/tarball-smoke.mjs',
]
for (const path of executableSurfaces) {
  const source = await text(path)
  const floating = [`${SCOPE}/runtime@latest`, `${SCOPE}/bootstrap@latest`, `${SCOPE}/runtime@1`, `${SCOPE}/bootstrap@1`]
  check(!floating.some((spec) => source.includes(spec)), `no floating spec in ${path}`)
  check(!source.includes(RETIRED_SCOPE), `no retired scope in ${path}`)
}

// ── documented exact commands match the release ────────────────────────────
// AGENTS.md도 여기 있어야 한다 — agent가 실제로 실행하는 명령이 적힌 문서이므로, 핀이
// 어긋나면 사람이 아니라 자동화가 틀린 버전을 설치한다.
const docs = ['README.md', 'README.ko.md', 'AGENTS.md', 'packages/runtime/README.md', 'packages/bootstrap/README.md']
// 코드가 만들어 내는 명령 문자열도 같은 규칙을 받는다. skill 본문은 사용자의
// `~/.claude/skills/` 에 **실제로 쓰이는** 것이라 여기서 뒤처지면 사용자가 그 명령을
// 실행한다 — 0.2.0 회차에 `@0.1.0` 을 들고 있었고 아무도 잡지 못했다.
const emitters = ['packages/runtime/adapters/claude-code/skill.ts', 'packages/bootstrap/src/cli.ts']
const staleSpec = new RegExp(`${SCOPE}/(runtime|bootstrap)@(?!${version.replace(/\./g, '\\.')})[0-9]`, 'g')
for (const path of [...docs, ...emitters]) {
  const source = await text(path)
  const stale = source.match(staleSpec)
  check(stale === null, `documented exact spec matches ${version} in ${path}`, stale?.join(', ') ?? '')
  check(!source.includes(`${SCOPE}/runtime@latest`), `no @latest in ${path}`)
}

// ── the persistent path is pinned exactly ──────────────────────────────────
// `npm install -g @asc-agent/runtime@<pin>` 은 npx가 서기도 전에 죽는 기계의 fallback으로
// 문서가 직접 시키는 명령이다 — 핀이 뒤처지면 사용자가 옛 버전을 전역에 심는다.
// `<exact>` 류 placeholder는 명령이 아니라 형태 설명이므로 통과시킨다.
const persistentSpec = new RegExp(`npm install -g ${RUNTIME}@([^\\s\\\`]+)`, 'g')
for (const path of docs) {
  const source = await text(path)
  const stalePins = [...source.matchAll(persistentSpec)]
    .map((m) => m[1])
    .filter((pin) => pin !== version && !pin.startsWith('<'))
  check(stalePins.length === 0, `npm install -g pin matches ${version} in ${path}`, stalePins.join(', '))
}

// ── the agent-facing surface names one canonical form ──────────────────────
// `--agent` 는 계속 동작하지만(호환) 문서·산출물에서는 사라졌다. `--json` 이 같은 것을
// 더 단순하게 말하고, 진입 표면이 둘이면 agent가 무엇이 정본인지 고르게 된다.
for (const path of [...docs, ...emitters]) {
  const source = await text(path)
  check(!source.includes('--agent'), `no --agent in the agent-facing surface: ${path}`)
}

// ── retired scope is gone from current surfaces ────────────────────────────
const offenders = []
const floaters = []
const walk = async (dir) => {
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'private' || entry.name === '.git' || entry.name === '.claude') continue
    if (entry.isDirectory()) {
      await walk(rel)
      continue
    }
    if (!/\.(ts|mjs|json|md)$/.test(entry.name)) continue
    if (EXEMPT.some((prefix) => rel.slice(2).startsWith(prefix))) continue
    const source = await text(rel)
    if (source.includes(RETIRED_SCOPE)) offenders.push(rel.slice(2))
    // floating spec은 문서 어디에 있어도 안 된다 — 사용자가 그 줄을 그대로 실행한다.
    if (source.includes(`${RUNTIME}@latest`) || source.includes(`${BOOTSTRAP}@latest`)) floaters.push(rel.slice(2))
  }
}
await walk('.')
check(offenders.length === 0, 'retired scope absent from current surfaces', offenders.join(', '))
check(floaters.length === 0, 'no @latest anywhere in current surfaces', floaters.join(', '))

// ── publish metadata ───────────────────────────────────────────────────────
// 이 아래는 **게시 직전에 틀리면 되돌리기 어려운 것들**이다. 실제 tarball 내용은
// `npm run pack:all` + `npm run smoke` 가 더 정확히 보므로 여기서 중복 소유하지 않는다.
const rootLicense = (await text('LICENSE')).split('\n')[0]
for (const [label, pkg, dir] of [
  ['runtime', runtimePkg, 'packages/runtime'],
  ['bootstrap', bootstrapPkg, 'packages/bootstrap'],
]) {
  check(pkg.license === rootPkg.license, `${label} license matches the workspace`, String(pkg.license))
  check(rootLicense.includes(String(pkg.license)), `${label} license matches the LICENSE file`, rootLicense)
  check((await text(`${dir}/LICENSE`)) === (await text('LICENSE')), `${label} ships the same LICENSE`)
  check(pkg.publishConfig?.access === 'public', `${label} publishConfig.access is public`)
  check(pkg.repository?.directory === dir, `${label} repository.directory`, String(pkg.repository?.directory))
  check(
    String(pkg.repository?.url).includes('github.com/colosair/asc'),
    `${label} repository url`,
    String(pkg.repository?.url),
  )
  check(String(pkg.homepage).startsWith('https://github.com/colosair/asc'), `${label} homepage`)
  check(String(pkg.bugs?.url).startsWith('https://github.com/colosair/asc'), `${label} bugs url`)
  check(pkg.engines?.node === rootPkg.engines?.node, `${label} node engine matches the workspace`, String(pkg.engines?.node))
  check(typeof pkg.description === 'string' && pkg.description.length > 20, `${label} has a real description`)
  check(Array.isArray(pkg.keywords) && pkg.keywords.length > 0, `${label} has keywords`)
  check(Array.isArray(pkg.files) && pkg.files.includes('dist'), `${label} ships dist`)
  check(!JSON.stringify(pkg.bin).includes('.ts"'), `${label} bin points at compiled output`)
}

// runtime → bootstrap 순서가 문서에 남아 있어야 한다. bootstrap이 exact로 runtime을
// 가리키므로 반대 순서로 게시하면 첫 설치가 깨진다.
const checklist = await text(`docs/release/v${version}-checklist.md`)
check(
  checklist.indexOf('publish @asc-agent/runtime') < checklist.indexOf('publish @asc-agent/bootstrap'),
  'release checklist publishes runtime before bootstrap',
)
check(checklist.includes(version), `release checklist names ${version}`)

// ── the Release body is authored, not generated ────────────────────────────
// The GitHub Release for this version is created from docs/releases/v<version>.md
// by release-finalize.yml. A missing or unstructured note fails here first, so the
// release-prep PR carries it rather than someone writing it into a web form later.
const notePath = `docs/releases/v${version}.md`
let note = null
try {
  note = await text(notePath)
} catch {
  note = null
}
check(note !== null, `release note exists: ${notePath}`)
if (note !== null) {
  for (const section of [
    '## What changed',
    '## Install / Upgrade',
    '## Agent setup',
    '## Compatibility',
    '## Verified',
    '## Known limitations',
  ]) {
    check(note.includes(section), `release note has "${section}"`)
  }
  check(note.includes(version), `release note names ${version}`)
  // Public artefacts are English (docs/release/README.md conventions).
  check(!/[가-힣]/.test(note), 'release note is English (no Hangul)')
  check(note.includes(`@asc-agent/bootstrap@${version}`), 'release note pins the bootstrap install command')
}

// ── stale version literals in consumer docs ────────────────────────────────
// A JSON example carrying an old release version reads as the current release
// (the 0.2.0 example lived in the README for two releases). Any quoted
// "version": "x.y.z" in the consumer docs must be the current version.
//
// This ran for four releases without being able to fail: the pattern was written
// unescaped, so `s*` asked for a literal `s` and `d+` for a literal `d`, and it
// matched nothing at all. A gate that cannot fail is worse than no gate — it
// reads as coverage. Escaped, and given a self-test below so an edit that breaks
// it again is caught by the same run.
const versionLiteral = /"version":\s*"(\d+\.\d+\.\d+)"/g
check(
  [...'"version": "9.9.9"'.matchAll(versionLiteral)].map((m) => m[1]).join('') === '9.9.9',
  'the version-literal pattern still matches a version literal',
)
for (const path of docs) {
  const source = await text(path)
  const staleVersionLiterals = [...source.matchAll(versionLiteral)]
    .map((m) => m[1])
    .filter((v) => v !== version)
  check(staleVersionLiterals.length === 0, `no stale "version" literal in ${path}`, staleVersionLiterals.join(', '))
}

// ── product status carries no release version ──────────────────────────────
// `docs/status.md` claimed a current release and drifted four releases behind,
// because nothing required it to move and nothing here looked at it. The fix is
// not another thing to remember: the file states what the product does and what
// is proven, and the published packages state which version that is. One fact,
// one place. This gate keeps a version from creeping back in.
const statusPath = 'docs/status.md'
const statusSource = await text(statusPath)
const releaseClaims = [...statusSource.matchAll(/v?\d+\.\d+\.\d+/g)].map((m) => m[0])
check(
  releaseClaims.length === 0,
  `${statusPath} names no release version — the packages and the latest Release are that answer`,
  releaseClaims.join(', '),
)

// SECURITY.md — 없는 채널을 있다고 적지 않는다
const security = await text('SECURITY.md')
check(security.includes('private vulnerability reporting'), 'SECURITY.md names a private reporting path')
check(/do not include/i.test(security), 'SECURITY.md tells reporters what not to send')
check(!/security@|@example\.com/.test(security), 'SECURITY.md invents no contact address')

console.log(failures === 0 ? '\nrelease:check passed' : `\nrelease:check failed: ${failures}`)
process.exitCode = failures === 0 ? 0 : 1
