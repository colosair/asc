// B-02 Gate — Port 계약이 실제로 구현 가능한지, CAS semantics가 두 채널의 동시 결정을
// 정확히 하나만 통과시키는지, PresentationRecord가 Core entity 밖에 사는지 검증한다.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { FakeScm, FixtureEventSource, MapIdentityBinding, MemoryChannel } from '../adapters/memory/mocks.ts'
import { ApprovalRequest, Session } from '../core/model/entities.ts'
import { DecisionView, Freshness } from '../core/view/decision-view.ts'
import { transitionRequest } from '../core/model/transitions.ts'
import { describeStateStoreContract } from './support/state-store-contract.ts'
import type { ApprovalChannel } from '../ports/approval.ts'
import type { EventSource } from '../ports/event-source.ts'
import type { ScmPort } from '../ports/scm.ts'
import type { StateStore } from '../ports/state-store.ts'

const NOW = '2026-08-22T10:00:00+09:00'
const LATER = '2026-08-22T10:20:00+09:00'

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest =>
  ApprovalRequest.parse({
    id: 'REQ-0042',
    version: 0,
    status: 'AWAITING_APPROVAL',
    type: 'actionable',
    priority: 'P0',
    title: 'Issue #19 답변 승인 필요',
    detectedAt: NOW,
    source: { eventKey: 'comment:531245', reference: 'Issue #19', threadLastEventId: 'evt-7' },
    situation: '상대방이 계약 해석을 물었다',
    impact: { interruptRequired: false, affectedSessions: ['S-20260822-01'] },
    draft: '초안 본문',
    snapshot: [{ sourceId: 'shared-spec', baseline: 'abc123' }],
    authorizedApprover: 'controller-a',
    allowedDecisions: ['approve', 'revise', 'defer', 'dismiss'],
    ...over,
  })

const view = (over: Partial<DecisionView> = {}): DecisionView =>
  DecisionView.parse({
    requestId: 'REQ-0042',
    reference: 'ASC · P0 · REQ-0042 · Issue #19',
    version: 0,
    stored: {
      status: 'AWAITING_APPROVAL',
      type: 'actionable',
      priority: 'P0',
      title: 'Issue #19 답변 승인 필요',
      detectedAt: NOW,
      source: 'Issue #19',
      situation: '상대방이 계약 해석을 물었다',
      context: '',
      interruptRequired: false,
      affectedSessions: ['S-20260822-01'],
      rationale: '',
      recommendation: '답변 필요',
      draft: '초안 본문',
      snapshot: [{ sourceId: 'shared-spec', baseline: 'abc123' }],
      threadLastEventId: 'evt-7',
    },
    freshness: 'CURRENT',
    verification: { localContext: 'VERIFIED', source: 'VERIFIED' },
    allowedDecisions: ['approve', 'revise', 'defer', 'dismiss'],
    authorizedApprover: 'controller-a',
    ...over,
  })

const decision = { kind: 'approve' as const, actor: 'controller-a', channel: 'local', decidedAt: NOW }

// ── State Store / CAS ───────────────────────────────────────────────────────

describeStateStoreContract('memory', async () => new MemoryStateStore())

// ── Approval Port ───────────────────────────────────────────────────────────

describe('Approval Port', () => {
  it('PresentationRecord는 Core entity가 아니라 Adapter scope에 산다', async () => {
    const store = new MemoryStateStore()
    const channel: ApprovalChannel = new MemoryChannel('mattermost', store.scope('mattermost'))

    const outcome = await channel.present(view())
    assert.equal(outcome.ok, true)
    assert.equal(outcome.ok && outcome.externalRef, 'mattermost:msg:REQ-0042')

    // Core가 아는 entity 목록에는 흔적이 없다
    assert.equal((await store.list('request')).length, 0)
    const record = JSON.parse((await store.scope('mattermost').get('presentation:REQ-0042'))!)
    assert.deepEqual(Object.keys(record).sort(), ['channel', 'externalMessageRef', 'renderedAt', 'requestId'])
  })

  it('표시 갱신 실패는 예외가 아니라 결과값이다 — canonical state와 무관하다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    const channel = new MemoryChannel('mattermost', store.scope('mattermost'))
    await channel.present(view())

    channel.breakUpdates()
    const outcome = await channel.update(view({ freshness: 'ALREADY_DECIDED' }))
    assert.equal(outcome.ok, false)
    // 채널이 죽어도 요청 자체는 그대로다
    assert.equal((await store.get('request', 'REQ-0042'))!.status, 'AWAITING_APPROVAL')
  })

  it('capability는 채널마다 다르고 Core는 선언만 읽는다', () => {
    const store = new MemoryStateStore()
    const rich = new MemoryChannel('mattermost', store.scope('mm'), ['interactive_actions', 'dialogs', 'priority'])
    const plain = new MemoryChannel('local', store.scope('local'), [])
    assert.equal(rich.capabilities.has('dialogs'), true)
    assert.equal(plain.capabilities.has('dialogs'), false)
  })

  it('Identity Binding은 로컬 결정도 검증한다', async () => {
    const binding = new MapIdentityBinding({ 'local:cli-user': 'controller-a', 'mattermost:@colosair': 'controller-a' })
    assert.equal(await binding.verify({ channel: 'local', actor: 'cli-user', authorizedApprover: 'controller-a' }), true)
    assert.equal(await binding.verify({ channel: 'local', actor: 'stranger', authorizedApprover: 'controller-a' }), false)
    // 같은 이름이라도 다른 채널의 identity는 별개다
    assert.equal(await binding.verify({ channel: 'web', actor: 'cli-user', authorizedApprover: 'controller-a' }), false)
  })
})

// ── SCM / Event Source / Renderer ───────────────────────────────────────────

describe('SCM Port', () => {
  it('스레드 상태와 baseline을 source별로 돌려준다', async () => {
    const scm: ScmPort = new FakeScm()
    ;(scm as FakeScm).setThread('owner/repo#19', 'evt-7')
    ;(scm as FakeScm).setBaseline('shared-spec', 'def456')

    assert.equal((await scm.getThread('owner/repo#19')).lastEventId, 'evt-7')
    assert.equal((await scm.getThread('owner/repo#99')).missing, true)
    assert.deepEqual(await scm.getBaselines([{ sourceId: 'shared-spec' }, { sourceId: 'fe-plan' }]), [
      { sourceId: 'shared-spec', baseline: 'def456' },
      { sourceId: 'fe-plan', baseline: 'unknown' },
    ])
  })

  it('실행 결과는 성공이든 실패든 결과값으로 온다', async () => {
    const scm = new FakeScm()
    const action = { action: 'github.issue_comment.create', target: 'owner/repo#19', payload: '초안 본문' }

    scm.failNextExecute('rate limited')
    const failed = await scm.execute(action)
    assert.equal(failed.ok, false)
    assert.equal(scm.executed.length, 0)

    const ok = await scm.execute(action)
    assert.equal(ok.ok, true)
    assert.equal(scm.executed.length, 1)
  })
})

describe('Event Source Port', () => {
  it('cursor 이후 배치를 순서대로 흘린다', async () => {
    const source: EventSource = new FixtureEventSource([
      [{ eventKey: 'comment:1', detectedAt: NOW, reference: 'Issue #19' }],
      [{ eventKey: 'review:2', detectedAt: LATER, reference: 'PR #50' }],
    ])
    const first = await source.drain(null)
    assert.equal(first.events[0]!.eventKey, 'comment:1')
    assert.equal(first.hasMore, true)

    const second = await source.drain(first.cursor)
    assert.equal(second.events[0]!.eventKey, 'review:2')
    assert.equal(second.hasMore, false)
    assert.deepEqual((await source.drain(second.cursor)).events, [])
  })
})

// Renderer의 행동 계약은 실 Adapter와 함께 tests/operator.test.ts에서 검증한다.

// ── View Model ──────────────────────────────────────────────────────────────

describe('Shared Decision View Model', () => {
  it('Overlay는 없을 수 있고, 있으면 관측 시각을 갖는다', () => {
    assert.equal(view().current, undefined)
    const withOverlay = view({
      current: { observedAt: LATER, activeSessions: [], affectsCurrentWork: false, canonicalChanges: [], notes: [] },
    })
    assert.equal(withOverlay.current?.observedAt, LATER)
  })

  it('freshness는 정해진 4종뿐이다', () => {
    assert.deepEqual(Freshness.options, ['CURRENT', 'STALE_CONTEXT', 'SOURCE_CHANGED', 'ALREADY_DECIDED'])
    assert.equal(Freshness.safeParse('FRESH').success, false)
  })

  it('선택지 없는 view와 참조 없는 view는 만들 수 없다', () => {
    assert.equal(DecisionView.safeParse({ ...view(), allowedDecisions: [] }).success, false)
    assert.equal(DecisionView.safeParse({ ...view(), reference: '' }).success, false)
  })

  it('version은 결정 제출 시 expectedVersion으로 되돌아온다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    const stored = (await store.get('request', 'REQ-0042'))!
    const v = view({ version: stored.version })
    const next = transitionRequest(stored, 'APPROVED', 'controller', { decision })
    assert.equal((await store.compareAndSet('request', 'REQ-0042', v.version, next)).ok, true)
  })
})

// typecheck 범위 회귀 — cli·composition·schemas 가 include에서 빠졌던 적이 있고,
// 그때 "typecheck clean"은 그 셋을 보지 않은 결과였다. 다시 빠지면 여기서 잡힌다.
describe('typecheck 범위', () => {
  it('runtime source가 tsconfig include에 전부 들어 있다', async () => {
    // 검사 범위는 workspace 뿌리 하나가 정한다 — 패키지마다 따로 두면 다시 갈라진다
    const raw = await readFile(new URL('../../../tsconfig.json', import.meta.url), 'utf8')
    const include = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')).include as string[]
    for (const dir of ['core', 'ports', 'adapters', 'cli', 'composition', 'schemas', 'tests']) {
      assert.ok(
        include.some((entry) => entry.endsWith(`/${dir}`) || entry === dir),
        `${dir} 가 typecheck 대상에서 빠졌다`,
      )
    }
  })
})
