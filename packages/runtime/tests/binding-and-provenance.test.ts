// 0.8.5 — #77 · #78. 둘 다 "화면이 말한 것과 실제가 다르다" 는 같은 종류의 결함이다.
//
//   #77  없는 세션에 결합을 만들고 "이 세션은 이제 ASC 가 관리한다" 고 말했다
//   #78  같은 사실을 두 화면이 다르게 그려, run 이 자기 답을 가진 것이 한쪽에서만 보였다
//
// CLI 를 실제로 돌린다. 둘 다 판정 함수 안의 결함이 아니라 **연결과 렌더의 결함**이라
// 그 경로를 지나야만 잡힌다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const CLI = new URL('../cli/asc.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const RUN_ID = '11111111-2222-4333-8444-555555555555'

function run(cwd: string, home: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
    cwd,
    env: { ...process.env, ASC_HOME: home, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function attached(): Promise<{ repo: string; home: string; root: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), 'asc-provenance-'))
  const repo = join(base, 'repo')
  const home = join(base, 'home')
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' })
  await writeFile(join(repo, 'README.md'), '# project\n', 'utf8')
  spawnSync('git', ['add', '-A'], { cwd: repo })
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
  spawnSync('git', ['remote', 'add', 'origin', 'git@lab.example.com:group/project.git'], { cwd: repo })
  const init = run(repo, home, ['init', '--profile', 'pilot-local'])
  assert.equal(init.code, 0, init.stderr)
  const { readFile } = await import('node:fs/promises')
  const index = JSON.parse(await readFile(join(home, 'workspace-index.json'), 'utf8')) as {
    locators: Record<string, { root: string }>
  }
  return { repo, home, root: Object.values(index.locators)[0]!.root, cleanup: () => rm(base, { recursive: true, force: true }) }
}

describe('I — #77 없는 논리 세션에는 결합을 만들지 않는다', () => {
  it('거절하고, 결합 파일도 실행 증거도 남기지 않는다', async () => {
    const { repo, home, root, cleanup } = await attached()
    try {
      const outcome = run(repo, home, ['host', 'claude', 'bind', 'S-20260909-99', '--physical', RUN_ID])
      assert.notEqual(outcome.code, 0, '없는 세션을 관리한다고 말하지 않는다')
      assert.match(`${outcome.stderr}${outcome.stdout}`, /was not found/)
      assert.doesNotMatch(
        `${outcome.stdout}`,
        /ASC-managed/,
        '없는 것을 "이제 관리한다" 고 말하면 그 문장이 곧 거짓말이다',
      )

      const dir = join(root, 'adapters', 'claude-code')
      const files = await readdir(dir).catch(() => [] as string[])
      assert.equal(
        files.filter((name) => name.startsWith('runtime-binding-S-20260909-99')).length,
        0,
        '남은 결합은 Run 을 점유해 다음 bind 를 막는다',
      )
      assert.equal(
        files.filter((name) => name.includes('S-20260909-99')).length,
        0,
        '실행 증거도 남기지 않는다',
      )
    } finally {
      await cleanup()
    }
  })

  it('release 는 그대로 동작한다 — 이미 잘못 생긴 결합을 푸는 것이 그 명령의 일이다', async () => {
    const { repo, home, cleanup } = await attached()
    try {
      const outcome = run(repo, home, ['host', 'claude', 'release', 'S-20260909-99', '--physical', RUN_ID])
      assert.doesNotMatch(`${outcome.stderr}`, /was not found\s*$/, 'release 까지 막으면 고칠 방법이 없어진다')
    } finally {
      await cleanup()
    }
  })
})

describe('J — #78 같은 사실을 두 화면이 같게 그린다', () => {
  it('run 이 자기 답을 가지면 status 도 그렇게 말한다', async () => {
    const { repo, home, cleanup } = await attached()
    try {
      const env = { CLAUDE_CODE_SESSION_ID: RUN_ID }
      const lowered = run(repo, home, ['mode', 'manual', '--this-run', '--as', 'colosair'], env)
      assert.equal(lowered.code, 0, lowered.stderr)
      assert.match(lowered.stdout, /this run only/)

      const status = run(repo, home, ['status'], env)
      assert.match(
        status.stdout,
        /Execution Mode: MANUAL \(this run only\)/,
        'status 만 scope 를 빼고 그리면 사람은 자기가 고르지 않은 값을 자기 것으로 읽는다',
      )
    } finally {
      await cleanup()
    }
  })

  it('자기 답이 없는 Run 에게는 workspace 기본값이라고 말한다', async () => {
    const { repo, home, cleanup } = await attached()
    try {
      run(repo, home, ['mode', 'manual', '--this-run', '--as', 'colosair'], { CLAUDE_CODE_SESSION_ID: RUN_ID })
      const other = run(repo, home, ['status'], {
        CLAUDE_CODE_SESSION_ID: '99999999-2222-4333-8444-555555555555',
      })
      assert.match(other.stdout, /workspace default/)
    } finally {
      await cleanup()
    }
  })
})
