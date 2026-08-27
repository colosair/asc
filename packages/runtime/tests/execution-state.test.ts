// B-57 Gate — 외부 도구 상태를 실행 상태로 읽지 않는다 (C-10 §7).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { deriveExecutionState, executionLine } from '../core/runtime/execution-state.ts'

describe('B-57 Gate — 파생 실행 상태', () => {
  it('막는 것이 있으면 다른 무엇보다 먼저 Blocked다', () => {
    const verdict = deriveExecutionState({
      blockers: ['읽기 자격 없음'],
      waitingOn: ['리뷰'],
      doneCriteria: ['a'],
      metCriteria: ['a'],
      externalState: '완료',
    })
    assert.equal(verdict.state, 'Blocked')
    assert.match(verdict.reasons[0]!, /읽기 자격 없음/)
  })

  it('기다리는 것이 있으면 Waiting이다', () => {
    const verdict = deriveExecutionState({ waitingOn: ['GitLab 자격 발급'] })
    assert.equal(verdict.state, 'Waiting')
    assert.match(verdict.reasons[0]!, /waiting on/)
  })

  it('제한된 범위에서만 갈 수 있으면 Conditional이다', () => {
    const verdict = deriveExecutionState({ conditions: ['fixture로만 검증 가능'] })
    assert.equal(verdict.state, 'Conditional')
    assert.match(verdict.reasons[0]!, /limit:/)
  })

  it('막는 것도 기다리는 것도 없으면 Ready다', () => {
    assert.equal(deriveExecutionState({}).state, 'Ready')
  })

  it('완료 조건이 다 차고 검증이 통과해야 Done이다', () => {
    const done = deriveExecutionState({
      doneCriteria: ['테스트 통과', 'Gate 통과'],
      metCriteria: ['테스트 통과', 'Gate 통과'],
      verificationPassed: true,
    })
    assert.equal(done.state, 'Done')
    assert.match(done.reasons.join(' '), /required verification passed/)
  })

  it('조건은 찼으나 검증이 실패면 Done이 아니다', () => {
    const verdict = deriveExecutionState({
      doneCriteria: ['a'],
      metCriteria: ['a'],
      verificationPassed: false,
    })
    assert.equal(verdict.state, 'Waiting')
    assert.match(verdict.reasons[0]!, /verification has not passed/)
  })

  it('완료 조건을 선언하지 않았으면 Done을 말하지 않는다', () => {
    // 조건이 없다는 것은 "다 했다"가 아니라 "무엇이 끝인지 안 정했다"이다
    assert.equal(deriveExecutionState({ metCriteria: ['a'] }).state, 'Ready')
  })

  it('남은 조건이 있으면 그 사실이 이유에 남는다', () => {
    const verdict = deriveExecutionState({ doneCriteria: ['a', 'b'], metCriteria: ['a'] })
    assert.equal(verdict.state, 'Ready')
    assert.match(verdict.reasons.join(' '), /1 done-criteria remaining/)
  })
})

describe('B-57 Gate — 외부 상태는 증거일 뿐이다 (불변식 ⑭)', () => {
  it('외부 도구가 진행 중이어도 자격이 없으면 Blocked다', () => {
    const verdict = deriveExecutionState({ externalState: '진행 중', blockers: ['자격 없음'] })
    assert.equal(verdict.state, 'Blocked')
  })

  it('외부 도구가 완료여도 조건이 안 찼으면 Done이 아니다', () => {
    const verdict = deriveExecutionState({
      externalState: '완료',
      doneCriteria: ['실서버 E2E'],
      metCriteria: [],
    })
    assert.notEqual(verdict.state, 'Done')
  })

  it('외부 상태를 판정과 같은 줄에 섞지 않는다', () => {
    const lines = executionLine(deriveExecutionState({ externalState: '진행 중' }))
    assert.match(lines[0]!, /Ready/)
    assert.doesNotMatch(lines[0]!, /진행 중/)
    assert.match(lines.join('\n'), /evidence, not the basis of this verdict/)
  })
})

describe('B-57 Gate — 결정성 (불변식 ⑮)', () => {
  it('같은 증거에서는 같은 값이 나온다', () => {
    const facts = { waitingOn: ['리뷰'], externalState: '진행 중' }
    assert.deepEqual(deriveExecutionState(facts), deriveExecutionState({ ...facts }))
  })

  it('모르는 것을 안 된다로 읽지 않는다', () => {
    // verificationPassed가 undefined인 것은 "요구가 없다"이지 "실패했다"가 아니다
    const verdict = deriveExecutionState({ doneCriteria: ['a'], metCriteria: ['a'] })
    assert.equal(verdict.state, 'Done')
    assert.match(verdict.reasons.join(' '), /no verification required/)
  })
})

// B-62에서 추가된 갈래 — 기다리는 것이 있어도 갈 수 있는 것이 남았으면 멈춘 게 아니다.
describe('B-62 보정 — 부분 대기는 Waiting이 아니라 Conditional (C-13 §6)', () => {
  it('대기와 진행 가능이 함께 있으면 Conditional이다', () => {
    const verdict = deriveExecutionState({
      waitingOn: ['ESC-1 [secret_or_permission] N2'],
      conditions: ['계속 가능: N1, N3'],
    })
    assert.equal(verdict.state, 'Conditional')
    assert.match(verdict.reasons.join(' '), /계속 가능/)
    assert.match(verdict.reasons.join(' '), /waiting on/, '무엇을 기다리는지도 남는다')
  })

  it('갈 수 있는 것이 없으면 예전대로 Waiting이다', () => {
    assert.equal(deriveExecutionState({ waitingOn: ['ESC-1'] }).state, 'Waiting')
  })
})
