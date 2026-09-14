// 0.10.0 P1 — 정상 경로가 advanced primitive 없이 닫히기 위한 첫 묶음.
//
// dogfood 2026-09-13 에서 사람이 알아야 했던 네 가지: git.push 의 더미 --body-file(N4), publish 의
// FORBIDDEN_ISSUER 와 그때 status 가 OPEN 이라고 말한 것(U2), 매번 --as, 그리고 붙여 넣을 수 없는
// 발급 명령(F2). 여기서 고정하는 것은 그 넷의 규칙이지 문구가 아니다.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { GrantService } from '../core/execution/grant.ts'
import { Session } from '../core/model/entities.ts'
import { computeSetupPlan, type SetupState } from '../core/attach/setup-plan.ts'
import { shellWord, shellWords, shorthandCommand } from '../core/distribution/release.ts'
import { issueArgs } from '../core/operator/contract-draft.ts'
import { ACTION_PAYLOAD, MANAGED_EXTERNAL_ACTIONS, payloadContractOf } from '../ports/scm.ts'
import type { IdentityBinding } from '../ports/approval.ts'
import { issuerResolutionLines, localApprovers, resolveIssuer } from '../cli/identity-config.ts'

const NOW = '2026-09-14T00:00:00.000Z'

const approver: IdentityBinding = {
  async verify({ channel, actor }) {
    return channel === 'local' && actor === 'colosair'
  },
}

describe('P1 — 행위마다 본문 계약이 있다 (ACTION_PAYLOAD)', () => {
  it('관리 행위 전부에 계약이 있고, git.push 는 본문을 갖지 않는다', () => {
    for (const action of MANAGED_EXTERNAL_ACTIONS) assert.ok(ACTION_PAYLOAD[action], action)
    assert.equal(payloadContractOf('git.push'), 'forbidden')
    assert.equal(payloadContractOf('gitlab.mr.create'), 'required')
  })

  it('모르는 행위는 required 다 — 본문 없이 나가는 것을 기본값으로 두지 않는다', () => {
    assert.equal(payloadContractOf('something.new'), 'required')
  })

  it('Core 는 계약을 모른다 — payloadRequired 가 false 로 오면 빈 본문으로 발급하고, 생략하면 거절한다', async () => {
    const store = new MemoryStateStore()
    await store.create(
      'session',
      Session.parse({ id: 'S-20260914-01', version: 1, status: 'ACTIVE', role: 'implementer', goal: 'g', doneCriteria: [], writeBoundary: [] }),
    )
    const issue = (over: Record<string, unknown>) =>
      new GrantService(store, approver).issueForSession({
        grantId: 'G-0001',
        sessionId: 'S-20260914-01',
        issuedBy: 'colosair',
        channel: 'local',
        action: 'git.push',
        target: 'feat/x',
        payload: '',
        issuedAt: NOW,
        ...over,
      })
    const strict = await issue({})
    assert.equal(strict.ok === false && strict.failure.kind, 'NO_PAYLOAD')
    const relaxed = await issue({ grantId: 'G-0002', payloadRequired: false })
    assert.equal(relaxed.ok, true)
  })

  it('CLI 는 검수 전에 계약을 적용한다 — forbidden 에 본문이 오면 거절이지 무시가 아니다', async () => {
    const source = await readFile(join(import.meta.dirname, '..', 'cli', 'asc.ts'), 'utf8')
    const publish = source.indexOf("case 'publish': {")
    const review = source.indexOf('await outward.review(action)', publish)
    const read = source.indexOf('readActionPayload(values.action', publish)
    assert.ok(read > publish && read < review, 'publish 는 검수보다 먼저 본문 계약을 읽는다')
    const helper = source.slice(source.indexOf('async function readActionPayload('))
    assert.match(helper, /contract === 'forbidden' && bodyFile[\s\S]*ok: false/)
    assert.ok(!/console\.warn|ignored|무시/.test(helper.slice(0, helper.indexOf('const GRANT_ERROR'))), '경고하고 버리지 않는다')
  })
})

describe('P1 — 승인자는 이 기계의 local 채널로 검증된 사람이다', () => {
  it('local:<이름> 이 붙은 승인자만 이 기계에서 승인할 수 있다', () => {
    assert.deepEqual(localApprovers({ colosair: ['gitlab:colosair'] }), [])
    assert.deepEqual(localApprovers({ colosair: ['gitlab:colosair', 'local:colosair'] }), ['colosair'])
    // 이름과 local 계정이 다르면 검증이 통하지 않으므로 세지 않는다
    assert.deepEqual(localApprovers({ lead: ['local:someone-else'] }), [])
  })

  it('--as 생략은 local 승인자가 정확히 한 명일 때만 통한다', () => {
    const one = resolveIssuer(undefined, { colosair: ['local:colosair'] })
    assert.deepEqual(one, { ok: true, actor: 'colosair', given: false })
    const none = resolveIssuer(undefined, { colosair: ['gitlab:colosair'] })
    assert.equal(none.ok === false && none.reason, 'NONE_MAPPED')
    const two = resolveIssuer(undefined, { a: ['local:a'], b: ['local:b'] })
    assert.equal(two.ok === false && two.reason, 'SEVERAL_MAPPED')
    // 말했으면 그것이다 — "알고 있는 사람" 으로 바꿔치기하지 않는다
    assert.deepEqual(resolveIssuer('b', { a: ['local:a'], b: ['local:b'] }), { ok: true, actor: 'b', given: true })
  })

  it('거절 사유는 다음 행동을 든다 — 매핑 명령, 또는 --as', () => {
    const none = resolveIssuer(undefined, {})
    assert.ok(none.ok === false)
    assert.match(issuerResolutionLines(none).join('\n'), /asc setup identity --actor local:<이름> --role controller/)
    const two = resolveIssuer(undefined, { a: ['local:a'], b: ['local:b'] })
    assert.ok(two.ok === false)
    assert.match(issuerResolutionLines(two).join('\n'), /--as <이름>/)
  })
})

describe('P1 — setup 은 후보를 발견하고, 매핑은 사람이 한 번 말한다', () => {
  const attached = (identity: SetupState['identity']): SetupState => ({
    entry: 'bootstrap',
    projectRoot: '/tmp/project',
    git: true,
    profileCandidates: ['pilot-local'],
    scope: 'local',
    host: [{ id: 'claude', status: 'INSTALLED_CURRENT' }],
    ascRoot: '/home/u/.asc/workspaces/W-1',
    identity,
  })

  it('붙어 있고 고칠 것이 없는데 이 기계에 승인자가 없으면 사람의 결정을 기다린다', () => {
    const plan = computeSetupPlan(attached({ wired: true, localMapped: false, localCandidates: ['colosair'] }))
    assert.equal(plan.status, 'user_action_required')
    assert.equal(plan.code, 'ASC_LOCAL_IDENTITY_REQUIRED')
    assert.equal(plan.requiresUserAction, true)
    assert.deepEqual(plan.changes, [], '권한을 대신 지어 주지 않는다')
    assert.match(plan.actions[0]!.display, /^asc setup identity --actor local:colosair --role controller$/)
  })

  it('후보를 못 찾아도 막다른 길이 아니다 — 자리표시자로 같은 명령을 든다', () => {
    const plan = computeSetupPlan(attached({ wired: false, localMapped: false, localCandidates: [] }))
    assert.equal(plan.code, 'ASC_LOCAL_IDENTITY_REQUIRED')
    assert.match(plan.actions[0]!.display, /local:<name>/)
  })

  it('매핑돼 있으면 already_configured 이고 다음은 work start 다', () => {
    const plan = computeSetupPlan(attached({ wired: true, localMapped: true }))
    assert.equal(plan.status, 'already_configured')
    assert.match(plan.actions[0]!.display, /^asc work start$/)
  })
})

describe('P1 — 건네는 명령은 그대로 붙여 넣을 수 있다', () => {
  it('공백·>·[ 이 든 인자는 작은따옴표로 감싸고, 안전한 단어는 그대로 둔다', () => {
    assert.equal(shellWord('S-20260913-03'), 'S-20260913-03')
    assert.equal(shellWord('festa-frontend/src/**'), "'festa-frontend/src/**'")
    assert.equal(shellWord('rewardCoin > 0 이면'), "'rewardCoin > 0 이면'")
    assert.equal(shellWord("it's"), "'it'\\''s'")
    assert.equal(shellWords(['a', 'b c']), "a 'b c'")
  })

  it('발급 명령이 통째로 한 줄이고 owner 도 빠지지 않는다', () => {
    const args = issueArgs({
      id: 'S-20260913-03',
      role: 'implementer',
      goal: 'S15P21A604-520: [FE] Survey Builder rewardCoin 입력 추가',
      boundary: ['festa-frontend/src/**'],
      criteria: ['rewardCoin > 0 이면 안내가 보인다'],
      owner: 'planner',
    })
    const line = shorthandCommand(args)
    assert.equal(
      line,
      "asc session issue S-20260913-03 --role implementer --goal 'S15P21A604-520: [FE] Survey Builder rewardCoin 입력 추가' " +
        "--boundary 'festa-frontend/src/**' --criteria 'rewardCoin > 0 이면 안내가 보인다' --owner planner",
    )
  })
})
