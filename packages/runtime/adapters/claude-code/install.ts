// Claude Host 설치물 관리 — skill · guard hook · manifest (C-03 §5.1).
//
// spike 결론(B-15): user-scope Skill + user-scope settings hook. Plugin을 버린 이유는
// marketplace 관리가 더 무겁고, enforcement 안정성은 설치 위치가 아니라 hook의 판별
// 로직이 결정하기 때문이다. 프로젝트 tracked 파일은 만들지 않는다 —
// `.claude/settings.local.json`은 gitignore 보장이 없어 배제했다(spike 실측).
//
// 설치는 계약이 셋이다 (C-03 §5.1):
//   반복 install → idempotent
//   같은 경로의 사용자 파일 → 무단 overwrite 금지 (digest 검증)
//   uninstall → ASC가 설치했다고 manifest로 증명되는 것만 제거

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { hookScript } from './guard.ts'
import { skillBundle } from './skill.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

export type InstallPaths = {
  /** 보통 ~/.claude — 테스트가 격리 디렉터리를 넘긴다. */
  claudeHome: string
}

export const defaultPaths = (): InstallPaths => ({ claudeHome: join(homedir(), '.claude') })

const HOOK_MATCHER = 'Bash'
const HOOK_MARKER = 'asc-external-write-guard'

function locate(paths: InstallPaths) {
  return {
    /** Bundle 전체. 파일이 늘어도 아래 계약(manifest·digest·멱등)은 그대로다 (C-05 §5). */
    skills: skillBundle().map((skill) => ({
      name: skill.name,
      path: join(paths.claudeHome, 'skills', skill.name, 'SKILL.md'),
      text: skill.text,
    })),
    /** hook은 **하나**로 둔다. guard는 안전 층이고 중복 등록은 그 자체가 위험이다. */
    hook: join(paths.claudeHome, 'asc', 'guard-hook.mjs'),
    settings: join(paths.claudeHome, 'settings.json'),
    manifest: join(paths.claudeHome, 'asc', 'install-manifest.json'),
  }
}

type Manifest = { files: Record<string, string>; settingsHook: boolean; installedAt: string }

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export type InstallOutcome = {
  written: string[]
  skipped: { path: string; reason: string }[]
  hookRegistered: boolean
}

export async function install(
  paths: InstallPaths,
  now: () => string = () => new Date().toISOString(),
  opts: { force?: boolean } = {},
): Promise<InstallOutcome> {
  const where = locate(paths)
  const force = opts.force ?? false
  const manifest = ((await readJson(where.manifest)) as Manifest | null) ?? {
    files: {},
    settingsHook: false,
    installedAt: now(),
  }
  const written: string[] = []
  const skipped: { path: string; reason: string }[] = []

  // 파일 배치. **세 경우를 가른다** (아래 `fileState` 와 같은 판정이다):
  //   지금 source와 같다        → 그대로 둔다 (idempotent)
  //   설치 당시와 같다(stale)    → 지금 source로 수렴시킨다 — 이것이 업그레이드다
  //   둘 다 아니다(user-modified)→ 남긴다. uninstall이 보존하는 것을 install이 지우면 안 된다
  for (const [path, content] of [
    ...where.skills.map((skill) => [skill.path, skill.text] as const),
    [where.hook, hookScript()],
  ] as const) {
    const existing = await readFile(path, 'utf8').catch(() => null)
    const state = fileState(existing, content, manifest.files[path])
    if (state === 'current') {
      manifest.files[path] = sha(content) // 내용 동일 — manifest만 확실히 잡는다
      continue
    }
    if (state === 'modified' && !force) {
      skipped.push({
        path,
        reason:
          manifest.files[path] === undefined
            ? 'a file of yours is already there — not overwriting it'
            : 'you edited this after install — pass --force to overwrite',
      })
      continue
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
    manifest.files[path] = sha(content)
    written.push(path)
  }

  // settings.json에 PreToolUse hook 등록 — ASC 항목만 다루고 나머지는 손대지 않는다
  const settings = (await readJson(where.settings)) ?? {}
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>
  const preToolUse = (hooks.PreToolUse ?? []) as {
    matcher?: string
    hooks?: { type: string; command: string; _asc?: string }[]
  }[]

  const command = hookCommand(where.hook)
  const ours = preToolUse.filter((entry) => entry.hooks?.some((h) => h._asc === HOOK_MARKER))
  // 등록은 돼 있는데 **다른 곳을 가리키는** 경우가 있다 — 그 상태에서 "설치됨"이라고
  // 하면 guard가 없는데 있다고 믿는다. 우리 항목만 지금 경로로 고친다.
  const misdirected = ours.some((entry) => entry.hooks?.some((h) => h._asc === HOOK_MARKER && h.command !== command))
  if (ours.length === 0) {
    preToolUse.push({ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command, _asc: HOOK_MARKER }] })
  } else if (misdirected) {
    for (const entry of ours) {
      for (const h of entry.hooks ?? []) if (h._asc === HOOK_MARKER) h.command = command
    }
  }
  if (ours.length === 0 || misdirected) {
    settings.hooks = { ...hooks, PreToolUse: preToolUse }
    await mkdir(dirname(where.settings), { recursive: true })
    await writeFile(where.settings, JSON.stringify(settings, null, 2) + '\n', 'utf8')
    written.push(`${where.settings} (PreToolUse hook)`)
  }
  manifest.settingsHook = true

  await mkdir(dirname(where.manifest), { recursive: true })
  await writeFile(where.manifest, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { written, skipped, hookRegistered: true }
}

/**
 * 설치본이 지금 source와 같은가 (기존 한계 L-5).
 *
 * 예전에는 manifest digest만 봤다. manifest는 **설치 당시** 무엇을 썼는지를 적은 것이라,
 * 그 뒤 hook·skill source가 전진해도 "설치됨"이라고 답했다. 패키지가 올라가도 사용자의
 * `~/.claude` 는 옛 내용인데 아무도 그것을 모르는 상태가 그렇게 생긴다.
 *
 * 그래서 세 값을 견준다:
 *
 * ```text
 * S = 지금 source가 만들어 낼 내용   (skillBundle() · hookScript())
 * M = manifest에 적힌 설치 당시 내용
 * I = 지금 설치돼 있는 내용
 *
 * I == S                → current    같다
 * I == M  그리고 S != M  → stale      사용자는 안 고쳤고 source만 전진했다
 * I != M  그리고 I != S  → modified   설치 뒤 사람이 고쳤다
 * 파일 없음               → missing
 * ```
 *
 * **stale과 modified를 섞지 않는다.** 섞으면 업그레이드가 사람의 수정을 지우거나,
 * 반대로 낡은 설치본이 영영 갱신되지 않는다.
 */
export type InstallStatus =
  | 'NOT_INSTALLED'
  | 'INSTALLED_CURRENT'
  | 'INSTALLED_STALE'
  | 'INSTALLED_MODIFIED'
  | 'BROKEN'

export type FileState = 'current' | 'stale' | 'modified' | 'missing'

export type InstallReport = {
  status: InstallStatus
  files: { path: string; state: FileState }[]
  /** settings.json 의 PreToolUse에 우리 hook이 지금 경로로 등록돼 있는가. */
  hookRegistered: boolean
}

/** 한 파일의 3-way 판정. install과 verify가 **같은 함수**를 쓴다 — 둘이 다르면 그게 결함이다. */
function fileState(existing: string | null, source: string, recorded?: string): FileState {
  if (existing === null) return 'missing'
  const now = sha(existing)
  if (now === sha(source)) return 'current'
  if (recorded !== undefined && now === recorded) return 'stale'
  return 'modified'
}

function hookCommand(hookPath: string): string {
  return `node "${hookPath}"`
}

export async function verifyInstall(paths: InstallPaths): Promise<InstallReport> {
  const where = locate(paths)
  const manifest = (await readJson(where.manifest)) as Manifest | null

  const expected = [
    ...where.skills.map((skill) => [skill.path, skill.text] as const),
    [where.hook, hookScript()] as const,
  ]

  const files: { path: string; state: FileState }[] = []
  for (const [path, content] of expected) {
    const existing = await readFile(path, 'utf8').catch(() => null)
    files.push({ path, state: fileState(existing, content, manifest?.files[path]) })
  }

  const settings = await readJson(where.settings)
  const preToolUse = ((settings?.hooks as Record<string, unknown[]>)?.PreToolUse ?? []) as {
    hooks?: { _asc?: string; command?: string }[]
  }[]
  const ourHooks = preToolUse.flatMap((entry) => (entry.hooks ?? []).filter((h) => h._asc === HOOK_MARKER))
  const hookRegistered = ourHooks.length > 0
  // 등록은 있는데 다른 곳을 가리키면 설치본이 뒤처진 것이다 — 없는 것으로 치지 않고 stale로 본다
  const hookMisdirected = hookRegistered && !ourHooks.some((h) => h.command === hookCommand(where.hook))

  const status = ((): InstallStatus => {
    if (!manifest && files.every((f) => f.state === 'missing') && !hookRegistered) return 'NOT_INSTALLED'
    if (!manifest || files.some((f) => f.state === 'missing') || !hookRegistered) return 'BROKEN'
    if (files.some((f) => f.state === 'modified')) return 'INSTALLED_MODIFIED'
    if (files.some((f) => f.state === 'stale') || hookMisdirected) return 'INSTALLED_STALE'
    return 'INSTALLED_CURRENT'
  })()

  return { status, files, hookRegistered }
}

/**
 * 설치가 지금 source 그대로인가. 기존 호출부(setup 판정·probe)는 참/거짓만 필요하다.
 * **stale도 거짓이다** — 낡은 설치본을 "설치됨"이라 부르면 L-5가 그대로 남는다.
 */
export async function verifyInstalled(paths: InstallPaths): Promise<boolean> {
  return (await verifyInstall(paths)).status === 'INSTALLED_CURRENT'
}

/** 사람이 읽는 줄. 상태마다 다음에 할 일이 다르므로 그것까지 말한다. */
export function installReportLines(report: InstallReport): string[] {
  const remedy: Record<InstallStatus, string> = {
    NOT_INSTALLED: 'not installed yet — run `asc host claude install`',
    INSTALLED_CURRENT: 'matches the current source',
    INSTALLED_STALE: 'the installation is behind the current source — `asc host claude install` converges it',
    INSTALLED_MODIFIED: 'you edited some installed files — leave them, or overwrite with `install --force`',
    BROKEN: 'part of the installation is missing, or the hook is not registered — `asc host claude install`',
  }
  const lines = [`Install state: ${report.status} — ${remedy[report.status]}`]
  for (const file of report.files) {
    if (file.state === 'current') continue
    lines.push(`  [${file.state}] ${file.path}`)
  }
  if (!report.hookRegistered) lines.push('  [missing] PreToolUse hook registration in settings.json')
  return lines
}

export type UninstallOutcome = { removed: string[]; kept: { path: string; reason: string }[] }

/** manifest로 증명되는 것만 제거한다. 사용자가 고친 파일은 남기고 이유를 말한다. */
export async function uninstall(paths: InstallPaths): Promise<UninstallOutcome> {
  const where = locate(paths)
  const manifest = (await readJson(where.manifest)) as Manifest | null
  const removed: string[] = []
  const kept: { path: string; reason: string }[] = []
  if (!manifest) return { removed, kept: [{ path: where.manifest, reason: 'no manifest — nothing is recorded as installed' }] }

  for (const [path, digest] of Object.entries(manifest.files)) {
    const existing = await readFile(path, 'utf8').catch(() => null)
    if (existing === null) continue
    if (sha(existing) !== digest) {
      kept.push({ path, reason: 'edited after install — cannot prove ASC owns it, so it stays' })
      continue
    }
    await rm(path)
    removed.push(path)
  }

  // settings에서 ASC hook 항목만 걷어낸다 — 무관한 설정은 그대로
  const settings = await readJson(where.settings)
  if (settings?.hooks) {
    const hooks = settings.hooks as Record<string, unknown[]>
    const preToolUse = (hooks.PreToolUse ?? []) as { hooks?: { _asc?: string }[] }[]
    const filtered = preToolUse.filter((entry) => !entry.hooks?.some((h) => h._asc === HOOK_MARKER))
    if (filtered.length !== preToolUse.length) {
      if (filtered.length > 0) hooks.PreToolUse = filtered
      else delete hooks.PreToolUse
      // 우리가 만든 hooks 컨테이너가 비면 키째 걷는다 — 빈 {}도 원래 없던 흔적이다
      if (Object.keys(hooks).length === 0) delete settings.hooks
      await writeFile(where.settings, JSON.stringify(settings, null, 2) + '\n', 'utf8')
      removed.push(`${where.settings} (PreToolUse hook entry)`)
    }
  }

  await rm(where.manifest, { force: true })
  await rm(dirname(where.manifest), { recursive: true, force: true }).catch(() => {})

  // 파일만 지우면 빈 skills/<name>/ 이 남는다 (P1 관찰 ⑥). 우리가 만든 디렉터리이므로
  // 우리가 걷되 **비어 있을 때만** 걷는다 — rmdir은 안에 무언가 남아 있으면 실패하고,
  // 그 경우엔 남기는 것이 맞다(사용자가 넣은 것일 수 있다).
  for (const skill of where.skills) {
    await rmdir(dirname(skill.path)).catch(() => {})
  }
  return { removed, kept }
}
