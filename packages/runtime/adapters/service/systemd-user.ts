// Linux — systemd --user (설계 §4.3).
//
// 사용자 세션에 묶인다. **lingering 을 조용히 켜지 않는다** — 그것은 "로그아웃해도 돈다"는
// 뜻이고, 사용자가 하지 않은 결정이다. 필요해지면 사람이 명시적으로 켠다.
//
// timer 가 주기를 갖고 service 가 한 회차를 돈다. 계속 도는 프로세스를 두지 않는 이유는
// port 주석과 같다.

import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  SERVICE_LABEL,
  type PersistentRuntimeAdapter,
  type ServiceCommand,
  type ServiceState,
} from '../../core/distribution/persistent-runtime.ts'

const run = promisify(execFile)

export const unitDir = (home = homedir()): string => join(home, '.config', 'systemd', 'user')
export const SERVICE_UNIT = `${SERVICE_LABEL}.service`
export const TIMER_UNIT = `${SERVICE_LABEL}.timer`

/** systemd 인자 인용. 공백이 든 경로가 통째로 깨지지 않게 한다. */
const quote = (value: string): string => `"${value.replace(/(["\\])/g, '\\$1')}"`

export function serviceUnit(command: ServiceCommand): string {
  return `[Unit]
Description=ASC persistent runtime

[Service]
Type=oneshot
ExecStart=${[command.program, ...command.args].map(quote).join(' ')}
`
}

export function timerUnit(command: ServiceCommand): string {
  return `[Unit]
Description=ASC persistent runtime schedule

[Timer]
OnBootSec=${command.intervalSeconds}
OnUnitActiveSec=${command.intervalSeconds}
Unit=${SERVICE_UNIT}

[Install]
WantedBy=timers.target
`
}

export type SystemdDeps = {
  home?: string
  exec?: (command: string, args: readonly string[]) => Promise<void>
  /** systemd --user 를 쓸 수 있는가. 테스트 주입점. */
  available?: () => Promise<boolean>
}

export function systemdUserAdapter(deps: SystemdDeps = {}): PersistentRuntimeAdapter {
  const home = deps.home ?? homedir()
  const dir = unitDir(home)
  const exec =
    deps.exec ??
    (async (command: string, args: readonly string[]) => {
      await run(command, [...args])
    })
  const available =
    deps.available ??
    (async () => {
      if (process.platform !== 'linux') return false
      // 컨테이너처럼 user bus 가 없는 자리가 흔하다 — 있는 척하지 않는다.
      return run('systemctl', ['--user', 'show-environment'])
        .then(() => true)
        .catch(() => false)
    })

  return {
    id: 'systemd-user',
    supported: available,
    async status(command) {
      const service = await readFile(join(dir, SERVICE_UNIT), 'utf8').catch(() => null)
      const timer = await readFile(join(dir, TIMER_UNIT), 'utf8').catch(() => null)
      if (service === null || timer === null) return { kind: 'ABSENT' } satisfies ServiceState
      return service === serviceUnit(command) && timer === timerUnit(command)
        ? ({ kind: 'CURRENT', detail: dir } satisfies ServiceState)
        : ({ kind: 'STALE', detail: `${dir} does not match the current runtime` } satisfies ServiceState)
    },
    async install(command) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, SERVICE_UNIT), serviceUnit(command), 'utf8')
      await writeFile(join(dir, TIMER_UNIT), timerUnit(command), 'utf8')
      await exec('systemctl', ['--user', 'daemon-reload'])
      await exec('systemctl', ['--user', 'enable', '--now', TIMER_UNIT])
    },
    async uninstall() {
      await exec('systemctl', ['--user', 'disable', '--now', TIMER_UNIT]).catch(() => undefined)
      // 우리가 만든 것만 지운다.
      await rm(join(dir, TIMER_UNIT), { force: true })
      await rm(join(dir, SERVICE_UNIT), { force: true })
      await exec('systemctl', ['--user', 'daemon-reload']).catch(() => undefined)
    },
  }
}

/** 이 기계에 맞는 adapter. 모르면 `null` — 없는 것을 있는 척하지 않는다. */
export function serviceAdapterFor(
  platform: NodeJS.Platform,
): 'launchd' | 'schtasks' | 'systemd-user' | null {
  if (platform === 'darwin') return 'launchd'
  if (platform === 'win32') return 'schtasks'
  if (platform === 'linux') return 'systemd-user'
  return null
}
