// B-06 Walking Skeleton Gate — 생성 → 저장 → 조회 → 명시적 결정 → atomic 전이 →
// 재결정 차단. 외부 시스템 없이 전 구간을 관통한다.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { MarkdownStateStore } from '../adapters/markdown/state-store.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { MemoryChannel } from '../adapters/memory/mocks.ts'
import { LocalIdentityBinding, UnverifiedIdentityBinding } from '../adapters/local/identity.ts'
import { ApprovalService } from '../core/approval/service.ts'
import { LocalOperator } from '../core/operator/local-operator.ts'
import { ApprovalRequest } from '../core/model/entities.ts'
import type { StateStore } from '../ports/state-store.ts'

const NOW = '2026-08-22T14:00:00+09:00'
const CONTROLLER = { 'controller-a': ['local:colosair', 'mattermost:@colosair'] }

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest =>
  ApprovalRequest.parse({
    id: 'REQ-0042',
    version: 0,
    status: 'AWAITING_APPROVAL',
    type: 'actionable',
    priority: 'P0',
    title: 'Issue #19 답변 승인 필요',
    detectedAt: '2026-08-22T10:00:00+09:00',
    source: { eventKey: 'comment:531245', reference: 'Issue #19', threadLastEventId: 'evt-7' },
    situation: '오류 봉투 계약 해석을 물어왔다',
    impact: { interruptRequired: false, affectedSessions: ['S-20260822-01'] },
    draft: 'C안으로 확정하겠습니다. 마지막 문장은 빼주세요.',
    snapshot: [{ sourceId: 'shared-spec', baseline: 'abc123' }],
    authorizedApprover: 'controller-a',
    allowedDecisions: ['approve', 'revise', 'defer', 'dismiss'],
    ...over,
  })

const serviceOn = (store: StateStore, channels: MemoryChannel[] = []) =>
  new ApprovalService({ store, identity: new LocalIdentityBinding(CONTROLLER), channels, now: () => NOW })

const humanDecision = (over: Record<string, unknown> = {}) => ({
  requestId: 'REQ-0042',
  expectedVersion: 0,
  kind: 'approve' as const,
  actor: 'colosair',
  channel: 'local',
  decidedAt: NOW,
  ...over,
})

/** 채널에 요청을 한 번 표시해 두는 준비 단계. */
async function presentOn(store: StateStore, channel: MemoryChannel): Promise<void> {
  const seen = await new LocalOperator({ store, now: () => NOW }).get('REQ-0042')
  assert.ok(seen.ok)
  await channel.present(seen.view)
}

const roots: string[] = []
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

describe('Walking Skeleton — 외부 시스템 0개', () => {
  it('생성 → 조회 → 결정 → 전이 → 재결정 차단이 파일 저장소에서 관통한다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asc-ws-'))
    roots.push(dir)
    const store = await MarkdownStateStore.open(join(dir, '.asc'))

    // 1. 생성 · 저장
    assert.equal((await store.create('request', request())).ok, true)

    // 2. 조회 — 사람이 무엇을 결정하는지 본다
    const operator = new LocalOperator({ store, now: () => NOW })
    const seen = await operator.get('REQ-0042')
    assert.ok(seen.ok)
    assert.equal(seen.view.reference, 'ASC · P0 · REQ-0042 · Issue #19')
    assert.equal(seen.view.stored.draft, 'C안으로 확정하겠습니다. 마지막 문장은 빼주세요.')

    // 3. 사람의 명시적 결정 — 읽은 version을 그대로 들고 간다
    const decided = await serviceOn(store).submit(
      humanDecision({ expectedVersion: seen.view.version, kind: 'revise', revision: 'C안으로 확정하겠습니다.' }),
    )
    assert.ok(decided.ok)
    assert.equal(decided.view.freshness, 'ALREADY_DECIDED')

    // 4. atomic 전이가 저장소에 남았다
    const stored = (await store.get('request', 'REQ-0042'))!
    assert.equal(stored.status, 'APPROVED')
    assert.equal(stored.version, 1)
    assert.equal(stored.decision?.revision, 'C안으로 확정하겠습니다.')

    // 5. 같은 요청을 다시 결정할 수 없다
    const again = await serviceOn(store).submit(humanDecision({ expectedVersion: 1, kind: 'dismiss' }))
    assert.ok(!again.ok && again.reason === 'ALREADY_DECIDED')
    assert.equal((await store.get('request', 'REQ-0042'))!.status, 'APPROVED')

    // 6. 결정은 History에 남는다
    const history = await store.readHistory()
    assert.equal(history.at(-1)?.kind, 'decision')
    assert.match(history.at(-1)!.detail!, /revise via local \(revised\)/)
  })
})

describe('사람의 명시적 결정만 통과한다 (C-01 §5)', () => {
  it('매핑되지 않은 actor는 거절되고 시도가 기록된다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())

    // Agent가 자기 이름으로 승인하려는 상황
    const outcome = await serviceOn(store).submit(humanDecision({ actor: 'assistant' }))
    assert.ok(!outcome.ok && outcome.reason === 'FORBIDDEN_ACTOR')
    assert.equal((await store.get('request', 'REQ-0042'))!.status, 'AWAITING_APPROVAL')

    const history = await store.readHistory()
    assert.equal(history.at(-1)?.kind, 'decision_rejected')
    assert.match(history.at(-1)!.detail!, /unauthorized via local/)
  })

  it('같은 이름이라도 매핑되지 않은 채널이면 거절한다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    const outcome = await serviceOn(store).submit(humanDecision({ channel: 'web' }))
    assert.ok(!outcome.ok && outcome.reason === 'FORBIDDEN_ACTOR')
  })

  it('요청이 허용하지 않은 결정은 통과하지 않는다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request({ allowedDecisions: ['approve', 'dismiss'] }))
    const outcome = await serviceOn(store).submit(humanDecision({ kind: 'defer' }))
    assert.ok(!outcome.ok && outcome.reason === 'NOT_ALLOWED_DECISION')
  })

  it('만료된 요청은 결정할 수 없다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request({ expiresAt: '2026-08-22T13:00:00+09:00' }))
    const outcome = await serviceOn(store).submit(humanDecision())
    assert.ok(!outcome.ok && outcome.reason === 'EXPIRED')
  })

  it('없는 요청은 NOT_FOUND', async () => {
    const outcome = await serviceOn(new MemoryStateStore()).submit(humanDecision())
    assert.ok(!outcome.ok && outcome.reason === 'NOT_FOUND')
  })

  it('검증을 끈 binding은 아무나 통과시킨다 — 초기 환경 전용', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    const service = new ApprovalService({ store, identity: new UnverifiedIdentityBinding(), now: () => NOW })
    assert.equal((await service.submit(humanDecision({ actor: '아무개' }))).ok, true)
  })
})

describe('CAS — 채널 간 경쟁', () => {
  it('먼저 들어온 결정만 통과하고 나머지는 이미 결정됨을 본다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    const service = serviceOn(store)

    // 두 채널이 같은 version을 읽어둔 상태에서 동시에 제출한다
    const [first, second] = await Promise.all([
      service.submit(humanDecision({ kind: 'approve', channel: 'local', actor: 'colosair' })),
      service.submit(humanDecision({ kind: 'dismiss', channel: 'mattermost', actor: '@colosair' })),
    ])

    const outcomes = [first, second]
    assert.equal(outcomes.filter((o) => o.ok).length, 1)
    const rejected = outcomes.find((o) => !o.ok)!
    assert.ok(!rejected.ok && (rejected.reason === 'ALREADY_DECIDED' || rejected.reason === 'STALE'))

    const stored = (await store.get('request', 'REQ-0042'))!
    assert.equal(stored.version, 1)
    assert.ok(stored.decision)
  })

  it('끝난 요청을 낡은 version으로 결정하려 하면 이미 결정됨을 본다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    await serviceOn(store).submit(humanDecision({ kind: 'dismiss' }))

    const stale = await serviceOn(store).submit(humanDecision({ expectedVersion: 0, kind: 'approve' }))
    assert.ok(!stale.ok && stale.reason === 'ALREADY_DECIDED')
    assert.ok('view' in stale && stale.view.stored.status === 'DISMISSED')
  })

  it('낡은 version이어도 아직 열려 있는 요청이면 다시 보라고 한다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    await serviceOn(store).submit(humanDecision({ kind: 'defer' }))

    // 보류는 끝난 것이 아니므로 '이미 결정됨'이 아니라 '다시 확인하라'가 맞다
    const stale = await serviceOn(store).submit(humanDecision({ expectedVersion: 0, kind: 'approve' }))
    assert.ok(!stale.ok && stale.reason === 'STALE')
    assert.ok('view' in stale && stale.view.stored.status === 'DEFERRED')
  })
})

describe('보류는 끝이 아니다 (OM §11.2)', () => {
  for (const [kind, expected] of [
    ['approve', 'APPROVED'],
    ['queue', 'QUEUED'],
    ['dismiss', 'DISMISSED'],
  ] as const) {
    it(`DEFERRED 에서 ${kind} 로 다시 결정할 수 있다`, async () => {
      const store = new MemoryStateStore()
      await store.create('request', request({ allowedDecisions: ['approve', 'queue', 'defer', 'dismiss'] }))

      const deferred = await serviceOn(store).submit(humanDecision({ kind: 'defer' }))
      assert.ok(deferred.ok)
      assert.equal(deferred.view.stored.status, 'DEFERRED')

      const again = await serviceOn(store).submit(humanDecision({ expectedVersion: 1, kind }))
      assert.ok(again.ok)
      const stored = (await store.get('request', 'REQ-0042'))!
      assert.equal(stored.status, expected)
      // entity의 decision은 최신 판단으로 갱신된다
      assert.equal(stored.decision?.kind, kind)
      assert.equal(stored.version, 2)

      // 이전 보류도 History에 남아 있다 — 갱신은 덮어쓰기가 아니다
      const kinds = (await store.readHistory()).filter((h) => h.kind === 'decision').map((h) => h.detail)
      assert.equal(kinds.length, 2)
      assert.match(kinds[0]!, /^defer/)
      assert.match(kinds[1]!, new RegExp(`^${kind}`))
    })
  }

  for (const terminal of ['approve', 'queue', 'dismiss'] as const) {
    it(`${terminal} 로 끝난 요청은 다시 결정할 수 없다`, async () => {
      const store = new MemoryStateStore()
      await store.create('request', request({ allowedDecisions: ['approve', 'queue', 'defer', 'dismiss'] }))
      const first = await serviceOn(store).submit(humanDecision({ kind: terminal }))
      assert.ok(first.ok)

      const again = await serviceOn(store).submit(humanDecision({ expectedVersion: 1, kind: 'defer' }))
      assert.ok(!again.ok && again.reason === 'ALREADY_DECIDED')
    })
  }
})

describe('결정 이후', () => {
  it('채널 표시 갱신은 best-effort — 실패해도 결정은 유효하다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    const channel = new MemoryChannel('mattermost', store.scope('mattermost'))
    await presentOn(store, channel)
    channel.breakUpdates()

    const outcome = await serviceOn(store, [channel]).submit(humanDecision())
    assert.ok(outcome.ok)
    assert.equal((await store.get('request', 'REQ-0042'))!.status, 'APPROVED')
  })

  it('살아 있는 채널에는 바뀐 상태가 전달된다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    const channel = new MemoryChannel('mattermost', store.scope('mattermost'))
    await presentOn(store, channel)

    await serviceOn(store, [channel]).submit(humanDecision())
    assert.equal(channel.updated.length, 1)
    assert.equal(channel.updated[0]!.freshness, 'ALREADY_DECIDED')
  })

  it('승인은 외부 반영이 아니다 — 결과 참조는 비어 있다', async () => {
    const store = new MemoryStateStore()
    await store.create('request', request())
    const outcome = await serviceOn(store).submit(humanDecision())
    assert.ok(outcome.ok)
    // 게시는 Execution Grant를 쥔 Executor만 한다 (B-07)
    assert.equal(outcome.view.resultRef, undefined)
    assert.equal((await store.get('request', 'REQ-0042'))!.resultRef, undefined)
  })
})
