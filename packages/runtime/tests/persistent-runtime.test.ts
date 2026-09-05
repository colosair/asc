// 설계 §4~§7 — 사용자가 켜지 않아도 도는 자리, 그리고 그 하나가 여러 workspace 를 돌본다.
//
// 지키는 문장 넷:
//   기계당 하나다 — workspace 마다 OS 서비스를 만들지 않는다
//   Core 는 scheduler 제품을 모른다 (C-12 불변식 ④)
//   우리가 만든 등록물만 다룬다
//   DORMANT 는 지우지 않고, 밖을 치지도 않는다

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  SERVICE_LABEL,
  persistentRuntimeLine,
  planPersistentRuntime,
  type PersistentRuntimeAdapter,
  type ServiceCommand,
  type ServiceState,
} from '../core/distribution/persistent-runtime.ts'
import { launchAgentPlist, launchdAdapter, plistPath } from '../adapters/service/launchd.ts'
import { TASK_NAME, schtasksAdapter, taskMinutes, taskRunLine } from '../adapters/service/schtasks.ts'
import {
  SERVICE_UNIT,
  TIMER_UNIT,
  serviceAdapterFor,
  serviceUnit,
  systemdUserAdapter,
  timerUnit,
  unitDir,
} from '../adapters/service/systemd-user.ts'
import { dueWorkspaces, renderWorkspaces, viewWorkspaces } from '../core/runtime/workspaces.ts'

const command: ServiceCommand = {
  program: '/usr/bin/node',
  args: ['/opt/asc/asc.js', 'runtime', 'tick', '--all'],
  intervalSeconds: 300,
}

const fake = (state: ServiceState, supported = true): PersistentRuntimeAdapter & { installed: number } => {
  const adapter = {
    id: 'launchd' as const,
    installed: 0,
    supported: async () => supported,
    status: async () => state,
    install: async () => {
      adapter.installed += 1
    },
    uninstall: async () => {},
  }
  return adapter
}

describe('Persistent Runtime Port — 계획과 실행을 나눈다', () => {
  it('등록이 없으면 등록한다', async () => {
    assert.equal((await planPersistentRuntime(fake({ kind: 'ABSENT' }), command)).action, 'install')
  })

  it('이미 지금 형태면 아무것도 하지 않는다 — 멱등이다', async () => {
    const plan = await planPersistentRuntime(fake({ kind: 'CURRENT' }), command)
    assert.equal(plan.action, 'none')
  })

  it('낡은 등록은 지금 형태로 수렴시킨다', async () => {
    const plan = await planPersistentRuntime(fake({ kind: 'STALE', detail: 'points elsewhere' }), command)
    assert.equal(plan.action, 'install')
    assert.match(persistentRuntimeLine('launchd', plan), /behind/)
  })

  it('쓸 수 없는 OS 에서는 등록을 시도하지 않는다 — 못 하는 것을 "했다"로 적지 않는다', async () => {
    const adapter = fake({ kind: 'ABSENT' }, false)
    const plan = await planPersistentRuntime(adapter, command)
    assert.equal(plan.action, 'unsupported')
    assert.equal(adapter.installed, 0)
    assert.match(persistentRuntimeLine('launchd', plan), /no user-scope service manager/)
  })

  it('Core 는 scheduler 제품을 모른다 (C-12 불변식 ④)', async () => {
    const source = await readFile(new URL('../core/distribution/persistent-runtime.ts', import.meta.url), 'utf8')
    // 이름을 아는 것은 adapter 의 id 타입까지다 — 동작이 그 이름으로 갈리지 않는다
    assert.doesNotMatch(source, /launchctl|schtasks\s|systemctl/)
    assert.doesNotMatch(source, /LaunchAgents|Scheduled Task/)
  })

  it('OS 마다 통로가 정해져 있고, 모르는 OS 는 null 이다', () => {
    assert.equal(serviceAdapterFor('darwin'), 'launchd')
    assert.equal(serviceAdapterFor('win32'), 'schtasks')
    assert.equal(serviceAdapterFor('linux'), 'systemd-user')
    assert.equal(serviceAdapterFor('aix'), null)
  })
})

describe('macOS LaunchAgent', () => {
  it('사용자 자리에 산다 — root daemon 이 아니다', () => {
    // 구분자는 OS 가 정한다 — 이 테스트가 보는 것은 "사용자 홈 아래인가"이지 구분자가 아니다
    const path = plistPath('/Users/me').replaceAll('\\', '/')
    assert.match(path, /^\/Users\/me\/Library\/LaunchAgents\//)
    assert.doesNotMatch(path, /^\/Library\/LaunchDaemons/)
  })

  it('한 회차만 도는 명령을 주기와 함께 등록한다', () => {
    const plist = launchAgentPlist(command)
    assert.match(plist, new RegExp(`<string>${SERVICE_LABEL}</string>`))
    assert.match(plist, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/)
    assert.match(plist, /runtime<\/string>/)
    assert.match(plist, /--all<\/string>/)
  })

  it('경로의 XML 특수문자를 그대로 흘리지 않는다', () => {
    const plist = launchAgentPlist({ ...command, program: '/opt/a&b/node' })
    assert.match(plist, /a&amp;b/)
  })

  it('내용이 같으면 CURRENT, 다르면 STALE, 없으면 ABSENT', async () => {
    const home = await mkdtemp(join(tmpdir(), 'asc-launchd-'))
    try {
      const adapter = launchdAdapter({ home, exec: async () => {} })
      assert.equal((await adapter.status(command)).kind, 'ABSENT')

      await adapter.install(command)
      assert.equal((await adapter.status(command)).kind, 'CURRENT')
      // 같은 것을 다시 등록해도 같다 — 멱등이다
      await adapter.install(command)
      assert.equal((await adapter.status(command)).kind, 'CURRENT')

      assert.equal((await adapter.status({ ...command, intervalSeconds: 900 })).kind, 'STALE')

      await adapter.uninstall()
      assert.equal((await adapter.status(command)).kind, 'ABSENT')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('Windows Scheduled Task', () => {
  it('공백이 든 경로가 통째로 깨지지 않는다', () => {
    const line = taskRunLine({ ...command, program: 'C:\\Program Files\\nodejs\\node.exe' })
    assert.ok(line.startsWith('\\"C:\\Program Files\\nodejs\\node.exe\\"'), line)
  })

  it('분 단위 반복은 1분 아래로 내려가지 않는다', () => {
    assert.equal(taskMinutes(300), 5)
    assert.equal(taskMinutes(10), 1)
  })

  it('조회에 우리 명령이 없으면 낡은 등록이다', async () => {
    const stale = schtasksAdapter({ exec: async () => 'Task To Run: something-else' })
    assert.equal((await stale.status(command)).kind, 'STALE')

    const current = schtasksAdapter({
      exec: async () => `Task To Run: ${taskRunLine(command).replace(/\\"/g, '"')}`,
    })
    assert.equal((await current.status(command)).kind, 'CURRENT')
  })

  it('등록은 덮어쓰기로 수렴시키고, 이름은 우리 것 하나다', async () => {
    const calls: string[][] = []
    const adapter = schtasksAdapter({
      exec: async (_command, args) => {
        calls.push([...args])
        return ''
      },
    })
    await adapter.install(command)
    assert.ok(calls[0]!.includes('/F'), '같은 이름의 우리 등록을 수렴시킨다')
    assert.equal(calls[0]![calls[0]!.indexOf('/TN') + 1], TASK_NAME)
  })
})

describe('Linux systemd --user', () => {
  it('사용자 자리에 산다', () => {
    assert.match(unitDir('/home/me').replaceAll('\\', '/'), /^\/home\/me\/\.config\/systemd\/user$/)
  })

  it('lingering 을 조용히 켜지 않는다 — 로그아웃 뒤 동작은 사람의 결정이다', async () => {
    const source = await readFile(new URL('../adapters/service/systemd-user.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /loginctl|enable-linger/)
  })

  it('timer 가 주기를 갖고 service 는 한 회차만 돈다', () => {
    assert.match(serviceUnit(command), /Type=oneshot/)
    assert.match(timerUnit(command), /OnUnitActiveSec=300/)
    assert.match(timerUnit(command), new RegExp(`Unit=${SERVICE_UNIT}`))
  })

  it('두 unit 이 모두 지금 형태여야 CURRENT 다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'asc-systemd-'))
    try {
      const adapter = systemdUserAdapter({ home, exec: async () => {}, available: async () => true })
      assert.equal((await adapter.status(command)).kind, 'ABSENT')
      await adapter.install(command)
      assert.equal((await adapter.status(command)).kind, 'CURRENT')

      // 한쪽만 낡아도 낡은 것이다
      await writeFile(join(unitDir(home), TIMER_UNIT), 'stale', 'utf8')
      assert.equal((await adapter.status(command)).kind, 'STALE')

      await adapter.uninstall()
      assert.equal((await adapter.status(command)).kind, 'ABSENT')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('user bus 가 없으면 쓸 수 있다고 하지 않는다', async () => {
    const adapter = systemdUserAdapter({ available: async () => false })
    assert.equal(await adapter.supported(), false)
  })
})

describe('여러 workspace 를 하나가 돌본다 (설계 §6·§7)', () => {
  const live = new Set(['/w/a', '/home/me/.asc/workspaces/W-a', '/home/me/.asc/workspaces/W-b'])
  const exists = (path: string) => live.has(path)

  const workspaces = [
    { workspaceId: 'W-a', root: '/home/me/.asc/workspaces/W-a', aliases: ['host/a'], locators: ['/w/a', '/w/a-old'] },
    { workspaceId: 'W-b', root: '/home/me/.asc/workspaces/W-b', aliases: ['host/b'], locators: ['/w/b-gone'] },
    { workspaceId: 'W-c', root: '/home/me/.asc/workspaces/W-c', aliases: [], locators: ['/w/a'] },
  ]

  it('살아 있는 checkout 이 있으면 ACTIVE, 없으면 DORMANT', () => {
    const views = viewWorkspaces(workspaces, exists)
    assert.deepEqual(views.map((view) => view.health), ['ACTIVE', 'DORMANT', 'DEGRADED'])
  })

  it('DORMANT 는 이번 회차에서 빠진다 — 없는 자리를 대신해 밖을 치지 않는다', () => {
    const due = dueWorkspaces(viewWorkspaces(workspaces, exists))
    assert.deepEqual(due, [{ workspaceId: 'W-a', cwd: '/w/a' }])
  })

  it('사라진 checkout 을 지우지 않는다 — 돌아올 수 있다', () => {
    const views = viewWorkspaces(workspaces, exists)
    assert.deepEqual(views[0]!.missingLocators, ['/w/a-old'])
    assert.match(renderWorkspaces(views).join('\n'), /\/w\/a-old \(gone\)/)
    // 상태가 남아 있다는 사실 자체가 화면에 보인다
    assert.match(renderWorkspaces(views).join('\n'), /W-b {2}DORMANT/)
  })

  it('workspace 하나에 checkout 이 여럿이어도 회차는 하나다', () => {
    const many = [{ workspaceId: 'W-a', root: '/home/me/.asc/workspaces/W-a', aliases: [], locators: ['/w/a', '/w/a'] }]
    assert.equal(dueWorkspaces(viewWorkspaces(many, exists)).length, 1)
  })

  it('아는 workspace 가 없으면 그렇게 말한다', () => {
    assert.match(renderWorkspaces([]).join('\n'), /No workspaces are registered/)
  })
})
