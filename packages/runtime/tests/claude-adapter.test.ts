// B-15 자동 계약 테스트 (C-03 §7.2). 실 Claude pilot은 별도 — 여기는 fake로 계약을 조인다.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { claudeBindings, CLAUDE_PROVIDER, CLAUDE_SCOPE } from '../adapters/claude-code/binding.ts'
import {
  install,
  installReportLines,
  locate,
  uninstall,
  verifyInstall,
  verifyInstalled,
  type InstallPaths,
} from '../adapters/claude-code/install.ts'
import { inboxSkillText, reviewSkillText, skillBundle, skillText } from '../adapters/claude-code/skill.ts'
import { MarkdownStateStore } from '../adapters/markdown/state-store.ts'
import { writeExecutionMode } from '../core/policy/execution-mode.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'

const NOW = '2026-08-23T18:00:00+09:00'

const dirs: string[] = []
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe('Core 독립성 — Claude 문자열 격리', () => {
  it('Generic Operator·Core에 Claude 명칭이 없다', async () => {
    const files = [
      'core/operator/proceed.ts',
      'core/operator/runtime-binding.ts',
      'core/runtime/session.ts',
      'core/model/entities.ts',
      'adapters/memory/runtime-binding.ts',
    ]
    for (const file of files) {
      assert.doesNotMatch(await readFile(file, 'utf8'), /claude/i, `${file} 에 Claude가 새었다`)
    }
  })
})
describe('install / uninstall (C-03 §5.1)', () => {
  // SessionStart hook 은 부를 CLI(entry)를 알 때만 심는다 — 설치 계약은 그 hook 으로 검증한다
  const ENTRY = '/opt/asc/dist/cli/asc.js'
  async function freshPaths(): Promise<InstallPaths> {
    return { claudeHome: await tempDir('asc-claude-home-'), entry: ENTRY }
  }

  it('설치 → 검증 → 반복 설치는 idempotent', async () => {
    const paths = await freshPaths()
    const first = await install(paths, () => NOW)
    assert.ok(first.written.some((p) => p.includes('SKILL.md')))
    assert.ok(first.written.some((p) => p.includes('front-hook.mjs')))
    assert.ok(first.written.some((p) => p.includes('settings.json')))
    assert.deepEqual(first.removed, [])
    assert.equal(await verifyInstalled(paths), true)

    const second = await install(paths, () => NOW)
    assert.deepEqual(second.written, [])
    assert.deepEqual(second.skipped, [])
    assert.deepEqual(second.removed, [])

    // hook 항목이 중복 등록되지 않았고, PreToolUse 는 더 이상 심지 않는다 (0.9.0)
    const settings = JSON.parse(await readFile(join(paths.claudeHome, 'settings.json'), 'utf8'))
    assert.equal(settings.hooks.SessionStart.length, 1)
    assert.equal(settings.hooks.PreToolUse, undefined)
  })

  it('같은 경로의 사용자 파일은 덮지 않는다', async () => {
    const paths = await freshPaths()
    const skillPath = join(paths.claudeHome, 'skills', 'asc', 'SKILL.md')
    await mkdir(join(paths.claudeHome, 'skills', 'asc'), { recursive: true })
    await writeFile(skillPath, '# 사용자가 직접 만든 skill\n', 'utf8')

    const outcome = await install(paths, () => NOW)
    assert.ok(outcome.skipped.some((s) => s.path === skillPath))
    assert.match(await readFile(skillPath, 'utf8'), /사용자가 직접/)
  })

  it('uninstall은 ASC 설치물만 제거하고 무관한 설정은 남긴다', async () => {
    const paths = await freshPaths()
    // 사용자의 기존 settings — 무관한 hook 포함
    await mkdir(paths.claudeHome, { recursive: true })
    await writeFile(
      join(paths.claudeHome, 'settings.json'),
      JSON.stringify({
        theme: 'dark',
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] }],
          SessionStart: [{ hooks: [{ type: 'command', command: 'my-start-hook' }] }],
        },
      }),
      'utf8',
    )
    await install(paths, () => NOW)

    const outcome = await uninstall(paths)
    assert.ok(outcome.removed.some((p) => p.includes('SKILL.md')))
    assert.ok(outcome.removed.some((p) => p.includes('front-hook.mjs')))

    const settings = JSON.parse(await readFile(join(paths.claudeHome, 'settings.json'), 'utf8'))
    assert.equal(settings.theme, 'dark') // 무관 설정 보존
    assert.equal(settings.hooks.PreToolUse.length, 1) // 사용자 hook 보존
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'my-own-hook')
    assert.equal(settings.hooks.SessionStart.length, 1)
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'my-start-hook')
    assert.equal(await verifyInstalled(paths), false)
  })

  it('hooks가 없던 settings는 install→uninstall 후 원상 복원된다 — 빈 {} 잔재 금지', async () => {
    const paths = await freshPaths()
    await mkdir(paths.claudeHome, { recursive: true })
    const original = { theme: 'dark' } // hooks 키 자체가 없음 — B-15 실 pilot에서 잡힌 케이스
    await writeFile(join(paths.claudeHome, 'settings.json'), JSON.stringify(original), 'utf8')

    await install(paths, () => NOW)
    await uninstall(paths)
    const restored = JSON.parse(await readFile(join(paths.claudeHome, 'settings.json'), 'utf8'))
    assert.deepEqual(restored, original)
  })

  it('사용자가 고친 설치 파일은 제거하지 않고 이유를 말한다', async () => {
    const paths = await freshPaths()
    await install(paths, () => NOW)
    const skillPath = join(paths.claudeHome, 'skills', 'asc', 'SKILL.md')
    await writeFile(skillPath, (await readFile(skillPath, 'utf8')) + '\n# 사용자 추가 규칙\n', 'utf8')

    const outcome = await uninstall(paths)
    assert.ok(outcome.kept.some((k) => k.path === skillPath && /cannot prove ASC owns it/.test(k.reason)))
    assert.match(await readFile(skillPath, 'utf8'), /사용자 추가 규칙/)
  })

  it('설치 파일이 변조되면 verify가 false다', async () => {
    const paths = await freshPaths()
    await install(paths, () => NOW)
    await writeFile(join(paths.claudeHome, 'asc', 'front-hook.mjs'), '// gutted\n', 'utf8')
    assert.equal(await verifyInstalled(paths), false)
  })
})

// L-5 closure — 설치본이 지금 source보다 뒤처진 것(stale)과 사람이 고친 것(modified)은
// 다른 사실이다. 예전 verify는 manifest digest만 봐서 전자를 아예 못 봤다.
describe('설치 drift 판정 (L-5)', () => {
  const ENTRY = '/opt/asc/dist/cli/asc.js'
  async function freshPaths(): Promise<InstallPaths> {
    return { claudeHome: await tempDir('asc-drift-home-'), entry: ENTRY }
  }

  const skillPathOf = (paths: InstallPaths) => join(paths.claudeHome, 'skills', 'asc', 'SKILL.md')
  const hookPathOf = (paths: InstallPaths) => join(paths.claudeHome, 'asc', 'front-hook.mjs')
  const manifestPathOf = (paths: InstallPaths) => join(paths.claudeHome, 'asc', 'install-manifest.json')

  /**
   * 옛 버전 asc가 설치했다면 남았을 상태를 만든다 — 파일은 옛 내용이고 manifest에는
   * **그 옛 내용의 digest**가 적혀 있다. 지금 것을 깔아 두고 manifest만 고치는 것이
   * 아니다(그건 조작이지 재현이 아니다).
   */
  async function installAsOlderVersion(paths: InstallPaths, path: string, oldText: string): Promise<void> {
    await install(paths, () => NOW)
    await writeFile(path, oldText, 'utf8')
    const manifest = JSON.parse(await readFile(manifestPathOf(paths), 'utf8'))
    manifest.files[path] = createHash('sha256').update(oldText).digest('hex').slice(0, 16)
    await writeFile(manifestPathOf(paths), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  }

  it('아무것도 없으면 NOT_INSTALLED다 — BROKEN과 섞지 않는다', async () => {
    const paths = await freshPaths()
    assert.equal((await verifyInstall(paths)).status, 'NOT_INSTALLED')
  })

  it('막 설치했으면 CURRENT다', async () => {
    const paths = await freshPaths()
    await install(paths, () => NOW)
    const report = await verifyInstall(paths)
    assert.equal(report.status, 'INSTALLED_CURRENT')
    assert.equal(report.hookRegistered, true)
    assert.ok(report.files.every((f) => f.state === 'current'))
  })

  it('설치본이 옛 내용이면 STALE이고, 재설치가 지금 source로 수렴시킨다', async () => {
    const paths = await freshPaths()
    const skill = skillPathOf(paths)
    await installAsOlderVersion(paths, skill, '# asc skill (옛 버전)\n')

    const stale = await verifyInstall(paths)
    assert.equal(stale.status, 'INSTALLED_STALE')
    assert.deepEqual(
      stale.files.filter((f) => f.state !== 'current').map((f) => f.state),
      ['stale'],
    )
    assert.match(installReportLines(stale).join('\n'), /behind the current source/)

    const again = await install(paths, () => NOW)
    assert.ok(again.written.includes(skill), 'stale 파일은 덮어써 수렴한다')
    assert.deepEqual(again.skipped, [])
    assert.equal((await verifyInstall(paths)).status, 'INSTALLED_CURRENT')
    assert.doesNotMatch(await readFile(skill, 'utf8'), /옛 버전/)
  })

  it('사람이 고친 설치물은 MODIFIED이고 재설치가 덮지 않는다 — --force만 덮는다', async () => {
    const paths = await freshPaths()
    await install(paths, () => NOW)
    const skill = skillPathOf(paths)
    await writeFile(skill, (await readFile(skill, 'utf8')) + '\n# 내가 붙인 규칙\n', 'utf8')

    assert.equal((await verifyInstall(paths)).status, 'INSTALLED_MODIFIED')

    const kept = await install(paths, () => NOW)
    assert.ok(kept.skipped.some((s) => s.path === skill && /--force/.test(s.reason)))
    assert.match(await readFile(skill, 'utf8'), /내가 붙인 규칙/, 'uninstall이 보존하는 것을 install이 지우면 안 된다')

    const forced = await install(paths, () => NOW, { force: true })
    assert.ok(forced.written.includes(skill))
    assert.equal((await verifyInstall(paths)).status, 'INSTALLED_CURRENT')
  })

  it('설치물이 없어지면 BROKEN이다', async () => {
    const paths = await freshPaths()
    await install(paths, () => NOW)
    await rm(hookPathOf(paths))
    const report = await verifyInstall(paths)
    assert.equal(report.status, 'BROKEN')
    assert.ok(report.files.some((f) => f.state === 'missing'))
  })

  it('hook 등록이 다른 곳을 가리키면 STALE이고, 재설치가 우리 항목만 고친다', async () => {
    const paths = await freshPaths()
    await install(paths, () => NOW)
    const settingsPath = join(paths.claudeHome, 'settings.json')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    settings.hooks.SessionStart[0].hooks[0].command = 'node "/opt/old-asc/front-hook.mjs"'
    settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'my-own-hook' }] })
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8')

    assert.equal((await verifyInstall(paths)).status, 'INSTALLED_STALE')

    await install(paths, () => NOW)
    const fixed = JSON.parse(await readFile(settingsPath, 'utf8'))
    assert.equal(fixed.hooks.SessionStart.length, 2, 'hook 항목을 늘리지 않는다')
    assert.match(fixed.hooks.SessionStart[0].hooks[0].command, /front-hook\.mjs/)
    assert.doesNotMatch(fixed.hooks.SessionStart[0].hooks[0].command, /old-asc/)
    assert.equal(fixed.hooks.SessionStart[1].hooks[0].command, 'my-own-hook', '남의 hook은 건드리지 않는다')
    assert.equal((await verifyInstall(paths)).status, 'INSTALLED_CURRENT')
  })

  it('drift 수렴이 무관한 사용자 파일을 건드리지 않는다', async () => {
    const paths = await freshPaths()
    const mine = join(paths.claudeHome, 'skills', 'my-skill', 'SKILL.md')
    await mkdir(join(paths.claudeHome, 'skills', 'my-skill'), { recursive: true })
    await writeFile(mine, '# 내 skill\n', 'utf8')
    await installAsOlderVersion(paths, hookPathOf(paths), '// 옛 front hook\n')

    await install(paths, () => NOW)
    assert.equal(await readFile(mine, 'utf8'), '# 내 skill\n')
    assert.equal((await verifyInstall(paths)).status, 'INSTALLED_CURRENT')
  })
})

// 0.9.0 — 0.8.x 가 심은 PreToolUse guard 는 더 이상 싣지 않는다. 새 버전이 안 심는 것으로는
// 끝나지 않는다: 옛 파일과 settings 등록이 남아 있으면 그 hook 이 계속 돈다. install(=refresh
// =update 의 마지막 걸음) 이 ASC 소유가 증명되는 것만 걷고, 사람이 고친 것은 남기고 말한다.
describe('0.9.0 upgrade — the 0.8.x guard is retired', () => {
  const ENTRY = '/opt/asc/dist/cli/asc.js'
  const sha16 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)
  const OLD_GUARD = '// 0.8.5 external-write guard\n'
  const OLD_FRONT = '// 0.8.5 front hook\n'

  type Shape = { marked?: boolean; unmarked?: boolean; guardText?: string; userPreToolUse?: boolean }

  /** 0.8.5 가 설치했다면 남았을 HOME. 파일·manifest digest·settings 등록을 그대로 재현한다. */
  async function home085(shape: Shape = {}): Promise<{ paths: InstallPaths; guard: string; settingsPath: string }> {
    const claudeHome = await tempDir('asc-085-home-')
    const paths: InstallPaths = { claudeHome, entry: ENTRY }
    const guard = join(claudeHome, 'asc', 'guard-hook.mjs')
    const front = join(claudeHome, 'asc', 'front-hook.mjs')
    const guardText = shape.guardText ?? OLD_GUARD
    await mkdir(join(claudeHome, 'asc'), { recursive: true })
    await writeFile(guard, guardText, 'utf8')
    await writeFile(front, OLD_FRONT, 'utf8')
    // skill 3종은 0.8.5 시점 내용 — 여기서는 지금 텍스트로 두고 manifest 에 그 digest 를 적는다
    const files: Record<string, string> = { [guard]: sha16(OLD_GUARD), [front]: sha16(OLD_FRONT) }
    for (const skill of locate(paths).skills) {
      await mkdir(join(skill.path, '..'), { recursive: true })
      await writeFile(skill.path, skill.text, 'utf8')
      files[skill.path] = sha16(skill.text)
    }
    await writeFile(
      join(claudeHome, 'asc', 'install-manifest.json'),
      JSON.stringify(
        {
          files,
          settingsHook: true,
          installedAt: '2026-09-11T12:16:35.334Z',
          permissionAllow: ['Bash(asc:*)'],
        },
        null,
        2,
      ),
      'utf8',
    )
    const preToolUse: unknown[] = []
    if (shape.marked ?? true) {
      preToolUse.push({
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `node "${guard}"`, _asc: 'asc-external-write-guard' }],
      })
    }
    if (shape.unmarked) {
      preToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${guard}"` }] })
    }
    if (shape.userPreToolUse ?? true) {
      preToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] })
    }
    const settingsPath = join(claudeHome, 'settings.json')
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          permissions: { allow: ['Bash(ls:*)', 'Bash(asc:*)'] },
          hooks: {
            PreToolUse: preToolUse,
            SessionStart: [
              { hooks: [{ type: 'command', command: 'caveman-hook' }] },
              { hooks: [{ type: 'command', command: `node "${front}"`, _asc: 'asc-front-binding' }] },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    )
    return { paths, guard, settingsPath }
  }

  const readSettings = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
  const exists = (path: string) => readFile(path, 'utf8').then(() => true, () => false)

  it('손대지 않은 0.8.5 설치본은 STALE 이다 — 걷을 것이 남아 있다', async () => {
    const { paths } = await home085()
    assert.equal((await verifyInstall(paths)).status, 'INSTALLED_STALE')
  })

  it('install 이 guard 파일·manifest 항목·PreToolUse 등록을 걷고, 사람의 것은 전부 남긴다', async () => {
    const { paths, guard, settingsPath } = await home085()
    const outcome = await install(paths, () => NOW)

    assert.ok(outcome.removed.includes(guard), 'ASC 것으로 증명된 파일은 걷는다')
    assert.ok(outcome.removed.some((p) => /PreToolUse hook entry retired/.test(p)))
    assert.equal(await exists(guard), false)
    const manifest = JSON.parse(await readFile(join(paths.claudeHome, 'asc', 'install-manifest.json'), 'utf8'))
    assert.equal(manifest.files[guard], undefined)

    const settings = await readSettings(settingsPath)
    assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] }])
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'caveman-hook')
    assert.match(settings.hooks.SessionStart[1].hooks[0].command, /front-hook\.mjs/)
    assert.equal(settings.hooks.SessionStart.length, 2)
    assert.deepEqual(settings.permissions.allow, ['Bash(ls:*)', 'Bash(asc:*)'], 'control-plane 허용은 그대로다')
    assert.equal((await verifyInstall(paths)).status, 'INSTALLED_CURRENT')

    const again = await install(paths, () => NOW)
    assert.deepEqual([again.written, again.skipped, again.removed], [[], [], []], '두 번째 install 은 no-op')
  })

  it('표식 없이 우리 옛 스크립트를 가리키는 등록도 우리 것이다 — 같이 걷는다', async () => {
    const { paths, settingsPath } = await home085({ marked: false, unmarked: true })
    await install(paths, () => NOW)
    const settings = await readSettings(settingsPath)
    assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] }])
    assert.equal((await verifyInstall(paths)).status, 'INSTALLED_CURRENT')
  })

  it('사람이 고친 guard 파일은 지우지 않고 말한다 — 등록은 걷고, --force 만 지운다', async () => {
    const { paths, guard, settingsPath } = await home085({ guardText: '// I edited this\n' })
    const outcome = await install(paths, () => NOW)

    assert.equal(await exists(guard), true)
    assert.ok(outcome.skipped.some((s) => s.path === guard && /no longer shipped/.test(s.reason)))
    assert.equal((await readSettings(settingsPath)).hooks.PreToolUse.length, 1, '등록은 파일과 무관하게 걷는다')
    // 파일이 남아 있어도 우리가 싣는 것은 전부 맞으므로 CURRENT 다 — 남은 파일은 uninstall 이 다시 말한다
    assert.equal((await verifyInstall(paths)).status, 'INSTALLED_CURRENT')

    const forced = await install(paths, () => NOW, { force: true })
    assert.ok(forced.removed.includes(guard))
    assert.equal(await exists(guard), false)

    // uninstall 도 같은 원칙 — 고친 파일은 남기고 이유를 말한다
    const other = await home085({ guardText: '// I edited this\n' })
    await install(other.paths, () => NOW)
    const un = await uninstall(other.paths)
    assert.ok(un.kept.some((k) => k.path === other.guard && /cannot prove ASC owns it/.test(k.reason)))
    assert.equal(await exists(other.guard), true)
  })

  it('우리 등록만 있던 PreToolUse 는 키째 사라진다', async () => {
    const { paths, settingsPath } = await home085({ userPreToolUse: false })
    await install(paths, () => NOW)
    assert.equal((await readSettings(settingsPath)).hooks.PreToolUse, undefined)
  })

  it('uninstall 도 0.8.5 설치본을 통째로 걷는다 — 표식 있는 것, 없는 것, 파일', async () => {
    const { paths, guard, settingsPath } = await home085({ marked: true, unmarked: true })
    const outcome = await uninstall(paths)
    assert.ok(outcome.removed.includes(guard))
    assert.equal(await exists(guard), false)
    const settings = await readSettings(settingsPath)
    assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] }])
    assert.deepEqual(settings.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'caveman-hook' }] }])
    assert.deepEqual(settings.permissions.allow, ['Bash(ls:*)'])
  })
})
describe('skill', () => {
  it('skill은 자연어 트리거와 명시 호출을 함께 제공하고 금지선을 담는다', () => {
    const text = skillText()
    assert.match(text, /ASC로 진행해/)
    assert.match(text, /\/asc/)
    assert.match(text, /asc work start/)
    assert.match(text, /Do not pick one yourself/)
    assert.match(text, /Never issue automatically/)
    // 발급 권한은 사람의 것이되, Controller가 역할 범위로 위임할 수 있다 (OM §450 해석).
    assert.match(text, /issuance\.authority/)
    assert.match(text, /never create a session just to show that setup worked/)
    assert.match(text, /are \*\*information only\*\*/)
    assert.match(text, /not an independent verifier PASS/)
    assert.match(text, /transitions go through the asc CLI \(SessionRuntime\)/)
  })
})

// B-26 Gate — 셋으로 나눈 목적은 기능 추가가 아니라 각 Agent가 볼 수 있는 것을 좁히는 것이다.
describe('B-26 Gate — Skill Bundle (C-05)', () => {
  it('install이 skill 3종을 배치하고, 재설치는 여전히 idempotent다', async () => {
    const paths: InstallPaths = { claudeHome: await tempDir('asc-bundle-') }
    const first = await install(paths, () => NOW)
    for (const name of ['asc', 'asc-inbox', 'asc-review']) {
      assert.ok(
        first.written.some((p) => p.includes(join('skills', name, 'SKILL.md'))),
        `${name} 이 설치되지 않았다`,
      )
    }
    assert.equal(await verifyInstalled(paths), true)

    const second = await install(paths, () => NOW)
    assert.deepEqual(second.written, [])

    // skill이 늘어도 PreToolUse 는 심지 않는다 (0.9.0) — entry 없는 설치는 hook 자체가 없다
    const settings = JSON.parse(await readFile(join(paths.claudeHome, 'settings.json'), 'utf8'))
    assert.equal(settings.hooks, undefined)
  })

  it('uninstall이 빈 skill 디렉터리를 남기지 않는다 (P1 관찰 ⑥)', async () => {
    const paths: InstallPaths = { claudeHome: await tempDir('asc-bundle-') }
    await install(paths, () => NOW)
    await uninstall(paths)
    for (const name of ['asc', 'asc-inbox', 'asc-review']) {
      const dir = join(paths.claudeHome, 'skills', name)
      assert.equal(await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => null), null)
      await assert.rejects(readdir(dir), /ENOENT/, `${name} 디렉터리가 남았다`)
    }
  })

  it('사용자가 고친 skill이 있으면 그 디렉터리는 남긴다', async () => {
    const paths: InstallPaths = { claudeHome: await tempDir('asc-bundle-') }
    await install(paths, () => NOW)
    const mine = join(paths.claudeHome, 'skills', 'asc-inbox', 'SKILL.md')
    await writeFile(mine, (await readFile(mine, 'utf8')) + '\n# 내 규칙\n', 'utf8')

    await uninstall(paths)
    assert.match(await readFile(mine, 'utf8'), /내 규칙/)
    // 옆의 것은 정상적으로 걷혔다
    await assert.rejects(readdir(join(paths.claudeHome, 'skills', 'asc-review')), /ENOENT/)
  })

  it('Skill 본문에 정책값을 하드코딩하지 않는다 (C-05 §4)', () => {
    // 우선순위 매핑이 skill에 복제되면 Profile과 skill이 서로 다른 정책을 말하게 된다
    for (const { name, text } of skillBundle()) {
      assert.doesNotMatch(text, /=\s*P[012]\b/, `${name} 에 우선순위 매핑이 있다`)
      assert.doesNotMatch(text, /review_requested|mention\s*=/, `${name} 에 신호 정책이 있다`)
    }
  })

  it('asc-inbox는 결정 제출 경로를 열지 않는다 (C-01 §5)', () => {
    const text = inboxSkillText()
    assert.match(text, /asc inbox list/)
    assert.match(text, /asc inbox show/)
    assert.match(text, /asc inbox trace/)
    assert.doesNotMatch(text, /asc inbox decide/)
    assert.match(text, /It does not decide/)
    assert.match(text, /External writes \(comments, PRs, issues\)/)
  })

  it('depth는 요청 단위 예산이고 기본은 inspect다 — 전역 mode가 없다', () => {
    const text = inboxSkillText()
    assert.match(text, /default is .inspect./)
    assert.match(text, /not a global mode/)
    assert.match(text, /Do not trace everything from the start/)
    assert.doesNotMatch(text, /ULTRA MODE/i)
  })

  it('asc-review는 자기 보고를 증거로 쓰지 않고, 고치지도 않는다', () => {
    const text = reviewSkillText()
    assert.match(text, /never used as verification evidence/)
    assert.match(text, /run the tests yourself/)
    assert.match(text, /It does not fix/)
    assert.match(text, /unresolved/)
  })

  it('asc는 조사와 검증을 스스로 하지 않고, 결정을 떠넘기지 않는다', () => {
    const text = skillText()
    assert.match(text, /leave reading thread originals to .asc-inbox./)
    assert.match(text, /independent verification is .asc-review./)
    assert.match(text, /asc query open/)
    assert.match(text, /DECIDE\|ANSWER\|ESCALATE/)
    assert.match(text, /Never hand it to another agent/)
    assert.match(text, /Receiving a DECIDE creates no approval, authority or scope/)
  })
})

describe('Auto mode ≠ ASC Policy (C-03 §5.4)', () => {
  it('permissive한 provider 판정이 와도 발급 시점의 HARD DENY 검사가 SSOT다', async () => {
    // provider(Auto mode)가 "user intent로 allow"라고 판단한 상황을 흉내 내도, ASC 의 발급
    // 검사에는 그 입력 자체가 없다 — 우회 경로가 아니라 무관한 층이다. 0.9.1 부터 이 불변식은
    // 실행 시점 판정기(evaluate) 가 아니라 SessionRuntime.issue 가 든다.
    const { mergePolicyLayers } = await import('../core/policy/policy.ts')
    const { SessionRuntime } = await import('../core/runtime/session.ts')
    const { policy } = mergePolicyLayers([
      { id: 'vanilla', hardDeny: ['external.write'], softDeny: ['dependency.add'], roleScopes: { implementer: ['src/**'] } },
    ])
    const runtime = new SessionRuntime(new MemoryStateStore(), policy)
    const forced = await runtime.issue({
      id: 'S-20260913-09',
      role: 'implementer',
      goal: 'x',
      policyExceptions: ['external.write'],
    })
    assert.ok(!forced.ok && forced.failures[0]!.kind === 'HARD_DENY_ESCAPE')
    const outside = await runtime.issue({ id: 'S-20260913-10', role: 'implementer', goal: 'x', writeBoundary: ['outside/**'] })
    assert.ok(!outside.ok && outside.failures[0]!.kind === 'SCOPE_ESCALATION')
  })
})

describe('관찰 이벤트 ≠ 전이 (C-03 §5.5·§5.6)', () => {
  it('goal achieved·agent_completed 관찰은 세션을 DONE으로 만들 수 없다', async () => {
    const store = new MemoryStateStore()
    const { SessionRuntime } = await import('../core/runtime/session.ts')
    const runtime = new SessionRuntime(store)
    await runtime.issue({ id: 'S-20260823-01', role: 'implementer', goal: 'x' })
    await runtime.start('S-20260823-01')

    // hook/goal 이벤트를 받은 adapter가 할 수 있는 것은 binding 관찰 갱신뿐이다
    const bindings = claudeBindings(store)
    await bindings.claim(
      { logicalSessionId: 'S-20260823-01', provider: CLAUDE_PROVIDER, physicalSessionId: 'claude-abc' },
      NOW,
    )
    await bindings.observe('S-20260823-01', 'claude-abc', { lastObservedState: 'goal_achieved' }, NOW)

    // 세션은 여전히 ACTIVE — DONE은 Handoff를 든 SessionRuntime 전이뿐이다
    assert.equal((await store.get('session', 'S-20260823-01'))!.status, 'ACTIVE')
  })

  it('physical worker 실패 관찰도 Logical FAILED로 승격되지 않는다 (C-03 §3.3)', async () => {
    const store = new MemoryStateStore()
    const { SessionRuntime } = await import('../core/runtime/session.ts')
    const runtime = new SessionRuntime(store)
    await runtime.issue({ id: 'S-20260823-01', role: 'implementer', goal: 'x' })
    await runtime.start('S-20260823-01')

    const bindings = claudeBindings(store)
    await bindings.claim(
      { logicalSessionId: 'S-20260823-01', provider: CLAUDE_PROVIDER, physicalSessionId: 'claude-abc' },
      NOW,
    )
    await bindings.observe('S-20260823-01', 'claude-abc', { lastObservedState: 'failed' }, NOW)
    assert.equal((await store.get('session', 'S-20260823-01'))!.status, 'ACTIVE')

    // respawn: 사람이 확인하고 rebind — 같은 Logical Session이 유지된다
    await bindings.rebind(
      { logicalSessionId: 'S-20260823-01', provider: CLAUDE_PROVIDER, physicalSessionId: 'claude-respawned' },
      NOW,
    )
    assert.equal((await bindings.get('S-20260823-01'))!.physicalSessionId, 'claude-respawned')
    assert.equal((await store.get('session', 'S-20260823-01'))!.status, 'ACTIVE')
  })
})
