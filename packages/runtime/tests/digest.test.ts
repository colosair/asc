// B-33 Gate — 감지와 방해가 분리되는지, 그리고 채널이 없어도 판단 요청이 사라지지 않는지.
//
// 이 Block이 지켜야 할 두 가지:
//   ① Digest는 새 Request를 만들지 않는다 — 같은 요청의 또 하나의 표현이다
//   ② 채널이 전부 실패해도 Local이 받는다

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { FixturePresentation } from '../adapters/memory/mocks.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { LocalPresentation } from '../adapters/local/presentation.ts'
import { DeliveryLedger, deliver, planDigest, renderDigest } from '../core/presentation/digest.ts'
import type { DecisionSummary } from '../core/view/decision-view.ts'

const AT = '2026-08-26T10:30:00+09:00'

const summary = (over: Partial<DecisionSummary> & { requestId: string }): DecisionSummary => ({
  reference: 'o/r#19',
  version: 0,
  freshness: 'CURRENT',
  status: 'AWAITING_APPROVAL',
  priority: 'P1',
  title: '계약 해석 확인',
  detectedAt: '2026-08-26T09:00:00+09:00',
  ...over,
})

describe('B-33 Gate — P0 즉시 / P1·P2 배치 (C-08 §2)', () => {
  it('급한 것만 따로 세우고 나머지는 묶는다', () => {
    const plan = planDigest({
      at: AT,
      pending: [
        summary({ requestId: 'REQ-0001', priority: 'P0' }),
        summary({ requestId: 'REQ-0002', priority: 'P1' }),
        summary({ requestId: 'REQ-0003', priority: 'P2' }),
      ],
    })
    assert.deepEqual(plan.urgent.map((i) => i.requestId), ['REQ-0001'])
    assert.deepEqual(plan.batch.groups.map((g) => g.priority), ['P0', 'P1', 'P2'])
  })

  it('이미 결정된 것은 판단 요청이 아니다 — 숫자로만 남는다', () => {
    const plan = planDigest({
      at: AT,
      pending: [summary({ requestId: 'REQ-0001', freshness: 'ALREADY_DECIDED' })],
    })
    assert.deepEqual(plan.batch.groups, [])
    assert.equal(plan.skipped.alreadyDecided, 1)
    assert.match(renderDigest(plan).join('\n'), /이미 결정됨 1/)
  })

  it('같은 판을 두 번 묶어 보내지 않는다', () => {
    const delivered = new Map([['REQ-0001', 0]])
    const plan = planDigest({ at: AT, pending: [summary({ requestId: 'REQ-0001', version: 0 })], delivered })
    assert.equal(plan.skipped.alreadyDelivered, 1)
    assert.deepEqual(plan.batch.groups, [])
  })

  it('바뀌었으면 다시 보낸다 — 그건 새 사실이다', () => {
    const delivered = new Map([['REQ-0001', 0]])
    const plan = planDigest({ at: AT, pending: [summary({ requestId: 'REQ-0001', version: 1 })], delivered })
    assert.equal(plan.skipped.alreadyDelivered, 0)
    assert.equal(plan.batch.groups[0]?.items.length, 1)
  })

  it('숨긴 것과 회수 경로 발견을 숫자로 남긴다 — 0으로 감추지 않는다', () => {
    const plan = planDigest({ at: AT, pending: [], shadowCount: 14, recoveredCount: 2 })
    const text = renderDigest(plan).join('\n')
    assert.match(text, /숨김 14/)
    assert.match(text, /회수 경로에서 발견 2/)
    assert.match(text, /건넬 것이 없다/)
  })

  it('묶은 뒤 변한 것은 freshness 4종으로 말한다 — 새 값을 만들지 않는다', () => {
    const plan = planDigest({ at: AT, pending: [summary({ requestId: 'REQ-0001', freshness: 'SOURCE_CHANGED' })] })
    assert.match(renderDigest(plan).join('\n'), /\(SOURCE_CHANGED\)/)
  })

  it('간격·주기 상수가 Core에 없다 (C-08 §2.3)', async () => {
    const source = await readFile(new URL('../core/presentation/digest.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\b(30|60)\s*\*\s*60|분마다|interval/i)
  })
})

describe('B-33 Gate — capability 기반 전달 (C-08 §1)', () => {
  it('능력이 없으면 그 기능만 내려가고 그 사실을 적는다', async () => {
    const digestOnly = new FixturePresentation('mail-like', ['presentation.digest'])
    const plan = planDigest({ at: AT, pending: [summary({ requestId: 'REQ-0001', priority: 'P0' })] })

    const report = await deliver(plan, digestOnly)
    assert.equal(report.urgent.length, 0)
    assert.match(report.degraded.join('\n'), /급한 건을 따로 전달하지 못한다/)
    // 묶음에는 실렸다 — 조용히 사라지지 않는다
    assert.equal(digestOnly.digests[0]?.groups[0]?.items[0]?.requestId, 'REQ-0001')
  })

  it('묶음도 못 보내는 채널이면 그것도 말한다', async () => {
    const decideOnly = new FixturePresentation('decide-only', ['approval.interactive'])
    const plan = planDigest({ at: AT, pending: [summary({ requestId: 'REQ-0001' })] })
    const report = await deliver(plan, decideOnly)
    assert.match(report.degraded.join('\n'), /묶음을 전달하지 못한다/)
    assert.equal(report.digest, undefined)
  })

  it('전달이 실패해도 canonical state는 그대로다 (best-effort)', async () => {
    const store = new MemoryStateStore()
    const broken = new FixturePresentation('broken', ['presentation.digest'])
    broken.failWith = '채널에 닿지 못했다'

    const ledger = new DeliveryLedger(store.scope('presentation'), () => AT)
    const plan = planDigest({ at: AT, pending: [summary({ requestId: 'REQ-0001' })] })
    const report = await deliver(plan, broken, ledger)

    assert.equal(report.digest?.ok, false)
    // 실패한 전달은 기록하지 않는다 — 다음에 다시 보내야 한다
    assert.equal((await ledger.delivered('broken')).size, 0)
    assert.equal((await store.list('request')).length, 0)
  })

  it('Local은 세 능력을 다 갖는다 — 마지막 안전망이다', async () => {
    const lines: string[] = []
    const local = new LocalPresentation({ write: (line) => lines.push(line) })
    assert.ok(local.capabilities.has('presentation.digest'))
    assert.ok(local.capabilities.has('presentation.priority'))
    assert.ok(local.capabilities.has('approval.interactive'))

    const plan = planDigest({ at: AT, pending: [summary({ requestId: 'REQ-0001', priority: 'P0' })] })
    const report = await deliver(plan, local)
    assert.equal(report.digest?.ok, true)
    assert.equal(report.urgent[0]?.outcome.ok, true)
    assert.match(lines.join('\n'), /🔴 REQ-0001/)
  })

  it('보낸 것을 채널별로 기록한다 — 같은 요청, 여러 표현', async () => {
    const store = new MemoryStateStore()
    const ledger = new DeliveryLedger(store.scope('presentation'), () => AT)
    const a = new FixturePresentation('channel-a', ['presentation.digest'])
    const b = new FixturePresentation('channel-b', ['presentation.digest'])
    const plan = planDigest({ at: AT, pending: [summary({ requestId: 'REQ-0001' })] })

    await deliver(plan, a, ledger)
    await deliver(plan, b, ledger)

    assert.equal((await ledger.delivered('channel-a')).get('REQ-0001'), 0)
    assert.equal((await ledger.delivered('channel-b')).get('REQ-0001'), 0)
    // 새 request는 생기지 않는다 (C-08 §3.1)
    assert.equal((await store.list('request')).length, 0)
  })
})

describe('B-33 Gate — 경계 (C-08 §2.1·§4)', () => {
  it('Digest는 새 Request를 만들지 않는다', async () => {
    const source = await readFile(new URL('../core/presentation/digest.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /create\('request'/)
    assert.doesNotMatch(source, /ApprovalRequest/)
  })

  it('digest 경로에 결정 제출 표면이 없다', async () => {
    for (const file of ['../core/presentation/digest.ts', '../adapters/local/presentation.ts']) {
      const source = await readFile(new URL(file, import.meta.url), 'utf8')
      assert.doesNotMatch(source, /submitDecision|ApprovalDecision/, file)
    }
  })

  it('Monitor에 전달 코드 경로가 없다 (OM §10.7 write 경계)', async () => {
    for (const name of await readdir(new URL('../core/monitor/', import.meta.url))) {
      if (!name.endsWith('.ts')) continue
      const source = await readFile(new URL(`../core/monitor/${name}`, import.meta.url), 'utf8')
      assert.doesNotMatch(source, /presentDigest|presentUrgent|PresentationPort/, join('core/monitor', name))
    }
  })

  it('Core는 채널 제품을 모른다', async () => {
    const source = await readFile(new URL('../core/presentation/digest.ts', import.meta.url), 'utf8')
    for (const word of ['mattermost', 'slack', 'teams', 'email']) {
      assert.doesNotMatch(source.toLowerCase(), new RegExp(word))
    }
  })
})
