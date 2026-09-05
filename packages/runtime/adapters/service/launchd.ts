// macOS — user LaunchAgent (설계 §4.3).
//
// root daemon 이 아니라 **사용자 것**이다. `~/Library/LaunchAgents/` 에 살고 로그인 이후에
// 돈다. 그것이 이 계약의 경계이고, 그 위로 올리지 않는다 — 사람의 세션과 무관하게 도는
// 것은 사용자가 켜지 않은 상시 프로세스이며 다른 종류의 결정이다.
//
// `StartInterval` 로 짧은 회차를 반복시킨다. 계속 도는 프로세스를 등록하지 않는 이유는
// port 주석에 있다: 죽었을 때 되살리는 일을 OS 가 더 잘한다.

import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import {
  SERVICE_LABEL,
  type PersistentRuntimeAdapter,
  type ServiceCommand,
  type ServiceState,
} from '../../core/distribution/persistent-runtime.ts'

const run = promisify(execFile)

export const plistPath = (home = homedir()): string =>
  join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)

/** XML 이스케이프. 경로에 `&` 가 있는 기계가 실제로 있다. */
const xml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * plist 본문. **내용이 곧 비교 기준이다** — 같으면 CURRENT, 다르면 STALE 이다.
 * digest 를 따로 두지 않는 이유: 파일이 우리가 만들 내용과 같은지 보는 것이 더 정확하다.
 */
export function launchAgentPlist(command: ServiceCommand): string {
  const args = [command.program, ...command.args].map((arg) => `    <string>${xml(arg)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key>
  <integer>${command.intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`
}

export type LaunchdDeps = {
  home?: string
  exec?: (command: string, args: readonly string[]) => Promise<void>
}

export function launchdAdapter(deps: LaunchdDeps = {}): PersistentRuntimeAdapter {
  const home = deps.home ?? homedir()
  const path = plistPath(home)
  const exec =
    deps.exec ??
    (async (command: string, args: readonly string[]) => {
      await run(command, [...args])
    })

  return {
    id: 'launchd',
    async supported() {
      return process.platform === 'darwin'
    },
    async status(command) {
      const wanted = launchAgentPlist(command)
      const existing = await readFile(path, 'utf8').catch(() => null)
      if (existing === null) return { kind: 'ABSENT' } satisfies ServiceState
      if (existing === wanted) return { kind: 'CURRENT', detail: path } satisfies ServiceState
      // 우리 파일이 우리 내용과 다르다 — 경로나 간격이 바뀌었다는 뜻이다.
      return { kind: 'STALE', detail: `${path} does not match the current runtime` } satisfies ServiceState
    },
    async install(command) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, launchAgentPlist(command), 'utf8')
      // 다시 읽히게 한다. 이미 없는 것을 unload 하는 것은 오류가 아니므로 삼킨다.
      await exec('launchctl', ['unload', path]).catch(() => undefined)
      await exec('launchctl', ['load', path])
    },
    async uninstall() {
      await exec('launchctl', ['unload', path]).catch(() => undefined)
      // 우리가 만든 것만 지운다. 없으면 지울 것이 없다.
      await rm(path, { force: true })
    },
  }
}
