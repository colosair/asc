// 0.9.1 — `asc session issue` 의 done criteria 는 `--criteria` 로만 들어간다.
//
// 0.9.0 published acceptance 에서 사람이 `--done` 을 쳤고, 옵션표가 명령마다 나뉘어 있지
// 않아 조용히 파싱된 뒤 버려졌다 — 세션은 READY 인데 doneCriteria 는 [] 였다. `--done` 은
// pause/done 의 "마친 task" 라 alias 로 만들 수 없다. 여기서는 쓰기 전에 거절하는 것과,
// `--criteria` 가 실제로 계약에 남는 것을 CLI 경로 그대로 고정한다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const CLI = new URL('../cli/asc.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function run(cwd: string, home: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
    cwd,
    env: { ...process.env, ASC_HOME: home },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function attached(): Promise<{ repo: string; home: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), 'asc-issue-cli-'))
  const repo = join(base, 'repo')
  const home = join(base, 'home')
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' })
  await writeFile(join(repo, 'README.md'), '# project\n', 'utf8')
  spawnSync('git', ['add', '-A'], { cwd: repo })
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
  spawnSync('git', ['remote', 'add', 'origin', 'git@lab.example.com:group/project.git'], { cwd: repo })
  const init = run(repo, home, ['init', '--profile', 'pilot-local'])
  assert.equal(init.code, 0, init.stderr)
  return { repo, home, cleanup: () => rm(base, { recursive: true, force: true }) }
}

describe('0.9.1 — session issue 의 done criteria 는 --criteria 로만 들어간다', () => {
  it('--criteria 가 계약에 남고 audit 에 보인다', async () => {
    const { repo, home, cleanup } = await attached()
    try {
      const issued = run(repo, home, [
        'session', 'issue', 'S-20260913-11', '--role', 'implementer', '--goal', '로그인',
        '--criteria', 'npm test 통과', '--criteria', 'MR 열림',
      ])
      assert.equal(issued.code, 0, issued.stderr)
      const audit = run(repo, home, ['session', 'audit', 'S-20260913-11'])
      assert.match(audit.stdout, /Done criteria:/)
      assert.match(audit.stdout, /\[ \] npm test 통과/)
      assert.match(audit.stdout, /\[ \] MR 열림/)
    } finally {
      await cleanup()
    }
  })

  it('--done 은 거절한다 — 쓰기 전에, 맞는 flag 를 말하면서', async () => {
    const { repo, home, cleanup } = await attached()
    try {
      const refused = run(repo, home, [
        'session', 'issue', 'S-20260913-12', '--role', 'implementer', '--goal', '로그인', '--done', 'npm test 통과',
      ])
      assert.equal(refused.code, 2)
      assert.match(refused.stderr, /--done is the pause\/done checkpoint flag/)
      assert.match(refused.stderr, /--criteria/)
      // 아무것도 발급되지 않았다
      const audit = run(repo, home, ['session', 'audit', 'S-20260913-12'])
      assert.doesNotMatch(audit.stdout, /Status: READY/)
    } finally {
      await cleanup()
    }
  })

  it('usage 가 --criteria 를 issue 줄에 적는다 — 사람이 --done 으로 헤매지 않게', () => {
    const help = run(process.cwd(), join(tmpdir(), 'asc-issue-help'), ['help', '--advanced'])
    const line = help.stdout.split('\n').find((l) => l.includes('asc session issue'))
    assert.ok(line, 'advanced help 에 session issue 가 있다')
    const block = help.stdout.slice(help.stdout.indexOf('asc session issue'), help.stdout.indexOf('asc session validate'))
    assert.match(block, /--criteria <text>\.\.\./)
    assert.match(block, /--done is the pause\/done checkpoint flag/)
  })
})
