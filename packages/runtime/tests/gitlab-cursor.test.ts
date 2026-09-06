// P0-M1 — 커서는 뒤로 가지 않는다. 반환 순서를 믿지 않는다.
//
// 실기계에서 본 것: 목록이 최신순으로 오는데 마지막 항목(가장 오래된 것)을 다음 기준선으로
// 삼아, 커서가 옛 시각에 고정된 채 같은 항목을 매 회차 다시 읽었다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { GitLabEventSource, laterOf } from '../adapters/gitlab/ports.ts'
import type { GitLabReader, GitLabResponse } from '../adapters/gitlab/client.ts'

const todo = (id: number, updated_at: string) => ({
  id,
  updated_at,
  action_name: 'mentioned',
  target_type: 'Issue',
  target: { iid: id, title: `t${id}` },
  project: { path_with_namespace: 'group/project' },
})

function pages(...pageData: unknown[][]): GitLabReader & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async get<T>(path: string): Promise<GitLabResponse<T>> {
      calls.push(path)
      const page = Number(new URL(`http://x${path}`).searchParams.get('page') ?? '1')
      const data = pageData[page - 1] ?? []
      const nextPage = page < pageData.length ? String(page + 1) : undefined
      return { ok: true, status: 200, data: data as T, ...(nextPage ? { nextPage } : {}) }
    },
  }
}

const since = (cursor: string | null) => (cursor ? (JSON.parse(cursor) as { since?: string }).since : undefined)

describe('GitLab todo 커서', () => {
  it('최신순 한 페이지 — 기준선은 마지막이 아니라 가장 늦은 시각이다', async () => {
    const source = new GitLabEventSource({
      client: pages([todo(3, '2026-09-06T03:00:00Z'), todo(2, '2026-09-06T02:00:00Z'), todo(1, '2026-09-06T01:00:00Z')]),
      project: 'group/project',
      perPage: 30,
    } as never)
    const batch = await source.drain(null)
    assert.equal(batch.events.length, 3)
    assert.equal(since(batch.cursor), '2026-09-06T03:00:00Z')
  })

  it('여러 페이지 — 첫 페이지의 최대값이 마지막 페이지의 옛 항목에 덮이지 않는다', async () => {
    const source = new GitLabEventSource({
      client: pages(
        [todo(5, '2026-09-06T05:00:00Z'), todo(4, '2026-09-06T04:00:00Z')],
        [todo(3, '2026-09-06T03:00:00Z'), todo(2, '2026-09-06T02:00:00Z')],
      ),
      project: 'group/project',
      perPage: 2,
    } as never)
    const first = await source.drain(null)
    assert.equal(first.hasMore, true)
    const second = await source.drain(first.cursor)
    assert.equal(second.hasMore, undefined)
    assert.equal(since(second.cursor), '2026-09-06T05:00:00Z')
  })

  it('이전 기준선이 더 늦으면 그대로다 — 뒤로 가지 않는다', async () => {
    const source = new GitLabEventSource({
      client: pages([todo(1, '2026-09-06T01:00:00Z')]),
      project: 'group/project',
      perPage: 30,
    } as never)
    const batch = await source.drain(source.cursorFrom('2026-09-06T09:00:00Z'))
    assert.deepEqual(batch.events, [], '기준선 이전 항목은 흘리지 않는다')
    assert.equal(since(batch.cursor), '2026-09-06T09:00:00Z')
  })

  it('시간대가 섞여도 시간순으로 비교한다 — 사전순이 아니다', () => {
    // 같은 순간: +09:00 표기가 사전순으로는 "더 작다"
    assert.equal(laterOf('2026-09-06T01:00:00+09:00', '2026-09-05T16:00:00Z'), '2026-09-06T01:00:00+09:00')
    // 실제로 더 늦은 Z 표기가 사전순으로는 "더 작다"
    assert.equal(laterOf('2026-09-06T02:00:00+09:00', '2026-09-05T18:00:00Z'), '2026-09-05T18:00:00Z')
    assert.equal(laterOf(undefined, 'x'), 'x')
    assert.equal(laterOf('x', undefined), 'x')
  })
})
