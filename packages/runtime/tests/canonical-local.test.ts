// 정본 baseline — 선언된 provider 대로 읽는가.
//
// 실제로 막혔던 것: 정본 갈래가 `git` 으로 선언돼 있는데 한 호스트의 API 로만 읽으려 해서,
// 그 호스트를 안 쓰는 프로젝트는 세션 발급 자체가 되지 않았다. 무엇을 딛고 시작하는지
// 적을 수 없으면 세션은 서지 않는다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { LocalCanonicalReader } from '../adapters/local/canonical.ts'

const SHA = '1dd4933873df1a25ec72c9e7567ad79e2267d9e4'

function git(answers: Record<string, string>) {
  const calls: string[] = []
  return {
    calls,
    exec: async (args: readonly string[]) => {
      const key = args.join(' ')
      calls.push(key)
      if (key in answers) return answers[key]!
      throw new Error(`unknown revision: ${key}`)
    },
  }
}

describe('정본을 이 checkout 에서 읽는다', () => {
  it('원격 추적 ref 를 먼저 본다 — 로컬 브랜치가 정본이 되지 않는다', async () => {
    const fake = git({ 'rev-parse --verify origin/develop^{commit}': SHA })
    const reader = new LocalCanonicalReader({
      cwd: '/repo',
      sourceRefs: { develop: { ref: 'develop', remote: 'origin' } },
      exec: fake.exec,
    })

    const snapshots = await reader.getBaselines([{ sourceId: 'develop' }])
    assert.deepEqual(snapshots, [{ sourceId: 'develop', baseline: SHA }])
    assert.equal(fake.calls[0], 'rev-parse --verify origin/develop^{commit}')
  })

  it('원격 추적 ref 가 없으면 그 다음에 로컬을 본다', async () => {
    const fake = git({ 'rev-parse --verify develop^{commit}': SHA })
    const reader = new LocalCanonicalReader({
      cwd: '/repo',
      sourceRefs: { develop: { ref: 'develop', remote: 'origin' } },
      exec: fake.exec,
    })

    assert.deepEqual(await reader.getBaselines([{ sourceId: 'develop' }]), [
      { sourceId: 'develop', baseline: SHA },
    ])
    assert.equal(fake.calls.length, 2)
  })

  it('읽지 못하면 unknown 이다 — 없는 값을 지어내지 않는다', async () => {
    const reader = new LocalCanonicalReader({
      cwd: '/repo',
      sourceRefs: { develop: { ref: 'develop' } },
      exec: git({}).exec,
    })

    assert.deepEqual(await reader.getBaselines([{ sourceId: 'develop' }]), [
      { sourceId: 'develop', baseline: 'unknown' },
    ])
  })

  it('쓰기 통로가 아니다', async () => {
    const reader = new LocalCanonicalReader({ cwd: '/repo', sourceRefs: {}, exec: git({}).exec })
    const result = await reader.execute({ action: 'anything', target: 'x#1', payload: '' })
    assert.equal(result.ok, false)
  })
})
