// B-20 Gate — 프로젝트 마무리 의무가 세션이 archive된 뒤에도 살아남는지.
//
// 이 Block의 존재 이유가 "미완료 사실이 조용히 사라지는 것"을 막는 것이라,
// 가장 중요한 검사는 **두 번째·세 번째 회수에서도 여전히 보이는가**다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { Handoff, Session } from '../core/model/entities.ts'
import { ClosureLedger, pendingLines } from '../core/runtime/closure.ts'
import { ProjectProfile } from '../schemas/profile.ts'
import { collectSessions } from '../core/runtime/controller.ts'

const NOW = '2026-08-23T21:00:00+09:00'
const CHECKLIST = ['tasks-synced', 'backlog-updated', 'worklog-recorded']

function ledgerOn(store: MemoryStateStore, now = NOW) {
  return new ClosureLedger(store.scope('closure'), () => now)
}

const handoff = () =>
  Handoff.parse({
    done: ['구현'],
    verified: 'self-check: 테스트 통과',
    next: '없음',
    recordedAt: NOW,
  })

async function doneSession(store: MemoryStateStore, id: string): Promise<void> {
  const created = await store.create(
    'session',
    Session.parse({
      id,
      version: 0,
      status: 'DONE',
      role: 'implementer',
      goal: '마무리 확인용',
      canonicalSources: [],
      handoff: handoff(),
    }),
  )
  assert.equal(created.ok, true)
}

const collect = (store: MemoryStateStore, checklist: readonly string[] = CHECKLIST) =>
  collectSessions(store, NOW, { closureChecklist: checklist, closureLedger: ledgerOn(store) })

describe('B-20 Gate — 선언과 표면화', () => {
  it('선언된 항목이 확인되지 않은 채 세션이 닫히면 판단 목록에 올라온다', async () => {
    const store = new MemoryStateStore()
    await doneSession(store, 'S-20260823-01')

    const outcome = await collect(store)

    const closureLines = outcome.awaiting.filter((l) => l.includes('마무리 미확인'))
    assert.equal(closureLines.length, 3)
    for (const item of CHECKLIST) {
      assert.ok(closureLines.some((l) => l.endsWith(item)), `${item} 이 표면화되지 않았다`)
    }
  })

  it('선언이 없는 프로젝트에는 의무를 지우지 않는다', async () => {
    const store = new MemoryStateStore()
    await doneSession(store, 'S-20260823-01')

    const outcome = await collect(store, [])

    assert.deepEqual(outcome.awaiting.filter((l) => l.includes('마무리')), [])
    assert.equal(await ledgerOn(store).get('S-20260823-01'), null)
  })

  it('closure ledger를 넘기지 않으면 기존 collect와 똑같이 동작한다', async () => {
    const store = new MemoryStateStore()
    await doneSession(store, 'S-20260823-01')

    const outcome = await collectSessions(store, NOW)

    assert.deepEqual(outcome.awaiting, [])
    assert.deepEqual(outcome.collected, ['S-20260823-01'])
  })
})

describe('B-20 Gate — archive 이후에도 살아남는다 (이 Block의 핵심)', () => {
  it('두 번째·세 번째 회수에서도 미확인 항목이 계속 보인다', async () => {
    const store = new MemoryStateStore()
    await doneSession(store, 'S-20260823-01')

    const first = await collect(store)
    assert.equal(first.collected.length, 1)
    // 세션은 archive로 갔다 — 다음 회수의 목록에 없다
    assert.deepEqual((await store.list('session')).map((s) => s.id), [])

    const second = await collect(store)
    const third = await collect(store)

    assert.equal(second.collected.length, 0, '두 번째 회수가 같은 세션을 또 거뒀다')
    assert.equal(second.awaiting.filter((l) => l.includes('마무리 미확인')).length, 3)
    assert.equal(third.awaiting.filter((l) => l.includes('마무리 미확인')).length, 3)
  })

  it('재회수가 이미 확인한 항목을 되돌리지 않는다', async () => {
    const store = new MemoryStateStore()
    await doneSession(store, 'S-20260823-01')
    await collect(store)

    const confirmed = await ledgerOn(store).confirm('S-20260823-01', ['tasks-synced'])
    assert.equal(confirmed.ok, true)

    const after = await collect(store)

    const lines = after.awaiting.filter((l) => l.includes('마무리 미확인'))
    assert.equal(lines.length, 2, 'setIfAbsent가 아니면 확인이 덮인다')
    assert.ok(!lines.some((l) => l.endsWith('tasks-synced')))
    assert.deepEqual((await ledgerOn(store).get('S-20260823-01'))?.confirmed, ['tasks-synced'])
  })
})

describe('B-20 Gate — 확인은 typed input만', () => {
  it('선언에 없는 항목은 거부한다 — 오타를 삼키지 않는다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.open('S-20260823-01', CHECKLIST)

    const outcome = await ledger.confirm('S-20260823-01', ['tasks-sync']) // 오타

    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.reason, 'UNKNOWN_ITEM')
    assert.deepEqual((await ledger.get('S-20260823-01'))?.confirmed, [])
  })

  it('부분 일치·대소문자 차이는 확인이 아니다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.open('S-20260823-01', CHECKLIST)

    for (const attempt of ['tasks', 'TASKS-SYNCED', 'tasks-synced ', ' tasks-synced']) {
      const outcome = await ledger.confirm('S-20260823-01', [attempt])
      assert.equal(outcome.ok, false, `'${attempt}' 가 통과했다`)
    }
    assert.deepEqual((await ledger.get('S-20260823-01'))?.confirmed, [])
  })

  it('Handoff 텍스트가 항목 이름을 포함해도 확인으로 치지 않는다', async () => {
    const store = new MemoryStateStore()
    const created = await store.create(
      'session',
      Session.parse({
        id: 'S-20260823-01',
        version: 0,
        status: 'DONE',
        role: 'implementer',
        goal: '마무리',
        canonicalSources: [],
        handoff: Handoff.parse({
          // 사람이 자연어로 "다 했다"고 써도 확인이 아니다
          done: ['tasks-synced 완료', 'backlog-updated 반영함', 'worklog-recorded 기록'],
          verified: 'tasks-synced, backlog-updated, worklog-recorded 전부 처리',
          next: '없음',
          recordedAt: NOW,
        }),
      }),
    )
    assert.equal(created.ok, true)

    const outcome = await collect(store)

    assert.equal(outcome.awaiting.filter((l) => l.includes('마무리 미확인')).length, 3)
  })

  it('열린 기록이 없으면 확인할 수 없다', async () => {
    const outcome = await ledgerOn(new MemoryStateStore()).confirm('S-20260823-01', ['tasks-synced'])
    assert.equal(outcome.ok === false && outcome.reason, 'NOT_FOUND')
  })
})

describe('B-20 Gate — 동시 확인 (하드닝)', () => {
  it('서로 다른 항목을 동시에 확인해도 둘 다 남는다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.open('S-20260823-01', CHECKLIST)

    // read-modify-write였다면 나중에 쓴 쪽이 앞의 확인을 덮는다
    await Promise.all([
      ledger.confirm('S-20260823-01', ['tasks-synced']),
      ledger.confirm('S-20260823-01', ['backlog-updated']),
    ])

    const record = await ledger.get('S-20260823-01')
    assert.deepEqual(record?.confirmed, ['tasks-synced', 'backlog-updated'])
  })

  it('마지막 항목들을 동시에 확인해도 닫힘은 정확히 한 번 보고된다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.open('S-20260823-01', ['a', 'b'])

    const outcomes = await Promise.all([
      ledger.confirm('S-20260823-01', ['a']),
      ledger.confirm('S-20260823-01', ['b']),
    ])

    const closedReports = outcomes.filter((o) => o.ok === true && o.newlyClosed)
    assert.equal(closedReports.length, 1, '닫힘 전이가 두 번 보고됐다')
    assert.ok((await ledger.get('S-20260823-01'))?.closedAt)
  })

  it('같은 항목을 동시에 확인해도 처음 것만 남는다', async () => {
    const store = new MemoryStateStore()
    const ledger = new ClosureLedger(store.scope('closure'), () => NOW)
    await ledger.open('S-20260823-01', CHECKLIST)

    await Promise.all([
      ledger.confirm('S-20260823-01', ['tasks-synced']),
      ledger.confirm('S-20260823-01', ['tasks-synced']),
    ])

    assert.deepEqual((await ledger.get('S-20260823-01'))?.confirmed, ['tasks-synced'])
  })

  it('확인 순서와 무관하게 선언 순서로 보인다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.open('S-20260823-01', CHECKLIST)

    await ledger.confirm('S-20260823-01', ['worklog-recorded'])
    await ledger.confirm('S-20260823-01', ['tasks-synced'])

    assert.deepEqual((await ledger.get('S-20260823-01'))?.confirmed, ['tasks-synced', 'worklog-recorded'])
  })
})

describe('B-20 Gate — 항목 id 문법', () => {
  it('파일명이 겹칠 수 있는 id는 선언 단계에서 거부한다', async () => {
    const ledger = ledgerOn(new MemoryStateStore())
    // `a:b` 와 `a-b` 는 같은 파일이 된다 — 통과시키면 "이미 확인됨"으로 오판한다
    await assert.rejects(
      () => ledger.open('S-20260823-01', ['tasks:synced']),
      /쓸 수 없는 값/,
    )
  })

  it('Profile 스키마가 선언 입구에서 먼저 막는다', () => {
    const bad = {
      schemaVersion: 1 as const,
      id: 'bad-profile',
      project: { scm: 'github', repository: 'o/r' },
      policy: { unionLists: { closureChecklist: ['tasks synced'] } },
    }
    assert.throws(() => ProjectProfile.parse(bad), /마무리 항목 id로 쓸 수 없다/)
  })

  it('올바른 형식은 통과한다', () => {
    const good = {
      schemaVersion: 1 as const,
      id: 'good-profile',
      project: { scm: 'github', repository: 'o/r' },
      policy: { unionLists: { closureChecklist: [...CHECKLIST, 'a.b_c-1'] } },
    }
    assert.deepEqual(ProjectProfile.parse(good).policy.unionLists?.closureChecklist, [...CHECKLIST, 'a.b_c-1'])
  })

  it('확인 단계에서도 형식을 본다', async () => {
    const ledger = ledgerOn(new MemoryStateStore())
    await ledger.open('S-20260823-01', CHECKLIST)
    const outcome = await ledger.confirm('S-20260823-01', ['tasks:synced'])
    assert.equal(outcome.ok === false && outcome.reason, 'INVALID_ITEM_ID')
  })
})

describe('B-20 Gate — 닫힘', () => {
  it('전부 확인되면 닫히고 판단 목록에서 빠진다 — 기록은 남는다', async () => {
    const store = new MemoryStateStore()
    await doneSession(store, 'S-20260823-01')
    await collect(store)

    const outcome = await ledgerOn(store).confirm('S-20260823-01', CHECKLIST)
    assert.equal(outcome.ok, true)
    assert.equal(outcome.ok === true && outcome.newlyClosed, true)

    const after = await collect(store)
    assert.deepEqual(after.awaiting.filter((l) => l.includes('마무리')), [])

    // 삭제가 아니다 — 무엇을 닫았는지가 남아야 기록이다
    const record = await ledgerOn(store).get('S-20260823-01')
    assert.ok(record?.closedAt)
    assert.deepEqual(record?.confirmed.sort(), [...CHECKLIST].sort())
  })

  it('이미 닫힌 것을 다시 확인해도 newlyClosed는 한 번뿐이다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.open('S-20260823-01', ['a'])

    const first = await ledger.confirm('S-20260823-01', ['a'])
    const second = await ledger.confirm('S-20260823-01', ['a'])

    assert.equal(first.ok === true && first.newlyClosed, true)
    assert.equal(second.ok === true && second.newlyClosed, false)
  })
})

describe('B-20 Gate — 경계', () => {
  it('강제 차단하지 않는다 — 미확인이 있어도 회수·archive는 그대로 진행된다', async () => {
    const store = new MemoryStateStore()
    await doneSession(store, 'S-20260823-01')

    const outcome = await collect(store)

    assert.deepEqual(outcome.collected, ['S-20260823-01'])
    assert.deepEqual((await store.list('session')).map((s) => s.id), [], 'archive가 막혔다')
  })

  it('Session entity를 건드리지 않는다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await doneSession(store, 'S-20260823-01')
    const before = await store.get('session', 'S-20260823-01')

    await ledger.open('S-20260823-01', CHECKLIST)
    await ledger.confirm('S-20260823-01', ['tasks-synced'])

    assert.deepEqual(await store.get('session', 'S-20260823-01'), before)
  })

  it('선언 스냅샷은 Profile이 나중에 바뀌어도 흔들리지 않는다', async () => {
    const store = new MemoryStateStore()
    await doneSession(store, 'S-20260823-01')
    await collect(store, CHECKLIST)

    // Profile에서 항목을 지운 뒤 다시 회수해도, 그 세션이 지고 있던 의무는 그대로다
    const after = await collect(store, ['completely-different'])

    assert.deepEqual((await ledgerOn(store).get('S-20260823-01'))?.declared, CHECKLIST)
    assert.equal(after.awaiting.filter((l) => l.includes('마무리 미확인')).length, 3)
  })

  it('pendingLines는 미확인만 낸다', () => {
    const lines = pendingLines([
      {
        logicalSessionId: 'S-20260823-01',
        declared: ['a', 'b'],
        confirmed: ['a'],
        openedAt: NOW,
      },
    ])
    assert.deepEqual(lines, ['S-20260823-01: 마무리 미확인 — b'])
  })
})
