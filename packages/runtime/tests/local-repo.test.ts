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

describe('P0-2 — 언급 커밋이 남긴 것이 지금도 있는가', () => {
  const historyGit = (over: Record<string, string | null>): GitRunner => async (args) => {
    const key = args.join(' ')
    if (key in over) return over[key]!
    if (args[0] === 'rev-parse') return 'front\n'
    if (args[0] === 'remote') return ''
    if (args[0] === 'for-each-ref') return ''
    if (args[0] === 'merge-base') return null
    return null
  }

  it('추가·수정된 파일이 정본에 남아 있으면 생존으로 읽는다', async () => {
    const repo = new LocalRepoAdapter({
      cwd: '/x',
      git: historyGit({
        'log --format=%h %s --grep=PROJ-87 -n 5 origin/develop': 'd2cadb0 feat: PROJ-87 구현\n',
        'show --name-status --format= d2cadb0': 'A\tfe/src/Slot.tsx\nM\tfe/src/index.ts\n',
        'cat-file -e origin/develop:fe/src/Slot.tsx': '',
      }),
    })

    const seen = await repo.observe({ refHint: 'PROJ-87', canonicalRef: 'origin/develop' })

    assert.equal(seen.mentionedArtifactsPresent, true)
    assert.equal(seen.mentionedOnlyReverts, false)
  })

  it('건드린 파일이 하나도 안 남았으면 소멸로 읽는다', async () => {
    const repo = new LocalRepoAdapter({
      cwd: '/x',
      git: historyGit({
        'log --format=%h %s --grep=PROJ-87 -n 5 origin/develop': 'd2cadb0 feat: PROJ-87 구현\n',
        'show --name-status --format= d2cadb0': 'A\tfe/src/Slot.tsx\n',
      }),
    })

    const seen = await repo.observe({ refHint: 'PROJ-87', canonicalRef: 'origin/develop' })

    assert.equal(seen.mentionedArtifactsPresent, false)
  })

  it('되돌리기만 있으면 그 사실을 말하고, 파일 목록을 읽지 않는다', async () => {
    const seenCommands: string[] = []
    const repo = new LocalRepoAdapter({
      cwd: '/x',
      git: async (args) => {
        seenCommands.push(args.join(' '))
        if (args[0] === 'rev-parse') return 'front\n'
        if (args[0] === 'log') return '9f1c2ab Revert "feat: PROJ-87 구현"\n'
        return null
      },
    })

    const seen = await repo.observe({ refHint: 'PROJ-87', canonicalRef: 'origin/develop' })

    assert.equal(seen.mentionedOnlyReverts, true)
    assert.equal(seen.mentionedArtifactsPresent, undefined, '되돌리기만 있는데 생존을 판정했다')
    assert.ok(!seenCommands.some((c) => c.startsWith('show ')))
  })

  it('파일 목록을 못 읽으면 없다고 하지 않고 모른다고 한다', async () => {
    const repo = new LocalRepoAdapter({
      cwd: '/x',
      git: historyGit({ 'log --format=%h %s --grep=PROJ-87 -n 5 origin/develop': 'd2cadb0 feat: PROJ-87\n' }),
    })

    const seen = await repo.observe({ refHint: 'PROJ-87', canonicalRef: 'origin/develop' })

    assert.equal(seen.mentionedArtifactsPresent, undefined)
  })

  it('삭제만 한 커밋은 생존 증거로 세지 않는다', async () => {
    const repo = new LocalRepoAdapter({
      cwd: '/x',
      git: historyGit({
        'log --format=%h %s --grep=PROJ-87 -n 5 origin/develop': 'aaa1111 chore: PROJ-87 정리\n',
        'show --name-status --format= aaa1111': 'D\tfe/src/Old.tsx\n',
      }),
    })

    const seen = await repo.observe({ refHint: 'PROJ-87', canonicalRef: 'origin/develop' })

    assert.equal(seen.mentionedArtifactsPresent, false)
  })
})
