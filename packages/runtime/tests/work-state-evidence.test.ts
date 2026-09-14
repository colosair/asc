// 0.10.0 P5 — WORK_STATE 는 결론뿐 아니라 근거도 맞아야 한다.
//
// dogfood 2026-09-13 F7: 정본에서 방금 만든 빈 가지가 "병합됐다" 로 읽혔고(실제로는 다른 worktree 에서
// 미커밋 진행 중), 키가 뒤바뀐 다른 작업의 commit 이 "구현 근거" 로 제시됐다. 여기서 고정하는 것:
// 정확한 키 일치 · 빈 가지는 증거가 아니다 · 다른 worktree 의 진행은 보인다 · 경로가 안 겹치는 언급은
// 증거가 아니라 UNDECIDABLE 이다 · 사람의 override 는 history 에 남는다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { LocalRepoAdapter, exactKeyPattern, type GitRunner } from '../adapters/local/repo.ts'
import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { Operator, type WorkIngress } from '../core/operator/proceed.ts'
import { judgeWorkState } from '../core/operator/work-state.ts'
import { SessionRuntime } from '../core/runtime/session.ts'
import type { RepoObservation } from '../ports/local-repo.ts'
import type { ResourceSnapshot } from '../ports/resource-context.ts'

const KEY = 'PROJ-64'
const LOG = `log --format=%h %s -E --grep=${exactKeyPattern(KEY)} -n 5 origin/develop`

/** args 를 공백으로 이은 키로 답하는 가짜 git. 정의 안 된 질문은 null(실패) 이다. */
const gitWith =
  (answers: Record<string, string | null>): GitRunner =>
  async (args) => {
    const key = args.join(' ')
    if (key in answers) return answers[key]!
    if (args[0] === 'rev-parse') return 'front\n'
    if (args[0] === 'remote') return ''
    return null
  }

const base = {
  'for-each-ref --format=%(refname:short) refs/heads refs/remotes': `feat/${KEY}-thing\nfeat/PROJ-641-other\norigin/develop\n`,
  'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/develop\n',
  'fetch --quiet origin develop': '',
  'rev-parse --verify origin/develop': 'abc\n',
}

describe('정확한 키 일치', () => {
  it('PROJ-64 는 PROJ-641 에 걸리지 않고, 경계 안에서는 걸린다', () => {
    const re = new RegExp(exactKeyPattern(KEY), 'i')
    assert.equal(re.test('feat/PROJ-641-other'), false)
    assert.equal(re.test('feat/PROJ-64-thing'), true)
    assert.equal(re.test('[PROJ-64][FE] something'), true)
    assert.equal(re.test('xPROJ-64'), false)
  })

  it('refs 는 정확한 키의 가지만 든다', async () => {
    const repo = new LocalRepoAdapter({ cwd: '/x', git: gitWith(base) })
    const seen = await repo.observe({ refHint: KEY, canonicalRef: 'develop', remote: 'origin' })
    assert.deepEqual(seen.refs, [`feat/${KEY}-thing`])
  })
})

describe('빈 가지는 병합의 증거가 아니다', () => {
  it('정본과 같은 tip 이고 이 작업의 commit 이 없으면 emptyRefs 이고 merged 는 false 다', async () => {
    const git = gitWith({
      ...base,
      [`rev-list --count origin/develop..feat/${KEY}-thing`]: '0\n',
      [`log -1 --format=%s feat/${KEY}-thing`]: 'Merge branch other into develop\n',
      [`merge-base --is-ancestor feat/${KEY}-thing origin/develop`]: '',
      [LOG]: '',
    })
    const seen = await new LocalRepoAdapter({ cwd: '/x', git }).observe({ refHint: KEY, canonicalRef: 'develop', remote: 'origin' })
    assert.deepEqual(seen.emptyRefs, [`feat/${KEY}-thing`])
    assert.equal(seen.mergedIntoCanonical, false)
  })

  it('tip 이 이 작업의 commit 이면 조상 관계는 병합 증거다 (기존 동작)', async () => {
    const git = gitWith({
      ...base,
      [`rev-list --count origin/develop..feat/${KEY}-thing`]: '0\n',
      [`log -1 --format=%s feat/${KEY}-thing`]: `[${KEY}][FE] the thing\n`,
      [`merge-base --is-ancestor feat/${KEY}-thing origin/develop`]: '',
      [LOG]: '',
    })
    const seen = await new LocalRepoAdapter({ cwd: '/x', git }).observe({ refHint: KEY, canonicalRef: 'develop', remote: 'origin' })
    assert.equal(seen.emptyRefs, undefined)
    assert.equal(seen.mergedIntoCanonical, true)
  })
})

describe('다른 worktree 의 진행', () => {
  it('작업 가지가 다른 worktree 에 checkout 돼 있고 미커밋이 있으면 inProgressElsewhere 다', async () => {
    const git = gitWith({
      ...base,
      'worktree list --porcelain': `worktree /x\nHEAD aaa\nbranch refs/heads/front\n\nworktree /w/${KEY}\nHEAD bbb\nbranch refs/heads/feat/${KEY}-thing\n\n`,
      [`-C /w/${KEY} status --porcelain`]: ' M a.ts\n?? b.ts\n',
      [`rev-list --count origin/develop..feat/${KEY}-thing`]: '0\n',
      [`log -1 --format=%s feat/${KEY}-thing`]: 'Merge branch other\n',
      [LOG]: '',
    })
    const seen = await new LocalRepoAdapter({ cwd: '/x', git }).observe({ refHint: KEY, canonicalRef: 'develop', remote: 'origin' })
    assert.deepEqual(seen.inProgressElsewhere, [{ ref: `feat/${KEY}-thing`, path: `/w/${KEY}`, uncommitted: 2 }])
  })
})

describe('언급 commit 의 경로 겹침', () => {
  it('언급 commit 이 이 작업의 경로를 하나도 안 건드리면 mentionedPathsOverlap 은 false 다', async () => {
    const git = gitWith({
      ...base,
      'for-each-ref --format=%(refname:short) refs/heads refs/remotes': '',
      [LOG]: `ec3a96c [${KEY}][game] corridor flicker\n`,
      'show --name-status --format= ec3a96c': 'M\tunity/Scenes/Corridor.unity\n',
      'cat-file -e origin/develop:unity/Scenes/Corridor.unity': '',
    })
    const seen = await new LocalRepoAdapter({ cwd: '/x', git }).observe({
      refHint: KEY,
      canonicalRef: 'develop',
      remote: 'origin',
      paths: ['src/unity/host/worldUiBridge.ts'],
    })
    assert.equal(seen.mentionedArtifactsPresent, true, '생존은 사실이다')
    assert.equal(seen.mentionedPathsOverlap, false, '그러나 이 작업의 자리가 아니다')
  })
})

describe('judgeWorkState — 근거가 결론을 만든다', () => {
  const item = (): ResourceSnapshot => ({
    reference: KEY,
    state: '해야 할 일',
    title: '오버레이 닫힘',
    updatedAt: '2026-09-14T00:00:00Z',
    revisionMarker: 'r1',
  })
  const repo = (over: Partial<RepoObservation>): RepoObservation => ({
    branch: 'front',
    remotes: [],
    refs: [],
    canonicalRef: 'origin/develop',
    freshness: { state: 'FRESH' },
    pathsExist: {},
    ...over,
  })

  it('경로가 안 겹치는 언급만 있으면 UNDECIDABLE (implementation-evidence) — 구현됐다고도 없다고도 하지 않는다', () => {
    const result = judgeWorkState({
      workItem: item(),
      trackerDone: false,
      repo: repo({ mentionedOnCanonical: ['ec3a96c [PROJ-64][game] corridor'], mentionedArtifactsPresent: true, mentionedPathsOverlap: false }),
    })
    assert.equal(result.state, 'UNDECIDABLE')
    assert.deepEqual(result.missing, ['implementation-evidence'])
    assert.match(result.evidence.join('\n'), /키만 같은 다른 작업일 수 있어 증거로 세지 않는다/)
  })

  it('빈 가지는 evidence 에 그렇게 적히고 판정은 ACTIONABLE 이다', () => {
    const result = judgeWorkState({
      workItem: item(),
      trackerDone: false,
      repo: repo({ refs: ['feat/PROJ-64-x'], emptyRefs: ['feat/PROJ-64-x'], mergedIntoCanonical: false }),
    })
    assert.equal(result.state === 'DECIDABLE_WITH_LIMITATION' ? result.leaning : result.state, 'ACTIONABLE')
    assert.match(result.evidence.join('\n'), /빈 작업 가지/)
  })

  it('다른 worktree 에서 미커밋 진행 중이면 IN_PROGRESS_ELSEWHERE 다', () => {
    const result = judgeWorkState({
      workItem: item(),
      trackerDone: false,
      repo: repo({
        refs: ['feat/PROJ-64-x'],
        emptyRefs: ['feat/PROJ-64-x'],
        mergedIntoCanonical: false,
        inProgressElsewhere: [{ ref: 'feat/PROJ-64-x', path: '/w/64', uncommitted: 3 }],
      }),
    })
    assert.equal(result.state, 'IN_PROGRESS_ELSEWHERE')
    assert.match(result.evidence.join('\n'), /다른 worktree 에서 진행 중: feat\/PROJ-64-x @ \/w\/64 \(미커밋 3건\)/)
  })
})

describe('사람의 override 는 history 에 남는다', () => {
  it('--fresh 는 판정을 뒤집고, 뒤집힌 근거를 outcome 에 싣고, history 에 이유를 적는다', async () => {
    const store = new MemoryStateStore()
    const sessions = new SessionRuntime(store)
    const workItem: ResourceSnapshot = { reference: KEY, state: 's', title: 't', updatedAt: 'u', revisionMarker: 'r' }
    const ingress: WorkIngress = {
      gather: async () => ({ workItem, trackerDone: false, comments: [], change: 'UNAVAILABLE' }),
      observeRepo: async () => ({
        branch: 'front',
        remotes: [],
        refs: ['feat/PROJ-64-x'],
        canonicalRef: 'origin/develop',
        freshness: { state: 'FRESH' },
        pathsExist: {},
        mergedIntoCanonical: false,
        inProgressElsewhere: [{ ref: 'feat/PROJ-64-x', path: '/w/64', uncommitted: 1 }],
      }),
      derive: () => ({ id: 'S-20260914-09', role: 'implementer', goal: `${KEY}: t`, boundary: ['src/**'], criteria: ['c'] }),
      usedIds: async () => [],
      plan: async (draft) => ({
        status: 'READY_TO_ISSUE',
        draft,
        facts: [],
        proposals: [],
        unresolved: [],
        issuance: { authority: 'delegated', delegatedRoles: ['implementer'], detail: 'fixture' },
        invalid: [],
      }),
      issue: async (d) => {
        const issued = await sessions.issue({ id: d.id!, role: 'implementer', goal: d.goal ?? '', doneCriteria: [...(d.criteria ?? [])] })
        return issued.ok ? { ok: true, sessionId: issued.session.id } : { ok: false, detail: 'x' }
      },
    }
    const operator = new Operator({ store, sessions, ingress, guard: async () => ({ ok: true }) })

    const judged = await operator.proceed({ workRef: KEY })
    assert.equal(judged.kind === 'WORK_STATE' && judged.result.state, 'IN_PROGRESS_ELSEWHERE')

    const overridden = await operator.proceed({ workRef: KEY, fresh: { reason: '그 worktree 는 내가 버린 것이다', by: 'colosair' } })
    assert.equal(overridden.kind, 'STARTED', '위임된 workspace 라 발급까지 간다')
    const history = await store.readHistory()
    const entry = history.find((h) => h.kind === 'work_state_overridden')
    assert.ok(entry)
    assert.equal(entry.actor, 'colosair')
    assert.match(entry.detail ?? '', /judged IN_PROGRESS_ELSEWHERE — overridden: 그 worktree 는 내가 버린 것이다/)
  })
})

// 0.10.1 — monorepo 상대 경로. 작업 항목은 패키지 안 경로를 적고 commit 은 뿌리 기준으로 남는다.
describe('언급 commit 의 경로 겹침 — monorepo 꼬리 일치 (0.10.1)', () => {
  it('작업 항목의 tools/devGateway.mjs 는 commit 의 festa-frontend/tools/devGateway.mjs 와 겹친다', async () => {
    const git = gitWith({
      ...base,
      'for-each-ref --format=%(refname:short) refs/heads refs/remotes': '',
      [LOG]: `4de91e8 [${KEY}][FE] gateway\n`,
      'show --name-status --format= 4de91e8': 'M\tfesta-frontend/tools/devGateway.mjs\nM\tfesta-frontend/src/pages/login/LoginPage.tsx\n',
      'cat-file -e origin/develop:festa-frontend/tools/devGateway.mjs': '',
    })
    const seen = await new LocalRepoAdapter({ cwd: '/x', git }).observe({
      refHint: KEY,
      canonicalRef: 'develop',
      remote: 'origin',
      paths: ['tools/devGateway.mjs', '/oauth2', 'SecurityConfiguration/CORS'],
    })
    assert.equal(seen.mentionedPathsOverlap, true)
  })
})
