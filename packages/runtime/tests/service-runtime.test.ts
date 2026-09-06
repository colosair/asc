// P0 F1 — 등록물이 사라질 자리를 가리키면 안 된다.
//
// 실기계에서 난 일: `npx @asc-agent/bootstrap … setup apply` 로 처음 설치한 사람에게
// 등록물이 npx 캐시 안의 실행물을 박았다. 캐시를 지우면 등록만 남고 실행물이 사라진다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isTransientPath, resolveServiceRuntime, serviceRuntimeLine } from '../core/distribution/service-runtime.ts'

const NPX = '/Users/me/.npm/_npx/6d96b097/node_modules/@asc-agent/runtime/dist/cli/asc.js'
const GLOBAL = '/opt/homebrew/lib/node_modules/@asc-agent/runtime/dist/cli/asc.js'
const NODE24 = '/opt/homebrew/opt/node@24/bin/node'

describe('사라질 자리 판정', () => {
  it('npx 캐시와 임시 디렉터리는 사라질 자리다', () => {
    assert.equal(isTransientPath(NPX), true)
    assert.equal(isTransientPath('/tmp/asc-1234/bin/node'), true)
    assert.equal(isTransientPath('/var/folders/xy/T/asc/asc.js'), true)
    assert.equal(isTransientPath('C:\\Users\\me\\AppData\\Local\\Temp\\npx\\asc.js'), true)
  })

  it('전역 설치본과 홈브루 Node 는 사라질 자리가 아니다', () => {
    assert.equal(isTransientPath(GLOBAL), false)
    assert.equal(isTransientPath(NODE24), false)
    assert.equal(isTransientPath('C:\\Program Files\\nodejs\\node.exe'), false)
  })
})

describe('등록물이 가리킬 것', () => {
  it('전역 설치본이 있으면 그것이다 — 지금 npx 에서 돌고 있어도', () => {
    const resolved = resolveServiceRuntime({
      runningEntry: NPX,
      runningNode: NODE24,
      runningNodeVersion: 'v24.2.0',
      stableEntry: GLOBAL,
    })
    assert.deepEqual(resolved, { kind: 'STABLE', node: NODE24, entry: GLOBAL })
  })

  it('전역 설치본이 없고 지금이 npx 면 등록하지 않는다', () => {
    const resolved = resolveServiceRuntime({
      runningEntry: NPX,
      runningNode: NODE24,
      runningNodeVersion: 'v24.2.0',
    })
    assert.equal(resolved.kind, 'UNSTABLE')
    assert.equal(resolved.kind === 'UNSTABLE' && resolved.reason, 'NO_STABLE_ENTRY')
    assert.match(serviceRuntimeLine(resolved), /temporary location/)
  })

  it('전역 설치본 경로가 임시 자리면 그것도 쓰지 않는다', () => {
    const resolved = resolveServiceRuntime({
      runningEntry: GLOBAL,
      runningNode: NODE24,
      runningNodeVersion: 'v24.2.0',
      stableEntry: '/tmp/prefix/lib/node_modules/@asc-agent/runtime/dist/cli/asc.js',
    })
    assert.deepEqual(resolved, { kind: 'STABLE', node: NODE24, entry: GLOBAL })
  })

  it('지금 Node 가 하한 아래면 이 기계의 다른 Node 를 쓴다', () => {
    const resolved = resolveServiceRuntime({
      runningEntry: GLOBAL,
      runningNode: '/opt/homebrew/opt/node@22/bin/node',
      runningNodeVersion: 'v22.23.2',
      nodeCandidates: [
        { path: '/tmp/throwaway/bin/node', version: 'v24.0.0' },
        { path: NODE24, version: 'v24.2.0' },
      ],
    })
    // 임시 자리의 Node 는 후보가 아니다 — 사라지면 등록물이 깨진다
    assert.deepEqual(resolved, { kind: 'STABLE', node: NODE24, entry: GLOBAL })
  })

  it('쓸 수 있는 Node 가 없으면 등록하지 않는다 — 깨진 등록을 남기지 않는다', () => {
    const resolved = resolveServiceRuntime({
      runningEntry: GLOBAL,
      runningNode: '/opt/homebrew/opt/node@22/bin/node',
      runningNodeVersion: 'v22.23.2',
      nodeCandidates: [{ path: '/opt/homebrew/opt/node@20/bin/node', version: 'v20.11.0' }],
    })
    assert.equal(resolved.kind, 'UNSTABLE')
    assert.equal(resolved.kind === 'UNSTABLE' && resolved.reason, 'NO_COMPATIBLE_NODE')
    assert.match(serviceRuntimeLine(resolved), /24 or newer/)
  })
})
