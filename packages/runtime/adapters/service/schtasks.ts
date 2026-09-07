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
 * 각 조각을 따옴표로 감싼다.
 *
 * **따옴표는 `"` 하나다.** 셸을 거치지 않고 `execFile` 로 인자를 넘기므로 Windows 쪽
 * 이스케이프는 Node 가 한다. 여기서 `\"` 를 손으로 넣으면 그 위에 한 겹이 더 붙어
 * schtasks 가 백슬래시를 값으로 읽고, `C:\Program Files\...` 가 공백에서 잘린다.
 */
export function taskRunLine(command: ServiceCommand): string {
  const quote = (value: string) => `"${value}"`
  return [command.program, ...command.args].map(quote).join(' ')
}

/** 분 단위 반복. 1분 아래로는 Task Scheduler 가 받지 않는다. */
export const taskMinutes = (intervalSeconds: number): number => Math.max(1, Math.round(intervalSeconds / 60))

/**
 * schtasks 출력 해독.
 *
 * `/XML` 은 UTF-16LE 로 나온다. 필드 이름이 로케일에 따라 번역되는 `/FO LIST /V` 대신
 * 이것을 쓰는 이유가 그거다 — 태그 이름은 어느 언어에서나 같다.
 */
const decodeSchtasksOutput = (raw: Buffer): string =>
  raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8')

const XML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }

/**
 * ISO-8601 기간을 분으로. 모르는 형태면 `null`.
 *
 * **문자열로 비교하면 안 된다** — Task Scheduler 는 받은 값을 자기 방식으로 정규화한다.
 * `/MO 60` 으로 등록한 것이 `PT1H` 로 저장되므로 `PT60M` 을 기대하면 같은 등록을
 * 낡았다고 읽는다 (실기계 실측).
 */
export function durationMinutes(value: string): number | null {
  const parsed = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value.trim())
  if (!parsed) return null
  const [, days, hours, minutes, seconds] = parsed
  return Number(days ?? 0) * 1440 + Number(hours ?? 0) * 60 + Number(minutes ?? 0) + Number(seconds ?? 0) / 60
}

/**
 * 등록물이 지금 형태와 어긋난 점. 없으면 `null`.
 *
 * 명령만 보던 때에는 **간격이 달라도 CURRENT 로 읽혔다** — `intervalSeconds` 는
 * `taskRunLine` 에 들어가지 않기 때문이다. launchd·systemd 는 간격이 unit 내용에
 * 있어 그냥 잡히는데 여기만 눈이 없었다.
 */
export function registrationDrift(xml: string, command: ServiceCommand): string | null {
  const text = xml.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity] ?? entity)
  // Command 와 Arguments 는 태그로 갈려 있다. 태그를 지우면 등록한 그 한 줄로 돌아온다.
  const flattened = text.replace(/<\/?[^>]+>/g, ' ').replace(/\s+/g, ' ')
  if (!flattened.includes(taskRunLine(command))) return `${TASK_NAME} runs a different command`

  const interval = /<Interval>([^<]+)<\/Interval>/.exec(text)?.[1]?.trim()
  const wanted = taskMinutes(command.intervalSeconds)
  if (interval === undefined || durationMinutes(interval) !== wanted) {
    return `${TASK_NAME} repeats every ${interval ?? 'an unknown interval'}, not every ${wanted} min`
  }

  return null
}

export type SchtasksDeps = {
  exec?: (command: string, args: readonly string[]) => Promise<string>
}

export function schtasksAdapter(deps: SchtasksDeps = {}): PersistentRuntimeAdapter {
  const exec =
    deps.exec ??
    (async (command: string, args: readonly string[]) => {
      // windowsHide 는 여기서 직접 준다 — runExternal 은 문자열을 돌려주는데 `/XML` 은
      // UTF-16 이라 버퍼로 받아야 한다. 창을 숨기는 이유는 runExternal 과 같다.
      const { stdout } = await run(command, [...args], { windowsHide: true, encoding: 'buffer' })
      return decodeSchtasksOutput(stdout as unknown as Buffer)
    })

  return {
    id: 'schtasks',
    async supported() {
      return process.platform === 'win32'
    },
    async status(command) {
      const query = await exec('schtasks', ['/Query', '/TN', TASK_NAME, '/XML', 'ONE']).catch(() => null)
      // 조회가 실패하는 것은 대개 "없다"이다. 없는 것과 못 읽은 것을 구분할 방법이
      // schtasks 에는 없으므로, 없는 쪽으로 읽고 install 이 다시 판정하게 둔다.
      if (query === null) return { kind: 'ABSENT' } satisfies ServiceState
      const drift = registrationDrift(query, command)
      return drift === null
        ? ({ kind: 'CURRENT', detail: TASK_NAME } satisfies ServiceState)
        : ({ kind: 'STALE', detail: drift } satisfies ServiceState)
    },
    async install(command) {
      // `/F` 로 덮어쓴다 — 같은 이름의 우리 등록을 지금 형태로 수렴시키는 것이다.
      //
      // 이 등록은 `InteractiveToken` 으로 만들어지고, 그래서 회차마다 콘솔 창이 뜬다.
      // 비대화형(`/RU <user> /NP`)은 관리자 권한을 요구해서 — 실측: "Access is denied"
      // 뒤에 비밀번호 프롬프트 — 일반 사용자 설치 경로에서는 쓸 수 없다. 창을 없애는
      // 일은 아직 열려 있고, 여기서 조용히 반쯤 해 두지 않는다.
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
