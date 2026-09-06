// 0.7.0 / §18 — 발급에서 실행까지가 한 줄로 이어지는가.
//
// 조사에서 CI 가 놓친 이유는 커버리지가 아니라 **검사 경계**였다. Core 함수는 검사되고,
// 조립과 그 사이의 연결이 검사 밖이었다. 여기서는 계약 발급 → 통로 해석 → 실행 →
// 소비까지를 한 프로세스 안에서 잇는다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { Executor } from '../core/execution/executor.ts'
import { GrantService } from '../core/execution/grant.ts'
import { GitLabScm } from '../adapters/gitlab/scm.ts'
import { Session } from '../core/model/entities.ts'
import type { GitLabResponse } from '../adapters/gitlab/client.ts'
import type { IdentityBinding } from '../ports/approval.ts'

const NOW = '2026-09-06T00:00:00.000Z'
const SESSION = 'S-20260906-01'

const approver: IdentityBinding = {
  async verify({ actor, authorizedApprover }) {
    return actor === 'colosair' && authorizedApprover === 'colosair'
  },
}

function surface(answers: Record<string, unknown>) {
  const calls: { path: string; body?: Record<string, unknown> }[] = []
  const respond = <T>(path: string): GitLabResponse<T> =>
    answers[path] === undefined
      ? { ok: false, status: 404, data: null, error: 'HTTP 404' }
      : { ok: true, status: 200, data: answers[path] as T }
  return {
    calls,
    client: {
      async get<T>(path: string): Promise<GitLabResponse<T>> {
        calls.push({ path })
        return respond<T>(path)
      },
      async post<T>(path: string, body: Record<string, unknown>): Promise<GitLabResponse<T>> {
        calls.push({ path, body })
        return respond<T>(path)
      },
    },
  }
}

async function attachedSession(store: MemoryStateStore) {
  await store.create(
    'session',
    Session.parse({
      id: SESSION,
      version: 1,
      status: 'ACTIVE',
      role: 'implementer',
      goal: 'WorldHud 조작 안내',
      doneCriteria: ['4항이 보인다'],
      writeBoundary: ['fe/**'],
    }),
  )
}

describe('세션 결과가 밖으로 나가는 한 바퀴', () => {
  it('발급 → 통로 → 실행 → 소비', async () => {
    const store = new MemoryStateStore()
    await attachedSession(store)
    const { client, calls } = surface({ '/projects/g%2Fp/merge_requests/19/notes': { id: 77 } })
    const scm = new GitLabScm({ reader: client, writer: client, defaultProject: 'g/p' })

    const issued = await new GrantService(store, approver).issueForSession({
      grantId: 'G-0001',
      sessionId: SESSION,
      issuedBy: 'colosair',
      channel: 'local',
      action: 'gitlab.note.create',
      target: 'g/p!19',
      payload: '작업 결과입니다',
      issuedAt: NOW,
    })
    assert.equal(issued.ok, true)

    const outcome = await new Executor({ store, scm, runId: 'run-1' }).run('G-0001')
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
    assert.deepEqual(calls.at(-1)!.body, { body: '작업 결과입니다' }, '승인된 내용 그대로 나간다')

    // 한 번 쓴 계약은 다시 쓰이지 않는다
    const again = await new Executor({ store, scm, runId: 'run-2' }).run('G-0001')
    assert.equal(again.ok, false)
    assert.equal(again.ok === false && again.reason, 'NOT_CLAIMABLE')
  })

  it('통로가 모르는 행위는 실행에서 막히고 계약이 무효가 된다', async () => {
    const store = new MemoryStateStore()
    await attachedSession(store)
    const { client, calls } = surface({})
    const scm = new GitLabScm({ reader: client, writer: client, defaultProject: 'g/p' })

    await new GrantService(store, approver).issueForSession({
      grantId: 'G-0002',
      sessionId: SESSION,
      issuedBy: 'colosair',
      channel: 'local',
      action: 'github.issue_comment.create',
      target: 'g/p!19',
      payload: 'x',
      issuedAt: NOW,
    })

    const outcome = await new Executor({ store, scm, runId: 'run-1' }).run('G-0002')
    assert.equal(outcome.ok, false)
    assert.deepEqual(calls, [], '모르는 행위에 밖을 치지 않는다')
    // 발급 시점에 `supports()` 가 이것을 먼저 막는다 — 여기까지 오는 것은 통로가 바뀐 경우다.
    assert.equal(scm.supports('github.issue_comment.create'), false)
  })

  it('승인 이후 대상이 움직였으면 실행하지 않는다', async () => {
    const store = new MemoryStateStore()
    await attachedSession(store)
    const { client } = surface({
      '/projects/g%2Fp/merge_requests/19/notes?per_page=1&sort=desc': [{ id: 99 }],
      '/projects/g%2Fp/merge_requests/19/notes': { id: 77 },
    })
    const scm = new GitLabScm({ reader: client, writer: client, defaultProject: 'g/p' })

    await new GrantService(store, approver).issueForSession({
      grantId: 'G-0003',
      sessionId: SESSION,
      issuedBy: 'colosair',
      channel: 'local',
      action: 'gitlab.note.create',
      target: 'g/p!19',
      payload: 'x',
      issuedAt: NOW,
    })
    // 승인 시점의 스레드 상태를 계약에 박아 둔다
    const grant = (await store.get('grant', 'G-0003'))!
    await store.compareAndSet('grant', 'G-0003', grant.version, {
      ...grant,
      version: grant.version + 1,
      threadLastEventId: '42',
    })

    const outcome = await new Executor({ store, scm, runId: 'run-1' }).run('G-0003')
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.reason, 'DRIFT')
  })
})
