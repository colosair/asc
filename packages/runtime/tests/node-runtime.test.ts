// Node 하한을 결정적으로 답한다 (v0.2.1 P0).
//
// 여기서 검사하는 것은 **판정과 제안**이지 host가 그 제안을 실행하게 해 주는가가 아니다.
// 후자는 classifier의 영역이고, 흉내 낸 classifier로 통과했다고 적으면 그 기록은 거짓이
// 된다 — 실기계 관측으로만 남긴다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MINIMUM_NODE_MAJOR,
  checkNodeRuntime,
  majorOf,
  type NodeRuntimeDeps,
} from '../core/distribution/node-runtime.ts'

const join = (...parts: string[]) => parts.join('/')

/** 아무것도 없는 machine. 각 검사가 필요한 것만 얹는다. */
const deps = (over: Partial<NodeRuntimeDeps> = {}): NodeRuntimeDeps => ({
  version: 'v22.23.2',
  exists: () => false,
  list: () => [],
  run: async () => ({ ok: false, stdout: '', stderr: 'not run' }),
  home: '/home/someone',
  join,
  ...over,
})

describe('P0 — 지원 하한을 먼저 답한다', () => {
  it('하한을 넘으면 아무것도 하지 않는다 — 정상 경로에 I/O를 얹지 않는다', async () => {
    let touched = 0
    const result = await checkNodeRuntime(
      deps({
        version: `v${MINIMUM_NODE_MAJOR}.1.0`,
        exists: () => {
          touched += 1
          return true
        },
        list: () => {
          touched += 1
          return ['node']
        },
      }),
    )
    assert.deepEqual(result, { ok: true, version: `v${MINIMUM_NODE_MAJOR}.1.0` })
    assert.equal(touched, 0, '돌아가는 machine에서 파일시스템을 뒤졌다')
  })

  it('못 넘으면 이 machine에 이미 있는 Node를 찾아 알려 준다', async () => {
    const result = await checkNodeRuntime(
      deps({
        list: (path) => (path === '/opt/homebrew/opt' ? ['node@26', 'node@20', 'nodenv'] : []),
        exists: (path) => path.startsWith('/opt/homebrew/opt/node@'),
        run: async (command) => ({
          ok: true,
          stdout: command.includes('node@26') ? 'v26.7.0\n' : 'v20.11.0\n',
          stderr: '',
        }),
      }),
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'NODE_RUNTIME_REQUIRED')
    // 하한을 넘는 것만 후보다 — 있다고 다 주면 사람이 다시 걸러야 한다.
    assert.deepEqual(result.candidates, [{ path: '/opt/homebrew/opt/node@26/bin/node', version: 'v26.7.0' }])
    assert.match(result.detail, /already on this machine/)
  })

  it('nvm 배치도 본다', async () => {
    const result = await checkNodeRuntime(
      deps({
        list: (path) => (path === '/home/someone/.nvm/versions/node' ? ['v24.4.0'] : []),
        exists: () => true,
        run: async () => ({ ok: true, stdout: 'v24.4.0', stderr: '' }),
      }),
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.deepEqual(result.candidates, [{ path: '/home/someone/.nvm/versions/node/v24.4.0/bin/node', version: 'v24.4.0' }])
  })

  it('찾지 못하면 찾지 못했다고 한다 — 없는 것을 지어내지 않는다', async () => {
    const result = await checkNodeRuntime(deps())
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.deepEqual(result.candidates, [])
    // Node를 놓는 일 자체가 사람의 경계다. 그 사실이 문장에 있어야 한다.
    assert.match(result.detail, /yours to do/)
  })

  it('물어봤는데 대답하지 못하는 후보는 버린다', async () => {
    const result = await checkNodeRuntime(
      deps({
        list: (path) => (path === '/usr/local/opt' ? ['node'] : []),
        exists: () => true,
        run: async () => ({ ok: false, stdout: '', stderr: 'exec format error' }),
      }),
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.deepEqual(result.candidates, [])
  })

  it('버전을 못 읽으면 추측하지 않는다', () => {
    assert.equal(majorOf('v26.7.0'), 26)
    assert.equal(majorOf('24.1.0'), 24)
    assert.equal(majorOf('nightly'), null)
  })
})
