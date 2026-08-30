// P0-B Gate — tracker 상태를 실제 작업 상태로 오인하지 않는가.
//
// 회귀 fixture 는 실제로 틀렸던 판정에서 왔다: Jira "진행 중" + develop 병합 완료인
// 항목을 "지금 바로 할 작업"으로 추천했다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { judgeWorkState, type WorkStateInput } from '../core/operator/work-state.ts'
import type { RepoObservation } from '../ports/local-repo.ts'
import type { ResourceSnapshot } from '../ports/resource-context.ts'

const item = (over: Partial<ResourceSnapshot> = {}): ResourceSnapshot => ({
  reference: 'PROJ-87',
  state: '진행 중',
  title: 'BoothSlot 목록·상태 조회 화면 구현',
  updatedAt: '2026-08-27T10:35:00Z',
  revisionMarker: 'r5',
  ...over,
})

const repo = (over: Partial<RepoObservation> = {}): RepoObservation => ({
  branch: 'front',
  remotes: [{ name: 'origin', url: 'https://lab.ssafy.com/g/p.git' }],
  refs: [],
  canonicalRef: 'origin/develop',
  // 기본 픽스처는 신선한 관측이다 — 신선도 자체를 다루는 케이스가 이 값을 덮는다.
  freshness: { state: 'FRESH' },
  pathsExist: {},
  ...over,
})

const judge = (over: Partial<WorkStateInput>) => judgeWorkState({ workItem: item(), repo: repo(), ...over })

describe('P0-B — 실제 작업 상태 판정', () => {
  it('A. tracker 진행 중 + 정본 병합 + 산출물 존재 → IMPLEMENTED_STALE_TRACKER', () => {
    const result = judge({
      trackerDone: false,
      repo: repo({
        refs: ['feat/PROJ-87-x'],
        mergedIntoCanonical: true,
        pathsExist: { 'fe/SlotListPage.tsx': true },
        pathsOnCanonical: { 'fe/SlotListPage.tsx': true },
      }),
    })

    assert.equal(result.state, 'IMPLEMENTED_STALE_TRACKER')
    assert.ok(result.evidence.some((line) => line.includes('병합')))
  })

  it('B. 구현 존재 + 검증 경로 차단 → IMPLEMENTATION_COMPLETE_BLOCKED_VERIFICATION', () => {
    const result = judge({
      trackerDone: false,
      change: 'UNAVAILABLE',
      repo: repo({ refs: ['feat/PROJ-90-auth'], mergedIntoCanonical: false, pathsExist: { 'fe/auth.ts': true } }),
    })

    assert.equal(result.state, 'DECIDABLE_WITH_LIMITATION')
    assert.equal(result.leaning, 'IMPLEMENTATION_COMPLETE_BLOCKED_VERIFICATION')
    assert.ok(result.limitations.some((line) => line.includes('MR')))
  })

  it('C. 가지 존재 + 미병합 + 선행 작업 열림 → BLOCKED_DEPENDENCY', () => {
    const result = judge({
      trackerDone: false,
      repo: repo({ refs: ['feat/PROJ-116-asset'], mergedIntoCanonical: false }),
      dependencies: [{ reference: 'PROJ-107', open: true }],
    })

    assert.equal(result.state, 'BLOCKED_DEPENDENCY')
    assert.ok(result.evidence.some((line) => line.includes('PROJ-107')))
  })

  it('D. 구현 증거 없음 + 막힌 것 없음 → ACTIONABLE', () => {
    const result = judge({
      trackerDone: false,
      change: { reference: 'PROJ-187', changedPaths: [], revisionMarker: 'r1' },
      comments: [],
      repo: repo({ refs: [], mergedIntoCanonical: false, pathsExist: { 'fe/asset.test.ts': false } }),
      dependencies: [],
    })

    assert.equal(result.state, 'ACTIONABLE')
    // 키 기준 관측의 구조적 한계는 항상 표기된다 — 판정을 되돌리지는 않는다.
    assert.deepEqual(result.limitations, [
      '다른 키·경로로 이미 충족됐을 가능성은 대조하지 않았다 — 키 기준 관측의 구조적 한계',
    ])
    assert.equal(result.evidenceGrade, 'none')
  })

  it('E. 저장소를 조사하지 않았으면 추천하지 않는다 — UNDECIDABLE', () => {
    const result = judgeWorkState({ workItem: item(), trackerDone: false, repo: 'MISSING' })

    assert.equal(result.state, 'UNDECIDABLE')
    assert.deepEqual(result.missing, ['repository'])
  })

  it('F. 논의를 못 읽었어도 나머지가 충분하면 한계 표기 후 판정한다', () => {
    const result = judge({
      trackerDone: false,
      comments: 'UNAVAILABLE',
      change: { reference: 'PROJ-187', changedPaths: [], revisionMarker: 'r1' },
      repo: repo({ refs: [], mergedIntoCanonical: false }),
    })

    assert.equal(result.state, 'DECIDABLE_WITH_LIMITATION')
    assert.equal(result.leaning, 'ACTIONABLE')
    assert.equal(result.missing.length, 0)
  })

  it('작업 항목을 못 읽으면 저장소만으로 판정하지 않는다', () => {
    const result = judgeWorkState({ repo: repo({ refs: ['feat/x'] }) })

    assert.equal(result.state, 'UNDECIDABLE')
    assert.deepEqual(result.missing, ['work-item'])
  })

  it('tracker 가 완료라고 말해도 그것만으로 판정하지 않는다', () => {
    const result = judge({
      trackerDone: true,
      change: { reference: 'PROJ-9', changedPaths: [], revisionMarker: 'r1' },
      comments: [],
      repo: repo({ refs: [], mergedIntoCanonical: false }),
    })

    // tracker 는 "끝났다"고 하지만 저장소에는 아무 증거가 없다 — 저장소가 판정한다.
    assert.equal(result.state, 'ACTIONABLE')
  })

  it('검토가 변경을 요구하면 응답이 다음 행동이다', () => {
    const result = judge({
      trackerDone: false,
      comments: [],
      change: {
        reference: 'PROJ-90',
        changedPaths: ['fe/auth.ts'],
        revisionMarker: 'r3',
        reviewState: 'CHANGES_REQUESTED',
      },
      repo: repo({ refs: ['feat/PROJ-90'], mergedIntoCanonical: false, pathsExist: { 'fe/auth.ts': true } }),
    })

    assert.equal(result.state, 'REVIEW_RESPONSE_REQUIRED')
  })
})

describe('P0-2 — 병합 흔적만으로 stale tracker 를 확정하지 않는다', () => {
  const mention = ['d2cadb0 Merge branch feat/PROJ-87 into develop']

  it('A. 병합 + 살아 있는 산출물 → IMPLEMENTED_STALE_TRACKER (단, 인수 조건은 미확인으로 남는다)', () => {
    const result = judge({
      trackerDone: false,
      repo: repo({
        refs: [],
        mergedIntoCanonical: false,
        mentionedOnCanonical: mention,
        mentionedOnlyReverts: false,
        mentionedArtifactsPresent: true,
      }),
    })

    assert.equal(result.state, 'IMPLEMENTED_STALE_TRACKER')
    assert.ok(result.evidence.some((line) => line.includes('생존 증거')))
    assert.ok(
      result.limitations.some((line) => line.includes('인수 조건')),
      '인수 조건 충족을 확인했다고 말해 버렸다',
    )
  })

  it('B. 언급만 있고 무엇을 건드렸는지 못 읽었으면 확정하지 않는다', () => {
    const result = judge({
      trackerDone: false,
      repo: repo({ refs: [], mergedIntoCanonical: false, mentionedOnCanonical: mention }),
    })

    assert.notEqual(result.state, 'IMPLEMENTED_STALE_TRACKER')
    assert.notEqual(result.leaning, 'IMPLEMENTED_STALE_TRACKER')
    assert.ok(result.limitations.some((line) => line.includes('확인하지 못했다')))
  })

  it('C. 언급 커밋이 건드린 파일이 하나도 안 남았으면 확정하지 않는다', () => {
    const result = judge({
      trackerDone: false,
      repo: repo({
        refs: [],
        mergedIntoCanonical: false,
        mentionedOnCanonical: mention,
        mentionedOnlyReverts: false,
        mentionedArtifactsPresent: false,
      }),
    })

    assert.notEqual(result.state, 'IMPLEMENTED_STALE_TRACKER')
  })

  it('D. 되돌리기만 있는 이력은 구현 증거가 아니다', () => {
    const result = judge({
      trackerDone: false,
      comments: [],
      change: { reference: 'PROJ-87', changedPaths: [], revisionMarker: 'r1' },
      repo: repo({
        refs: [],
        mergedIntoCanonical: false,
        mentionedOnCanonical: ['9f1c2ab Revert "feat: PROJ-87 구현"'],
        mentionedOnlyReverts: true,
        mentionedArtifactsPresent: false,
      }),
    })

    assert.notEqual(result.state, 'IMPLEMENTED_STALE_TRACKER')
    assert.equal(result.state, 'ACTIONABLE')
    assert.ok(result.evidence.some((line) => line.includes('되돌리기')))
  })

  it('E. 병합도 구현도 차단도 없으면 ACTIONABLE 이다', () => {
    const result = judge({
      trackerDone: false,
      comments: [],
      change: { reference: 'PROJ-195', changedPaths: [], revisionMarker: 'r1' },
      repo: repo({ refs: [], mergedIntoCanonical: false }),
      dependencies: [],
    })

    assert.equal(result.state, 'ACTIONABLE')
  })

  it('가지가 정본의 조상이면 산출물 확인 없이도 확정한다 — 그 자체가 생존 증거다', () => {
    const result = judge({
      trackerDone: false,
      repo: repo({
        refs: ['feat/PROJ-87'],
        mergedIntoCanonical: true,
        pathsOnCanonical: { 'fe/SlotListPage.tsx': true },
      }),
    })

    assert.equal(result.state, 'IMPLEMENTED_STALE_TRACKER')
  })
})

// ── A1/A2/A3 회귀 (0.3.1) — stale 관측·증거 등급·내용 등가 ───────────────────

describe('A1 — 신선하지 않은 관측 위에서 "없음"을 확정하지 않는다', () => {
  it('remote ahead + local behind(FETCH_FAILED): 증거 없음이어도 ACTIONABLE 금지', () => {
    const result = judge({
      trackerDone: false,
      repo: repo({ freshness: { state: 'FETCH_FAILED', detail: 'git fetch origin develop 실패' } }),
    })

    assert.equal(result.state, 'UNDECIDABLE')
    assert.deepEqual(result.missing, ['canonical-freshness'])
    // fetch 실패를 repository 부재로 오해하지 않는다 — 어휘가 다르다.
    assert.ok(!result.missing.includes('repository'))
    assert.ok(result.limitations.some((l) => l.includes('FETCH_FAILED')))
  })

  it('freshness 미기록(구 관측)도 신선 취급하지 않는다 — UNKNOWN 과 동일', () => {
    const stale = repo()
    delete (stale as Partial<RepoObservation>).freshness
    const result = judge({ trackerDone: false, repo: stale })

    assert.equal(result.state, 'UNDECIDABLE')
    assert.deepEqual(result.missing, ['canonical-freshness'])
  })

  it('FRESH 면 기존대로 ACTIONABLE 확정이 성립한다', () => {
    const result = judge({ trackerDone: false, repo: repo() })
    assert.equal(result.state, 'ACTIONABLE')
  })

  it('구현 증거가 있으면 신선도와 무관하게 존재를 인정한다 — 있던 것은 stale 에서도 있다', () => {
    const result = judge({
      trackerDone: false,
      repo: repo({
        freshness: { state: 'FETCH_FAILED' },
        refs: ['feat/PROJ-87'],
        mergedIntoCanonical: true,
        pathsOnCanonical: { 'fe/a.ts': true },
      }),
    })
    assert.equal(
      result.state === 'IMPLEMENTED_STALE_TRACKER' || result.leaning === 'IMPLEMENTED_STALE_TRACKER',
      true,
    )
  })
})

describe('A2 — 증거 등급과 표현', () => {
  it('키 직접 증거 없음 ≠ 구현 없음 — 문구가 관측 한계를 말한다', () => {
    const result = judge({ trackerDone: false, repo: repo() })

    assert.ok(result.evidence.some((e) => e.includes('이 작업 키를 직접 가리키는 증거를 확인하지 못했다')))
    assert.ok(!result.evidence.some((e) => e.includes('어디에도 구현 증거가 없다')))
    assert.ok(result.limitations.some((l) => l.includes('다른 키·경로로 이미 충족됐을 가능성')))
    assert.equal(result.evidenceGrade, 'none')
  })

  it('정본 자체가 말하는 증거는 direct 다', () => {
    const result = judge({
      trackerDone: false,
      repo: repo({ refs: ['feat/PROJ-87'], mergedIntoCanonical: true, pathsOnCanonical: { 'fe/a.ts': true } }),
    })
    assert.equal(result.evidenceGrade, 'direct')
  })

  it('언급·작업 트리 잔재는 proxy 다', () => {
    const result = judge({
      trackerDone: false,
      repo: repo({ pathsExist: { 'fe/a.ts': true } }),
    })
    assert.equal(result.evidenceGrade, 'proxy')
  })
})

describe('A3 — 내용 등가는 direct 증거다', () => {
  it('-317 스타일: 조상이 아니어도 contentEquivalent 면 구현 존재로 판정한다', () => {
    const result = judge({
      trackerDone: false,
      repo: repo({ refs: ['feat/PROJ-317-other'], mergedIntoCanonical: false, contentEquivalent: true }),
    })

    assert.notEqual(result.state, 'ACTIONABLE')
    assert.notEqual(result.leaning, 'ACTIONABLE')
    assert.equal(result.evidenceGrade, 'direct')
    assert.ok(result.evidence.some((e) => e.includes('내용이 전부 정본에 반영')))
  })
})
