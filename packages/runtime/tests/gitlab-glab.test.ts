// P1-H Gate — 이미 로그인된 도구를 통로로 쓰되, 자격을 훔쳐 오지는 않는가.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { GitLabAdapter } from '../adapters/gitlab/adapter.ts'
import { GlabApiClient, glabAvailable, type ProcessRunner } from '../adapters/gitlab/client.ts'

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
