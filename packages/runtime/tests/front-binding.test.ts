// C-12 §4 / C-03 §5.6 — Host 세션이 열리면 지금 상태가 되살아난다.
//
// 지키는 문장 넷:
//   Core는 Host를 모른다 — 같은 판정이 어느 host에서도 같다
//   붙지 못하면 조용히 빈 화면을 주지 않는다 (불변식 ⑰)
//   세션을 만들지 않는다 — 열었다는 사실은 작업 요청이 아니다
//   사람이 넣어 둔 host 설정을 보존한다 (C-11 불변식 ⑪)

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { frontOpeningLines, openFront, type FrontState } from '../core/runtime/front.ts'
import { sessionStartPayload, sessionStartScript } from '../adapters/claude-code/session-start.ts'
import { install, uninstall, verifyInstall, type InstallPaths } from '../adapters/claude-code/install.ts'

const emptyState = (): FrontState => ({
  active: [],
  unclaimed: [],
  awaitingCollect: [],
  pendingDecisions: [],
  awaitingController: [],
  health: [],
  escalations: [],
})

describe('openFront — Core는 Host를 모른다 (C-12 §4)', () => {
  it('ASC 자리가 아니면 아무 말도 하지 않는다', async () => {
    const opening = await openFront({ workspace: null, restore: async () => emptyState() })
    assert.equal(opening.kind, 'NOT_ASC')
    // 남의 프로젝트 세션마다 빈 블록이 붙으면 그것이 방해다 (C-11 불변식 ⑪)
    assert.deepEqual(frontOpeningLines(opening), [])
  })

  it('붙었으면 지금 걸려 있는 것을 든다', async () => {
    const opening = await openFront({
      workspace: { workspaceId: 'W-1', locator: '/w/main' },
      restore: async () => ({
        ...emptyState(),
        workspace: { workspaceId: 'W-1', locator: '/w/main' },
        active: [{ id: 'S-1', role: 'implementer', status: 'ACTIVE', goal: 'ship it' }],
      }),
    })
    assert.equal(opening.kind, 'BOUND')
    const text = frontOpeningLines(opening).join('\n')
    assert.match(text, /W-1/)
    assert.match(text, /S-1/)
  })

  it('상태를 못 읽으면 조용히 빈 화면을 주지 않는다 (불변식 ⑰)', async () => {
    const opening = await openFront({
      workspace: { workspaceId: 'W-1', locator: '/w/main' },
      restore: async () => {
        throw new Error('state.md is unreadable')
      },
    })
    assert.equal(opening.kind, 'UNAVAILABLE')
    const text = frontOpeningLines(opening).join('\n')
    // 왜 못 붙었는지가 사람에게 닿아야 한다
    assert.match(text, /could not be read/)
    assert.match(text, /state\.md is unreadable/)
  })

  it('여는 것만으로 세션을 만들지 않는다 — 읽기 외의 호출이 없다', async () => {
    let restores = 0
    const opening = await openFront({
      workspace: { workspaceId: 'W-1', locator: '/w/main' },
      restore: async () => {
        restores += 1
        return emptyState()
      },
    })
    assert.equal(restores, 1)
    assert.equal(opening.kind, 'BOUND')
    // 아무것도 안 걸려 있으면 그렇게 말한다 — 없는 일을 만들어 보이지 않는다
    assert.match(frontOpeningLines(opening).join('\n'), /Nothing is pending/)
  })

  it('같은 판정이 어느 host에서도 같다 — Core에 host 분기가 없다', async () => {
    const workspace = { workspaceId: 'W-1', locator: '/w/main' }
    const restore = async () => emptyState()
    // "다른 host"는 봉투만 다르다. Core가 내는 줄은 같은 것이어야 한다.
    const a = frontOpeningLines(await openFront({ workspace, restore }))
    const b = frontOpeningLines(await openFront({ workspace, restore }))
    assert.deepEqual(a, b)

    const claude = sessionStartPayload(a)
    const other = a.join('\n') // 봉투 없는 host
    assert.ok(claude && claude.includes('SessionStart'), 'Claude 봉투는 adapter가 만든다')
    assert.ok(!other.includes('SessionStart'), 'Core가 낸 줄에는 host 어휘가 없다')

    // 구조로 고정한다: Core는 adapter를 import하지 않고 host id로 분기하지 않는다.
    // 산문에 host 이름이 나오는 것은 설명이고, 코드가 그것을 아는 것과 다르다.
    const source = await readFile(new URL('../core/runtime/front.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /from '\.\.\/\.\.\/adapters\//, 'Core가 adapter를 import하면 안 된다')
    assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, ''), /host\s*===/,
      'Core가 host id로 분기하면 안 된다')
  })

  it('할 말이 없으면 봉투도 만들지 않는다', () => {
    assert.equal(sessionStartPayload([]), null)
  })
})

describe('SessionStart hook — 세션을 막지 않는다', () => {
  it('무슨 일이 나도 exit 0 이고, 부를 CLI 경로가 박혀 있다', () => {
    const script = sessionStartScript('/opt/asc/dist/cli/asc.js')
    assert.match(script, /process\.exit\(0\)/)
    assert.match(script, /\/opt\/asc\/dist\/cli\/asc\.js/)
    // 등록되지 않은 자리에서는 CLI를 부르지도 않는다 — 세션마다 프로세스를 띄우지 않는다
    assert.match(script, /attachedHere/)
    assert.match(script, /timeout: BUDGET_MS/)
  })
})

describe('설치 — 사람의 host 설정을 보존한다 (C-03 §5.1)', () => {
  const paths = async (): Promise<InstallPaths & { dir: string }> => {
    const dir = await mkdtemp(join(tmpdir(), 'asc-front-'))
    return { dir, claudeHome: join(dir, '.claude'), entry: join(dir, 'asc.js') }
  }

  const settingsOf = async (p: InstallPaths) =>
    JSON.parse(await readFile(join(p.claudeHome, 'settings.json'), 'utf8')) as {
      hooks?: Record<string, { hooks?: { command?: string; _asc?: string }[] }[]>
      permissions?: unknown
    }

  const withUserHooks = async (p: InstallPaths) => {
    await mkdir(p.claudeHome, { recursive: true })
    await writeFile(
      join(p.claudeHome, 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(ls:*)'] },
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'caveman-hook' }] },
            { hooks: [{ type: 'command', command: 'ponytail-hook' }] },
          ],
        },
      }),
      'utf8',
    )
  }

  it('기존 SessionStart hook 옆에 더할 뿐이다', async () => {
    const p = await paths()
    try {
      await withUserHooks(p)
      await install(p)

      const settings = await settingsOf(p)
      const commands = (settings.hooks?.SessionStart ?? []).flatMap((e) => (e.hooks ?? []).map((h) => h.command))
      assert.ok(commands.includes('caveman-hook'), '남의 hook이 그대로 있다')
      assert.ok(commands.includes('ponytail-hook'), '남의 hook이 그대로 있다')
      assert.equal(commands.length, 3, 'ASC 것 하나만 더해졌다')
      // 무관한 설정은 손대지 않는다
      assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] })
    } finally {
      await rm(p.dir, { recursive: true, force: true })
    }
  })

  it('재설치해도 중복 0', async () => {
    const p = await paths()
    try {
      await withUserHooks(p)
      await install(p)
      await install(p)
      await install(p)

      const settings = await settingsOf(p)
      const ours = (settings.hooks?.SessionStart ?? []).flatMap((e) =>
        (e.hooks ?? []).filter((h) => h._asc !== undefined),
      )
      assert.equal(ours.length, 1)
      const guards = (settings.hooks?.PreToolUse ?? []).flatMap((e) =>
        (e.hooks ?? []).filter((h) => h._asc !== undefined),
      )
      assert.equal(guards.length, 1)
    } finally {
      await rm(p.dir, { recursive: true, force: true })
    }
  })

  it('표식 없는 옛 설치본을 입양한다 — 재설치가 guard를 두 번 등록하지 않는다', async () => {
    const p = await paths()
    try {
      // 표식(_asc)을 붙이기 전 버전이 남긴 등록. 실제 사용 기계에서 이 상태를 봤다.
      await mkdir(p.claudeHome, { recursive: true })
      await writeFile(
        join(p.claudeHome, 'settings.json'),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: `node "${join(p.claudeHome, 'asc', 'guard-hook.mjs')}"` }],
              },
            ],
          },
        }),
        'utf8',
      )

      await install(p)
      const settings = await settingsOf(p)
      const preToolUse = settings.hooks?.PreToolUse ?? []
      const guards = preToolUse.flatMap((e) => (e.hooks ?? []).filter((h) => h.command?.includes('guard-hook')))
      assert.equal(guards.length, 1, '옛 항목을 입양했으므로 하나뿐이다')
      assert.equal(guards[0]!._asc, 'asc-external-write-guard', '이제 우리 것으로 표시된다')
    } finally {
      await rm(p.dir, { recursive: true, force: true })
    }
  })

  it('uninstall 은 ASC 표식이 붙은 것만 걷어낸다', async () => {
    const p = await paths()
    try {
      await withUserHooks(p)
      await install(p)
      await uninstall(p)

      const settings = await settingsOf(p)
      const commands = (settings.hooks?.SessionStart ?? []).flatMap((e) => (e.hooks ?? []).map((h) => h.command))
      assert.deepEqual(commands, ['caveman-hook', 'ponytail-hook'])
      assert.equal(settings.hooks?.PreToolUse, undefined, '우리만 있던 이벤트는 키째 걷힌다')
      assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] })
    } finally {
      await rm(p.dir, { recursive: true, force: true })
    }
  })

  it('부를 CLI를 모르면 SessionStart 를 심지 않는다 — 어디를 부를지 모르는 hook은 없느니만 못하다', async () => {
    const p = await paths()
    try {
      const withoutEntry: InstallPaths = { claudeHome: p.claudeHome }
      await install(withoutEntry)
      const settings = await settingsOf(withoutEntry)
      assert.equal(settings.hooks?.SessionStart, undefined)
      // guard 는 그대로 선다 — 안전 층은 entry 와 무관하다
      assert.equal((settings.hooks?.PreToolUse ?? []).length, 1)
      assert.equal((await verifyInstall(withoutEntry)).status, 'INSTALLED_CURRENT')
    } finally {
      await rm(p.dir, { recursive: true, force: true })
    }
  })

  it('SessionStart 등록이 사라지면 설치를 온전하다고 하지 않는다', async () => {
    const p = await paths()
    try {
      await install(p)
      assert.equal((await verifyInstall(p)).status, 'INSTALLED_CURRENT')

      const settings = await settingsOf(p)
      delete settings.hooks!.SessionStart
      await writeFile(join(p.claudeHome, 'settings.json'), JSON.stringify(settings), 'utf8')

      // 반쯤 등록된 상태를 "설치됨"이라 부르면 없는 hook을 있다고 믿게 된다
      assert.equal((await verifyInstall(p)).status, 'BROKEN')
    } finally {
      await rm(p.dir, { recursive: true, force: true })
    }
  })
})
