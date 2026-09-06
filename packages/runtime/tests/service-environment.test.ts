// P0-R1 — 등록된 서비스는 로그인 셸의 PATH 를 물려받지 않는다. 그래서 필요한 것을 실어 보낸다.
//
// 지키는 문장 셋:
//   셸의 PATH 를 통째로 옮기지 않는다 — 있는 디렉터리만
//   환경이 바뀌면 등록물이 STALE 로 드러난다
//   회차 출력이 버려지지 않는다

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { findOnPath, servicePath, SYSTEM_PATH } from '../core/distribution/external-command.ts'
import { launchAgentPlist, launchdAdapter } from '../adapters/service/launchd.ts'
import { serviceUnit } from '../adapters/service/systemd-user.ts'
import type { ServiceCommand } from '../core/distribution/persistent-runtime.ts'

const env = { PATH: '/Users/me/.local/bin:/tmp/session-xyz/bin:/opt/homebrew/bin:/usr/bin:/bin' }
const exists = (path: string) => ['/opt/homebrew/bin/glab', '/opt/homebrew/bin/npx', '/usr/bin/git'].includes(path)
const deps = { env, exists, platform: 'darwin' as const }

const base: ServiceCommand = {
  program: '/usr/bin/node',
  args: ['/opt/asc/asc.js', 'runtime', 'tick', '--all'],
  intervalSeconds: 300,
}

describe('서비스에 실어 보낼 PATH', () => {
  it('실행 파일이 실제로 있는 디렉터리만 고른다 — 세션 임시 경로는 들어가지 않는다', () => {
    const { path, missing } = servicePath(['glab', 'npx', 'git'], deps)
    assert.equal(path.startsWith('/opt/homebrew/bin:/usr/bin:'), true, path)
    assert.equal(path.includes('session-xyz'), false)
    assert.equal(path.includes('/Users/me/.local/bin'), false)
    assert.deepEqual(missing, [])
  })

  it('못 찾은 도구는 조용히 빠지지 않는다', () => {
    const { missing } = servicePath(['glab', 'jam-that-is-not-there'], deps)
    assert.deepEqual(missing, ['jam-that-is-not-there'])
  })

  it('시스템 기본 자리는 항상 뒤에 붙고, 중복은 한 번만', () => {
    const { path } = servicePath(['git'], deps)
    for (const dir of SYSTEM_PATH) assert.equal(path.split(':').filter((d) => d === dir).length, 1, dir)
  })

  it('절대 경로 도구는 그 디렉터리를 그대로 쓴다', () => {
    const { path } = servicePath(['/opt/homebrew/bin/glab'], deps)
    assert.equal(path.split(':')[0], '/opt/homebrew/bin')
    assert.equal(findOnPath('/nowhere/tool', deps), null)
  })

  it('Windows 에서는 찾지 않는다 — 예약 작업이 사용자 환경을 물려받는다', () => {
    assert.equal(findOnPath('glab', { ...deps, platform: 'win32' }), null)
  })
})

describe('등록물에 환경과 로그 자리가 실린다', () => {
  const command: ServiceCommand = { ...base, environment: { PATH: '/opt/homebrew/bin:/usr/bin:/bin' }, logPath: '/Users/me/.asc/service.log' }

  it('launchd — EnvironmentVariables 와 StandardOut/ErrorPath', () => {
    const plist = launchAgentPlist(command)
    assert.match(plist, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/)
    assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/Users\/me\/\.asc\/service\.log<\/string>/)
    assert.match(plist, /<key>StandardErrorPath<\/key>/)
    // 환경이 없으면 키 자체가 없다 — 빈 dict 를 남기지 않는다
    assert.doesNotMatch(launchAgentPlist(base), /EnvironmentVariables/)
  })

  it('systemd — Environment= 한 줄', () => {
    assert.match(serviceUnit(command), /Environment="PATH=\/opt\/homebrew\/bin:\/usr\/bin:\/bin"/)
    assert.doesNotMatch(serviceUnit(base), /Environment=/)
  })

  it('환경이 달라지면 STALE — 도구 위치가 바뀐 것을 등록물이 드러낸다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'asc-svc-env-'))
    try {
      const adapter = launchdAdapter({ home, exec: async () => {} })
      await adapter.install(command)
      assert.equal((await adapter.status(command)).kind, 'CURRENT')
      const moved = { ...command, environment: { PATH: '/usr/local/bin:/usr/bin:/bin' } }
      assert.equal((await adapter.status(moved)).kind, 'STALE')
      // 예전 등록물(환경 없음)도 지금 형태 기준으로는 낡은 것이다
      await adapter.install(base)
      assert.equal((await adapter.status(command)).kind, 'STALE')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
