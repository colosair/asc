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
import { sessionStartScript } from './session-start.ts'
import { skillBundle } from './skill.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

export type InstallPaths = {
  /** 보통 ~/.claude — 테스트가 격리 디렉터리를 넘긴다. */
  claudeHome: string
  /**
   * 이 hook들을 부를 ASC CLI의 경로. SessionStart hook이 상태를 물어볼 곳이다.
   *
   * 없으면 SessionStart는 설치되지 않는다 — 어디를 부를지 모르는 hook을 심느니
   * 그 기능이 없는 편이 낫다.
   */
  entry?: string
}

export const defaultPaths = (): InstallPaths => ({ claudeHome: join(homedir(), '.claude') })

const HOOK_MARKER = 'asc-external-write-guard'
const FRONT_MARKER = 'asc-front-binding'

/**
 * ASC가 등록하는 hook들. 이벤트마다 **하나**씩이며 중복 등록은 그 자체가 결함이다.
 *
 * `_asc` 표식이 소유권의 근거다 — 이것이 붙은 항목만 우리가 고치고 지운다.
 */
type HookSpec = {
  event: string
  marker: string
  /** 이 이벤트가 matcher를 쓰는가. SessionStart는 도구 이름으로 거르지 않는다. */
  matcher?: string
  script: string
}

function locate(paths: InstallPaths) {
  const guard = join(paths.claudeHome, 'asc', 'guard-hook.mjs')
  const front = join(paths.claudeHome, 'asc', 'front-hook.mjs')
  return {
    /** Bundle 전체. 파일이 늘어도 아래 계약(manifest·digest·멱등)은 그대로다 (C-05 §5). */
    skills: skillBundle().map((skill) => ({
      name: skill.name,
      path: join(paths.claudeHome, 'skills', skill.name, 'SKILL.md'),
      text: skill.text,
    })),
    /** hook은 **하나**로 둔다. guard는 안전 층이고 중복 등록은 그 자체가 위험이다. */
    hook: guard,
    front,
    settings: join(paths.claudeHome, 'settings.json'),
    manifest: join(paths.claudeHome, 'asc', 'install-manifest.json'),
    hooks: ((): HookSpec[] => {
      const specs: HookSpec[] = [
        { event: 'PreToolUse', marker: HOOK_MARKER, matcher: 'Bash', script: guard },
      ]
      // 부를 곳을 모르면 심지 않는다 (§InstallPaths.entry)
      if (paths.entry) specs.push({ event: 'SessionStart', marker: FRONT_MARKER, script: front })
      return specs
    })(),
  }
}

/**
 * settings.json 의 hook 목록에서 **우리 항목만** 손본다 (C-03 §5.1).
 *
 * 표식이 없는 남의 항목은 읽지도 고치지도 않는다. 여기가 "사용자의 host integration을
 * 보존한다"가 실제로 지켜지는 자리다 — 사람이 넣어 둔 SessionStart hook 옆에 우리 것을
 * **더할** 뿐이다.
 *
 * 표식 없이 우리 스크립트를 가리키는 항목은 **옛 설치본이다.** 그것을 남으로 보면 재설치가
 * 같은 guard를 하나 더 등록해 버린다 (실측: 표식 이전 버전으로 설치한 기계에서 그렇게
 * 됐다). 그래서 명령이 우리 스크립트를 가리키면 그 항목을 우리 것으로 **입양한다**.
 */
function reconcileHooks(
  settings: Record<string, unknown>,
  specs: readonly HookSpec[],
): { settings: Record<string, unknown>; changed: string[] } {
  const hooks = { ...((settings.hooks ?? {}) as Record<string, unknown[]>) }
  const changed: string[] = []

  for (const spec of specs) {
    const command = hookCommand(spec.script)
    const entries = [...((hooks[spec.event] ?? []) as {
      matcher?: string
      hooks?: { type: string; command: string; _asc?: string }[]
    }[])]

    let touched = false
    // 표식 없이 우리 스크립트를 가리키는 옛 항목을 입양한다
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        if (hook._asc === undefined && hook.command === command) {
          hook._asc = spec.marker
          touched = true
        }
      }
    }

    const ours = entries.filter((entry) => entry.hooks?.some((h) => h._asc === spec.marker))
    if (ours.length === 0) {
      entries.push({
        ...(spec.matcher ? { matcher: spec.matcher } : {}),
        hooks: [{ type: 'command', command, _asc: spec.marker }],
      })
      touched = true
    } else {
      // 등록은 돼 있는데 **다른 곳을 가리키는** 경우가 있다 — 그 상태에서 "설치됨"이라고
      // 하면 hook이 없는데 있다고 믿는다. 우리 항목만 지금 경로로 고친다.
      for (const entry of ours) {
        for (const hook of entry.hooks ?? []) {
          if (hook._asc === spec.marker && hook.command !== command) {
            hook.command = command
            touched = true
          }
        }
      }
      // 같은 표식이 여럿이면 하나만 남긴다 — 중복 등록은 그 자체가 결함이다
      if (ours.length > 1) {
        for (const extra of ours.slice(1)) {
          const at = entries.indexOf(extra)
          if (at >= 0) entries.splice(at, 1)
        }
        touched = true
      }
    }

    if (touched) {
      hooks[spec.event] = entries
      changed.push(spec.event)
    }
  }

  return { settings: changed.length > 0 ? { ...settings, hooks } : settings, changed }
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
    // 부를 CLI를 모르면 SessionStart hook 자체를 만들지 않는다
    ...(paths.entry ? ([[where.front, sessionStartScript(paths.entry)]] as const) : []),
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

  // settings.json 의 hook 등록 — **ASC 항목만** 다루고 나머지는 한 글자도 건드리지 않는다
  const reconciled = reconcileHooks((await readJson(where.settings)) ?? {}, where.hooks)
  if (reconciled.changed.length > 0) {
    await mkdir(dirname(where.settings), { recursive: true })
    await writeFile(where.settings, JSON.stringify(reconciled.settings, null, 2) + '\n', 'utf8')
    written.push(`${where.settings} (${reconciled.changed.join(', ')} hook)`)
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
    ...(paths.entry ? [[where.front, sessionStartScript(paths.entry)] as const] : []),
  ]

  const files: { path: string; state: FileState }[] = []
  for (const [path, content] of expected) {
    const existing = await readFile(path, 'utf8').catch(() => null)
    files.push({ path, state: fileState(existing, content, manifest?.files[path]) })
  }

  const settings = await readJson(where.settings)
  // 이벤트마다 우리 항목이 있는가. 하나라도 없으면 등록이 성립하지 않은 것으로 본다 —
  // 반쯤 등록된 상태를 "설치됨"이라 부르면 없는 hook을 있다고 믿게 된다.
  const registrations = where.hooks.map((spec) => {
    const entries = ((settings?.hooks as Record<string, unknown[]>)?.[spec.event] ?? []) as {
      hooks?: { _asc?: string; command?: string }[]
    }[]
    const mine = entries.flatMap((entry) => (entry.hooks ?? []).filter((h) => h._asc === spec.marker))
    return { present: mine.length > 0, pointsHere: mine.some((h) => h.command === hookCommand(spec.script)) }
  })
  const hookRegistered = registrations.every((r) => r.present)
  // 등록은 있는데 다른 곳을 가리키면 설치본이 뒤처진 것이다 — 없는 것으로 치지 않고 stale로 본다
  const hookMisdirected = registrations.some((r) => r.present && !r.pointsHere)

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
  if (!report.hookRegistered) lines.push('  [missing] an ASC hook registration in settings.json')
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

  // settings에서 ASC hook 항목만 걷어낸다 — 무관한 설정은 그대로.
  // 표식(`_asc`)이 소유권의 근거다: 사람이 넣은 SessionStart hook은 그 자리에 남는다.
  const settings = await readJson(where.settings)
  if (settings?.hooks) {
    const hooks = settings.hooks as Record<string, unknown[]>
    // 지금 설치가 SessionStart를 안 심었더라도 옛 설치가 남긴 것은 걷는다 —
    // 우리 표식이 붙은 것은 전부 우리 것이다.
    const markers = new Set([HOOK_MARKER, FRONT_MARKER])
    const dropped: string[] = []
    for (const [event, value] of Object.entries(hooks)) {
      const entries = (value ?? []) as { hooks?: { _asc?: string }[] }[]
      const kept = entries.filter((entry) => !entry.hooks?.some((h) => h._asc && markers.has(h._asc)))
      if (kept.length === entries.length) continue
      if (kept.length > 0) hooks[event] = kept
      else delete hooks[event]
      dropped.push(event)
    }
    if (dropped.length > 0) {
      // 우리가 만든 hooks 컨테이너가 비면 키째 걷는다 — 빈 {}도 원래 없던 흔적이다
      if (Object.keys(hooks).length === 0) delete settings.hooks
      await writeFile(where.settings, JSON.stringify(settings, null, 2) + '\n', 'utf8')
      removed.push(`${where.settings} (${dropped.join(', ')} hook entry)`)
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
