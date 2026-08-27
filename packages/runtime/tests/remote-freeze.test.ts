// B-58 Gate — 원격을 얼려도 로컬은 돈다. 녹여도 자동으로 나가지 않는다 (지시 §27).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { hookScript } from '../adapters/claude-code/guard.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { FreezeLedger, freezeLines, judgeAction, type FreezePolicy } from '../core/policy/remote-freeze.ts'

const NOW = '2026-08-26T21:00:00+09:00'

const ledgerOn = (store: MemoryStateStore) => new FreezeLedger(store.scope('policy'), () => NOW)

const policy = (over: Partial<FreezePolicy> = {}): FreezePolicy => ({
  frozen: true,
  since: NOW,
  reason: '원격 반영 금지 기간',
  denyRemoteRead: false,
  ...over,
})

describe('B-58 Gate — 무엇을 얼리고 무엇을 얼리지 않는가', () => {
  it('얼지 않았으면 전부 통과한다', () => {
    const open = policy({ frozen: false })
    for (const action of ['remote.read', 'remote.write', 'local.implement'] as const) {
      assert.equal(judgeAction(open, action).decision, 'ALLOW', action)
    }
  })

  it('원격 쓰기는 버리지 않고 미룬다', () => {
    const verdict = judgeAction(policy(), 'remote.write')
    assert.equal(verdict.decision, 'DEFER', '해야 할 일이지만 지금은 아니다')
    assert.match(verdict.detail, /원격 반영 금지 기간/)
  })

  it('로컬 작업은 얼리지 않는다 — 안 쓰이는 안전장치는 안전장치가 아니다', () => {
    for (const action of ['local.inspect', 'local.implement', 'local.test'] as const) {
      assert.equal(judgeAction(policy(), action).decision, 'ALLOW', action)
    }
  })

  it('읽기는 기본 허용이고 완전 오프라인일 때만 막힌다', () => {
    assert.equal(judgeAction(policy(), 'remote.read').decision, 'ALLOW')
    assert.equal(judgeAction(policy({ denyRemoteRead: true }), 'remote.read').decision, 'DENY')
  })
})

describe('B-58 Gate — 미룬 것은 녹여도 자동으로 나가지 않는다', () => {
  it('얼릴 때 이유가 남는다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)

    const frozen = await ledger.freeze('릴리스 동결')
    assert.equal(frozen.frozen, true)
    assert.equal(frozen.reason, '릴리스 동결')
    assert.equal(frozen.since, NOW)
  })

  it('미뤄 둔 것이 녹인 뒤에도 남고, 실행되지 않는다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.freeze('동결')
    await ledger.defer({
      id: 'push-1',
      action: 'remote.write',
      intent: 'main 에 push',
      basis: ['G-0007 승인'],
      grantRef: 'G-0007',
    })

    const { policy: thawed, deferred } = await ledger.thaw()
    assert.equal(thawed.frozen, false)
    assert.equal(deferred.length, 1, '녹였다고 목록이 비지 않는다')
    assert.equal(deferred[0]!.intent, 'main 에 push')
    assert.deepEqual(deferred[0]!.basis, ['G-0007 승인'])
  })

  it('사람이 다시 판단해 뺄 때까지 남는다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.defer({ id: 'push-1', action: 'remote.write', intent: 'push', basis: [] })

    assert.equal(await ledger.release('push-1'), true)
    assert.deepEqual(await ledger.deferred(), [])
    assert.equal(await ledger.release('push-1'), false, '없는 것을 뺐다고 하지 않는다')
  })

  it('같은 것을 두 번 미뤘다고 적지 않는다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.defer({ id: 'push-1', action: 'remote.write', intent: 'push', basis: [] })
    assert.equal(await ledger.defer({ id: 'push-1', action: 'remote.write', intent: '다른 의도', basis: [] }), false)
    assert.equal((await ledger.deferred())[0]!.intent, 'push', '먼저 적힌 것이 남는다')
  })

  it('사람이 읽는 줄이 다시 확인하라고 말한다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.freeze('동결')
    await ledger.defer({ id: 'push-1', action: 'remote.write', intent: 'push', basis: ['G-0007'] })

    const rendered = freezeLines(await ledger.policy(), await ledger.deferred()).join('\n')
    assert.match(rendered, /자동으로 나가지 않는다/)
    assert.match(rendered, /아직 유효한지 보라/)
  })
})

describe('B-58 Gate — guard는 완전 오프라인일 때만 읽기를 막는다', () => {
  async function scratch(freeze: FreezePolicy | null) {
    const base = await mkdtemp(join(tmpdir(), 'asc-freeze-'))
    const ascRoot = join(base, 'project', '.asc')
    const bindingDir = join(ascRoot, 'adapters', 'claude-code')
    await mkdir(bindingDir, { recursive: true })
    await writeFile(
      join(bindingDir, 'runtime-binding-S-1.json'),
      JSON.stringify({
        key: 'runtime-binding:S-1',
        value: JSON.stringify({
          logicalSessionId: 'S-1',
          provider: 'claude-code',
          physicalSessionId: 'phys-1',
          updatedAt: NOW,
        }),
      }),
      'utf8',
    )
    if (freeze) {
      const policyDir = join(ascRoot, 'adapters', 'policy')
      await mkdir(policyDir, { recursive: true })
      await writeFile(
        join(policyDir, 'freeze-policy.json'),
        JSON.stringify({ key: 'freeze-policy', value: JSON.stringify(freeze) }),
        'utf8',
      )
    }
    const hook = join(base, 'guard.mjs')
    await writeFile(hook, hookScript(), 'utf8')
    return { base, cwd: join(base, 'project'), hook, cleanup: () => rm(base, { recursive: true, force: true }) }
  }

  const run = (hook: string, cwd: string, command: string) => {
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: 'Bash', session_id: 'phys-1', cwd, tool_input: { command } }),
      encoding: 'utf8',
      env: { ...process.env, ASC_HOME: join(cwd, '..', 'no-home') },
    })
    return { code: result.status ?? 1, stderr: result.stderr ?? '' }
  }

  it('평소에는 원격 읽기를 막지 않는다', async () => {
    const { cwd, hook, cleanup } = await scratch(null)
    try {
      assert.equal(run(hook, cwd, 'git fetch origin').code, 0)
    } finally {
      await cleanup()
    }
  })

  it('쓰기만 얼린 상태에서도 읽기는 통과한다', async () => {
    const { cwd, hook, cleanup } = await scratch(policy())
    try {
      assert.equal(run(hook, cwd, 'git fetch origin').code, 0, '조사까지 멈추면 아무도 freeze를 안 쓴다')
    } finally {
      await cleanup()
    }
  })

  it('완전 오프라인이면 원격 읽기를 막고 이유를 말한다', async () => {
    const { cwd, hook, cleanup } = await scratch(policy({ denyRemoteRead: true, reason: '망 분리' }))
    try {
      const blocked = run(hook, cwd, 'git fetch origin')
      assert.equal(blocked.code, 2)
      assert.match(blocked.stderr, /완전 오프라인/)
      assert.match(blocked.stderr, /망 분리/)
      assert.match(blocked.stderr, /asc thaw/)
    } finally {
      await cleanup()
    }
  })

  it('완전 오프라인이어도 로컬 명령은 그대로 된다', async () => {
    const { cwd, hook, cleanup } = await scratch(policy({ denyRemoteRead: true }))
    try {
      assert.equal(run(hook, cwd, 'npm test').code, 0)
      assert.equal(run(hook, cwd, 'git status').code, 0)
      assert.equal(run(hook, cwd, 'git commit -m "wip"').code, 0)
    } finally {
      await cleanup()
    }
  })

  it('얼지 않아도 원격 쓰기는 여전히 막힌다 — 기존 차단이 약해지지 않는다', async () => {
    const { cwd, hook, cleanup } = await scratch(null)
    try {
      assert.equal(run(hook, cwd, 'git push origin main').code, 2)
    } finally {
      await cleanup()
    }
  })
})
