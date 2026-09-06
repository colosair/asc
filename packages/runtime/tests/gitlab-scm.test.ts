// 0.7.0 / D-05 — 승인된 행위가 나갈 통로는 결합이 정한다.
//
// 조사에서 나온 사실은 두 개다. Executor 는 진작 provider-neutral 이었고(ScmPort 하나만
// 받는다), CLI 만 GitHub client 를 직접 만들고 있었다. 그래서 코드가 다른 곳에 있는
// 프로젝트에서는 승인이 끝난 **뒤에야** 실행할 통로가 없다는 것이 드러났다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { GitLabScm, GITLAB_ACTIONS } from '../adapters/gitlab/scm.ts'
import type { GitLabResponse } from '../adapters/gitlab/client.ts'

type Call = { path: string; body?: Record<string, unknown> }

function fakeClient(answers: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const respond = <T>(path: string): GitLabResponse<T> => {
    const data = answers[path]
    return data === undefined
      ? { ok: false, status: 404, data: null, error: 'HTTP 404' }
      : { ok: true, status: 200, data: data as T }
  }
  return {
    calls,
    reader: {
      async get<T>(path: string): Promise<GitLabResponse<T>> {
        calls.push({ path })
        return respond<T>(path)
      },
    },
    writer: {
      async post<T>(path: string, body: Record<string, unknown>): Promise<GitLabResponse<T>> {
        calls.push({ path, body })
        return respond<T>(path)
      },
    },
  }
}

describe('GitLab 통로가 아는 행위', () => {
  it('아는 것만 한다고 말한다', () => {
    const { reader, writer } = fakeClient()
    const scm = new GitLabScm({ reader, writer })
    for (const action of GITLAB_ACTIONS) assert.equal(scm.supports(action), true, action)
    assert.equal(scm.supports('github.issue_comment.create'), false)
    assert.equal(scm.supports('anything.else'), false)
  })

  it('모르는 행위는 수행하지 않는다', async () => {
    const { reader, writer, calls } = fakeClient()
    const scm = new GitLabScm({ reader, writer })
    const result = await scm.execute({ action: 'gitlab.unknown', target: 'g/p!1', payload: '' })
    assert.equal(result.ok, false)
    assert.deepEqual(calls, [], '모르는 행위에 밖을 치지 않는다')
  })

  it('코멘트는 승인된 본문 그대로 나간다', async () => {
    const { reader, writer, calls } = fakeClient({ '/projects/g%2Fp/merge_requests/19/notes': { id: 77 } })
    const scm = new GitLabScm({ reader, writer, defaultProject: 'g/p' })
    const result = await scm.execute({ action: 'gitlab.note.create', target: '!19', payload: '결정 근거' })

    assert.equal(result.ok, true)
    assert.deepEqual(calls[0]!.body, { body: '결정 근거' }, '본문을 다시 쓰지 않는다')
  })

  it('변경요청 생성은 필수 항목이 없으면 밖을 치지 않는다', async () => {
    const { reader, writer, calls } = fakeClient()
    const scm = new GitLabScm({ reader, writer, defaultProject: 'g/p' })
    const result = await scm.execute({
      action: 'gitlab.mr.create',
      target: 'g/p',
      payload: JSON.stringify({ source_branch: 'feat/x' }),
    })
    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : '', /target_branch/)
    assert.deepEqual(calls, [])
  })
})

describe('원격에 올리는 것도 승인된 행위 하나다', () => {
  const scmWith = (git: (args: readonly string[], cwd: string) => Promise<{ ok: boolean; detail: string }>) => {
    const { reader, writer } = fakeClient()
    return new GitLabScm({ reader, writer, defaultProject: 'g/p', repoRoot: '/repo', git })
  }

  it('가지를 올린다', async () => {
    const seen: string[][] = []
    const scm = scmWith(async (args) => {
      seen.push([...args])
      return { ok: true, detail: '' }
    })
    const result = await scm.execute({ action: 'git.push', target: 'origin feat/x', payload: '' })

    assert.equal(result.ok, true)
    assert.deepEqual(seen, [['push', 'origin', 'feat/x']])
  })

  it('remote 를 생략하면 origin 이다', async () => {
    const seen: string[][] = []
    const scm = scmWith(async (args) => {
      seen.push([...args])
      return { ok: true, detail: '' }
    })
    await scm.execute({ action: 'git.push', target: 'feat/x', payload: '' })
    assert.deepEqual(seen, [['push', 'origin', 'feat/x']])
  })

  it('되돌릴 수 없는 형태는 승인 한 번으로 열지 않는다', async () => {
    let called = false
    const scm = scmWith(async () => {
      called = true
      return { ok: true, detail: '' }
    })
    const result = await scm.execute({ action: 'git.push', target: '--force origin main', payload: '' })

    assert.equal(result.ok, false)
    assert.equal(called, false, 'flag 가 섞인 채로 git 을 부르지 않는다')
  })

  it('저장소 자리를 모르면 할 수 없다고 말한다', async () => {
    const { reader, writer } = fakeClient()
    const scm = new GitLabScm({ reader, writer, defaultProject: 'g/p' })
    const result = await scm.execute({ action: 'git.push', target: 'feat/x', payload: '' })
    assert.equal(result.ok, false)
  })
})

describe('Drift Guard 가 대조할 값', () => {
  it('스레드를 못 읽으면 missing 이다 — 변화 없음으로 적지 않는다', async () => {
    const { reader, writer } = fakeClient()
    const scm = new GitLabScm({ reader, writer, defaultProject: 'g/p' })
    const thread = await scm.getThread('!19')
    assert.equal(thread.missing, true)
  })

  it('정본 ref 를 모르면 unknown 이다', async () => {
    const { reader, writer } = fakeClient()
    const scm = new GitLabScm({ reader, writer, defaultProject: 'g/p' })
    const [baseline] = await scm.getBaselines([{ sourceId: 'develop' }])
    assert.equal(baseline!.baseline, '(unknown)')
  })
})
