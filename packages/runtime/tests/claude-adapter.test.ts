// B-15 자동 계약 테스트 (C-03 §7.2). 실 Claude pilot은 별도 — 여기는 fake로 계약을 조인다.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { claudeBindings, CLAUDE_PROVIDER, CLAUDE_SCOPE } from '../adapters/claude-code/binding.ts'
import { readHeartbeat } from '../adapters/claude-code/observer.ts'
import {
  FORBIDDEN_COMMAND_PATTERNS,
  hookScript,
  isForbiddenCommand,
  workerContract,
  workerSettings,
  PERMISSION_DENY_RULES,
} from '../adapters/claude-code/guard.ts'
import {
  install,
  installReportLines,
  uninstall,
  verifyInstall,
  verifyInstalled,
  type InstallPaths,
} from '../adapters/claude-code/install.ts'
import {
  applyHostReport,
  assessReadiness,
  probe,
  CAPABILITIES,
  type CommandRunner,
} from '../adapters/claude-code/probe.ts'
import { inboxSkillText, reviewSkillText, skillBundle, skillText } from '../adapters/claude-code/skill.ts'
import { MarkdownStateStore } from '../adapters/markdown/state-store.ts'
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

describe('External Write Guard — 규칙 정본 (C-03 §5.3)', () => {
  it('차단 대상이 전부 걸린다', () => {
    for (const command of [
      'git push origin feature',
      'git push --force-with-lease',
      'cd repo && git -c user.name=x push',
      'gh pr create --title x',
      'gh pr merge 42',
      'gh pr comment 42 --body hi',
      'gh issue create --title x',
      'gh issue comment 19 --body x',
      'gh api repos/o/r/issues -f title=x',
      'gh api /repos/o/r/pulls/1/comments --method POST',
      'glab mr create',
      'glab api projects',
    ]) {
      assert.equal(isForbiddenCommand(command).forbidden, true, command)
    }
  })

  it('정상 작업 명령은 걸리지 않는다', () => {
    for (const command of [
      'git status',
      'git commit -m "local work"', // commit은 local write — Session Contract의 몫
      'git log --oneline',
      'gh pr list',
      'gh pr view 42',
      'gh issue view 19',
      'npm test',
      'node cli/asc.ts grant run G-0001', // ASC 승인 경로는 Bash 밖(fetch)이지만 명령 자체도 무해
    ]) {
      assert.equal(isForbiddenCommand(command).forbidden, false, command)
    }
  })

  it('permission deny 규칙(2층)이 패턴 정본(3층)과 같은 대상을 겨눈다', () => {
    for (const rule of ['Bash(git push:*)', 'Bash(gh pr create:*)', 'Bash(gh api:*)', 'Bash(glab mr create:*)']) {
      assert.ok(PERMISSION_DENY_RULES.includes(rule), rule)
    }
    assert.ok(FORBIDDEN_COMMAND_PATTERNS.length >= 6)
  })
})

describe('guard hook(3층) — 실행 직전 차단', () => {
  /** hook 스크립트를 실제 프로세스로 돌려 exit code를 본다. */
  async function invokeHook(input: Record<string, unknown>): Promise<{ code: number; stderr: string }> {
    const dir = await tempDir('asc-hook-')
    const script = join(dir, 'guard-hook.mjs')
    await writeFile(script, hookScript(), 'utf8')
    try {
      // stdin을 닫아 줘야 hook의 readFileSync(0)가 끝난다 — execFileSync의 input이 그 역할
      execFileSync('node', [script], { input: JSON.stringify(input), timeout: 10_000 })
      return { code: 0, stderr: '' }
    } catch (error) {
      const failure = error as { status?: number; stderr?: Buffer }
      return { code: failure.status ?? 1, stderr: failure.stderr?.toString() ?? '' }
    }
  }

  async function attachedProject(): Promise<{ project: string; store: MarkdownStateStore }> {
    const project = await tempDir('asc-hookproj-')
    const store = await MarkdownStateStore.open(join(project, '.asc'))
    return { project, store }
  }

  it('managed 세션의 git push는 exit 2로 막힌다', async () => {
    const { project, store } = await attachedProject()
    await claudeBindings(store).claim(
      { logicalSessionId: 'S-20260823-01', provider: CLAUDE_PROVIDER, physicalSessionId: 'claude-abc' },
      NOW,
    )

    const outcome = await invokeHook(
      { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, session_id: 'claude-abc', cwd: project },
    )
    assert.equal(outcome.code, 2)
    assert.match(outcome.stderr, /ASC guard/)
    assert.match(outcome.stderr, /Execution Grant/)
  })

  it('같은 프로젝트라도 사람 세션(미등록)은 통과한다', async () => {
    const { project, store } = await attachedProject()
    await claudeBindings(store).claim(
      { logicalSessionId: 'S-20260823-01', provider: CLAUDE_PROVIDER, physicalSessionId: 'claude-abc' },
      NOW,
    )

    const outcome = await invokeHook(
      { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, session_id: 'human-session', cwd: project },
    )
    assert.equal(outcome.code, 0)
  })

  it('ASC 무관 프로젝트는 항상 통과한다', async () => {
    const plain = await tempDir('asc-plain-')
    const outcome = await invokeHook(
      { tool_name: 'Bash', tool_input: { command: 'git push' }, session_id: 'any', cwd: plain },
    )
    assert.equal(outcome.code, 0)
  })

  it('managed 세션이라도 무해한 명령은 통과한다', async () => {
    const { project, store } = await attachedProject()
    await claudeBindings(store).claim(
      { logicalSessionId: 'S-20260823-01', provider: CLAUDE_PROVIDER, physicalSessionId: 'claude-abc' },
      NOW,
    )
    for (const command of ['npm test', 'git commit -m x', 'gh pr view 1']) {
      const outcome = await invokeHook(
        { tool_name: 'Bash', tool_input: { command }, session_id: 'claude-abc', cwd: project },
      )
      assert.equal(outcome.code, 0, command)
    }
  })

  it('workerId로 등록된 subagent도 막힌다', async () => {
    const { project, store } = await attachedProject()
    await claudeBindings(store).claim(
      {
        logicalSessionId: 'S-20260823-01',
        provider: CLAUDE_PROVIDER,
        physicalSessionId: 'claude-abc',
        workerId: 'subagent-7',
      },
      NOW,
    )
    const outcome = await invokeHook(
      { tool_name: 'Bash', tool_input: { command: 'gh pr create' }, session_id: 'subagent-7', cwd: project },
    )
    assert.equal(outcome.code, 2)
  })

  it('Bash 외 도구·깨진 입력은 판단하지 않는다', async () => {
    const outcome = await invokeHook({ tool_name: 'Read', tool_input: { file_path: 'x' }, session_id: 'any' })
    assert.equal(outcome.code, 0)
  })

  // ── Runtime Observer (B-18) — 같은 hook에 실리지만 safety와 책임이 다르다 ──

  it('managed 세션의 활동은 heartbeat로 남고, binding 파일은 건드리지 않는다', async () => {
    const { project, store } = await attachedProject()
    const bindings = claudeBindings(store)
    await bindings.claim(
      { logicalSessionId: 'S-20260823-01', provider: CLAUDE_PROVIDER, physicalSessionId: 'claude-abc' },
      NOW,
    )
    const bindingFile = join(project, '.asc/adapters/claude-code/runtime-binding-S-20260823-01.json')
    const before = await readFile(bindingFile, 'utf8')

    const outcome = await invokeHook({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      session_id: 'claude-abc',
      cwd: project,
    })

    assert.equal(outcome.code, 0)
    const beat = await readHeartbeat(store.scope(CLAUDE_SCOPE), 'S-20260823-01')
    assert.ok(beat, 'heartbeat가 남지 않았다')
    assert.equal(beat.physicalSessionId, 'claude-abc')
    assert.equal(beat.lastTool, 'Bash')
    // 안전 판정의 근거 파일은 관찰 때문에 흔들리면 안 된다
    assert.equal(await readFile(bindingFile, 'utf8'), before, 'observer가 binding 파일을 고쳤다')
  })

  it('workerId로 매치된 subagent도 owner id로 기록된다 — heartbeat는 Logical Session당 하나다', async () => {
    const { project, store } = await attachedProject()
    await claudeBindings(store).claim(
      {
        logicalSessionId: 'S-20260823-01',
        provider: CLAUDE_PROVIDER,
        physicalSessionId: 'claude-owner',
        workerId: 'claude-worker',
      },
      NOW,
    )

    await invokeHook({
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      session_id: 'claude-worker',
      cwd: project,
    })

    const beat = await readHeartbeat(store.scope(CLAUDE_SCOPE), 'S-20260823-01')
    assert.equal(beat?.physicalSessionId, 'claude-owner')
    assert.equal(beat?.observedSessionId, 'claude-worker')
  })

  it('unmanaged 세션은 관찰도 남기지 않는다', async () => {
    const { project, store } = await attachedProject()
    await claudeBindings(store).claim(
      { logicalSessionId: 'S-20260823-01', provider: CLAUDE_PROVIDER, physicalSessionId: 'claude-abc' },
      NOW,
    )

    await invokeHook({
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      session_id: 'human-session',
      cwd: project,
    })

    assert.equal(await readHeartbeat(store.scope(CLAUDE_SCOPE), 'S-20260823-01'), null)
  })

  it('관찰이 실패해도 차단은 그대로다 — telemetry가 safety를 흔들지 않는다', async () => {
    const { project, store } = await attachedProject()
    await claudeBindings(store).claim(
      { logicalSessionId: 'S-20260823-01', provider: CLAUDE_PROVIDER, physicalSessionId: 'claude-abc' },
      NOW,
    )
    // heartbeat 목적지를 디렉터리로 점유해 기록을 실패시킨다. 권한 모델에 기대지 않는 방식이라
    // 어느 OS에서도 같게 실패한다 — 파일 자리에 디렉터리가 있으면 rename이 통하지 않는다.
    await mkdir(join(project, '.asc/adapters/claude-code/heartbeat-S-20260823-01.json'), {
      recursive: true,
    })

    const blocked = await invokeHook({
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
      session_id: 'claude-abc',
      cwd: project,
    })
    const allowed = await invokeHook({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      session_id: 'claude-abc',
      cwd: project,
    })

    assert.equal(blocked.code, 2, '관찰 실패가 차단을 무력화했다')
    assert.match(blocked.stderr, /ASC guard/)
    assert.equal(allowed.code, 0, '관찰 실패가 무해한 명령까지 막았다')
    assert.equal(await readHeartbeat(store.scope(CLAUDE_SCOPE), 'S-20260823-01'), null)
  })
})

describe('install / uninstall (C-03 §5.1)', () => {
  async function freshPaths(): Promise<InstallPaths> {
    return { claudeHome: await tempDir('asc-claude-home-') }
  }

  it('설치 → 검증 → 반복 설치는 idempotent', async () => {
    const paths = await freshPaths()
    const first = await install(paths, () => NOW)
    assert.ok(first.written.some((p) => p.includes('SKILL.md')))
    assert.ok(first.written.some((p) => p.includes('guard-hook.mjs')))
    assert.ok(first.written.some((p) => p.includes('settings.json')))
    assert.equal(await verifyInstalled(paths), true)

    const second = await install(paths, () => NOW)
    assert.deepEqual(second.written, [])
    assert.deepEqual(second.skipped, [])

    // hook 항목이 중복 등록되지 않았다
    const settings = JSON.parse(await readFile(join(paths.claudeHome, 'settings.json'), 'utf8'))
    assert.equal(settings.hooks.PreToolUse.length, 1)
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
      JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] }] } }),
      'utf8',
    )
    await install(paths, () => NOW)

    const outcome = await uninstall(paths)
    assert.ok(outcome.removed.some((p) => p.includes('SKILL.md')))
    assert.ok(outcome.removed.some((p) => p.includes('guard-hook.mjs')))

    const settings = JSON.parse(await readFile(join(paths.claudeHome, 'settings.json'), 'utf8'))
    assert.equal(settings.theme, 'dark') // 무관 설정 보존
    assert.equal(settings.hooks.PreToolUse.length, 1) // 사용자 hook 보존
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'my-own-hook')
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

  it('설치 파일이 변조되면 verify가 false다 — probe의 STOP 근거', async () => {
    const paths = await freshPaths()
    await install(paths, () => NOW)
    await writeFile(join(paths.claudeHome, 'asc', 'guard-hook.mjs'), '// gutted\n', 'utf8')
    assert.equal(await verifyInstalled(paths), false)
  })
})

// L-5 closure — 설치본이 지금 source보다 뒤처진 것(stale)과 사람이 고친 것(modified)은
// 다른 사실이다. 예전 verify는 manifest digest만 봐서 전자를 아예 못 봤다.
describe('설치 drift 판정 (L-5)', () => {
  async function freshPaths(): Promise<InstallPaths> {
    return { claudeHome: await tempDir('asc-drift-home-') }
  }

  const skillPathOf = (paths: InstallPaths) => join(paths.claudeHome, 'skills', 'asc', 'SKILL.md')
  const hookPathOf = (paths: InstallPaths) => join(paths.claudeHome, 'asc', 'guard-hook.mjs')
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
    settings.hooks.PreToolUse[0].hooks[0].command = 'node "/opt/old-asc/guard-hook.mjs"'
    settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] })
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8')

    assert.equal((await verifyInstall(paths)).status, 'INSTALLED_STALE')

    await install(paths, () => NOW)
    const fixed = JSON.parse(await readFile(settingsPath, 'utf8'))
    assert.equal(fixed.hooks.PreToolUse.length, 2, 'hook 항목을 늘리지 않는다')
    assert.match(fixed.hooks.PreToolUse[0].hooks[0].command, /guard-hook\.mjs/)
    assert.doesNotMatch(fixed.hooks.PreToolUse[0].hooks[0].command, /old-asc/)
    assert.equal(fixed.hooks.PreToolUse[1].hooks[0].command, 'my-own-hook', '남의 hook은 건드리지 않는다')
    assert.equal((await verifyInstall(paths)).status, 'INSTALLED_CURRENT')
  })

  it('drift 수렴이 무관한 사용자 파일을 건드리지 않는다', async () => {
    const paths = await freshPaths()
    const mine = join(paths.claudeHome, 'skills', 'my-skill', 'SKILL.md')
    await mkdir(join(paths.claudeHome, 'skills', 'my-skill'), { recursive: true })
    await writeFile(mine, '# 내 skill\n', 'utf8')
    await installAsOlderVersion(paths, hookPathOf(paths), '// 옛 guard\n')

    await install(paths, () => NOW)
    assert.equal(await readFile(mine, 'utf8'), '# 내 skill\n')
    assert.equal((await verifyInstall(paths)).status, 'INSTALLED_CURRENT')
  })
})

describe('worker-settings — 2층 wiring', () => {
  it('deny 규칙 정본이 전부 들어간다', () => {
    const parsed = JSON.parse(workerSettings())
    assert.deepEqual(parsed.permissions.deny, [...PERMISSION_DENY_RULES])
  })

  it('worker 전용이다 — user settings에 섞을 값이 아니라는 근거가 파일에 남는다', () => {
    assert.match(workerSettings(), /ASC-managed worker 전용/)
    assert.match(workerSettings(), /--settings/)
  })
})

describe('capability probe (C-03 §5.2)', () => {
  // CLI 실행 결과를 주입한다. 호스트에 claude가 깔렸는지로 판정이 달라지면 그건 계약 검증이
  // 아니라 그 머신의 사정을 재는 것이다 — 두 경우를 각각 명시적으로 세운다.
  const cliPresent: CommandRunner = async (_command, args) =>
    args[0] === '--version' ? { ok: true, stdout: '2.1.233 (Claude Code)\n' } : { ok: true, stdout: '[]' }
  const cliAbsent: CommandRunner = async () => ({ ok: false, stdout: '' })

  it('guard 미설치면 external_write_guard=false → STOP', async () => {
    const result = await probe({ guardInstalled: false, now: () => NOW, run: cliPresent })
    assert.equal(result.capabilities.external_write_guard.available, false)
    const readiness = assessReadiness(result)
    assert.ok(!readiness.ok && readiness.reason === 'STOP')
    assert.deepEqual(readiness.missing, ['external_write_guard'])
  })

  it('hook만 있고 worker-settings가 없으면 여전히 STOP — 2층도 enforcement다', async () => {
    const result = await probe({
      guardInstalled: true,
      workerSettingsReady: false,
      now: () => NOW,
      run: cliPresent,
    })
    assert.equal(result.capabilities.external_write_guard.available, false)
    assert.match(result.capabilities.external_write_guard.detail!, /worker-settings 미준비/)
    const readiness = assessReadiness(result)
    assert.ok(!readiness.ok && readiness.reason === 'STOP')
  })

  it('두 층이 다 서면 external_write_guard=true', async () => {
    const result = await probe({
      guardInstalled: true,
      workerSettingsReady: true,
      now: () => NOW,
      run: cliPresent,
    })
    assert.equal(result.capabilities.external_write_guard.available, true)
  })

  it('CLI가 없으면 2층이 다 서 있어도 STOP — 실측하지 못한 것을 있다고 치지 않는다', async () => {
    const result = await probe({
      guardInstalled: true,
      workerSettingsReady: true,
      now: () => NOW,
      run: cliAbsent,
    })
    assert.equal(result.claudeVersion, null)
    assert.equal(result.capabilities.external_write_guard.available, false)
    assert.equal(result.capabilities.external_write_guard.source, 'cli-probe')
    const readiness = assessReadiness(result)
    assert.ok(!readiness.ok && readiness.reason === 'STOP')
    assert.deepEqual(readiness.missing, ['external_write_guard'])
  })

  it('기본 runner는 실제 CLI다 — 주입 슬롯이 실측을 대신하지 않는다', async () => {
    const source = await readFile('adapters/claude-code/probe.ts', 'utf8')
    assert.match(source, /input\.run \?\? tryRun/, '주입이 없으면 실제 CLI를 불러야 한다')
    assert.match(source, /exec\('claude', \['--version'\]\)/, 'CLI 실측이 사라졌다')
  })

  it('runtime tool은 아는 척하지 않는다 — unknown + host-report로만 채워진다', async () => {
    const result = await probe({
      guardInstalled: true,
      workerSettingsReady: true,
      now: () => NOW,
      run: cliPresent,
    })
    assert.equal(result.capabilities.cross_session_message.available, 'unknown')
    assert.equal(result.capabilities.goal_loop.available, 'unknown')

    const reported = applyHostReport(result, { cross_session_message: true, goal_loop: true }, NOW)
    assert.equal(reported.capabilities.cross_session_message.available, true)
    assert.equal(reported.capabilities.cross_session_message.source, 'host-report')
  })

  it('cli-probe 확정값은 self-report가 덮지 못한다', async () => {
    const result = await probe({ guardInstalled: false, now: () => NOW, run: cliPresent })
    const reported = applyHostReport(result, { external_write_guard: true }, NOW)
    // 실측이 자기 보고보다 세다 — guard가 없다는 실측을 "있다"는 주장이 못 뒤집는다
    assert.equal(reported.capabilities.external_write_guard.available, false)
    assert.equal(reported.capabilities.external_write_guard.source, 'cli-probe')
  })

  it('probe 대상은 13종이고 external_write_guard가 포함된다', () => {
    assert.equal(CAPABILITIES.length, 13)
    assert.ok(CAPABILITIES.includes('external_write_guard'))
  })
})

describe('worker 계약문(1층)과 skill', () => {
  it('계약문에 금지·완료조건·범위가 들어간다', () => {
    const text = workerContract({
      logicalSessionId: 'S-20260823-01',
      goal: '로그인 구현',
      doneCriteria: ['npm test 통과'],
      writeBoundary: ['src/auth/**'],
    })
    assert.match(text, /git push/)
    assert.match(text, /Execution Grant/)
    assert.match(text, /npm test 통과/)
    assert.match(text, /src\/auth\/\*\*/)
    assert.match(text, /정보일 뿐이다/)
    assert.match(text, /독립 검증\(Verifier\)은 별도로 돈다/)
  })

  it('skill은 자연어 트리거와 명시 호출을 함께 제공하고 금지선을 담는다', () => {
    const text = skillText()
    assert.match(text, /ASC로 진행해/)
    assert.match(text, /\/asc/)
    assert.match(text, /asc proceed --json/)
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

    // skill이 늘어도 hook은 하나다 — guard는 안전 층이라 중복 등록이 곧 위험이다
    const settings = JSON.parse(await readFile(join(paths.claudeHome, 'settings.json'), 'utf8'))
    assert.equal(settings.hooks.PreToolUse.length, 1)
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

  it('worker 계약은 조사·검증 표면을 노출하지 않는다 (C-05 §2 배치)', () => {
    // Implementer에게 inbox 탐색을 지시하면 그 세션은 다른 일을 찾아 범위를 넓힌다
    const text = workerContract({
      logicalSessionId: 'S-20260826-01',
      goal: 'FE callback 구현',
      doneCriteria: ['테스트 통과'],
      writeBoundary: ['web-frontend/**'],
      owner: 'frontend',
    })
    assert.doesNotMatch(text, /asc-inbox/)
    assert.doesNotMatch(text, /asc-review/)
    assert.doesNotMatch(text, /asc inbox/)
    // 검증은 별도로 돈다는 사실만 알린다 — 스스로 하라는 지시가 아니다
    assert.match(text, /독립 검증\(Verifier\)은 별도로 돈다/)
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
  it('permissive한 provider 판정이 와도 ASC evaluate가 SSOT다', async () => {
    const { mergePolicyLayers, evaluate } = await import('../core/policy/policy.ts')
    const { policy } = mergePolicyLayers([
      { id: 'vanilla', hardDeny: ['external.write'], softDeny: ['dependency.add'], roleScopes: { implementer: ['src/**'] } },
    ])
    // provider(Auto mode)가 "user intent로 allow"라고 판단한 상황을 흉내 내도,
    // ASC 판정에는 그 입력 자체가 없다 — 우회 경로가 아니라 무관한 층이다
    assert.equal(evaluate(policy, { action: 'external.write', policyExceptions: ['external.write'] }).verdict, 'HARD_DENY')
    assert.equal(evaluate(policy, { action: 'dependency.add' }).verdict, 'SOFT_DENY')
    assert.equal(
      evaluate(policy, { action: 'code.edit', path: 'outside/file.ts', writeBoundary: ['src/**'] }).verdict,
      'HARD_DENY',
    )
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
