// 0.10.0 P2 — 막는 것은 하나의 모델에서 나오고, 명령은 CLI 가 붙인다.
//
// dogfood 2026-09-13 F5: 세 번 막힌 publish 동안 status 의 Next 는 내내 `asc inbox` 였고, LOCK_DRIFT
// remedy 는 세 곳에서 달랐고, CONFLICT 는 stderr 와 stdout 이 반대말을 했다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { collectBlockers, type Remediation } from '../core/operator/blockers.ts'
import { renderProgress } from '../core/operator/render.ts'
import { Session } from '../core/model/entities.ts'
import { remediationCommand, renderBlocker } from '../cli/remediation.ts'

const ready = { attachment: 'READY' as const, host: { id: 'claude', status: 'INSTALLED_CURRENT' } }

describe('collectBlockers — 사실에서 의미만 뽑는다', () => {
  it('붙어 있고 최신이고 승인자가 매핑돼 있으면 막는 것이 없다', () => {
    assert.deepEqual(collectBlockers({ ...ready, approval: { hasApprovers: true, hasLocalApprover: true } }), [])
  })

  it('LOCK_DRIFT 는 사람의 몫이고 remediation 은 RESOLVE_PROFILE_DRIFT 다 — 문자열이 아니다', () => {
    const [blocker] = collectBlockers({ ...ready, attachment: 'LOCK_DRIFT' })
    assert.equal(blocker?.remediation, 'RESOLVE_PROFILE_DRIFT')
    assert.equal(blocker?.resolver, 'person')
    assert.doesNotMatch(JSON.stringify(blocker), /asc /, 'Core 는 CLI 명령을 들지 않는다')
  })

  it('승인자가 있어도 local 채널이 아니면 MAP_LOCAL_IDENTITY 다', () => {
    const [blocker] = collectBlockers({ ...ready, approval: { hasApprovers: true, hasLocalApprover: false } })
    assert.equal(blocker?.remediation, 'MAP_LOCAL_IDENTITY')
    assert.match(blocker?.why ?? '', /not on the local channel/)
  })

  it('AUTO 인데 경로가 없으면 STEP_DOWN_OR_FIX_AUTO, MANUAL 이면 아무것도 아니다', () => {
    const blocking = [{ axis: 'executor', state: 'MISSING', detail: 'no binding' }]
    assert.equal(collectBlockers({ ...ready, mode: { mode: 'AUTO', ready: false, blocking } })[0]?.remediation, 'STEP_DOWN_OR_FIX_AUTO')
    assert.deepEqual(collectBlockers({ ...ready, mode: { mode: 'MANUAL', ready: false, blocking } }), [])
  })

  it('끝난 세션을 쥔 결합은 RELEASE_TERMINAL_HOLDER, 남이 쥔 산 세션은 이 Run 에서만 RECLAIM_SESSION 이다', () => {
    const bindings = [
      { sessionId: 'S-1', holder: 'run-a', sessionStatus: 'DONE' },
      { sessionId: 'S-2', holder: 'run-a', sessionStatus: 'ACTIVE' },
      { sessionId: 'S-3', holder: 'run-b', sessionStatus: 'ACTIVE' },
    ]
    const mine = collectBlockers({ ...ready, bindings, thisRun: 'run-a' })
    assert.deepEqual(
      mine.map((b) => [b.ref, b.remediation]),
      [
        ['S-1', 'RELEASE_TERMINAL_HOLDER'],
        ['S-3', 'RECLAIM_SESSION'],
      ],
    )
    // Run 밖에서는 남이 쥔 것이 막는 것이 아니다 — 잔재만 남는다
    assert.deepEqual(collectBlockers({ ...ready, bindings }).map((b) => b.ref), ['S-1'])
  })

  it('순서는 붙기 → host → 모드 → 승인자 → 결합이다 — Next 는 첫 줄이다', () => {
    const all = collectBlockers({
      attachment: 'LOCK_DRIFT',
      host: { id: 'claude', status: 'INSTALLED_STALE' },
      mode: { mode: 'AUTO', ready: false, blocking: [{ axis: 'executor', state: 'MISSING' }] },
      approval: { hasApprovers: false, hasLocalApprover: false },
      bindings: [{ sessionId: 'S-1', holder: 'run-a', sessionStatus: 'DONE' }],
    })
    assert.deepEqual(
      all.map((b) => b.remediation),
      ['RESOLVE_PROFILE_DRIFT', 'REFRESH_HOST', 'STEP_DOWN_OR_FIX_AUTO', 'MAP_LOCAL_IDENTITY', 'RELEASE_TERMINAL_HOLDER'],
    )
  })
})

describe('remediation → 명령은 CLI 의 표 하나다', () => {
  it('모든 remediation 에 명령이 있고 같은 값은 같은 명령이다', () => {
    const every: Remediation[] = [
      'ATTACH_WORKSPACE',
      'REPAIR_ATTACHMENT',
      'RESOLVE_PROFILE_DRIFT',
      'REFRESH_HOST',
      'FORCE_HOST_INSTALL',
      'STEP_DOWN_OR_FIX_AUTO',
      'MAP_LOCAL_IDENTITY',
      'RECLAIM_SESSION',
      'RELEASE_TERMINAL_HOLDER',
    ]
    for (const r of every) assert.match(remediationCommand(r, 'S-1'), /^asc /, r)
    assert.equal(remediationCommand('RESOLVE_PROFILE_DRIFT'), 'asc profile resolve --write')
    assert.equal(remediationCommand('RECLAIM_SESSION', 'S-9'), 'asc work reclaim S-9')
  })

  it('한 blocker 는 두 줄이다 — 무엇이·왜, 누가·무엇으로', () => {
    const [blocker] = collectBlockers({ ...ready, attachment: 'LOCK_DRIFT' })
    const lines = renderBlocker(blocker!)
    assert.equal(lines.length, 2)
    assert.match(lines[1]!, /a person decides: asc profile resolve --write/)
  })
})

describe('진행 화면은 소유권을 안다', () => {
  const session = Session.parse({
    id: 'S-20260914-01',
    version: 1,
    status: 'ACTIVE',
    role: 'implementer',
    goal: '소유권 화면',
    doneCriteria: [],
    writeBoundary: [],
  })

  it('이 Run 이 소유자가 아니면 "판단 필요 없음" 도 "막는 문제 없음" 도 말하지 않는다', () => {
    const rendered = renderProgress({ session, progress: null, ownership: { held: false, holder: 'run-b' } })
    const text = rendered.body.join('\n')
    assert.match(text, /이 Run 은 이 세션의 소유자가 아닙니다 — run-b 이 잡고 있어/)
    assert.doesNotMatch(text, /판단이 필요한 항목은 없습니다|막는 문제는 없습니다/)
  })

  it('소유자면 이전과 같다', () => {
    const rendered = renderProgress({ session, progress: null, ownership: { held: true } })
    assert.match(rendered.body.join('\n'), /지금 사용자 판단이 필요한 항목은 없습니다/)
  })
})
