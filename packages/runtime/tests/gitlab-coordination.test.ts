// GitLab 조율 표면 — 밖에 있는 게시물 하나를 신원으로 다루는가.
//
// 지키는 문장 넷:
//   주소가 아니라 안정 신원으로 판정한다
//   공개 payload 밖의 값은 나가지 않는다
//   찾기 실패는 "없음"이 아니다
//   쓰기 통로가 없으면 없다고 말한다

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { GitLabCoordinationSurface } from '../adapters/gitlab/coordination.ts'
import type { GitLabReader, GitLabResponse, GitLabWriter } from '../adapters/gitlab/client.ts'

const PROJECT = 'group/sub/project'

const issue = (iid: number, over: Record<string, unknown> = {}) => ({
  iid,
  title: `조율 ${iid}`,
  state: 'opened',
  web_url: `https://git.example.com/${PROJECT}/-/issues/${iid}`,
  updated_at: '2026-09-06T00:00:00Z',
  ...over,
})

function reader(routes: Record<string, unknown>, fail = false): GitLabReader & { paths: string[] } {
  const paths: string[] = []
  return {
    paths,
    async get<T>(path: string): Promise<GitLabResponse<T>> {
      paths.push(path)
      if (fail) return { ok: false, status: 500, data: null, error: 'HTTP 500' }
      const hit = Object.entries(routes).find(([key]) => path.includes(key))
      if (!hit) return { ok: false, status: 404, data: null, error: 'HTTP 404' }
      return { ok: true, status: 200, data: hit[1] as T }
    },
  }
}

function writer(): GitLabWriter & { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  return {
    bodies,
    async post<T>(_path: string, body: Record<string, unknown>): Promise<GitLabResponse<T>> {
      bodies.push(body)
      return { ok: true, status: 201, data: issue(77) as T }
    },
  }
}

describe('GitLab 조율 표면', () => {
  it('이미 아는 게시물을 신원으로 찾는다', async () => {
    const surface = new GitLabCoordinationSurface({
      reader: reader({ [`issues/133`]: issue(133), 'labels=': [] }),
      project: PROJECT,
    })

    const found = await surface.find({
      correlation: 'X-20260906-01',
      known: [{ objectType: 'issue', objectId: `${PROJECT}#133` }],
    })

    assert.equal(found.length, 1)
    assert.equal(found[0]!.matchedBy, 'known-identity')
    assert.equal(found[0]!.identity.objectId, `${PROJECT}#133`)
    // 주소는 사람이 여는 값일 뿐이고 판정에 쓰이지 않는다.
    assert.notEqual(found[0]!.identity.objectId, found[0]!.identity.locator)
  })

  it('심어 둔 상관 관계로 찾은 것은 강한 근거다', async () => {
    const surface = new GitLabCoordinationSurface({
      reader: reader({ 'labels=': [issue(133)] }),
      project: PROJECT,
    })

    const found = await surface.find({ correlation: 'X-20260906-01' })
    assert.deepEqual(
      found.map((candidate) => candidate.matchedBy),
      ['correlation'],
    )
  })

  it('작업 항목으로 훑은 것은 약한 근거로 남는다', async () => {
    const surface = new GitLabCoordinationSurface({
      reader: reader({ 'labels=': [], 'search=': [issue(140)] }),
      project: PROJECT,
    })

    const found = await surface.find({ correlation: 'X-20260906-01', workReference: 'ABC-123' })
    assert.deepEqual(
      found.map((candidate) => candidate.matchedBy),
      ['work-reference'],
    )
  })

  it('찾기가 실패하면 없다고 하지 않는다', async () => {
    const surface = new GitLabCoordinationSurface({ reader: reader({}, true), project: PROJECT })
    await assert.rejects(() => surface.find({ correlation: 'X-20260906-01' }))
  })

  it('공개 payload 와 상관 관계 라벨만 나간다', async () => {
    const post = writer()
    const surface = new GitLabCoordinationSurface({
      reader: reader({ 'issues/77': issue(77) }),
      writer: post,
      project: PROJECT,
    })

    const identity = await surface.create(
      { title: '계약 질문', body: '어느 필드에 실을까요', labels: ['back'] },
      { correlation: 'X-20260906-01', workReference: 'ABC-123' },
    )

    assert.equal(post.bodies.length, 1)
    const sent = JSON.stringify(post.bodies[0])
    assert.match(sent, /계약 질문/)
    // 작업 항목 참조는 우리가 심는 값이 아니다 — 넣으려면 공개 본문에 사람이 쓴다.
    assert.equal(sent.includes('ABC-123'), false)
    assert.match(String(post.bodies[0]!.labels), /^back,asc-coordination:X-20260906-01$/)
    assert.equal(identity.objectId, `${PROJECT}#77`)
  })

  it('쓰기 통로가 없으면 만들지 않고 그 사실을 말한다', async () => {
    const surface = new GitLabCoordinationSurface({ reader: reader({}), project: PROJECT })
    await assert.rejects(
      () => surface.create({ title: 't', body: 'b' }, { correlation: 'X-20260906-01' }),
      /no write channel/,
    )
  })

  it('되읽기는 신원만으로 선다 — 프로젝트를 따로 알려 주지 않는다', async () => {
    const read = reader({ 'issues/133': issue(133, { state: 'closed' }) })
    const surface = new GitLabCoordinationSurface({ reader: read, project: 'other/project' })

    const snapshot = await surface.read({ objectType: 'issue', objectId: `${PROJECT}#133` })
    assert.ok(snapshot)
    assert.equal(snapshot.closed, true)
    assert.match(read.paths[0]!, /group%2Fsub%2Fproject/)
  })

  it('없는 것을 읽으면 null 이다', async () => {
    const surface = new GitLabCoordinationSurface({ reader: reader({}), project: PROJECT })
    assert.equal(await surface.read({ objectType: 'issue', objectId: `${PROJECT}#999` }), null)
  })
})
