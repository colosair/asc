// 0.8.5 Lane B — 돌아가는 기계 쪽. #74 · #76 · 멈춘 세션 · lock 잡음.
//
// 넷 다 판정이 틀린 것이 아니라 **사람에게 닿는 방식**이 틀렸던 것들이다. 그래서 여기
// 있는 시험은 값이 아니라 화면과 등록물의 모양을 본다.

import assert from 'node:assert/strict'
import { basename, dirname } from 'node:path'
import { describe, it } from 'node:test'

import { hookScript } from '../adapters/claude-code/guard.ts'
import {
  commandFingerprint,
  launcherPath,
  launcherScript,
  registrationDrift,
  taskLauncherLine,
  taskRunLine,
} from '../adapters/service/schtasks.ts'
import { staleSessions } from '../core/runtime/stale-session.ts'
import type { StaleSessionInput } from '../core/runtime/stale-session.ts'
import type { ServiceCommand } from '../core/distribution/persistent-runtime.ts'

const NOW = '2026-09-10T12:00:00.000Z'
const DAY_AGO = '2026-09-09T02:00:00.000Z'
const MINUTES_AGO = '2026-09-10T11:40:00.000Z'

const command: ServiceCommand = {
  program: 'C:\\Program Files\\nodejs\\node.exe',
  args: ['C:\\Users\\t\\entry.js', 'runtime', 'tick', '--all'],
  intervalSeconds: 300,
  logPath: 'C:\\Users\\t\\.asc\\service.log',
}

describe('#76 — 예약 회차가 사람 화면에 창을 띄우지 않는다', () => {
  it('등록물은 콘솔 프로그램이 아니라 GUI 호스트를 부른다', () => {
    const line = taskLauncherLine(launcherPath(command), command)
    assert.match(line, /wscript\.exe/, 'node.exe 를 직접 등록하면 회차마다 창이 뜬다')
    assert.doesNotMatch(line, /node\.exe/)
  })

  it('실행기는 자식을 숨긴 채 띄운다', () => {
    const script = launcherScript(command)
    // Run 의 두 번째 인자가 0 이다. 이 0 이 숨김이고, 나머지는 이 한 줄을 위한 포장이다.
    assert.match(script, /shell\.Run ".*", 0, False/)
    assert.match(script, /WScript\.Shell/)
  })

  it('공백이 든 경로가 실행기 안에서 깨지지 않는다', () => {
    const script = launcherScript(command)
    // VBScript 문자열 안의 따옴표는 겹쳐 쓴다. Program Files 가 기본값이라 이 이스케이프가
    // 곧 동작 조건이다.
    assert.match(script, /""C:\\Program Files\\nodejs\\node\.exe""/)
  })

  it('실행기는 등록물의 곳간에 산다 — 로그와 같은 자리', () => {
    // 경로 구분자는 이 검사의 대상이 아니다 — 로그와 같은 디렉터리에 사는지, 이름이
    // 무엇인지만 본다. 구분자까지 고정하면 이 사실이 아니라 실행 OS 를 검사하게 된다.
    const path = launcherPath(command)
    assert.equal(dirname(path), dirname(command.logPath!))
    assert.equal(basename(path), 'service-launcher.vbs')
  })

  it('안쪽 명령이 바뀌면 등록물에서 그것이 드러난다', () => {
    const moved = { ...command, args: ['C:\\Users\\t\\other.js', 'runtime', 'tick', '--all'] }
    assert.notEqual(commandFingerprint(command), commandFingerprint(moved))

    const xml = registrationXml(taskLauncherLine(launcherPath(command), command))
    assert.equal(registrationDrift(xml, command), null)
    assert.match(
      registrationDrift(xml, moved) ?? '',
      /different command/,
      '실행기를 거치면 명령이 등록물에서 사라진다 — 지문이 그 눈을 되살린다',
    )
  })

  it('실행기를 거치지 않던 옛 등록은 낡은 것이다', () => {
    const legacy = registrationXml(taskRunLine(command))
    assert.match(registrationDrift(legacy, command) ?? '', /different command|console program/)
  })
})

describe('#74 — 어느 workspace 기준으로 막았는지 말한다', () => {
  const script = hookScript()

  it('막을 때 판정 기준을 함께 말한다', () => {
    assert.match(script, /판정 기준 workspace/)
    assert.match(script, /명령이 가리키는 대상이 아니다/)
  })

  it('이 Run 만 내리는 출구를 준다 — workspace 전체를 내리라고 하지 않는다', () => {
    assert.match(script, /asc mode manual --this-run/)
  })

  it('대상을 말할 수 있을 때만 말한다', () => {
    // 셸 파서가 되지 않는다. 명령이 대상 경로를 직접 말하는 자리 하나만 본다.
    assert.match(script, /function targetElsewhere/)
    assert.match(script, /if \(!match\) return null/)
  })

  it('fail-closed 는 그대로다 — 모른다고 통과시키지 않는다', () => {
    const managed = script.slice(script.indexOf('const forbidden = forbiddenIn(command, FORBIDDEN)'))
    assert.match(managed.slice(0, 2000), /process\.exit\(2\)/)
  })
})

describe('멈춘 채 잊힌 세션 — 이름은 대고 닫지는 않는다', () => {
  const paused = session({ recordedAt: DAY_AGO })

  it('오래 조용하고 아무도 붙들지 않으면 후보다', () => {
    const [row] = staleSessions([{ session: paused, held: false }], NOW, { quietMs: 60_000 })
    assert.ok(row)
    assert.equal(row.id, 'S-20260907-03')
    assert.ok(row.evidence.some((line) => /붙들고 있는 Run 이 없다/.test(line)))
    assert.ok(row.evidence.some((line) => /멈춘 자리/.test(line)))
  })

  it('붙들고 있는 Run 이 있으면 잊힌 것이 아니다', () => {
    assert.deepEqual(staleSessions([{ session: paused, held: true }], NOW, { quietMs: 60_000 }), [])
  })

  it('방금 멈춘 것은 후보가 아니다', () => {
    const fresh = session({ recordedAt: MINUTES_AGO })
    assert.deepEqual(staleSessions([{ session: fresh, held: false }], NOW, { quietMs: 24 * 60 * 60_000 }), [])
  })

  it('ACTIVE 는 건드리지 않는다', () => {
    const active = { ...session({ recordedAt: DAY_AGO }), status: 'ACTIVE' as const }
    assert.deepEqual(staleSessions([{ session: active, held: false }], NOW, { quietMs: 60_000 }), [])
  })

  it('닫지 않는다 — 두 갈래를 주고 고르지 않는다', () => {
    const [row] = staleSessions([{ session: paused, held: false }], NOW, { quietMs: 60_000 })
    assert.equal(row?.next.length, 2)
    assert.ok(row?.next.some((line) => /work resume/.test(line)))
    assert.ok(row?.next.some((line) => /work finish/.test(line)))
  })

  it('언제 멈췄는지 모르면 후보로 만들지 않는다', () => {
    const unknown = { id: 'S-1', status: 'PAUSED' as const, goal: 'x' }
    assert.deepEqual(staleSessions([{ session: unknown, held: false }], NOW, { quietMs: 60_000 }), [])
  })

})

/** 멈춘 세션 하나. checkpoint 는 계약상 필수 배열들을 다 갖는다. */
function session({ recordedAt }: { recordedAt: string }): StaleSessionInput['session'] {
  return {
    id: 'S-20260907-03',
    status: 'PAUSED',
    goal: '0.8.1 릴리스',
    checkpoint: {
      position: '게시 완료',
      nextAction: '인수 후 finalize',
      recordedAt,
      completedTasks: [],
      uncommittedChanges: [],
      blockers: [],
      risks: [],
      evidenceRefs: [],
    },
  }
}

/** schtasks `/Query /XML ONE` 이 돌려주는 모양. Command 와 Arguments 가 갈려 있다. */
function registrationXml(runLine: string): string {
  const [program = '', ...rest] = runLine.match(/"[^"]*"/g) ?? []
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2">
  <Triggers><TimeTrigger><Repetition><Interval>PT5M</Interval></Repetition></TimeTrigger></Triggers>
  <Actions Context="Author"><Exec>
    <Command>${program}</Command>
    <Arguments>${rest.join(' ')}</Arguments>
  </Exec></Actions>
</Task>`
}
