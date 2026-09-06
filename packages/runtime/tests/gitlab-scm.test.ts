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

  it('가지가 아니라 commit 을 올린다 (0.8.0 §L)', async () => {
    // 승인은 "이 브랜치" 가 아니라 그때의 그 commit 에 대한 것이었다. 이름으로 밀면
    // 승인 이후 움직인 HEAD 가 같은 명령으로 다른 내용을 내보낸다.
    const seen: string[][] = []
    const scm = scmWith(async (args) => {
      seen.push([...args])
      return { ok: true, detail: args[0] === 'rev-parse' ? 'abc123' : '' }
    })
    const result = await scm.execute({ action: 'git.push', target: 'origin feat/x', payload: '' })

    assert.equal(result.ok, true)
    assert.deepEqual(seen, [
      ['rev-parse', 'HEAD'],
      ['push', 'origin', 'abc123:refs/heads/feat/x'],
    ])
    assert.ok(result.ok && result.resultRef.includes('abc123'), '무엇이 올라갔는지가 결과에 남는다')
  })

  it('HEAD 를 읽지 못하면 이름으로 밀지 않는다', async () => {
    const scm = scmWith(async (args) => (args[0] === 'rev-parse' ? { ok: false, detail: 'not a repository' } : { ok: true, detail: '' }))
    const result = await scm.execute({ action: 'git.push', target: 'origin feat/x', payload: '' })
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error, /could not read HEAD/)
  })

  it('remote 를 생략하면 origin 이다', async () => {
    const seen: string[][] = []
    const scm = scmWith(async (args) => {
      seen.push([...args])
      return { ok: true, detail: args[0] === 'rev-parse' ? 'abc123' : '' }
    })
    await scm.execute({ action: 'git.push', target: 'feat/x', payload: '' })
    assert.deepEqual(seen, [
      ['rev-parse', 'HEAD'],
      ['push', 'origin', 'abc123:refs/heads/feat/x'],
    ])
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

// ── 0.8.0 보정 P1-2 — 나간 것을 되돌려 읽는다 ────────────────────────────────
//
// 명령이 0 으로 끝났다는 것과 밖에 그것이 있다는 것은 다르다. 되돌려 읽지 못하는 행위를
// 자율 실행 가능한 것으로 광고하지도 않는다.

describe('되돌려 읽기 (P1-2)', () => {
  const scm = (answers: Record<string, unknown> = {}) => {
    const client = fakeClient(answers)
    return {
      client,
      port: new GitLabScm({
        reader: client.reader,
        writer: { ...client.writer, async put<T>(path: string, body: Record<string, unknown>) {
          client.calls.push({ path, body })
          return (answers[path] === undefined
            ? { ok: false, status: 404, data: null, error: 'HTTP 404' }
            : { ok: true, status: 200, data: answers[path] as T }) as GitLabResponse<T>
        } },
        defaultProject: 'group/project',
      }),
    }
  }

  it('무엇을 되돌려 읽을 수 있는지 스스로 말한다', () => {
    const { port } = scm()
    for (const action of ['git.push', 'gitlab.mr.create', 'gitlab.mr.merge', 'gitlab.note.create', 'gitlab.issue.update']) {
      assert.equal(port.verifies(action), true, action)
    }
    // 조율 게시는 이 통로가 하지 않는다 — 자기가 하지 않은 일을 확인했다고 말하지 않는다.
    assert.equal(port.verifies('coordination.publish'), false)
  })

  it('T-21 — note 는 그 글이 그 자리에 그 내용으로 있는지 읽는다', async () => {
    const { port } = scm({
      '/projects/group%2Fproject/issues/7/notes/91': { id: 91, body: '작업 결과입니다' },
    })
    const read = await port.verify(
      { action: 'gitlab.note.create', target: 'group/project#7', payload: '작업 결과입니다' },
      { resultRef: 'group/project#7#note_91' },
    )
    assert.equal(read.observed['body'], '작업 결과입니다')
    assert.equal(read.observed['resource'], 'group/project')

    // 검수는 그 본문을 기대치로 미리 적어 둔다 — 실행 뒤에 기대치를 정하지 않는다.
    const facts = await port.review({ action: 'gitlab.note.create', target: 'group/project#7', payload: '작업 결과입니다' })
    assert.equal(facts.observed?.['expect.body'], '작업 결과입니다')
    assert.equal(facts.verifiable, true)
  })

  it('T-22 — issue 는 승인된 payload 의 필드가 실제로 그 값이 됐는지 읽는다', async () => {
    const { port } = scm({
      '/projects/group%2Fproject/issues/7': { state_event: 'close', labels: 'front' },
    })
    const read = await port.verify(
      { action: 'gitlab.issue.update', target: 'group/project#7', payload: JSON.stringify({ labels: 'front' }) },
      { resultRef: 'group/project#7' },
    )
    assert.equal(read.observed['issue.labels'], 'front')

    const facts = await port.review({
      action: 'gitlab.issue.update',
      target: 'group/project#7',
      payload: JSON.stringify({ labels: 'front' }),
    })
    assert.equal(facts.observed?.['expect.issue.labels'], 'front')
  })

  it('merge 는 PUT 으로 나간다 — 공식 계약이다', async () => {
    const { client, port } = scm({ '/projects/group%2Fproject/merge_requests/9/merge': { state: 'merged' } })
    const result = await port.execute({ action: 'gitlab.mr.merge', target: 'group/project!9', payload: '' })
    assert.equal(result.ok, true)
    assert.ok(client.calls.some((call) => call.path.endsWith('/merge_requests/9/merge')))
  })

  it('PUT 을 못 보내는 통로면 그렇다고 말한다 — 하는 척하지 않는다', async () => {
    const client = fakeClient()
    const port = new GitLabScm({ reader: client.reader, writer: client.writer, defaultProject: 'group/project' })
    const result = await port.execute({ action: 'gitlab.mr.merge', target: 'group/project!9', payload: '' })
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error, /cannot send PUT/)
  })
})
