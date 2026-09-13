// 0.9.0 — `asc work start` 가 이 Run 을 세션에 묶는다.
//
// 0.8.x 까지 healthy path 는 세션 전이(STARTED)에서 끝났고, "지금 도는 Run 이 그 세션의
// 소유자인가" 는 사람이 `asc host claude bind` 를 알아야 채워졌다. 실기계에서 Agent 는 그
// 명령을 사람에게 떠넘겼고, 사람 터미널에는 Run id 가 없어 성립하지 않았다.
//
// 여기서 지키는 것은 넷이다:
//   결합은 Host 가 보고하는 Run id 로만 만든다 (Run 밖이면 NO_RUN, 조용히 성공이라 적지 않는다)
//   같은 Run·같은 세션은 no-op 이다 — 실행 증거도 두 번 남기지 않는다
//   충돌은 성공이 아니다 — 세션 전이는 되돌리지 않되 exit 1 이고, 기존 소유자를 뺏지 않는다
//   `--physical` 이 없어도 소유권을 소비하는 명령은 이 Run 의 id 로 답한다 (명시값 우선)
//
// Core/Operator 는 Host 를 모른다 — 이 seam 은 CLI 의 것이고, 그래서 CLI 를 실제로 돌린다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const CLI = new URL('../cli/asc.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const RUN_A = '11111111-2222-4333-8444-555555555555'
const RUN_B = '22222222-3333-4444-8555-666666666666'

/** Host 가 보고하는 Run id 는 env 로만 온다 — 이 프로세스가 물려받은 값을 쓰지 않고 명시한다. */
function run(
  cwd: string,
  home: string,
  args: string[],
  runId: string | undefined,
): { code: number; stdout: string; stderr: string } {
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
  const base = await mkdtemp(join(tmpdir(), 'asc-work-start-'))
  const repo = join(base, 'repo')
  const home = join(base, 'home')
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' })
  await writeFile(join(repo, 'README.md'), '# project\n', 'utf8')
  spawnSync('git', ['add', '-A'], { cwd: repo })
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
  spawnSync('git', ['remote', 'add', 'origin', 'git@lab.example.com:group/project.git'], { cwd: repo })
  const init = run(repo, home, ['init', '--profile', 'pilot-local'], undefined)
  assert.equal(init.code, 0, init.stderr)
  const index = JSON.parse(await readFile(join(home, 'workspace-index.json'), 'utf8')) as {
    locators: Record<string, { root: string }>
  }
  const root = Object.values(index.locators)[0]!.root
  return { repo, home, root, cleanup: () => rm(base, { recursive: true, force: true }) }
}

const bindingFile = (root: string, id: string) => join(root, 'adapters', 'claude-code', `runtime-binding-${id}.json`)
const exists = (path: string) => readFile(path, 'utf8').then(() => true, () => false)

function issue(repo: string, home: string, id: string, goal: string): void {
  assert.equal(run(repo, home, ['session', 'issue', id, '--role', 'implementer', '--goal', goal], undefined).code, 0)
}

/** 실행 증거 수 — audit scope 에 남은 `work start` 출처의 것만 센다. */
async function executionEvidence(root: string, id: string): Promise<number> {
  const dir = join(root, 'adapters', 'audit')
  const names = await readdir(dir).catch(() => [] as string[])
  let count = 0
  for (const name of names) {
    if (!name.includes(`exec-${id}`) && !name.includes(`exec:${id}`)) continue
    if (name.includes('exec-end')) continue
    const record = JSON.parse(await readFile(join(dir, name), 'utf8')) as { value: string }
    const evidence = JSON.parse(record.value) as { evidenceSource?: string }
    if (evidence.evidenceSource === 'work start') count += 1
  }
  return count
}

describe('0.9.0 — asc work start 가 이 Run 을 세션에 묶는다', () => {
  it('STARTED 와 함께 CLAIMED — 결합 파일과 실행 증거가 생기고 exit 0', async () => {
    const { repo, home, root, cleanup } = await attached()
    try {
      issue(repo, home, 'S-20260913-01', '첫 번째')
      const started = run(repo, home, ['work', 'start', '--session', 'S-20260913-01', '--json'], RUN_A)
      assert.equal(started.code, 0, started.stderr)
      const outcome = JSON.parse(started.stdout) as { kind: string; binding: { state: string; physical?: string } }
      assert.equal(outcome.kind, 'STARTED')
      assert.deepEqual(outcome.binding, { state: 'CLAIMED', physical: RUN_A })
      assert.equal(await exists(bindingFile(root, 'S-20260913-01')), true)
      assert.equal(await executionEvidence(root, 'S-20260913-01'), 1)
    } finally {
      await cleanup()
    }
  })

  it('같은 Run 이 다시 부르면 ALREADY — 증거를 두 번 남기지 않는다', async () => {
    const { repo, home, root, cleanup } = await attached()
    try {
      issue(repo, home, 'S-20260913-01', '첫 번째')
      assert.equal(run(repo, home, ['work', 'start', '--session', 'S-20260913-01'], RUN_A).code, 0)
      const again = run(repo, home, ['work', 'start', '--session', 'S-20260913-01', '--json'], RUN_A)
      assert.equal(again.code, 0, again.stderr)
      const outcome = JSON.parse(again.stdout) as { kind: string; binding: { state: string } }
      assert.equal(outcome.kind, 'CONTINUE_ACTIVE')
      assert.equal(outcome.binding.state, 'ALREADY')
      assert.equal(await executionEvidence(root, 'S-20260913-01'), 1)
    } finally {
      await cleanup()
    }
  })

  it('같은 Run 이 다른 세션을 시작하면 CONFLICT — 세션은 STARTED 로 남되 exit 1, 소유자는 그대로', async () => {
    const { repo, home, root, cleanup } = await attached()
    try {
      issue(repo, home, 'S-20260913-01', '첫 번째')
      issue(repo, home, 'S-20260913-02', '두 번째')
      assert.equal(run(repo, home, ['work', 'start', '--session', 'S-20260913-01'], RUN_A).code, 0)

      const second = run(repo, home, ['work', 'start', '--session', 'S-20260913-02', '--json'], RUN_A)
      assert.equal(second.code, 1, 'ownership 을 얻지 못한 healthy path 는 성공이 아니다')
      const outcome = JSON.parse(second.stdout) as {
        kind: string
        binding: { state: string; holder: { logicalSessionId: string; physicalSessionId: string } }
      }
      assert.equal(outcome.kind, 'STARTED', '논리 세션의 전이는 되돌리지 않는다')
      assert.equal(outcome.binding.state, 'CONFLICT')
      assert.deepEqual(outcome.binding.holder, { logicalSessionId: 'S-20260913-01', physicalSessionId: RUN_A })
      assert.match(second.stderr, /did not obtain ownership/)
      assert.match(second.stderr, /한 Run 은 한 세션만 잡는다/)

      // 상태: S-02 는 ACTIVE(시작됨), S-01 의 소유자는 그대로, S-02 결합 파일은 없다
      const status = run(repo, home, ['status', '--json'], undefined)
      const work = (JSON.parse(status.stdout) as { work: { id: string; status: string }[] }).work
      assert.equal(work.find((s) => s.id === 'S-20260913-02')?.status, 'ACTIVE')
      assert.equal(await exists(bindingFile(root, 'S-20260913-02')), false)
      const holder = JSON.parse(await readFile(bindingFile(root, 'S-20260913-01'), 'utf8')) as { value: string }
      assert.equal((JSON.parse(holder.value) as { physicalSessionId: string }).physicalSessionId, RUN_A)
      assert.equal(await executionEvidence(root, 'S-20260913-02'), 0, '실패한 결합은 실행 증거를 남기지 않는다')
    } finally {
      await cleanup()
    }
  })

  it('다른 Run 이 이미 쥔 세션을 시작하면 CONFLICT — 뺏지 않고 --force 를 가리킨다', async () => {
    const { repo, home, root, cleanup } = await attached()
    try {
      issue(repo, home, 'S-20260913-01', '첫 번째')
      assert.equal(run(repo, home, ['work', 'start', '--session', 'S-20260913-01'], RUN_A).code, 0)
      const other = run(repo, home, ['work', 'start', '--session', 'S-20260913-01', '--json'], RUN_B)
      assert.equal(other.code, 1)
      const outcome = JSON.parse(other.stdout) as { binding: { state: string; holder: { physicalSessionId: string } } }
      assert.equal(outcome.binding.state, 'CONFLICT')
      assert.equal(outcome.binding.holder.physicalSessionId, RUN_A)
      assert.match(other.stderr, /--force/)
      const holder = JSON.parse(await readFile(bindingFile(root, 'S-20260913-01'), 'utf8')) as { value: string }
      assert.equal((JSON.parse(holder.value) as { physicalSessionId: string }).physicalSessionId, RUN_A, '기존 소유자 무변경')
    } finally {
      await cleanup()
    }
  })

  it('Claude Run 밖이면 NO_RUN — 결합을 만들지 않고, 성공으로 끝난다', async () => {
    const { repo, home, root, cleanup } = await attached()
    try {
      issue(repo, home, 'S-20260913-01', '첫 번째')
      const started = run(repo, home, ['work', 'start', '--session', 'S-20260913-01', '--json'], undefined)
      assert.equal(started.code, 0, started.stderr)
      const outcome = JSON.parse(started.stdout) as { kind: string; binding: { state: string } }
      assert.equal(outcome.kind, 'STARTED')
      assert.deepEqual(outcome.binding, { state: 'NO_RUN' })
      assert.equal(await exists(bindingFile(root, 'S-20260913-01')), false)

      const text = run(repo, home, ['work', 'start', '--session', 'S-20260913-01'], '')
      assert.match(text.stdout, /run binding: skipped/)
    } finally {
      await cleanup()
    }
  })

  it('finish 는 --physical 없이도 이 Run 의 소유권을 놓는다 — 그 뒤 같은 Run 이 다음 세션을 잡는다', async () => {
    const { repo, home, root, cleanup } = await attached()
    try {
      issue(repo, home, 'S-20260913-01', '첫 번째')
      assert.equal(run(repo, home, ['work', 'start', '--session', 'S-20260913-01'], RUN_A).code, 0)

      const finished = run(
        repo,
        home,
        ['work', 'finish', 'S-20260913-01', '--verified', '검증했다', '--next', '다음', '--as', 'colosair'],
        RUN_A,
      )
      assert.equal(finished.code, 0, finished.stderr)
      assert.match(finished.stdout, /ownership released/)
      assert.equal(await exists(bindingFile(root, 'S-20260913-01')), false)

      issue(repo, home, 'S-20260913-02', '두 번째')
      const next = run(repo, home, ['work', 'start', '--session', 'S-20260913-02', '--json'], RUN_A)
      assert.equal(next.code, 0, next.stderr)
      assert.equal((JSON.parse(next.stdout) as { binding: { state: string } }).binding.state, 'CLAIMED')
    } finally {
      await cleanup()
    }
  })

  it('progress report 도 --physical 없이 이 Run 으로 기록한다', async () => {
    const { repo, home, cleanup } = await attached()
    try {
      issue(repo, home, 'S-20260913-01', '첫 번째')
      assert.equal(run(repo, home, ['work', 'start', '--session', 'S-20260913-01'], RUN_A).code, 0)
      const reported = run(repo, home, ['progress', 'report', 'S-20260913-01', '--phase', '구현 중', '--next', '테스트'], RUN_A)
      assert.equal(reported.code, 0, reported.stderr)
      // Run 밖에서는 여전히 요구한다 — 없는 값을 지어내지 않는다
      const outside = run(repo, home, ['progress', 'report', 'S-20260913-01', '--phase', '구현 중'], undefined)
      assert.equal(outside.code, 2)
      assert.match(outside.stderr, /--physical/)
    } finally {
      await cleanup()
    }
  })

  it('명시한 --physical 이 관측값보다 우선한다', async () => {
    const { repo, home, root, cleanup } = await attached()
    try {
      issue(repo, home, 'S-20260913-01', '첫 번째')
      assert.equal(run(repo, home, ['session', 'start', 'S-20260913-01'], undefined).code, 0)
      const bound = run(repo, home, ['host', 'claude', 'bind', 'S-20260913-01', '--physical', RUN_B], RUN_A)
      assert.equal(bound.code, 0, bound.stderr)
      assert.match(bound.stdout, /다른 Run 이다/)
      const holder = JSON.parse(await readFile(bindingFile(root, 'S-20260913-01'), 'utf8')) as { value: string }
      assert.equal((JSON.parse(holder.value) as { physicalSessionId: string }).physicalSessionId, RUN_B)
    } finally {
      await cleanup()
    }
  })

  it('status 가 이 Run 이 쥔 세션을 그렇게 말한다', async () => {
    const { repo, home, cleanup } = await attached()
    try {
      issue(repo, home, 'S-20260913-01', '첫 번째')
      assert.equal(run(repo, home, ['work', 'start', '--session', 'S-20260913-01'], RUN_A).code, 0)
      const mine = run(repo, home, ['status'], RUN_A)
      assert.match(mine.stdout, /S-20260913-01 ACTIVE[^\n]*held by this Run/)
      const theirs = run(repo, home, ['status', '--json'], RUN_B)
      const parsed = JSON.parse(theirs.stdout) as { work: { id: string; heldBy?: string }[] }
      assert.equal(parsed.work.find((w) => w.id === 'S-20260913-01')?.heldBy, RUN_A)
    } finally {
      await cleanup()
    }
  })
})
