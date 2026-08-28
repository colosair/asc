// P0-E Gate — 원격 provider 없이도 저장소 사실을 읽는가, 그리고 못 읽으면 못 읽었다고 하는가.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { LocalRepoAdapter, type GitRunner } from '../adapters/local/repo.ts'

const REFS = ['front', 'feat/S15P21A604-87-booth-slot-real-api', 'origin/develop', 'origin/front'].join('\n')

const gitWith = (over: Record<string, string | null> = {}, merged = true): GitRunner => {
  const calls: string[] = []
  const runner: GitRunner = async (args) => {
    const key = args.join(' ')
    calls.push(key)
    if (key in over) return over[key]!
    if (args[0] === 'rev-parse') return 'front\n'
    if (args[0] === 'remote') return 'origin\thttps://lab.ssafy.com/g/p.git (fetch)\norigin\thttps://lab.ssafy.com/g/p.git (push)\n'
    if (args[0] === 'for-each-ref') return REFS
    if (args[0] === 'merge-base') return merged ? '' : null
    if (args[0] === 'cat-file') return merged ? '' : null
    return null
  }
  ;(runner as GitRunner & { calls: string[] }).calls = calls
  return runner
}

describe('P0-E — 로컬 저장소 관측', () => {
  it('작업 항목 키로 ref 를 찾고 정본 병합 여부를 읽는다', async () => {
    const repo = new LocalRepoAdapter({ cwd: '/x', git: gitWith(), exists: async () => true })
    const seen = await repo.observe({
      refHint: 'S15P21A604-87',
      canonicalRef: 'origin/develop',
      paths: ['fe/src/SlotListPage.tsx'],
    })

    assert.equal(seen.branch, 'front')
    assert.deepEqual(seen.refs, ['feat/S15P21A604-87-booth-slot-real-api'])
    assert.equal(seen.mergedIntoCanonical, true)
    assert.equal(seen.pathsExist['fe/src/SlotListPage.tsx'], true)
    assert.equal(seen.pathsOnCanonical?.['fe/src/SlotListPage.tsx'], true)
    assert.deepEqual(seen.remotes, [{ name: 'origin', url: 'https://lab.ssafy.com/g/p.git' }])
  })

  it('병합되지 않은 가지는 병합됨으로 읽지 않는다', async () => {
    const repo = new LocalRepoAdapter({ cwd: '/x', git: gitWith({}, false), exists: async () => false })
    const seen = await repo.observe({ refHint: 'S15P21A604-87', canonicalRef: 'origin/develop', paths: ['a.ts'] })

    assert.equal(seen.mergedIntoCanonical, false)
    assert.equal(seen.pathsExist['a.ts'], false)
    assert.equal(seen.pathsOnCanonical?.['a.ts'], false)
  })

  it('git 을 쓸 수 없으면 던지지 않고 unavailable 로 답한다', async () => {
    const repo = new LocalRepoAdapter({ cwd: '/x', git: async () => null })
    const seen = await repo.observe({ refHint: 'X-1', canonicalRef: 'origin/develop' })

    assert.equal(seen.branch, null)
    assert.deepEqual(seen.refs, [])
    assert.ok(seen.unavailable)
  })

  it('정본 ref 를 주지 않으면 병합 여부를 지어내지 않는다', async () => {
    const repo = new LocalRepoAdapter({ cwd: '/x', git: gitWith() })
    const seen = await repo.observe({ refHint: 'S15P21A604-87' })

    assert.equal(seen.mergedIntoCanonical, undefined)
    assert.equal(seen.canonicalRef, undefined)
  })
})
