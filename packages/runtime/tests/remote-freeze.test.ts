// B-58 Gate — 원격을 얼려도 로컬은 돈다. 녹여도 자동으로 나가지 않는다 (지시 §27).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

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
