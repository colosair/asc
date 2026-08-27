// B-08 Gate — event key가 안정적이라 exact lookup으로 중복이 걸리는지, cursor가
// 다음 조회를 좁히는지, 실패가 조용히 넘어가지 않는지.
//
// fetch를 주입해 fixture로 검증한다. 실 네트워크에 기대는 테스트는 남의 사정으로 깨지고,
// 그러면 아무도 안 보게 된다. 실 저장소 대상 확인은 scripts/github-probe.ts 로 따로 한다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { GitHubClient, type Fetch } from '../adapters/github/client.ts'
import { GitHubEventSource, parseCursor } from '../adapters/github/event-source.ts'
import { GitHubScm, parseThreadRef } from '../adapters/github/scm.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { EventKey } from '../core/model/ids.ts'

type Route = { status?: number; body?: unknown; headers?: Record<string, string> }

/** 경로 접두사로 응답을 고르는 fetch. 호출 기록도 남긴다. */
function fakeFetch(routes: Record<string, Route | Route[]>): Fetch & { calls: string[] } {
  const calls: string[] = []
  const remaining = new Map<string, Route[]>(
    Object.entries(routes).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]),
  )

  const fn = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    // 가장 구체적인(긴) 키를 고른다 — `/issues/19` 가 `/issues/19/comments` 를 가로채지 않게
    const key = [...remaining.keys()].filter((k) => url.includes(k)).sort((a, b) => b.length - a.length)[0]
    const queue = key ? remaining.get(key)! : []
    const route = queue.length > 1 ? queue.shift()! : (queue[0] ?? { status: 404, body: { message: 'not found' } })
    const status = route.status ?? 200
    return new Response(status === 304 ? null : JSON.stringify(route.body ?? []), {
      status,
      headers: { 'content-type': 'application/json', ...route.headers },
    })
  }) as Fetch & { calls: string[] }
  fn.calls = calls
  return fn
}

const clientWith = (fetch: Fetch) => new GitHubClient({ token: 'test-token', fetch })

const notification = (id: string, updatedAt: string) => ({
  id,
  updated_at: updatedAt,
  reason: 'mention',
  subject: { title: '답변 요청', type: 'Issue', url: 'https://api.github.com/repos/o/r/issues/19' },
  repository: { full_name: 'o/r' },
})

const comment = (id: number, updatedAt: string, issue = 19) => ({
  id,
  created_at: updatedAt,
  updated_at: updatedAt,
  html_url: `https://github.com/o/r/issues/${issue}#issuecomment-${id}`,
  user: { login: 'strdeok' },
  body: '계약 해석을 묻습니다',
  issue_url: `https://api.github.com/repos/o/r/issues/${issue}`,
})

describe('Event Source — 수집', () => {
  it('세 갈래를 모아 event key 규칙에 맞는 이벤트를 낸다', async () => {
    const fetch = fakeFetch({
      '/notifications': { body: [notification('9001', '2026-08-22T10:00:00Z')] },
      '/issues/comments': { body: [comment(531245, '2026-08-22T10:05:00Z')] },
      '/pulls/comments': {
        body: [
          {
            ...comment(778899, '2026-08-22T10:10:00Z'),
            pull_request_url: 'https://api.github.com/repos/o/r/pulls/50',
          },
        ],
      },
    })
    const source = new GitHubEventSource({ client: clientWith(fetch), repo: 'o/r' })

    const batch = await source.drain(null)
    assert.deepEqual(batch.events.map((e) => e.eventKey), [
      'notification:9001:2026-08-22T10:00:00Z',
      'comment:531245',
      'review_comment:778899',
    ])
    // 전부 정본이 정한 형식을 지킨다 (OM §10.4)
    for (const event of batch.events) assert.equal(EventKey.safeParse(event.eventKey).success, true, event.eventKey)

    // 사람이 읽는 참조가 붙어 조회 없이도 어디 일인지 알 수 있다
    assert.deepEqual(batch.events.map((e) => e.reference), ['o/r#19', 'o/r#19', 'o/r#50'])
    assert.deepEqual(batch.events.map((e) => e.detectedAt).sort(), batch.events.map((e) => e.detectedAt))
  })

  it('우선순위를 매기지 않는다 — 그건 Monitor 몫이다', async () => {
    const fetch = fakeFetch({ '/notifications': { body: [notification('9001', '2026-08-22T10:00:00Z')] } })
    const batch = await new GitHubEventSource({ client: clientWith(fetch), repo: 'o/r' }).drain(null)
    assert.equal(batch.events[0]!.hints?.priority, undefined)
    assert.equal(batch.events[0]!.hints?.type, undefined)
  })

  it('감지가 사람의 읽음 처리에 좌우되지 않는다', async () => {
    const fetch = fakeFetch({ '/notifications': { body: [] }, '/issues/comments': { body: [] }, '/pulls/comments': { body: [] } })
    await new GitHubEventSource({ client: clientWith(fetch), repo: 'o/r' }).drain(null)
    // 웹에서 먼저 읽었다는 이유로 사건을 놓치면 안 된다
    assert.ok(fetch.calls.some((url) => url.includes('/repos/o/r/notifications') && url.includes('all=true')))
  })

  it('cursor는 기준선을 밀지 않는다 — 겹쳐 받고 key로 거른다', async () => {
    const fetch = fakeFetch({
      '/notifications': { body: [notification('9001', '2026-08-22T10:00:00Z')] },
      '/issues/comments': { body: [comment(531245, '2026-08-22T10:05:00Z')] },
      '/pulls/comments': { body: [] },
    })
    const source = new GitHubEventSource({ client: clientWith(fetch), repo: 'o/r' })

    const first = await source.drain(null)
    const cursor = parseCursor(first.cursor)
    // 앞으로 밀면 같은 시각에 달린 다른 댓글이 사라지고, 정확히 맞춰도 그 직후 같은 초에
    // 달린 것을 놓친다. 그래서 뒤로 겹쳐 잡는다.
    assert.equal(cursor.commentsSince, '2026-08-22T10:04:59.000Z')
    assert.equal(cursor.notificationsSince, '2026-08-22T09:59:59.000Z')
    assert.equal(cursor.commentsPage, undefined)

    await source.drain(first.cursor)
    assert.ok(fetch.calls.some((url) => url.includes('since=2026-08-22T10:04:59')))
  })

  it('sweep 직후 같은 초에 생긴 이벤트를 다음 회차가 잡는다', async () => {
    const existing = comment(1, '2026-08-22T10:05:00Z')
    const bornSameSecond = comment(2, '2026-08-22T10:05:00Z')

    const fetch = fakeFetch({
      '/notifications': { body: [] },
      '/pulls/comments': { body: [] },
      '/issues/comments': [{ body: [existing] }, { body: [existing, bornSameSecond] }],
    })
    const source = new GitHubEventSource({ client: clientWith(fetch), repo: 'o/r', perPage: 10 })

    const first = await source.drain(null)
    assert.deepEqual(first.events.map((e) => e.eventKey), ['comment:1'])

    // 1회차 직후, 같은 초에 새 댓글이 달렸다
    const second = await source.drain(first.cursor)
    const keys = second.events.map((e) => e.eventKey)
    assert.ok(keys.includes('comment:2'), '같은 초에 생긴 이벤트를 놓쳤다')
    // 겹쳐 읽은 만큼 이미 본 것도 다시 온다 — 그건 key로 거른다
    assert.ok(keys.includes('comment:1'))
  })

  it('같은 시각 이벤트가 한 페이지를 넘겨도 전부 회수한다', async () => {
    const sameMoment = '2026-08-22T10:05:00Z'
    const fetch = fakeFetch({
      '/notifications': { body: [] },
      '/pulls/comments': { body: [] },
      '/issues/comments': [
        // 첫 페이지가 꽉 찼다 = 뒤에 더 있다
        { body: [comment(1, sameMoment), comment(2, sameMoment)] },
        { body: [comment(3, sameMoment), comment(4, sameMoment)] },
        { body: [comment(5, sameMoment)] },
      ],
    })
    const source = new GitHubEventSource({ client: clientWith(fetch), repo: 'o/r', perPage: 2 })

    const collected: string[] = []
    let cursor = null as string | null
    for (let round = 0; round < 3; round++) {
      const batch = await source.drain(cursor)
      collected.push(...batch.events.map((e) => e.eventKey))
      cursor = batch.cursor
      const state = parseCursor(cursor)
      // 다 읽기 전에는 기준선을 옮기지 않는다
      if (round < 2) assert.equal(state.commentsPage, round + 2, `round ${round}`)
      else assert.equal(state.commentsPage, undefined)
    }
    // 같은 시각 5건이 한 건도 빠지지 않는다
    assert.deepEqual(collected, ['comment:1', 'comment:2', 'comment:3', 'comment:4', 'comment:5'])
    // 다 읽은 뒤에야 기준선이 옮겨가고, 그것도 겹치도록 뒤로 잡는다
    assert.equal(parseCursor(cursor).commentsSince, '2026-08-22T10:04:59.000Z')
  })

  it('알림도 페이지를 이어받아 한 건도 흘리지 않는다', async () => {
    const at = (n: number) => `2026-08-22T10:0${n}:00Z`
    const fetch = fakeFetch({
      '/issues/comments': { body: [] },
      '/pulls/comments': { body: [] },
      '/notifications': [
        { body: [notification('n1', at(1)), notification('n2', at(2))] },
        { body: [notification('n3', at(3)), notification('n4', at(4))] },
        { body: [notification('n5', at(5))] },
      ],
    })
    const source = new GitHubEventSource({ client: clientWith(fetch), repo: 'o/r', perPage: 2 })

    const collected: string[] = []
    let cursor = null as string | null
    for (let round = 0; round < 3; round++) {
      const batch = await source.drain(cursor)
      collected.push(...batch.events.map((e) => e.eventKey))
      cursor = batch.cursor
      const state = parseCursor(cursor)
      if (round < 2) {
        assert.equal(state.notificationsPage, round + 2, `round ${round}`)
        assert.equal(batch.hasMore, true)
      } else {
        assert.equal(state.notificationsPage, undefined)
        assert.equal(batch.hasMore, false)
      }
    }
    assert.deepEqual(collected, ['n1', 'n2', 'n3', 'n4', 'n5'].map((id) => `notification:${id}:${at(Number(id[1]))}`))
    // 다 읽은 뒤에야 기준선이 옮겨간다 — 그것도 겹쳐서
    assert.equal(parseCursor(cursor).notificationsSince, '2026-08-22T10:04:59.000Z')
  })

  it('페이지를 이어받는 중에는 조건부 요청을 쓰지 않는다', async () => {
    const fetch = fakeFetch({
      '/issues/comments': { body: [] },
      '/pulls/comments': { body: [] },
      '/notifications': {
        body: [notification('n1', '2026-08-22T10:01:00Z'), notification('n2', '2026-08-22T10:02:00Z')],
        headers: { 'last-modified': 'Sat, 22 Aug 2026 10:02:00 GMT' },
      },
    })
    const source = new GitHubEventSource({ client: clientWith(fetch), repo: 'o/r', perPage: 2 })

    const first = await source.drain(null)
    // 아직 다 못 읽었으므로 조건부 요청 기준을 세우지 않는다 — 304가 오면 남은 페이지를 잃는다
    assert.equal(parseCursor(first.cursor).notificationsLastModified, undefined)
    assert.equal(parseCursor(first.cursor).notificationsPage, 2)
  })

  it('조용한 구간의 304는 실패가 아니라 값싼 대답이다', async () => {
    const fetch = fakeFetch({
      '/notifications': { status: 304, headers: { 'last-modified': 'Fri, 22 Aug 2026 10:00:00 GMT' } },
      '/issues/comments': { body: [] },
      '/pulls/comments': { body: [] },
    })
    const batch = await new GitHubEventSource({ client: clientWith(fetch), repo: 'o/r' }).drain(null)
    assert.deepEqual(batch.events, [])
  })

  it('한 갈래가 실패해도 나머지는 살린다 — 다음 회차가 다시 받는다', async () => {
    const fetch = fakeFetch({
      '/notifications': { status: 500, body: { message: 'server error' } },
      '/issues/comments': { body: [comment(531245, '2026-08-22T10:05:00Z')] },
      '/pulls/comments': { body: [] },
    })
    const batch = await new GitHubEventSource({ client: clientWith(fetch), repo: 'o/r' }).drain(null)
    assert.deepEqual(batch.events.map((e) => e.eventKey), ['comment:531245'])
    // 실패한 갈래의 기준선은 전진하지 않는다
    assert.equal(parseCursor(batch.cursor).notificationsSince, undefined)
  })

  it('망가진 cursor는 처음부터 다시 받는 것으로 취급한다', () => {
    assert.deepEqual(parseCursor('{not json'), {})
    assert.deepEqual(parseCursor(null), {})
  })
})

describe('event key exact dedupe', () => {
  it('같은 댓글은 몇 번을 받아도 같은 key다', async () => {
    const fetch = fakeFetch({
      '/notifications': { body: [] },
      '/issues/comments': { body: [comment(531245, '2026-08-22T10:05:00Z')] },
      '/pulls/comments': { body: [] },
    })
    const source = new GitHubEventSource({ client: clientWith(fetch), repo: 'o/r' })

    const first = await source.drain(null)
    const second = await source.drain(null)
    assert.equal(first.events[0]!.eventKey, second.events[0]!.eventKey)
  })

  it('저장된 key와 대조해 신규·중복·재시도를 가른다', async () => {
    const store = new MemoryStateStore()
    const fetch = fakeFetch({
      '/notifications': { body: [] },
      '/issues/comments': { body: [comment(531245, '2026-08-22T10:05:00Z')] },
      '/pulls/comments': { body: [] },
    })
    const source = new GitHubEventSource({ client: clientWith(fetch), repo: 'o/r' })

    // 1회차 — 처음 보는 key라 신규다
    const first = (await source.drain(null)).events[0]!
    assert.equal(await store.get('event', first.eventKey), null)
    await store.create('event', {
      eventKey: first.eventKey,
      version: 0,
      detectedAt: first.detectedAt,
      type: 'actionable',
      suggestedPriority: 'P1',
      processing: 'PROCESSED',
      inboxCandidate: true,
    })

    // 2회차 — 같은 댓글이 다시 왔다. log를 훑지 않고 key 하나로 걸린다
    const again = (await source.drain(null)).events[0]!
    const known = await store.get('event', again.eventKey)
    assert.ok(known)
    assert.equal(known.processing, 'PROCESSED')

    // 재시도 대상은 저장된 상태로 구분된다 — 다시 받아도 처리 이력이 남아 있다
    const current = (await store.get('event', again.eventKey))!
    await store.compareAndSet('event', again.eventKey, current.version, {
      ...current,
      version: current.version + 1,
      processing: 'PENDING_RETRY',
    })
    assert.equal((await store.get('event', again.eventKey))!.processing, 'PENDING_RETRY')
  })
})

describe('SCM — 읽기', () => {
  it('스레드 참조를 쪼갠다', () => {
    assert.deepEqual(parseThreadRef('owner/repo#19'), { owner: 'owner', repo: 'repo', number: 19 })
    assert.equal(parseThreadRef('그냥 문자열'), null)
  })

  it('표식은 이슈 갱신·댓글 수·마지막 댓글을 함께 담는다', async () => {
    const fetch = fakeFetch({
      '/issues/19/comments': { body: [comment(2, '2026-08-22T10:00:00Z')] },
      '/issues/19': { body: { updated_at: '2026-08-22T10:00:00Z', comments: 2 } },
    })
    const scm = new GitHubScm({ client: clientWith(fetch) })
    const thread = await scm.getThread('o/r#19')
    assert.equal(thread.lastEventId, 'issue:2026-08-22T10:00:00Z|c2|2:2026-08-22T10:00:00Z')
    assert.equal(thread.missing, undefined)
    // 마지막 댓글은 첫 페이지가 아니라 마지막 페이지에서 집는다
    assert.ok(fetch.calls.some((url) => url.includes('per_page=1&page=2')))
  })

  it('댓글이 100개를 넘어도 마지막 것을 본다', async () => {
    const fetch = fakeFetch({
      '/issues/19/comments': { body: [comment(9999, '2026-08-22T12:00:00Z')] },
      '/issues/19': { body: { updated_at: '2026-08-22T12:00:00Z', comments: 101 } },
    })
    const scm = new GitHubScm({ client: clientWith(fetch) })
    const thread = await scm.getThread('o/r#19')
    // 첫 페이지만 봤다면 101번째 댓글은 표식에 잡히지 않는다
    assert.match(thread.lastEventId, /\|c101\|9999:/)
    assert.ok(fetch.calls.some((url) => url.includes('page=101')))
  })

  it('제목·본문만 바뀌어도 표식이 달라진다', async () => {
    const before = fakeFetch({
      '/issues/19/comments': { body: [comment(2, '2026-08-22T10:00:00Z')] },
      '/issues/19': { body: { updated_at: '2026-08-22T10:00:00Z', comments: 2 } },
    })
    const after = fakeFetch({
      '/issues/19/comments': { body: [comment(2, '2026-08-22T10:00:00Z')] },
      // 댓글은 그대로인데 이슈 본문이 수정됐다
      '/issues/19': { body: { updated_at: '2026-08-22T13:00:00Z', comments: 2 } },
    })
    const first = await new GitHubScm({ client: clientWith(before) }).getThread('o/r#19')
    const second = await new GitHubScm({ client: clientWith(after) }).getThread('o/r#19')
    assert.notEqual(first.lastEventId, second.lastEventId)
  })

  it('댓글이 없으면 이슈 갱신 시각과 개수만으로 표식을 만든다', async () => {
    const fetch = fakeFetch({ '/issues/19': { body: { updated_at: '2026-08-22T09:00:00Z', comments: 0 } } })
    const scm = new GitHubScm({ client: clientWith(fetch) })
    assert.equal((await scm.getThread('o/r#19')).lastEventId, 'issue:2026-08-22T09:00:00Z|c0')
  })

  it('댓글이 있다는데 못 읽으면 안다고 답하지 않는다', async () => {
    const fetch = fakeFetch({
      '/issues/19': { body: { updated_at: '2026-08-22T10:00:00Z', comments: 5 } },
      '/issues/19/comments': { status: 500, body: { message: 'server error' } },
    })
    const thread = await new GitHubScm({ client: clientWith(fetch) }).getThread('o/r#19')
    assert.equal(thread.missing, true)
  })

  it('읽지 못하면 변화 없음이 아니라 missing이다', async () => {
    // 모르는 것을 안다고 답하면 Drift Guard가 통과해버린다
    const fetch = fakeFetch({ '/issues/999': { status: 404, body: { message: 'Not Found' } } })
    const scm = new GitHubScm({ client: clientWith(fetch) })
    assert.equal((await scm.getThread('o/r#999')).missing, true)
    assert.equal((await scm.getThread('형식이 틀린 참조')).missing, true)
  })

  it('source별 baseline을 각자의 ref에서 읽는다', async () => {
    const fetch = fakeFetch({ '/commits/': { body: { sha: 'abc123def' } } })
    const scm = new GitHubScm({
      client: clientWith(fetch),
      defaultRepo: 'o/r',
      sourceRefs: { 'shared-spec': { ref: 'develop' }, 'fe-plan': { ref: 'front' } },
    })
    assert.deepEqual(await scm.getBaselines([{ sourceId: 'shared-spec' }, { sourceId: 'fe-plan' }]), [
      { sourceId: 'shared-spec', baseline: 'abc123def' },
      { sourceId: 'fe-plan', baseline: 'abc123def' },
    ])
    assert.ok(fetch.calls.some((u) => u.includes('/commits/develop')))
    assert.ok(fetch.calls.some((u) => u.includes('/commits/front')))
  })

  it('설정되지 않은 source는 unknown으로 남는다', async () => {
    const scm = new GitHubScm({ client: clientWith(fakeFetch({})), defaultRepo: 'o/r' })
    assert.deepEqual(await scm.getBaselines([{ sourceId: '모르는-소스' }]), [
      { sourceId: '모르는-소스', baseline: 'unknown' },
    ])
  })
})

describe('SCM — 쓰기 경계', () => {
  it('아는 행위만 수행한다', async () => {
    const fetch = fakeFetch({ '/comments': { status: 201, body: { html_url: 'https://github.com/o/r/issues/19#c1' } } })
    const scm = new GitHubScm({ client: clientWith(fetch) })

    const unknown = await scm.execute({ action: 'github.repo.delete', target: 'o/r#19', payload: 'x' })
    assert.ok(!unknown.ok && unknown.error.includes('unsupported action'))
    assert.equal(fetch.calls.length, 0)

    const known = await scm.execute({ action: 'github.issue_comment.create', target: 'o/r#19', payload: '답변' })
    assert.ok(known.ok)
    assert.equal(known.resultRef, 'https://github.com/o/r/issues/19#c1')
  })

  it('대상을 못 알아들으면 아무것도 하지 않는다', async () => {
    const fetch = fakeFetch({})
    const scm = new GitHubScm({ client: clientWith(fetch) })
    const outcome = await scm.execute({ action: 'github.issue_comment.create', target: '??', payload: 'x' })
    assert.ok(!outcome.ok)
    assert.equal(fetch.calls.length, 0)
  })

  it('실패는 결과값으로 온다', async () => {
    const fetch = fakeFetch({ '/comments': { status: 403, body: { message: 'Resource not accessible' } } })
    const scm = new GitHubScm({ client: clientWith(fetch) })
    const outcome = await scm.execute({ action: 'github.issue_comment.create', target: 'o/r#19', payload: '답변' })
    assert.ok(!outcome.ok && outcome.error.includes('Resource not accessible'))
  })
})
