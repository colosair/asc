// B-30 Gate — "나를 불렀는가"와 "실제로 내 일인가"를 따로 판정하는지.
//
// 두 시나리오가 이 Block의 존재 이유다:
//   태깅 난사  나를 불렀는데 내 영역이 아니다 → 숨긴다 (버리지 않는다)
//   태깅 누락  안 불렀는데 내 영역이다       → 올린다

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { GENERIC_SIGNALS, classify, detectSignals } from '../core/monitor/signals.ts'
import { evaluateRelevance, renderRelevance } from '../core/monitor/relevance.ts'
import {
  ObservationLedger,
  fingerprintOf,
  shadowLines,
  type Fingerprint,
} from '../core/monitor/observation.ts'
import type { RawEvent } from '../ports/event-source.ts'

const NOW = '2026-08-26T10:00:00+09:00'

const OWNERSHIP = {
  frontend: { paths: ['web-frontend/**'], authorities: ['client-ui'] },
  backend: { paths: ['backend/**'], authorities: ['api-contract'] },
}

const MINE = { ownership: OWNERSHIP, myRoles: ['frontend'] }

describe('B-30 Gate — Signal ≠ Relevance (C-07 §2)', () => {
  it('신호 어휘는 10종 그대로다 — 관련성을 신호로 표현하지 않는다', () => {
    assert.equal(GENERIC_SIGNALS.length, 10)
  })

  it('관련성 판정은 신호 목록을 늘리지 않는다', () => {
    const relevance = evaluateRelevance(['mentioned_me'], {
      ...MINE,
      changedPaths: ['web-frontend/src/a.ts'],
    })
    // 결과는 두 축과 근거다. 새 signal 이름이 아니다.
    assert.equal(relevance.actual, 'HIGH')
    assert.ok(relevance.evidence.every((e) => !GENERIC_SIGNALS.includes(e.kind as never)))
  })
})

describe('B-30 Gate — 미이행 신호 이행 (C-07 §2.3)', () => {
  const event = (over: Partial<RawEvent> = {}): RawEvent => ({
    eventKey: 'comment:1',
    detectedAt: NOW,
    reference: 'org/repo#19',
    ...over,
  })

  it('direct_reply — 내 글에 달린 응답', () => {
    assert.deepEqual(detectSignals(event(), {}, { replyToMe: true }), ['direct_reply'])
    assert.deepEqual(detectSignals(event(), {}, {}), [])
  })

  it('active_canonical_changed — 정본이 이미 움직였다 (actual drift)', () => {
    assert.deepEqual(detectSignals(event(), {}, { canonicalChanged: true }), ['active_canonical_changed'])
  })

  it('open_change_touches_active_canonical — 열린 변경이 정본 영역을 건드린다 (potential drift)', () => {
    const signals = detectSignals(
      event(),
      {},
      { changedPaths: ['specs/api/auth.md'], canonicalPaths: ['specs/**'] },
    )
    assert.deepEqual(signals, ['open_change_touches_active_canonical'])
  })

  it('두 canonical 신호를 섞지 않는다 — "바뀌었다"와 "바뀔 수 있다"는 다르다', () => {
    const potential = detectSignals(
      event(),
      {},
      { changedPaths: ['specs/api/auth.md'], canonicalPaths: ['specs/**'] },
    )
    assert.ok(!potential.includes('active_canonical_changed'))

    const actual = detectSignals(event(), {}, { canonicalChanged: true })
    assert.ok(!actual.includes('open_change_touches_active_canonical'))
  })

  it('canonical paths와 ownership paths를 섞지 않는다 (C-07 §2.4)', () => {
    // 내 영역이 바뀌었다고 canonical 신호가 서지 않는다 — 그건 관련성 근거다
    const signals = detectSignals(
      event(),
      {},
      { changedPaths: ['web-frontend/src/a.ts'], canonicalPaths: ['specs/**'] },
    )
    assert.deepEqual(signals, [])

    const relevance = evaluateRelevance(signals, { ...MINE, changedPaths: ['web-frontend/src/a.ts'] })
    assert.equal(relevance.actual, 'HIGH')
    assert.ok(relevance.evidence.some((e) => e.kind === 'ownership' && e.supports))
  })

  it('신호가 없으면 우선순위 판정도 예전 그대로다 — 회귀 0', () => {
    assert.deepEqual(classify(event(), {}).signals, [])
    assert.equal(classify(event(), {}).inboxCandidate, false)
  })
})

describe('B-30 Gate — Explicit × Actual 네 칸 (C-07 §3.1)', () => {
  it('HIGH × HIGH → Inbox', () => {
    const r = evaluateRelevance(['mentioned_me'], { ...MINE, changedPaths: ['web-frontend/src/a.ts'] })
    assert.deepEqual([r.explicit, r.actual, r.disposition], ['HIGH', 'HIGH', 'INBOX'])
  })

  it('LOW × HIGH → Inbox — 태깅 누락을 회수한다', () => {
    // 아무도 나를 부르지 않았는데 내 영역이 바뀌었다
    const r = evaluateRelevance([], { ...MINE, changedPaths: ['web-frontend/src/auth.ts'] })
    assert.deepEqual([r.explicit, r.actual, r.disposition], ['LOW', 'HIGH', 'INBOX'])
    assert.ok(r.evidence.some((e) => e.kind === 'targeting' && !e.supports))
  })

  it('HIGH × LOW → Shadow — 태깅 난사를 억제한다', () => {
    const r = evaluateRelevance(['mentioned_me'], { ...MINE, changedPaths: ['backend/src/auth.ts'] })
    assert.deepEqual([r.explicit, r.actual, r.disposition], ['HIGH', 'LOW', 'SHADOW'])
    assert.ok(r.evidence.some((e) => e.kind === 'ownership' && !e.supports))
  })

  it('LOW × LOW → Shadow', () => {
    const r = evaluateRelevance([], { ...MINE, changedPaths: ['backend/src/auth.ts'] })
    assert.deepEqual([r.explicit, r.actual, r.disposition], ['LOW', 'LOW', 'SHADOW'])
  })

  it('현재 세션이 잡은 경로를 건드리면 관련이 있다', () => {
    const r = evaluateRelevance([], {
      changedPaths: ['src/studio/a.ts'],
      activeBoundaries: [{ sessionId: 'S-20260826-01', paths: ['src/studio/**'] }],
    })
    assert.equal(r.actual, 'HIGH')
    assert.ok(r.evidence.some((e) => e.detail.includes('S-20260826-01')))
  })

  it('의미 판단 하나로는 올리지 않는다 — 보조 근거다', () => {
    const r = evaluateRelevance([], { semanticHint: '제목이 로그인과 관련돼 보인다' })
    assert.equal(r.actual, 'LOW')
    assert.ok(r.evidence.some((e) => e.kind === 'semantic'))
  })

  it('역할 선언이 없으면 ownership 근거를 만들지 않는다 — 추론하지 않는다', () => {
    const r = evaluateRelevance(['mentioned_me'], {
      ownership: OWNERSHIP,
      changedPaths: ['web-frontend/src/a.ts'],
    })
    assert.equal(r.actual, 'LOW')
    assert.ok(!r.evidence.some((e) => e.kind === 'ownership'))
  })

  it('숫자가 아니라 근거를 낸다', () => {
    const text = renderRelevance(
      evaluateRelevance(['mentioned_me'], { ...MINE, changedPaths: ['backend/src/a.ts'] }),
    ).join('\n')
    assert.doesNotMatch(text, /0\.\d+/)
    assert.match(text, /Relevance: LOW \(지목 HIGH\)/)
    assert.match(text, /Shadow Watch/)
  })
})

describe('B-30 Gate — Material Change · Shadow Watch (C-07 §4·§5)', () => {
  const ledgerOn = (store = new MemoryStateStore()) =>
    new ObservationLedger(store.scope('monitor:test'), () => NOW)

  const fp = (marker: string, evidence: string[] = ['ownership:내 영역 변경']): Fingerprint => ({
    revisionMarker: marker,
    evidence,
  })

  it('처음 보는 것은 올린다', async () => {
    const ledger = ledgerOn()
    const decision = await ledger.decide('org/repo#19', fp('r1'), 'INBOX')
    assert.deepEqual(decision, { surface: true, reason: 'NEW' })
  })

  it('실질 변화가 없으면 다시 올리지 않는다 — 반복 mention 억제', async () => {
    const ledger = ledgerOn()
    await ledger.record('org/repo#19', fp('r1'), 'INBOX')
    const again = await ledger.decide('org/repo#19', fp('r1'), 'INBOX')
    assert.equal(again.surface, false)
    assert.equal(again.reason, 'NO_MATERIAL_CHANGE')
  })

  it('marker가 바뀌면 다시 올린다', async () => {
    const ledger = ledgerOn()
    await ledger.record('org/repo#19', fp('r1'), 'INBOX')
    const changed = await ledger.decide('org/repo#19', fp('r2'), 'INBOX')
    assert.deepEqual(changed, { surface: true, reason: 'MATERIAL_CHANGE' })
  })

  it('근거가 바뀌어도 실질 변화다 — 같은 스레드라도 내 영역까지 넓어졌으면 새 사건이다', async () => {
    const ledger = ledgerOn()
    await ledger.record('org/repo#19', fp('r1', ['work:S-1 와 같은 경로']), 'INBOX')
    const widened = await ledger.decide('org/repo#19', fp('r1', ['ownership:내 영역 변경']), 'INBOX')
    assert.deepEqual(widened, { surface: true, reason: 'MATERIAL_CHANGE' })
  })

  it('Shadow는 숨김이지 폐기가 아니다 — 목록에 남고 이유가 붙는다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.record('org/repo#55', fp('r1', []), 'SHADOW', '관련 근거 없음')

    const shadowed = await ledger.shadowed()
    assert.equal(shadowed.length, 1)
    assert.match(shadowLines(shadowed)[0]!, /org\/repo#55 — 관련 근거 없음/)
  })

  it('Shadow에 있던 것이 관련돼지면 승격한다', async () => {
    const ledger = ledgerOn()
    await ledger.record('org/repo#55', fp('r1', []), 'SHADOW', '관련 근거 없음')
    const promoted = await ledger.decide('org/repo#55', fp('r2'), 'INBOX')
    assert.deepEqual(promoted, { surface: true, reason: 'PROMOTED' })
  })

  it('처음 본 시각은 보존된다 — 언제부터 지켜봤는지가 사라지지 않는다', async () => {
    const store = new MemoryStateStore()
    let clock = '2026-08-01T00:00:00+09:00'
    const ledger = new ObservationLedger(store.scope('monitor:test'), () => clock)
    await ledger.record('org/repo#19', fp('r1'), 'SHADOW')
    clock = '2026-08-26T00:00:00+09:00'
    const later = await ledger.record('org/repo#19', fp('r2'), 'INBOX')
    assert.equal(later.firstSeenAt, '2026-08-01T00:00:00+09:00')
    assert.equal(later.lastSeenAt, clock)
  })

  it('fingerprint는 관련 근거만 담고 순서에 흔들리지 않는다', () => {
    const relevance = evaluateRelevance(['mentioned_me'], {
      ...MINE,
      changedPaths: ['web-frontend/src/a.ts'],
    })
    const first = fingerprintOf(relevance, 'r1')
    const second = fingerprintOf({ ...relevance, evidence: [...relevance.evidence].reverse() }, 'r1')
    assert.deepEqual(first.evidence, second.evidence)
    // 반대 근거는 지문에 넣지 않는다 — 없는 것이 달라졌다고 재표면화하지 않게
    assert.ok(first.evidence.every((e) => !e.includes('없다')))
  })

  it('Request 상태를 만들지 않는다 (OM §11.2 무변경)', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.record('org/repo#55', fp('r1', []), 'SHADOW')
    assert.equal((await store.list('request')).length, 0)
    assert.equal((await store.list('event')).length, 0)
  })
})

describe('Core 독립성 — relevance · observation', () => {
  it('provider 어휘가 새지 않는다', async () => {
    for (const file of ['relevance.ts', 'observation.ts']) {
      const source = await readFile(new URL(`../core/monitor/${file}`, import.meta.url), 'utf8')
      for (const word of ['github', 'gitlab', 'jira', 'mattermost']) {
        assert.doesNotMatch(source.toLowerCase(), new RegExp(word), `${file}`)
      }
    }
  })
})
