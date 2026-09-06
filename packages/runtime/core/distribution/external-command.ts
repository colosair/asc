// 바깥 CLI를 Windows에서도 실제로 찾아 부른다 (C-14 §11의 연장).
//
// Node는 보안 수정 이후 shell 없이 `.cmd` 를 실행하지 않는다. 그런데 npm이 전역 설치로
// 만들어 주는 명령은 Windows에서 전부 `.cmd` shim이다 — bare 이름을 Unix 방식으로만
// spawn하면 ENOENT/EINVAL이 나고, 호출자는 "설치돼 있지 않다"고 오판한다
// (Windows 실전 실측: shim이 PATH에 실재하는데 host probe가 not found →
// external_write_guard STOP까지 이어졌다).
//
// shell을 켜는 것은 답이 아니다 — 인자가 escape 없이 이어붙는다(DEP0190). 대신:
//   ① PATH에서 `.exe` 를 찾으면 그대로 부른다 (shell 불필요).
//   ② `.cmd` shim이면 그 안이 가리키는 JS 진입점을 읽어 지금 도는 node로 직접 부른다 —
//      cli/asc.ts의 npm 해석(resolveCommand)과 같은 태도다.
//   ③ shim을 못 읽으면 cmd.exe /d /c 로 그 .cmd 를 부른다 — cmd.exe는 진짜 실행 파일이라
//      shell 옵션이 필요 없다.
// 셋 다 실패하면 이름 그대로 돌려준다 — PATH에 진짜 실행 파일이 있는 환경이 그 경우다.

import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter as winDelimiter, dirname, extname, isAbsolute, join } from 'node:path/win32'

export type ResolvedInvocation = { command: string; args: string[] }

export type ResolveDeps = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** 테스트 주입용 — 실제 파일시스템을 보지 않게 한다. */
  exists?: (path: string) => boolean
  readText?: (path: string) => string | null
  nodePath?: string
}

const defaultRead = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * npm `.cmd` shim이 가리키는 JS 진입점.
 *
 * npm이 쓰는 shim은 두 세대가 있고 둘 다 `"%dp0%\<상대경로>" %*` 형태로 JS를 부른다:
 *   "%_prog%"  "%dp0%\node_modules\<pkg>\<bin>.js" %*
 *   "%dp0%\node.exe"  "%dp0%\node_modules\<pkg>\<bin>.js" %*
 * 형태가 다르면 null — 아는 척하지 않고 cmd.exe 경로로 넘어간다.
 */
export function shimTarget(shimText: string): string | null {
  const match = /"%dp0%\\([^"%]+\.(?:js|mjs|cjs))"/i.exec(shimText)
  return match ? match[1]! : null
}

export function resolveExternalCommand(
  command: string,
  args: readonly string[],
  deps: ResolveDeps = {},
): ResolvedInvocation {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return { command, args: [...args] }
  // 경로나 확장자를 이미 갖췄으면 호출자가 알고 부르는 것이다 — 손대지 않는다.
  if (isAbsolute(command) || command.includes('/') || command.includes('\\') || extname(command) !== '') {
    return { command, args: [...args] }
  }

  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const readText = deps.readText ?? defaultRead
  const nodePath = deps.nodePath ?? process.execPath
  const pathValue = env.PATH ?? env.Path ?? ''

  let firstShim: string | null = null
  for (const dir of pathValue.split(winDelimiter)) {
    if (!dir) continue
    const exe = join(dir, `${command}.exe`)
    if (exists(exe)) return { command: exe, args: [...args] }
    if (!firstShim) {
      for (const ext of ['.cmd', '.bat']) {
        const shim = join(dir, `${command}${ext}`)
        if (exists(shim)) {
          firstShim = shim
          break
        }
      }
    }
  }

  if (firstShim) {
    const text = readText(firstShim)
    const target = text ? shimTarget(text) : null
    if (target) {
      const script = join(dirname(firstShim), target)
      if (exists(script)) return { command: nodePath, args: [script, ...args] }
    }
    return { command: 'cmd.exe', args: ['/d', '/c', firstShim, ...args] }
  }

  return { command, args: [...args] }
}

/**
 * PATH 에서 실행 파일 하나를 찾는다 (POSIX). 없으면 null — 있는 척하지 않는다.
 *
 * Windows 는 위 `resolveExternalCommand` 가 shim 까지 풀어 주므로 여기서는 다루지 않는다.
 */
export function findOnPath(
  command: string,
  deps: { env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean; platform?: NodeJS.Platform } = {},
): string | null {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') return null
  if (command.includes('/')) return (deps.exists ?? isExecutable)(command) ? command : null
  const exists = deps.exists ?? isExecutable
  const pathValue = (deps.env ?? process.env).PATH ?? ''
  for (const dir of pathValue.split(':')) {
    if (!dir) continue
    const candidate = `${dir}/${command}`
    if (exists(candidate)) return candidate
  }
  return null
}

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 시스템 기본 자리. 서비스 관리자가 주는 PATH 가 대개 이것이다. */
export const SYSTEM_PATH = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const

/**
 * 서비스에 실어 보낼 PATH — **지금 이 셸의 PATH 를 통째로 옮기지 않는다.** 세션마다 붙는
 * 임시 디렉터리가 그대로 들어가면 등록물이 매번 STALE 이 되고, 사라진 경로가 남는다.
 * 대신 필요한 실행 파일이 **실제로 있는 디렉터리만** 고른다. 못 찾은 도구는 조용히 빠지지
 * 않고 `missing` 에 남는다 — 그 도구를 쓰는 통로는 서비스에서도 열리지 않을 것이다.
 */
export function servicePath(
  tools: readonly string[],
  deps: { env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean; platform?: NodeJS.Platform } = {},
): { path: string; missing: string[] } {
  const dirs: string[] = []
  const missing: string[] = []
  const push = (dir: string) => {
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  for (const tool of tools) {
    const found = findOnPath(tool, deps)
    if (found) push(found.slice(0, found.lastIndexOf('/')) || '/')
    else missing.push(tool)
  }
  for (const dir of SYSTEM_PATH) push(dir)
  return { path: dirs.join(':'), missing }
}
