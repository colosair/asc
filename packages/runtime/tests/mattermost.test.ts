// B-13 Gate — 메신저 채널이 늘어도 계약은 그대로다 (C-08 §1).
//
// 실서버 E2E는 자격이 있어야 한다. 여기 있는 것은 transport를 주입한 계약 검사이며,
// 실 인스턴스 관측은 pilot 문서로 따로 남긴다 — 자동 테스트가 남의 서버 사정으로
// 깨지면 아무도 안 본다 (B-35와 같은 방침).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MattermostClient, discoverBaseUrl, discoverToken } from '../adapters/mattermost/client.ts'
import { MattermostPresentation, renderBatch, renderUrgent } from '../adapters/mattermost/presentation.ts'
import { planDigest, deliver, DeliveryLedger } from '../core/presentation/digest.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import type { DecisionSummary } from '../core/view/decision-view.ts'
import type { MattermostPost } from '../adapters/mattermost/presentation.ts'
import type { DigestBatch } from '../ports/presentation.ts'

const NOW = '2026-08-26T21:00:00+09:00'

const item = (over: Partial<DecisionSummary> = {}): DecisionSummary => ({
  requestId: 'REQ-0001',
  reference: 'o/r#19',
  title: '계약 해석 확인',
  priority: 'P1',
  status: 'AWAITING_APPROVAL',
  freshness: 'CURRENT',
  detectedAt: NOW,
  version: 0,
  ...over,
})

/** 게시를 기록하는 통로. 무엇을 보냈는지가 이 Gate의 핵심이다. */
function recorder(result: { ok: true; id: string } | { ok: false; error: string } = { ok: true, id: 'post-1' }) {
  const posts: MattermostPost[] = []
  return {
    posts,
    transport: {
      post: async (payload: MattermostPost) => {
        posts.push(payload)
        return result
      },
    },
  }
}

const batchOf = (over: Partial<DigestBatch> = {}): DigestBatch => ({
  at: NOW,
  groups: [{ priority: 'P1', items: [item()] }],
  ...over,
})

describe('B-13 Gate — Port를 바꾸지 않고 채널만 는다 (C-08 §1)', () => {
  it('묶음을 그 채널로 보낸다', async () => {
    const { posts, transport } = recorder()
    const channel = new MattermostPresentation({ transport, channelId: 'ch-1' })

    const outcome = await channel.presentDigest(batchOf())
    assert.deepEqual(outcome, { ok: true, externalRef: 'post-1' })
    assert.equal(posts[0]!.channel_id, 'ch-1')
    assert.match(posts[0]!.message, /REQ-0001/)
  })

  it('할 수 있는 것만 선언한다 — 결정 수신은 없다', () => {
    const channel = new MattermostPresentation({ transport: recorder().transport, channelId: 'ch-1' })
    assert.equal(channel.capabilities.has('presentation.digest'), true)
    assert.equal(channel.capabilities.has('presentation.priority'), true)
    assert.equal(channel.capabilities.has('approval.interactive'), false)
  })

  it('메시지에 결정 버튼이 없고 결정 경로를 안내한다 (C-08 §4)', () => {
    const message = renderBatch(batchOf())
    assert.match(message, /asc inbox decide/)
    assert.match(message, /승인 창구가 아니다/)
  })

  it('묶은 뒤 변한 것은 새 상태가 아니라 freshness로 말한다', () => {
    const message = renderBatch(batchOf({ groups: [{ priority: 'P1', items: [item({ freshness: 'SOURCE_CHANGED' })] }] }))
    assert.match(message, /SOURCE_CHANGED/)
  })

  it('걸러진 것의 수를 감추지 않는다', () => {
    const message = renderBatch(batchOf({ suppressed: { shadow: 3, alreadyDecided: 2 }, recovered: 1 }))
    assert.match(message, /숨김 3/)
    assert.match(message, /이미 결정됨 2/)
    assert.match(message, /회수 경로에서 발견 1/)
  })

  it('급한 것은 요약만 보낸다 — 전달 한 번에 조사 한 번이 딸리지 않게', async () => {
    const { posts, transport } = recorder()
    const channel = new MattermostPresentation({ transport, channelId: 'ch-1' })

    await channel.presentUrgent(item({ priority: 'P0' }))
    assert.match(posts[0]!.message, /지금 판단이 필요하다/)
    assert.match(renderUrgent(item()), /asc inbox decide/)
  })
})

describe('B-13 Gate — 전달 실패가 상태를 흔들지 않는다 (C-08 §1.3)', () => {
  it('provider가 거절하면 실패로 돌려준다', async () => {
    const { transport } = recorder({ ok: false, error: 'HTTP 403' })
    const channel = new MattermostPresentation({ transport, channelId: 'ch-1' })

    assert.deepEqual(await channel.presentDigest(batchOf()), { ok: false, error: 'HTTP 403' })
  })

  it('통로가 터져도 예외를 밖으로 던지지 않는다', async () => {
    const channel = new MattermostPresentation({
      transport: {
        post: async () => {
          throw new Error('ECONNRESET')
        },
      },
      channelId: 'ch-1',
    })

    const outcome = await channel.presentDigest(batchOf())
    assert.equal(outcome.ok, false)
    assert.match(outcome.ok === false ? outcome.error : '', /ECONNRESET/)
  })

  it('전달에 실패해도 보냈다고 기록하지 않는다', async () => {
    const store = new MemoryStateStore()
    const ledger = new DeliveryLedger(store.scope('presentation'))
    const { transport } = recorder({ ok: false, error: 'HTTP 500' })
    const channel = new MattermostPresentation({ transport, channelId: 'ch-1' })

    const plan = planDigest({ at: NOW, pending: [item()] })
    await deliver(plan, channel, ledger)

    assert.equal((await ledger.delivered(channel.id)).size, 0, '실패를 성공으로 적으면 그 건은 영영 안 간다')
  })
})

describe('B-13 Gate — 자격을 남기지 않는다 (C-11 §8)', () => {
  it('환경에서만 읽는다', () => {
    assert.equal(discoverToken({}), null)
    assert.equal(discoverToken({ MATTERMOST_TOKEN: 'tok' }), 'tok')
    assert.equal(discoverBaseUrl({ ASC_MATTERMOST_URL: 'https://mm.example.com' }), 'https://mm.example.com')
  })

  it('오류 메시지에 토큰이 섞여 나가지 않는다', async () => {
    const client = new MattermostClient({
      baseUrl: 'https://mm.example.com',
      token: 'super-secret-token',
      fetchImpl: (async () => {
        throw new Error('연결 실패: Bearer super-secret-token 로 시도함')
      }) as unknown as typeof fetch,
    })

    const result = await client.post({ channel_id: 'ch-1', message: 'hi' })
    assert.equal(result.ok, false)
    assert.doesNotMatch(result.ok === false ? result.error : '', /super-secret-token/)
    assert.match(result.ok === false ? result.error : '', /redacted/)
  })

  it('HTTP 실패는 상태 코드까지만 옮긴다 — 본문을 되비추지 않는다', async () => {
    const client = new MattermostClient({
      baseUrl: 'https://mm.example.com/',
      token: 'tok',
      fetchImpl: (async () =>
        new Response('{"detail":"token tok is invalid"}', { status: 401 })) as unknown as typeof fetch,
    })

    const result = await client.post({ channel_id: 'ch-1', message: 'hi' })
    assert.deepEqual(result, { ok: false, error: 'HTTP 401' })
  })

  it('성공하면 provider post id를 돌려준다', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    const client = new MattermostClient({
      baseUrl: 'https://mm.example.com',
      token: 'tok',
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.url = url
        seen.init = init
        return new Response(JSON.stringify({ id: 'post-9' }), { status: 200 })
      }) as unknown as typeof fetch,
    })

    assert.deepEqual(await client.post({ channel_id: 'ch-1', message: 'hi' }), { ok: true, id: 'post-9' })
    assert.equal(seen.url, 'https://mm.example.com/api/v4/posts')
  })
})
