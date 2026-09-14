// 0.10.0 P3 — `asc work issue <S-ID>`: 보존된 제안을 사람이 id 하나로 발급한다.
//
// 발급 경로는 SessionRuntime.issue 그대로다. 여기서 보는 것은 표면이다: 초안을 다시 치지 않는다,
// 닫힌 제안은 발급되지 않는다, 발급 기록이 발급자와 근거를 나눠 적는다, work status 가 열린 제안을 든다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { MarkdownStateStore } from '../adapters/markdown/state-store.ts'
import { ProposalLedger } from '../core/operator/proposal.ts'

const CLI = new URL('../cli/asc.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const RUN = '11111111-2222-4333-8444-555555555555'

function run(cwd: string, home: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
    cwd,
    env: { ...process.env, ASC_HOME: home, CLAUDE_CODE_SESSION_ID: RUN },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function attached(): Promise<{ repo: string; home: string; root: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), 'asc-work-issue-'))
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

const propose = async (root: string, id: string, goal: string) => {
  const ledger = new ProposalLedger(new MarkdownStateStore(root).scope('proposals'))
  const created = await ledger.create({
    id,
    draft: { id, role: 'implementer', goal, boundary: ['src/**'], criteria: ['테스트가 있다', '문서가 있다'] },
    createdBy: 'run-x',
  })
  assert.equal(created.ok, true)
  return ledger
}

describe('asc work issue', () => {
  it('제안 id 하나로 발급된다 — 초안의 criteria·boundary 가 그대로 세션이 된다', async () => {
    const { repo, home, root, cleanup } = await attached()
    try {
      await writeFile(join(root, 'identities.json'), JSON.stringify({ colosair: ['local:colosair'] }), 'utf8')
      const ledger = await propose(root, 'S-20260914-01', 'PROJ-1: 첫 일')
      assert.match(run(repo, home, ['work', 'status']).stdout, /Proposed \(awaiting issue\): S-20260914-01/)

      const issued = run(repo, home, ['work', 'issue', 'S-20260914-01'])
      assert.equal(issued.code, 0, issued.stderr)
      assert.match(issued.stdout, /S-20260914-01 READY — PROJ-1: 첫 일/)
      assert.match(issued.stdout, /asc work start --session S-20260914-01/)

      const audit = run(repo, home, ['session', 'audit', 'S-20260914-01']).stdout
      assert.match(audit, /\[ \] 테스트가 있다/)
      assert.match(audit, /\[ \] 문서가 있다/)
      assert.equal((await ledger.get('S-20260914-01'))?.status, 'ISSUED')

      // 발급 기록: 발급자는 이 기계의 유일한 승인자, 근거는 controller, 적은 것은 이 Run
      const record = JSON.parse(
        (JSON.parse(await readFile(join(root, 'adapters', 'audit', 'audit-del-S-20260914-01.json'), 'utf8')) as { value: string }).value,
      ) as { issuedBy: string; authority?: string; recordedBy?: string; proposalId?: string }
      assert.equal(record.issuedBy, 'colosair')
      assert.equal(record.authority, 'controller')
      assert.equal(record.recordedBy, RUN)
      assert.equal(record.proposalId, 'S-20260914-01')
    } finally {
      await cleanup()
    }
  })

  it('거절은 이유를 남기고, 닫힌 제안은 다시 발급되지 않는다', async () => {
    const { repo, home, root, cleanup } = await attached()
    try {
      const ledger = await propose(root, 'S-20260914-02', 'PROJ-2')
      assert.equal(run(repo, home, ['work', 'issue', 'S-20260914-02', '--reject', '범위가 넓다']).code, 0)
      assert.equal((await ledger.get('S-20260914-02'))?.status, 'REJECTED')
      const again = run(repo, home, ['work', 'issue', 'S-20260914-02'])
      assert.equal(again.code, 1)
      assert.match(again.stderr, /이미 REJECTED/)
      assert.equal(run(repo, home, ['work', 'issue', 'S-none']).code, 2)
    } finally {
      await cleanup()
    }
  })
})

// 0.10.1 — 발급은 정본 baseline 을 읽는다. scm 없이 SessionRuntime 을 만들면 canonical 이 선언된
// workspace 에서 CANONICAL_UNAVAILABLE 로 거절됐다 (0.10.0 게시본 acceptance Q-4).
describe('asc work issue 는 session issue 와 같은 정본 통로를 쓴다', () => {
  it('runWorkIssue 가 scmFor(resolved) 를 SessionRuntime 에 넘긴다', async () => {
    const source = await readFile(new URL('../cli/asc.ts', import.meta.url), 'utf8')
    const body = source.slice(source.indexOf('async function runWorkIssue('), source.indexOf('async function runSessionPlan('))
    assert.match(body, /const scm = await scmFor\(resolved\)/)
    assert.match(body, /new SessionRuntime\(store, resolved\?\.resolved\.policy \?\? null, \{\s*\.\.\.\(scm \? \{ scm \} : \{\}\)/)
  })
})
