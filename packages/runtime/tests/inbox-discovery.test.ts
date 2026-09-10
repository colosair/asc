// 0.8.5 — 수신함이 알림 목록이 아니라 "내 차례" 를 찾는 자리가 되는가.
//
// 0.8.4 까지 후보를 만드는 신호는 사실상 둘이었다: 알림이 준 사유, 그리고 목록이 알려 준
// 배정. `replyToMe` 는 0.7 부터 선언돼 있었고 `direct_reply` 로 이어져 있었고 단위 시험까지
// 있었는데 **production 에서 그 칸을 채우는 호출자가 없었다.** 그래서 "내가 묻고 상대가
// 답한" 스레드는 신호가 0 이 되어 informational 로 접혔다.
//
// 여기 있는 시나리오는 실기계에서 사라진 세 건의 모양 그대로다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { detectSignals } from '../core/monitor/signals.ts'
import { directionOf, readParticipation, type ThreadFacts } from '../core/monitor/participation.ts'
import { judgeConsumption, obligationOf, type ConsumptionSignal } from '../core/approval/consumption.ts'
import type { RawEvent } from '../ports/event-source.ts'

const ME = ['colosair']
const EARLY = '2026-09-09T01:00:00.000Z'
const LATE = '2026-09-09T05:00:00.000Z'
const LATER = '2026-09-09T09:00:00.000Z'

const facts = (patch: Partial<ThreadFacts> = {}): ThreadFacts => ({ comments: [], ...patch })

/** 회수 경로가 만드는 사건 — 알림이 준 사유가 없다. 이것이 세 건이 지나간 문이다. */
const sweepEvent = (): RawEvent => ({
  eventKey: 'reconcile:group/project#148:m2',
  detectedAt: LATER,
  reference: 'group/project#148',
  raw: { kind: 'inventory', title: 'license 근거 질문' },
})

describe('A1 — 알림 없이 온 답도 후보가 된다', () => {
  // 실기계: 내가 물었고 상대가 답했다. To-Do 없음, 배정 없음, 호명 없음.
  const answered = facts({
    author: 'colosair',
    comments: [
      { author: 'colosair', at: EARLY },
      { author: 'other', at: LATE },
    ],
  })

  it('내 마지막 발언 뒤에 남이 말했다는 사실을 읽는다', () => {
    const participation = readParticipation(answered, ME)
    assert.equal(participation.participated, true)
    assert.equal(participation.lastHumanActor, 'other')
    assert.equal(participation.replyAfterMine, true)
    assert.equal(participation.lastOtherAt, LATE)
  })

  it('그 사실이 direct_reply 신호를 세운다 — 0.8.4 까지 아무도 채우지 않던 칸이다', () => {
    const signals = detectSignals(sweepEvent(), { identities: ME }, { replyToMe: true })
    assert.deepEqual(signals, ['direct_reply'])
  })

  it('신호가 없으면 이 사건은 informational 로 접힌다 — 이것이 사라진 이유다', () => {
    assert.deepEqual(detectSignals(sweepEvent(), { identities: ME }, {}), [])
  })

  it('방향은 INBOUND 다', () => {
    assert.equal(directionOf(readParticipation(answered, ME)), 'INBOUND')
  })
})

describe('A2 — 이미 다른 자리에서 다뤄진 답을 다시 묻지 않는다', () => {
  // 실기계 #148: 답은 왔고 그 답이 이미 다른 판단에 쓰였다. "상대가 마지막 발언자" 하나로
  // 접으면 사람이 같은 것을 두 번 처리한다.
  const consumed: ConsumptionSignal[] = [{ source: 'REQ-0002 dismiss', at: LATER }]

  it('답이 온 뒤의 기록이 있으면 CONSUMED_ELSEWHERE 다', () => {
    const verdict = judgeConsumption(LATE, consumed, ['요청 처분'])
    assert.equal(verdict.kind, 'CONSUMED_ELSEWHERE')
    assert.equal(obligationOf('INBOUND', verdict), 'CONSUMED_ELSEWHERE')
  })

  it('답보다 **앞선** 기록은 그 답을 처리한 것일 수 없다', () => {
    const before = judgeConsumption(LATE, [{ source: 'REQ-0002 dismiss', at: EARLY }], ['요청 처분'])
    assert.equal(before.kind, 'UNCONSUMED')
    assert.equal(obligationOf('INBOUND', before), 'ACTION_REQUIRED_BY_ME')
  })

  it('볼 곳이 없었으면 "처리 안 됨" 이 아니라 UNKNOWN 이다', () => {
    const verdict = judgeConsumption(LATE, [], [])
    assert.equal(verdict.kind, 'UNKNOWN')
    assert.equal(obligationOf('INBOUND', verdict), 'ACTION_REQUIRED_BY_ME', '모른다고 숨기지는 않는다')
  })

  it('확인한 곳을 화면이 말할 수 있게 들고 간다', () => {
    const verdict = judgeConsumption(LATE, [], ['조율 원장', '요청 처분'])
    assert.equal(verdict.kind === 'UNCONSUMED' && verdict.checked.length, 2)
  })
})

describe('B — 내가 마지막으로 말했으면 내 차례가 아니다', () => {
  const waiting = facts({
    author: 'colosair',
    comments: [
      { author: 'other', at: EARLY },
      { author: 'colosair', at: LATE },
    ],
  })

  it('OUTBOUND 로 읽는다', () => {
    const participation = readParticipation(waiting, ME)
    assert.equal(participation.replyAfterMine, false)
    assert.equal(directionOf(participation), 'OUTBOUND')
  })

  it('의무는 상대 차례이며, 소비 기록이 무엇이든 뒤집히지 않는다', () => {
    for (const consumption of [
      judgeConsumption(undefined, [], []),
      judgeConsumption(LATE, [{ source: 'x', at: LATER }], ['요청 처분']),
    ]) {
      assert.equal(obligationOf('OUTBOUND', consumption), 'WAITING_ON_OTHER')
    }
  })
})

describe('C — 닫힌 것에 붙은 새 대화도 후보다', () => {
  // 열거 Port 의 계약이 이미 "닫힌 것도 포함한다" 이고, 실질 변화 마커가 새 발언을 잡는다.
  // 남은 문제는 그 사건에 신호가 서지 않던 것이었다.
  it('상태가 닫힘이어도 방향 판정은 같은 규칙으로 선다', () => {
    const followUp = facts({
      author: 'colosair',
      comments: [
        { author: 'colosair', at: EARLY },
        { author: 'other', at: LATER },
      ],
    })
    assert.equal(directionOf(readParticipation(followUp, ME)), 'INBOUND')
  })
})

describe('D — 관계없는 옛 잡담은 수신함을 오염시키지 않는다', () => {
  it('내가 말한 적 없고 배정도 없으면 방향이 서지 않는다', () => {
    const chatter = facts({ author: 'other', comments: [{ author: 'other', at: LATER }] })
    const participation = readParticipation(chatter, ME)
    assert.equal(participation.participated, false)
    assert.equal(participation.replyAfterMine, false)
    assert.equal(directionOf(participation), 'UNKNOWN')
  })

  it('UNKNOWN 은 내 차례로 바뀌지 않는다', () => {
    assert.equal(obligationOf('UNKNOWN', judgeConsumption(undefined, [], [])), 'UNKNOWN')
    assert.equal(obligationOf(undefined, judgeConsumption(undefined, [], [])), 'UNKNOWN')
  })

  it('시스템이 남긴 자국은 사람의 답이 아니다', () => {
    const noise = facts({
      author: 'colosair',
      comments: [
        { author: 'colosair', at: EARLY },
        { author: 'bot', at: LATER, system: true },
      ],
    })
    const participation = readParticipation(noise, ME)
    assert.equal(participation.replyAfterMine, false, '자국을 답으로 세면 "답이 왔다" 가 저절로 성립한다')
    assert.equal(directionOf(participation), 'OUTBOUND')
  })
})

describe('E — 배정이 남에게 있어도 내가 물은 것은 내 차례로 온다', () => {
  it('작성자가 남이고 배정도 남이지만 내가 물었고 답이 왔다', () => {
    const asked = facts({
      author: 'other',
      assignees: ['other'],
      comments: [
        { author: 'other', at: EARLY },
        { author: 'colosair', at: LATE },
        { author: 'other', at: LATER },
      ],
    })
    const participation = readParticipation(asked, ME)
    assert.equal(participation.replyAfterMine, true)
    assert.equal(directionOf(participation), 'INBOUND')
  })
})

describe('F — 방향이 소유권으로 승격되지 않는다', () => {
  it('배정만으로 INBOUND 를 만들지 않는다 — 남이 말한 뒤여야 한다', () => {
    const silent = facts({ assignees: ['colosair'], comments: [] })
    assert.equal(directionOf(readParticipation(silent, ME), { assignedToMe: true }), 'UNKNOWN')
  })

  it('나에게 배정됐고 남이 마지막으로 말했으면 INBOUND 다', () => {
    const mine = facts({ assignees: ['colosair'], comments: [{ author: 'other', at: LATER }] })
    assert.equal(directionOf(readParticipation(mine, ME), { assignedToMe: true }), 'INBOUND')
  })

  it('내가 마지막으로 말했으면 배정이 나여도 상대 차례다', () => {
    const spoke = facts({
      assignees: ['colosair'],
      comments: [
        { author: 'other', at: EARLY },
        { author: 'colosair', at: LATER },
      ],
    })
    assert.equal(directionOf(readParticipation(spoke, ME), { assignedToMe: true }), 'OUTBOUND')
  })
})

describe('G — 소유권 선언이 없어도 방향은 서고, 그 둘은 섞이지 않는다', () => {
  it('방향은 구조적 사실에서만 나온다 — ownership 을 입력으로 받지 않는다', () => {
    const answered = facts({
      author: 'colosair',
      comments: [
        { author: 'colosair', at: EARLY },
        { author: 'other', at: LATE },
      ],
    })
    assert.equal(directionOf(readParticipation(answered, ME)), 'INBOUND')
    assert.equal(
      readParticipation(answered, ME).participated,
      true,
      '참여했다는 사실이지 이 일이 내 것이라는 뜻이 아니다',
    )
  })

  it('판정 함수의 입력에 ownership 도 authority 도 없다', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../core/monitor/participation.ts', import.meta.url), 'utf8')
    for (const word of ['ownership', 'authority', 'decision']) {
      assert.doesNotMatch(
        source.slice(source.indexOf('export function directionOf')),
        new RegExp(`\\b${word}\\b`, 'i'),
        `${word} 가 방향 판정의 입력에 들어왔다`,
      )
    }
  })
})

describe('H — 같은 사건이 두 번 와도 후보는 하나다', () => {
  it('신원 비교는 @ 유무에 흔들리지 않는다', () => {
    const withAt = facts({ comments: [{ author: '@colosair', at: EARLY }, { author: 'other', at: LATE }] })
    assert.equal(readParticipation(withAt, ['colosair']).replyAfterMine, true)
    assert.equal(readParticipation(withAt, ['@colosair']).replyAfterMine, true)
  })

  it('읽을 수 없는 시각으로 순서를 뒤집지 않는다', () => {
    const broken = facts({
      author: 'colosair',
      comments: [
        { author: 'colosair', at: 'not-a-time' },
        { author: 'other', at: 'also-not-a-time' },
      ],
    })
    assert.equal(readParticipation(broken, ME).replyAfterMine, false, '모르면 "답이 왔다" 라고 말하지 않는다')
  })
})
