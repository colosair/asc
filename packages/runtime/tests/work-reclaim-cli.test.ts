// 0.10.0 P4 — 소유권 복구는 work 표면 안에서 끝난다.
//
// R-1 (2026-09-13): 다른 Run 이 쥔 세션 앞에서 사람이 알아야 했던 것은 `host claude bind --force` 였다.
// 여기서 고정하는 것: `work reclaim` 이 근거를 보이고 인수하며 기록을 남긴다 · 끝난 세션의 결합은
// 조용히 잊히지 않고 이유가 적힌 RELEASED 로 놓인다 · 자동 탈취는 없다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const CLI = new URL('../cli/asc.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const RUN_A = '11111111-2222-4333-8444-555555555555'
const RUN_B = '22222222-3333-4444-8555-666666666666'

function run(cwd: string, home: string, args: string[], runId?: string): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ASC_HOME: home }
  if (runId === undefined) delete env.CLAUDE_CODE_SESSION_ID
  else env.CLAUDE_CODE_SESSION_ID = runId
  const result = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function attached(): Promise<{ repo: string; home: string; root: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), 'asc-reclaim-'))
  const repo = join(base, 'repo')
  const home = join(base, 'home')
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' })
  await writeFile(join(repo, 'README.md'), '# project\n', 'utf8')
  spawnSync('git', ['add', '-A'], { cwd: repo })
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
  const init = run(repo, home, ['init', '--profile', 'pilot-local'])
  assert.equal(init.code, 0, init.stderr)
  const index = JSON.parse(await readFile(join(home, 'workspace-index.json'), 'utf8')) as {
    locators: Record<string, { root: string }>
  }
  const root = Object.values(index.locators)[0]!.root
  return { repo, home, root, cleanup: () => rm(base, { recursive: true, force: true }) }
}

const issueAndStart = (repo: string, home: string, id: string, runId: string) => {
  assert.equal(run(repo, home, ['session', 'issue', id, '--role', 'implementer', '--goal', `${id} 의 일`]).code, 0)
  assert.equal(run(repo, home, ['work', 'start', '--session', id], runId).code, 0)
}

const holderOf = async (root: string, id: string): Promise<string | null> => {
  try {
    const raw = JSON.parse(await readFile(join(root, 'adapters', 'claude-code', `runtime-binding-${id}.json`), 'utf8')) as { value: string }
    return (JSON.parse(raw.value) as { physicalSessionId: string }).physicalSessionId
  } catch {
    return null
  }
}

const bindingLog = async (root: string, id: string): Promise<{ kind: string; reason?: string }[]> => {
  const dir = join(root, 'adapters', 'claude-code')
  const out: { kind: string; reason?: string }[] = []
  for (const name of (await readdir(dir)).filter((n) => n.includes(`binding-log-${id}`) || n.includes(`binding-log:${id}`)).sort()) {
    const raw = JSON.parse(await readFile(join(dir, name), 'utf8')) as { value: string }
    out.push(JSON.parse(raw.value) as { kind: string; reason?: string })
  }
  return out
}

describe('asc work reclaim', () => {
  it('다른 Run 이 쥔 세션을 근거를 보이고 인수한다 — 기록이 남고, 이전 holder 는 승계된다', async () => {
    const { repo, home, root, cleanup } = await attached()
    try {
      issueAndStart(repo, home, 'S-20260914-01', RUN_A)
      assert.equal(await holderOf(root, 'S-20260914-01'), RUN_A)

      const blocked = run(repo, home, ['work', 'start', '--session', 'S-20260914-01'], RUN_B)
      assert.equal(blocked.code, 1)
      assert.match(blocked.stderr, /asc work reclaim S-20260914-01/)
      assert.match(blocked.stdout, /이 Run 은 이 세션의 소유자가 아닙니다/, 'stdout 도 같은 말을 한다')

      const reclaimed = run(repo, home, ['work', 'reclaim', 'S-20260914-01'], RUN_B)
      assert.equal(reclaimed.code, 0, reclaimed.stderr)
      assert.match(reclaimed.stdout, new RegExp(`holder:\\s+${RUN_A}`))
      assert.match(reclaimed.stdout, /Reclaiming is your call/)
      assert.match(reclaimed.stdout, new RegExp(`S-20260914-01 ← ${RUN_B} \\(reclaimed`))
      assert.equal(await holderOf(root, 'S-20260914-01'), RUN_B)
      assert.deepEqual(
        (await bindingLog(root, 'S-20260914-01')).map((e) => e.kind),
        ['CLAIMED', 'SUPERSEDED', 'CLAIMED'],
      )
      // 이제 이 Run 의 것이다 — 진행 보고가 통한다
      assert.equal(run(repo, home, ['progress', 'report', 'S-20260914-01', '--phase', '인수 뒤'], RUN_B).code, 0)
    } finally {
      await cleanup()
    }
  })

  it('끝난 세션의 결합은 이유가 적힌 RELEASED 로 놓인다 — 조용한 forget 이 아니다', async () => {
    const { repo, home, root, cleanup } = await attached()
    try {
      issueAndStart(repo, home, 'S-20260914-02', RUN_A)
      // finish 를 거치지 않고 끝낸다 — 0.8.1 이 남기던 모양
      assert.equal(
        run(repo, home, ['session', 'done', 'S-20260914-02', '--physical', RUN_A, '--verified', 'v', '--next', 'n']).code,
        0,
      )
      assert.equal(await holderOf(root, 'S-20260914-02'), RUN_A)
      assert.match(run(repo, home, ['status'], RUN_A).stdout, /asc work reclaim S-20260914-02/)

      const released = run(repo, home, ['work', 'reclaim', 'S-20260914-02'], RUN_B)
      assert.equal(released.code, 0, released.stderr)
      assert.match(released.stdout, /끝난 세션이다 — .* 놓았다 \(audited\)/)
      assert.equal(await holderOf(root, 'S-20260914-02'), null)
      const log = await bindingLog(root, 'S-20260914-02')
      assert.deepEqual(log.at(-1), { ...log.at(-1), kind: 'RELEASED', reason: 'terminal-holder' })
    } finally {
      await cleanup()
    }
  })

  it('이 Run 이 끝난 세션을 쥔 채 다음 일을 시작하면 그 결합은 기록과 함께 놓이고 시작은 성공한다', async () => {
    const { repo, home, root, cleanup } = await attached()
    try {
      issueAndStart(repo, home, 'S-20260914-03', RUN_A)
      assert.equal(
        run(repo, home, ['session', 'done', 'S-20260914-03', '--physical', RUN_A, '--verified', 'v', '--next', 'n']).code,
        0,
      )
      assert.equal(run(repo, home, ['session', 'issue', 'S-20260914-04', '--role', 'implementer', '--goal', '다음 일']).code, 0)
      const next = run(repo, home, ['work', 'start', '--session', 'S-20260914-04'], RUN_A)
      assert.equal(next.code, 0, next.stderr)
      assert.match(next.stdout, /terminal holder released: S-20260914-03/)
      assert.equal(await holderOf(root, 'S-20260914-03'), null)
      assert.equal(await holderOf(root, 'S-20260914-04'), RUN_A)
      assert.equal((await bindingLog(root, 'S-20260914-03')).at(-1)?.reason, 'terminal-holder')
    } finally {
      await cleanup()
    }
  })

  it('아무도 쥐지 않은 세션은 인수할 것이 없다', async () => {
    const { repo, home, cleanup } = await attached()
    try {
      assert.equal(run(repo, home, ['session', 'issue', 'S-20260914-05', '--role', 'implementer', '--goal', 'g']).code, 0)
      const none = run(repo, home, ['work', 'reclaim', 'S-20260914-05'], RUN_B)
      assert.equal(none.code, 1)
      assert.match(none.stderr, /인수할 것이 없다/)
    } finally {
      await cleanup()
    }
  })
})
