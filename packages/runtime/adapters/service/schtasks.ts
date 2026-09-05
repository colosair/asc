// Windows — 사용자 Scheduled Task (설계 §4.3).
//
// 시스템 서비스가 아니라 **로그인한 사용자의 작업**이다. `/RU` 없이 만들면 현재 사용자로
// 등록되고, 그것이 이 계약의 경계다.
//
// 반복은 Task Scheduler 가 한다(`/SC MINUTE /MO n`). ASC 는 한 회차만 도는 명령을 준다.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import {
  SERVICE_LABEL,
  type PersistentRuntimeAdapter,
  type ServiceCommand,
  type ServiceState,
} from '../../core/distribution/persistent-runtime.ts'

const run = promisify(execFile)

/** 작업 이름. `\` 없이 두면 루트 폴더에 만들어진다. */
export const TASK_NAME = SERVICE_LABEL

/**
 * `/TR` 에 들어갈 한 줄.
 *
 * schtasks 는 명령을 문자열 하나로 받는다 — 경로에 공백이 있으면 통째로 깨지므로
 * 각 조각을 따옴표로 감싼다. 따옴표가 든 인자는 등록 자체를 깨뜨리므로 거른다.
 */
export function taskRunLine(command: ServiceCommand): string {
  const quote = (value: string) => `\\"${value}\\"`
  return [command.program, ...command.args].map(quote).join(' ')
}

/** 분 단위 반복. 1분 아래로는 Task Scheduler 가 받지 않는다. */
export const taskMinutes = (intervalSeconds: number): number => Math.max(1, Math.round(intervalSeconds / 60))

export type SchtasksDeps = {
  exec?: (command: string, args: readonly string[]) => Promise<string>
}

export function schtasksAdapter(deps: SchtasksDeps = {}): PersistentRuntimeAdapter {
  const exec =
    deps.exec ??
    (async (command: string, args: readonly string[]) => {
      const { stdout } = await run(command, [...args])
      return stdout
    })

  return {
    id: 'schtasks',
    async supported() {
      return process.platform === 'win32'
    },
    async status(command) {
      const query = await exec('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST', '/V']).catch(() => null)
      // 조회가 실패하는 것은 대개 "없다"이다. 없는 것과 못 읽은 것을 구분할 방법이
      // schtasks 에는 없으므로, 없는 쪽으로 읽고 install 이 다시 판정하게 둔다.
      if (query === null) return { kind: 'ABSENT' } satisfies ServiceState
      const wanted = taskRunLine(command).replace(/\\"/g, '"')
      // 조회 출력에 우리 명령이 그대로 들어 있는가. 없으면 낡은 등록이다.
      return query.includes(wanted)
        ? ({ kind: 'CURRENT', detail: TASK_NAME } satisfies ServiceState)
        : ({ kind: 'STALE', detail: `${TASK_NAME} runs a different command` } satisfies ServiceState)
    },
    async install(command) {
      // `/F` 로 덮어쓴다 — 같은 이름의 우리 등록을 지금 형태로 수렴시키는 것이다.
      await exec('schtasks', [
        '/Create',
        '/F',
        '/TN',
        TASK_NAME,
        '/TR',
        taskRunLine(command),
        '/SC',
        'MINUTE',
        '/MO',
        String(taskMinutes(command.intervalSeconds)),
      ])
    },
    async uninstall() {
      await exec('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']).catch(() => undefined)
    },
  }
}
