// P1-H Gate — 이미 로그인된 도구를 통로로 쓰되, 자격을 훔쳐 오지는 않는가.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { GitLabAdapter } from '../adapters/gitlab/adapter.ts'
import { GlabApiClient, glabAvailable, hostOf, type ProcessRunner } from '../adapters/gitlab/client.ts'

const candidate = {
  adapterId: 'gitlab',
  resource: 'group/project',
  provides: ['context.change'] as const,
  discoveredBy: 'test',
}

const runner = (answers: Record<string, string>): ProcessRunner & { calls: string[] } => {
  const calls: string[] = []
  const fn = (async (command: string, args: readonly string[]) => {
    const key = [command, ...args].join(' ')
    calls.push(key)
    if (key in answers) return answers[key]!
    throw new Error(`not logged in: ${key}`)
  }) as ProcessRunner & { calls: string[] }
  fn.calls = calls
  return fn
}

describe('P1-H — 토큰이 없어도 로그인된 glab 는 통로다', () => {
  it('토큰이 없고 glab 가 로그인돼 있으면 UNCONFIGURED 로 닫지 않는다', async () => {
    const adapter = new GitLabAdapter({
      findToken: () => null,
      run: runner({ 'glab auth status': 'logged in' }),
    })

    const result = await adapter.probe(candidate as never, { projectRoot: '/x', env: {} })

    assert.equal(result.state, 'DEGRADED')
    assert.match(result.detail ?? '', /glab/)
  })

  it('토큰도 glab 도 없으면 무엇을 하면 되는지 말한다', async () => {
    const adapter = new GitLabAdapter({ findToken: () => null, run: runner({}) })

    const result = await adapter.probe(candidate as never, { projectRoot: '/x', env: {} })

    assert.equal(result.state, 'UNCONFIGURED')
    assert.match(result.detail ?? '', /glab auth login/)
  })

  it('토큰이 있으면 그쪽이 먼저다 — 명시한 것이 추론보다 앞선다', async () => {
    const run = runner({ 'glab auth status': 'logged in' })
    const adapter = new GitLabAdapter({
      findToken: () => 'token-value',
      reach: async () => ({ ok: true }),
      run,
    })

    const result = await adapter.probe(candidate as never, { projectRoot: '/x', env: {} })

    assert.equal(result.state, 'AVAILABLE')
    assert.deepEqual(run.calls, [], 'glab 를 먼저 물었다')
  })

  it('glab 통로는 읽기만 하고, 자격을 꺼내 오지 않는다', async () => {
    const run = runner({ 'glab api projects/1': '{"id":1}' })
    const client = new GlabApiClient(run)

    const response = await client.get<{ id: number }>('/projects/1')

    assert.equal(response.ok, true)
    assert.deepEqual(response.data, { id: 1 })
    // 토큰을 묻는 명령은 어디에도 없다.
    assert.ok(run.calls.every((call) => !call.includes('token')))
  })

  it('로그인돼 있지 않으면 있다고 하지 않는다', async () => {
    assert.equal(await glabAvailable(runner({})), false)
  })
})

// 0.9.0 — glab 은 host 를 cwd 의 git 컨텍스트에서 추론한다. ASC 는 발견 단계에서 결합의 host 를
// 이미 알고 있으므로 그 값을 넘긴다. 실측: 자체 호스팅 host 에만 로그인된 기계에서 hook·홈
// 디렉터리 cwd 로 돌린 `glab auth status` 는 gitlab.com 을 물어 exit 1 이었고, 결합이
// UNCONFIGURED 로 읽혀 `asc work publish` 가 "통로가 없다" 로 끝났다.
describe('0.9.0 — 자체 호스팅 host 는 glab 에게 이름으로 말한다', () => {
  const remotes = [
    { name: 'origin', url: 'git@lab.example.com:group/project.git' },
    { name: 'mirror', url: 'https://github.com/group/project.git' },
  ]

  it('probe 가 발견한 host 로 `glab auth status --hostname <host>` 를 묻는다', async () => {
    const run = runner({ 'glab auth status --hostname lab.example.com': 'logged in' })
    const adapter = new GitLabAdapter({ listRemotes: async () => remotes, findToken: () => null, run })
    const [found] = await adapter.discover({ projectRoot: '/x', env: {} })
    assert.equal(found?.resource, 'group/project')

    const result = await adapter.probe(found!, { projectRoot: '/x', env: {} })
    assert.equal(result.state, 'DEGRADED')
    assert.deepEqual(run.calls, ['glab auth status --hostname lab.example.com'])
  })

  it('glab api 도 같은 host 로 간다 — cwd 가 어디든', async () => {
    const run = runner({ 'glab api --hostname lab.example.com projects/1': '{"id":1}' })
    const client = new GlabApiClient(run, 'lab.example.com')
    const response = await client.get<{ id: number }>('/projects/1')
    assert.equal(response.ok, true)
    assert.deepEqual(run.calls, ['glab api --hostname lab.example.com projects/1'])
  })

  it('host 를 모르면 붙이지 않는다 — 추측하지 않는다', async () => {
    const run = runner({ 'glab auth status': 'logged in' })
    assert.equal(await glabAvailable(run), true)
    assert.deepEqual(run.calls, ['glab auth status'])
    assert.equal(hostOf(undefined), undefined)
    assert.equal(hostOf('not a url'), undefined)
    assert.equal(hostOf('https://lab.example.com/api/v4'), 'lab.example.com')
  })

  it('발견 단계가 remote 이름과 host 를 함께 기억한다 — 조립이 그대로 잇는다', async () => {
    const adapter = new GitLabAdapter({ listRemotes: async () => remotes, findToken: () => null, run: runner({}) })
    await adapter.discover({ projectRoot: '/x', env: {} })
    assert.equal(adapter.endpointFor('group/project'), 'https://lab.example.com/api/v4')
    assert.equal(adapter.remoteFor('group/project'), 'origin')
    assert.equal(adapter.remoteFor('nope'), undefined)
  })

  it('ASC_GITLAB_URL 은 조립까지 같은 값으로 간다 — probe 만 보던 override 가 아니다', async () => {
    const adapter = new GitLabAdapter({ listRemotes: async () => remotes, findToken: () => null, run: runner({}) })
    await adapter.discover({ projectRoot: '/x', env: { ASC_GITLAB_URL: 'https://lab.internal/api/v4' } })
    assert.equal(adapter.endpointFor('group/project'), 'https://lab.internal/api/v4')
  })
})
