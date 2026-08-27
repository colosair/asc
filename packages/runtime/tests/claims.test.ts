// B-56 Gate — 뒤집힌 판단을 지우지 않는다 (C-10 §6).
//
// 실전 사고의 형태: 어느 시점에 "A가 B를 막고 있다"고 봤고 나중에 아니었음이 드러났는데,
// 기록이 통째로 다시 쓰여 **언제 무엇을 근거로 그렇게 봤는지가 사라졌다.** 그러면 같은
// 오판을 또 한다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { ClaimLedger, claimLines } from '../core/runtime/claims.ts'

const NOW = '2026-08-26T21:00:00+09:00'
const LATER = '2026-08-27T09:00:00+09:00'

const ledgerOn = (store: MemoryStateStore, now = NOW) => new ClaimLedger(store.scope('claims'), () => now)

describe('B-56 Gate — 사실과 추론을 갈라 적는다', () => {
  it('네 상태를 구분해 적는다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)

    await ledger.record({ claimId: 'c-1', statement: '테스트 830건 통과', status: 'CONFIRMED', evidenceRefs: ['npm test'] })
    await ledger.record({ claimId: 'c-2', statement: 'B가 A를 막고 있다', status: 'INFERRED' })
    await ledger.record({ claimId: 'c-3', statement: '실서버 자격 유효 여부', status: 'PENDING' })

    const current = await ledger.current()
    assert.deepEqual(current.map((c) => c.status), ['CONFIRMED', 'INFERRED', 'PENDING'])
  })

  it('근거가 없으면 없다고 보인다 — 추론을 확인처럼 보이게 하지 않는다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.record({ claimId: 'c-1', statement: 'B가 A를 막고 있다', status: 'INFERRED' })

    const [line] = claimLines(await ledger.current())
    assert.match(line!, /추론/)
    assert.match(line!, /근거 없음/)
  })

  it('같은 id를 덮어쓰지 않는다 — 덮어쓰기가 곧 다시 쓰기다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.record({ claimId: 'c-1', statement: '처음 판단', status: 'INFERRED' })

    const again = await ledger.record({ claimId: 'c-1', statement: '바뀐 판단', status: 'CONFIRMED' })
    assert.equal(again.ok, false)
    if (again.ok) return
    assert.equal(again.reason, 'DUPLICATE_ID')
    assert.equal((await ledger.get('c-1'))!.statement, '처음 판단')
  })

  it('파일명으로 뭉개질 id는 받지 않는다', async () => {
    const store = new MemoryStateStore()
    const outcome = await ledgerOn(store).record({ claimId: 'a:b', statement: 'x', status: 'PENDING' })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.reason, 'INVALID_ID')
  })
})

describe('B-56 Gate — 뒤집혀도 지우지 않는다 (C-10 불변식 ⑫)', () => {
  async function reversed() {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.record({
      claimId: 'blocker-1',
      statement: 'B-37이 B-49를 막고 있다',
      status: 'INFERRED',
      evidenceRefs: ['roadmap 읽음'],
    })
    const outcome = await ledger.supersede({
      staleId: 'blocker-1',
      replacement: {
        claimId: 'blocker-2',
        statement: 'B-37은 B-49를 막지 않는다 — 자격만 다르다',
        status: 'CONFIRMED',
        evidenceRefs: ['의존 그래프 실측'],
      },
      reason: '실측으로 뒤집힘',
      at: LATER,
    })
    return { ledger, outcome }
  }

  it('옛 판단이 History에 남고 STALE로 표시된다', async () => {
    const { ledger, outcome } = await reversed()
    assert.equal(outcome.ok, true)

    const history = await ledger.history()
    assert.equal(history.length, 2, '지워지지 않는다')
    const stale = history.find((c) => c.claimId === 'blocker-1')!
    assert.equal(stale.status, 'STALE')
    assert.equal(stale.statement, 'B-37이 B-49를 막고 있다', '당시 문장 그대로다')
    assert.equal(stale.supersededBy, 'blocker-2')
    assert.match(stale.supersededReason!, /실측으로 뒤집힘/)
  })

  it('Current View에서는 빠진다 — projection이지 저장이 아니다', async () => {
    const { ledger } = await reversed()
    const current = await ledger.current()
    assert.deepEqual(current.map((c) => c.claimId), ['blocker-2'])
  })

  it('새 claim이 무엇을 대체했는지 들고 있다', async () => {
    const { ledger } = await reversed()
    assert.equal((await ledger.get('blocker-2'))!.supersedes, 'blocker-1')
  })

  it('없는 것을 뒤집었다고 적지 않는다', async () => {
    const store = new MemoryStateStore()
    const outcome = await ledgerOn(store).supersede({
      staleId: '없는-claim',
      replacement: { claimId: 'x-1', statement: 'x', status: 'CONFIRMED' },
      reason: 'r',
    })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.reason, 'NOT_FOUND')
  })

  it('두 번 뒤집었다고 적지 않는다', async () => {
    const { ledger } = await reversed()
    const again = await ledger.supersede({
      staleId: 'blocker-1',
      replacement: { claimId: 'blocker-3', statement: '또 다른 판단', status: 'INFERRED' },
      reason: '또',
    })
    assert.equal(again.ok, false)
    if (again.ok) return
    assert.equal(again.reason, 'ALREADY_STALE')
  })

  it('사람이 읽는 줄에 무엇이 무엇으로 뒤집혔는지 남는다', async () => {
    const { ledger } = await reversed()
    const rendered = claimLines(await ledger.history()).join('\n')
    assert.match(rendered, /뒤집힘/)
    assert.match(rendered, /blocker-1.*blocker-2/s)
    assert.match(rendered, /실측으로 뒤집힘/)
  })

  it('적힌 것이 없으면 없다고 말한다', () => {
    assert.deepEqual(claimLines([]), ['적힌 판단 없음'])
  })
})
