// 어느 build를 부를 것인가 (C-14 §4·§5).
//
// **이것은 C-12의 "always-on runtime"과 다른 축이다.** 저쪽은 상태가 어떻게 지속되는가고,
// 여기는 실행물이 어느 build인가다. 같은 낱말을 쓰지만 섞으면 안 된다.
//
// 이 파일은 선택만 안다 — credential·project key·workspace state는 여기 오지 않는다.
// 그리고 **선택을 바꾸는 것은 project를 바꾸는 것이 아니다** (불변식 ⑤).

import { constants } from 'node:fs'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 이 패키지의 이름. development checkout이 진짜 ASC인지 여기에 견준다. */
export const RUNTIME_PACKAGE = '@asc-agent/runtime'

/** build 산출물의 진입점. checkout 뿌리 기준 상대경로다. */
export const RUNTIME_ENTRY = join('dist', 'cli', 'asc.js')

export const SELECTION_FILE = 'runtime.json'

export type RuntimeMode = 'package' | 'development'

export type RuntimeSelection =
  | { version: 1; runtime: { mode: 'package' } }
  | { version: 1; runtime: { mode: 'development'; source: string } }

export type ResolvedTarget =
  /** 설치된 실행물이 스스로 돈다. 중간 프로세스도, network도 없다. */
  | { kind: 'package' }
  /** 지정된 checkout의 build를 대신 실행한다. */
  | { kind: 'development'; source: string; entry: string }

export type ResolveFailure = {
  code: 'ASC_DEVELOPMENT_SOURCE_INVALID'
  detail: string
  /** 사람이 실행할 한 줄. 무엇이 틀렸는지만 말하고 끝내지 않는다. */
  nextCommand: string
  /**
   * 이 해법이 **어느 checkout에 대한 것인가**.
   *
   * 지금 cwd가 그 checkout이라는 보장이 없다. `npm run build` 한 줄만 주면 엉뚱한
   * 프로젝트에서 빌드가 돈다 — 실제로 그럴 수 있는 배치다(작업 중인 저장소 ≠ ASC checkout).
   */
  remediationTarget?: string
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export const selectionPath = (ascHome: string): string => join(ascHome, SELECTION_FILE)

/**
 * 읽지 못하는 선택은 **없는 것으로 본다** (C-14 §5).
 *
 * 반쯤 해석해서 엉뚱한 build를 부르는 것보다, 선택이 없다고 말하고 기본으로 도는 것이 낫다.
 */
export async function readRuntimeSelection(ascHome: string): Promise<RuntimeSelection | undefined> {
  let raw: string
  try {
    raw = await readFile(selectionPath(ascHome), 'utf8')
  } catch {
    return undefined
  }
  try {
    return normalizeSelection(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/** 손으로 고칠 수 있는 파일이다. 형식이 어긋나면 받아들이지 않는다. */
export function normalizeSelection(value: unknown): RuntimeSelection | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.version !== 1) return undefined
  const runtime = record.runtime as Record<string, unknown> | undefined
  if (!runtime) return undefined
  if (runtime.mode === 'package') return { version: 1, runtime: { mode: 'package' } }
  if (runtime.mode === 'development') {
    const source = runtime.source
    if (typeof source !== 'string' || source.trim() === '') return undefined
    return { version: 1, runtime: { mode: 'development', source } }
  }
  return undefined
}

/** tmp+rename — 중간에 끊겨도 반쯤 쓰인 선택이 남지 않는다. */
export async function writeRuntimeSelection(ascHome: string, selection: RuntimeSelection): Promise<void> {
  const target = selectionPath(ascHome)
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  await writeFile(tmp, `${JSON.stringify(selection, null, 2)}\n`, 'utf8')
  await rename(tmp, target)
}

/**
 * 어느 build를 부를 것인가. **거절은 여기서 끝낸다** (C-14 §4.1).
 *
 * 경로가 틀렸거나 build가 없는 것을 통과시키면 사람은 한참 뒤에 module-not-found를
 * 맞는다. 무엇이 없는지 아는 곳에서 말하는 것이 싸다.
 */
export async function resolveRuntimeTarget(
  selection: RuntimeSelection | undefined,
): Promise<ResolvedTarget | ResolveFailure> {
  // 선택이 없으면 지금 도는 실행물이 곧 답이다 — 첫 실행이 설정을 요구하지 않는다.
  if (!selection || selection.runtime.mode === 'package') return { kind: 'package' }

  const source = selection.runtime.source
  const reject = (detail: string): ResolveFailure => ({
    code: 'ASC_DEVELOPMENT_SOURCE_INVALID',
    detail,
    nextCommand: `asc runtime use development ${source}`,
  })

  if (!(await exists(source))) return reject(`${source} does not exist — it was moved or removed`)

  const manifest = join(source, 'package.json')
  if (!(await exists(manifest))) return reject(`${source} has no package.json`)

  let name: unknown
  try {
    name = (JSON.parse(await readFile(manifest, 'utf8')) as Record<string, unknown>).name
  } catch {
    return reject(`${manifest} could not be read`)
  }
  if (name !== RUNTIME_PACKAGE) {
    return reject(`${source} is not ${RUNTIME_PACKAGE} (found ${String(name)})`)
  }

  const entry = join(source, RUNTIME_ENTRY)
  if (!(await exists(entry))) {
    return {
      code: 'ASC_DEVELOPMENT_SOURCE_INVALID',
      detail: `${source} has not been built yet`,
      // 이 경우만 다르다 — 경로는 맞고 build만 없다. **어느 checkout인지 함께 든다**:
      // 지금 cwd가 그곳이라고 가정하면 남의 프로젝트를 빌드하게 만든다.
      nextCommand: 'npm run build',
      remediationTarget: source,
    }
  }
  return { kind: 'development', source, entry }
}

/** 사람이 읽는 한 줄. 지금 무엇이 돌지가 먼저다. */
export function runtimeSelectionLine(target: ResolvedTarget | ResolveFailure): string {
  if ('code' in target) return `Runtime selection does not resolve — ${target.detail}`
  return target.kind === 'package'
    ? 'runtime: package (the installed executable)'
    : `runtime: development (${target.source})`
}

/**
 * 해법을 사람에게 말한다. **무엇에 대한 해법인지 먼저 말한다** (C-14 §3.4의 태도).
 *
 * `npm run build` 만 던지면 지금 열려 있는 저장소에서 그것을 실행할 사람이 있다.
 */
export function remediationLines(failure: ResolveFailure): string[] {
  const lines = [`${failure.code}: ${failure.detail}`]
  if (failure.remediationTarget) {
    lines.push(`  target: ${failure.remediationTarget}`)
    lines.push(`  Build that checkout and retry — do not run this in the current directory.`)
  }
  lines.push(`  Run: ${failure.nextCommand}`)
  return lines
}

/** agent가 그대로 소비하는 형태. 어느 checkout인지가 데이터로 들어 있다. */
export function remediationAction(failure: ResolveFailure): {
  type: 'build_development_runtime' | 'select_development_runtime'
  source?: string
  display: string
} {
  return failure.remediationTarget
    ? {
        type: 'build_development_runtime',
        source: failure.remediationTarget,
        display: failure.nextCommand,
      }
    : { type: 'select_development_runtime', display: failure.nextCommand }
}
