// B-59 Gate — 보고는 증거의 projection이지 증거 저장소가 아니다 (지시 §28).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Handoff } from '../core/model/entities.ts'
import type { ExecutionEvidence, ValidationRecord } from '../core/runtime/audit.ts'
import type { Claim } from '../core/runtime/claims.ts'
import { buildFinalReport, renderFinalReport } from '../core/runtime/report.ts'

const NOW = '2026-08-26T21:00:00+09:00'

const session = (over: Record<string, unknown> = {}) => ({
  id: 'S-20260826-02',
  role: 'implementer' as const,
  goal: '관찰 조립을 닫는다',
  status: 'DONE' as const,
  doneCriteria: ['Gate 통과', '실서버 확인'],
  ...over,
})

const handoff = (over: Partial<Handoff> = {}) =>
  Handoff.parse({
    done: ['Gate 통과'],
    changed: ['composition/observe.ts'],
    verified: 'self-check: npm test 868 pass',
    unresolved: ['실 자격 없음'],
    next: '회수 요청',
    recordedAt: NOW,
    ...over,
  })

const execution = (principal: string, source: 'declared' | 'derived' = 'declared'): ExecutionEvidence => ({
  executionId: `E-S-20260826-02-1`,
  logicalSessionId: 'S-20260826-02',
  hostAdapter: 'test-host',
  principal,
  principalSource: source,
  physicalReference: `phys-${principal}`,
  startedAt: NOW,
  status: 'RELEASED',
  evidenceSource: 'bind',
})

const validation = (independence: ValidationRecord['independence']): ValidationRecord => ({
  validationId: 'V-1',
  validatorSessionId: 'S-20260826-03',
  validatorExecutionId: 'E-S-20260826-03-1',
  principal: 'carol',
  principalSource: 'declared',
  targetSessionId: 'S-20260826-02',
  result: 'PASS',
  findings: [],
  verifiedAt: NOW,
  independence,
  independenceDetail: '판정 근거',
})

describe('B-59 Gate — 네 블록으로 줄인다', () => {
  it('결과·근거·미결·다음 행동만 든다', () => {
    const rendered = renderFinalReport(buildFinalReport({ session: session({ handoff: handoff() }) })).join('\n')
    for (const block of ['## 결과', '## 판정 근거', '## 미결 / 위험', '## 다음 행동']) {
      assert.match(rendered, new RegExp(block))
    }
  })

  it('상세는 옮기지 않고 어디서 읽을지 가리킨다', () => {
    const report = buildFinalReport({ session: session({ handoff: handoff() }) })
    assert.deepEqual(report.evidence, ['asc session audit S-20260826-02'])
    // 변경 파일 목록 같은 본문을 보고가 다시 들고 있지 않다
    assert.doesNotMatch(renderFinalReport(report).join('\n'), /composition\/observe\.ts/)
  })

  it('미결이 없으면 빈 칸이 아니라 없다고 적는다', () => {
    const report = buildFinalReport({
      session: session({ doneCriteria: [], handoff: handoff({ unresolved: [] }) }),
    })
    assert.deepEqual(report.open, ['없음'])
  })
})

describe('B-59 Gate — 증거 등급을 보고가 흐리지 않는다', () => {
  it('실행 증거가 없으면 그렇게 적는다', () => {
    const report = buildFinalReport({ session: session() })
    assert.match(report.basis.join(' '), /실행 증거 없음/)
  })

  it('주체가 유추면 독립성 주장이 서지 않는다고 적는다', () => {
    const report = buildFinalReport({ session: session(), executions: [execution('phys-1', 'derived')] })
    assert.match(report.basis.join(' '), /UNVERIFIED를 넘지 못한다/)
  })

  it('자기 확인을 독립 검증처럼 쓰지 않는다', () => {
    const report = buildFinalReport({ session: session({ handoff: handoff() }) })
    const basis = report.basis.join(' ')
    assert.match(basis, /독립 검증 없음/)
    assert.match(basis, /독립 검증 아님/)
  })

  it('검증 등급을 이유와 함께 든다', () => {
    const report = buildFinalReport({ session: session(), validations: [validation('SELF_REPORTED')] })
    assert.match(report.basis.join(' '), /SELF_REPORTED/)
    assert.match(report.basis.join(' '), /판정 근거/)
  })

  it('회수되지 않았으면 다음 행동에 남는다', () => {
    const report = buildFinalReport({ session: session({ handoff: handoff() }) })
    assert.match(report.next.join(' '), /Controller 회수 필요/)
    assert.match(report.basis.join(' '), /회수 기록 없음/)
  })
})

describe('B-59 Gate — 추론을 결과로 올리지 않는다', () => {
  const claims: Claim[] = [
    { claimId: 'c-1', statement: '실서버도 될 것이다', status: 'INFERRED', evidenceRefs: [], observedAt: NOW },
    { claimId: 'c-2', statement: '자격 유효 여부', status: 'PENDING', evidenceRefs: [], observedAt: NOW },
    { claimId: 'c-3', statement: '테스트 868건 통과', status: 'CONFIRMED', evidenceRefs: ['npm test'], observedAt: NOW },
  ]

  it('추론·미확인은 결과가 아니라 미결로 간다', () => {
    const report = buildFinalReport({ session: session({ doneCriteria: [], handoff: handoff({ unresolved: [] }) }), claims })
    assert.match(report.open.join(' '), /추론\(확정 아님\)/)
    assert.match(report.open.join(' '), /미확인/)
    assert.doesNotMatch(report.result, /실서버도 될 것이다/)
  })

  it('남은 완료 조건이 미결에 남는다', () => {
    const report = buildFinalReport({ session: session({ handoff: handoff() }) })
    assert.match(report.open.join(' '), /1 done-criteria remaining: 실서버 확인/)
  })

  it('파생 실행 상태가 있으면 결과가 그것을 따른다 — 결론이 둘이 되지 않는다', () => {
    const report = buildFinalReport({
      session: session({ handoff: handoff() }),
      derived: { state: 'Waiting', reasons: ['기다림: 실 자격'] },
    })
    assert.match(report.result, /Waiting/)
    assert.match(report.basis.join(' '), /기다림: 실 자격/)
  })
})
