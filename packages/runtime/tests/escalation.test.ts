// B-61 Gate — 올릴 자격이 없으면 올라가지 않는다 (C-13 §1).
//
// 이 Gate가 지키는 한 문장: **불확실성은 경계가 아니다.**
// "확신이 안 서서" 올린 것과 "내 권한 밖이라" 올린 것이 같은 모양으로 도착하면
// 사람은 둘 다 읽어야 하고, 그러면 Approval은 예외가 아니라 일상이 된다.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { boundaryFingerprint, EscalationLedger, escalationLines } from '../core/runtime/escalation.ts'

const NOW = '2026-08-26T21:00:00+09:00'
const SESSION = 'S-20260826-02'

const ledgerOn = (store: MemoryStateStore, now = NOW) => new EscalationLedger(store.scope('escalation'), () => now)

const open = (over: Record<string, unknown> = {}) => ({
  escalationId: 'ESC-20260826-01',
  sessionId: SESSION,
  openedBy: 'impl-agent',
  predicates: ['secret_or_permission'],
  question: 'OAuth credential이 필요하다 — 발급해 줄 수 있나',
  evidenceRefs: ['docs/auth.md#oauth'],
  blockedNodes: ['N2 외부 API 연동'],
  doneCriteria: ['N1 렌더 구현', 'N2 외부 API 연동', 'N3 스키마'],
  ...over,
})

describe('B-61 Gate — 자격 없는 사유는 request를 만들지 못한다', () => {
  for (const reason of ['uncertain', 'multiple_options', 'want_confirmation', 'reviewer_might_disagree']) {
    it(`${reason} 는 올릴 자격이 아니다`, async () => {
      const store = new MemoryStateStore()
      const ledger = ledgerOn(store)

      const outcome = await ledger.open(open({ predicates: [reason] }))
      assert.equal(outcome.ok, false)
      if (outcome.ok) return
      assert.equal(outcome.reason, 'APPROVAL_NOT_JUSTIFIED')
      assert.deepEqual(await ledger.pending(), [], 'record 자체가 생기지 않는다')
    })
  }

  it('사유가 아예 없으면 올라가지 않는다', async () => {
    const store = new MemoryStateStore()
    const outcome = await ledgerOn(store).open(open({ predicates: [] }))
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.reason, 'APPROVAL_NOT_JUSTIFIED')
  })

  it('막은 사실을 남긴다 — 무엇을 올리려 했는지가 사라지면 Gate를 검증할 수 없다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)

    await ledger.open(open({ predicates: ['uncertain'], question: '이 방식이 맞을까요' }))
    const rejected = await ledger.rejected()
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0]!.reason, 'APPROVAL_NOT_JUSTIFIED')
    assert.deepEqual(rejected[0]!.claimedReasons, ['uncertain'])
    assert.match(rejected[0]!.question, /이 방식이 맞을까요/)
  })

  it('근거 없는 상신은 상신이 아니다', async () => {
    const store = new MemoryStateStore()
    const outcome = await ledgerOn(store).open(open({ evidenceRefs: [] }))
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.match(outcome.detail, /근거 없는 상신/)
  })
})

describe('B-61 Gate — 7종은 올라간다 (C-13 §1.1)', () => {
  const predicates = [
    'ownership_boundary',
    'shared_contract_change',
    'acceptance_change',
    'secret_or_permission',
    'irreversible_action',
    'explicit_rule_requires_approval',
    'canonical_conflict',
  ]

  for (const [index, predicate] of predicates.entries()) {
    it(`${predicate} 로는 올릴 수 있다`, async () => {
      const store = new MemoryStateStore()
      const outcome = await ledgerOn(store).open(
        open({ predicates: [predicate], escalationId: `ESC-20260826-0${index + 1}` }),
      )
      assert.equal(outcome.ok, true)
      if (!outcome.ok) return
      assert.deepEqual(outcome.record.predicates, [predicate])
    })
  }

  it('유효한 사유와 무효한 사유가 섞이면 유효한 것만 남는다', async () => {
    const store = new MemoryStateStore()
    const outcome = await ledgerOn(store).open(
      open({ predicates: ['uncertain', 'ownership_boundary', 'want_confirmation'] }),
    )
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.deepEqual(outcome.record.predicates, ['ownership_boundary'])
  })
})

describe('B-61 Gate — blockedNodes ≠ blockedScope (C-13 §2.1)', () => {
  it('계속 갈 수 있는 노드는 자동 계산이다 — 올리는 쪽이 적지 않는다', async () => {
    const store = new MemoryStateStore()
    const outcome = await ledgerOn(store).open(open())
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return

    assert.deepEqual(outcome.record.blockedNodes, ['N2 외부 API 연동'])
    assert.deepEqual(outcome.record.stillRunnableNodes, ['N1 렌더 구현', 'N3 스키마'])
  })

  it('경계 영역은 노드 목록과 다른 축으로 남는다', async () => {
    const store = new MemoryStateStore()
    const outcome = await ledgerOn(store).open(
      open({ predicates: ['ownership_boundary'], blockedNodes: ['N3 스키마'], blockedScope: ['api/**'] }),
    )
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.deepEqual(outcome.record.blockedNodes, ['N3 스키마'])
    assert.deepEqual(outcome.record.blockedScope, ['api/**'])
  })

  it('막힌 노드가 없으면 상신이 성립하지 않는다', async () => {
    const store = new MemoryStateStore()
    const outcome = await ledgerOn(store).open(open({ blockedNodes: [] }))
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.reason, 'INVALID_INPUT')
  })

  it('사람이 읽는 줄에 무엇이 막히고 무엇이 가는지 함께 온다', async () => {
    const store = new MemoryStateStore()
    const outcome = await ledgerOn(store).open(open())
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return

    const rendered = escalationLines([outcome.record]).join('\n')
    assert.match(rendered, /secret_or_permission/)
    assert.match(rendered, /blocked: N2/)
    assert.match(rendered, /still running: N1 렌더 구현, N3 스키마/)
  })

  // 기록에만 있고 화면에 없으면 결정하는 사람은 "어디까지가 남의 것인가"를 다시 물어야 한다.
  it('막힌 경계도 사람이 읽는 줄에 온다', async () => {
    const store = new MemoryStateStore()
    const outcome = await ledgerOn(store).open(
      open({ predicates: ['ownership_boundary'], blockedNodes: ['N3 스키마'], blockedScope: ['server/**'] }),
    )
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return

    const rendered = escalationLines([outcome.record]).join('\n')
    assert.match(rendered, /blocked: N3 스키마/)
    assert.match(rendered, /boundary: server\/\*\*/)
  })

  it('경계가 없으면 없는 줄을 만들지 않는다', async () => {
    const store = new MemoryStateStore()
    const outcome = await ledgerOn(store).open(open())
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.doesNotMatch(escalationLines([outcome.record]).join('\n'), /boundary:/)
  })
})

describe('B-61 Gate — fingerprint는 경계로만 만든다 (C-13 불변식 ⑦)', () => {
  it('근거가 달라도 경계가 같으면 같은 지문이다', () => {
    const base = { predicates: ['secret_or_permission'], blockedNodes: ['N2'], blockedScope: ['api/**'] }
    assert.equal(boundaryFingerprint(base), boundaryFingerprint({ ...base }))
  })

  it('순서가 달라도 같은 지문이다', () => {
    const a = boundaryFingerprint({ predicates: ['a', 'b'], blockedNodes: ['N1', 'N2'] })
    const b = boundaryFingerprint({ predicates: ['b', 'a'], blockedNodes: ['N2', 'N1'] })
    assert.equal(a, b)
  })

  it('경계가 다르면 다른 지문이다', () => {
    const a = boundaryFingerprint({ predicates: ['secret_or_permission'], blockedNodes: ['N2'] })
    const b = boundaryFingerprint({ predicates: ['ownership_boundary'], blockedNodes: ['N2'] })
    const c = boundaryFingerprint({ predicates: ['secret_or_permission'], blockedNodes: ['N3'] })
    assert.notEqual(a, b)
    assert.notEqual(a, c)
  })
})

describe('B-61 Gate — 결정으로만 닫힌다', () => {
  it('닫기 전에는 계속 열려 있다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.open(open())

    assert.equal((await ledger.pending()).length, 1)
    await ledger.resolve('ESC-20260826-01', 'controller-a', 'REQ-0001:approve')
    assert.deepEqual(await ledger.pending(), [], '닫히면 대기 목록에서 빠진다')
    assert.equal((await ledger.all()).length, 1, '기록 자체는 남는다')
  })

  it('두 번 닫았다고 적지 않는다', async () => {
    const store = new MemoryStateStore()
    const ledger = ledgerOn(store)
    await ledger.open(open())
    await ledger.resolve('ESC-20260826-01', 'controller-a', 'REQ-0001:approve')

    const again = await ledger.resolve('ESC-20260826-01', 'someone', 'REQ-0001:dismiss')
    assert.equal(again.ok, false)
    if (again.ok) return
    assert.equal(again.reason, 'ALREADY_RESOLVED')
  })

  it('없는 상신을 닫았다고 적지 않는다', async () => {
    const store = new MemoryStateStore()
    const outcome = await ledgerOn(store).resolve('ESC-20260826-99', 'a', 'b')
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.reason, 'NOT_FOUND')
  })
})

describe('B-61 Gate — 우회 경로가 없다', () => {
  it('상신 없이 request를 만드는 product 경로가 CLI에 없다', async () => {
    const source = await readFile('cli/asc.ts', 'utf8')
    const creations = source.match(/store\.create\('request'/g) ?? []
    // 사람 상신 경로는 하나뿐이어야 한다 — 늘어나면 그 경로가 gate를 지나는지 확인하라
    assert.equal(creations.length, 1, `CLI의 request 생성 지점이 ${creations.length}개다`)

    const block = source.slice(source.indexOf("store.create('request'"))
    assert.match(block.slice(0, 400), /escalation:/, '생성되는 request가 상신 근거를 들고 있어야 한다')
  })

  it('Monitor packet 경로는 gate를 지나지 않는다 — 외부 사건은 상신이 아니다', async () => {
    const source = await readFile('core/monitor/engine.ts', 'utf8')
    assert.doesNotMatch(source, /EscalationLedger|escalation\.ts/)
  })

  it('저수준 Port 계약은 그대로다 — Adapter 교체 근거를 깨지 않는다', async () => {
    const contract = await readFile('tests/support/state-store-contract.ts', 'utf8')
    assert.doesNotMatch(contract, /escalation/i)
  })
})

// B-65 회귀 — dogfood에서 잡힌 결함들이 다시 생기지 않게 잠근다.
describe('B-65 회귀 — dogfood defect closure', () => {
  it('escalate의 경계 옵션이 adoption scope와 이름을 다투지 않는다', async () => {
    const source = await readFile('cli/asc.ts', 'utf8')
    // --scope 는 asc init 의 local|project 다. escalate 경계를 같은 이름으로 받으면
    // 하나는 문자열, 하나는 배열이라 zod가 터진다 (dogfood에서 실제로 터졌다).
    assert.match(source, /'blocked-scope':\s*\{\s*type:\s*'string',\s*multiple:\s*true\s*\}/)
    assert.match(source, /values\['blocked-scope'\]/)
    assert.doesNotMatch(source, /blockedScope:\s*values\.scope/)
  })

  it('proceed 화면이 막힌 것을 함께 말한다', async () => {
    const source = await readFile('cli/asc.ts', 'utf8')
    // 상신 2건이 열려 있는데 "판단 필요 항목 없음"이라고 하면 그 화면은 거짓말이다
    assert.match(source, /if \(outcome\.gate\) \{/)
  })

  it('막힌 경계가 proceed·front·audit 어디에서도 사라지지 않는다', async () => {
    const cli = await readFile('cli/asc.ts', 'utf8')
    const front = await readFile('core/runtime/front.ts', 'utf8')
    // dogfood 회차에서 blockedScope는 기록에만 있고 어떤 화면에도 없었다.
    assert.match(cli, /boundary: \$\{record\.blockedScope\.join/)
    assert.match(front, /boundary: \$\{item\.blockedScope\.join/)
  })

  it('열린 상신이 있으면 진행 화면이 판단 필요 없음이라 말하지 않는다', async () => {
    const cli = await readFile('cli/asc.ts', 'utf8')
    // gate verdict를 아래에 붙이는 것만으로는 부족하다 — 본문 자체가 틀린 말을 하면 안 된다
    assert.match(cli, /awaiting: outcome\.awaiting/)
    assert.match(cli, /awaiting\.length > 0 \? \{ awaiting \} : \{\}/)
  })

  it('audit 화면이 검증자에게 acceptance와 경계를 준다', async () => {
    const source = await readFile('cli/asc.ts', 'utf8')
    // 없으면 검증자가 세션 파일을 직접 열어야 한다 (dogfood에서 실제로 그랬다)
    assert.match(source, /Done criteria:/)
    assert.match(source, /Write boundary:/)
    assert.match(source, /changed: \(nothing recorded/)
  })
})
