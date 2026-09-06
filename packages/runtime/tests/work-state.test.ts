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
  remotes: [{ name: 'origin', url: 'https://git.example.com/g/p.git' }],
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

    // 0.7.0 — 구현이 정본에 살아 있다는 것까지는 이 증거로 말할 수 있다. 그러나 그것이
    // 받아들여졌는지는 다른 질문이고, 그것을 모른 채 "상태 정리만 하면 된다" 고 확정하지
    // 않는다. 기울기는 그대로 남는다.
    assert.equal(result.state, 'DECIDABLE_WITH_LIMITATION')
    assert.equal(result.leaning, 'IMPLEMENTED_STALE_TRACKER')
    assert.ok(result.evidence.some((line) => line.includes('병합')))
  })

  it('B. 구현이 정본에 있고 검증 경로가 막혔다 → IMPLEMENTATION_COMPLETE_BLOCKED_VERIFICATION', () => {
    // 병합 흔적은 있는데 그 산출물이 지금도 남아 있는지 읽지 못한 자리다.
    const result = judge({
      trackerDone: false,
      change: 'UNAVAILABLE',
      repo: repo({ refs: ['feat/PROJ-90-auth'], contentEquivalent: true }),
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

    assert.equal(result.state, 'DECIDABLE_WITH_LIMITATION')
    assert.equal(result.leaning, 'IMPLEMENTED_STALE_TRACKER')
    assert.ok(result.evidence.some((line) => line.includes('생존 증거')))
    assert.ok(
      result.limitations.some((line) => line.includes('받아들여졌는지')),
      '인수 여부를 확인했다고 말해 버렸다',
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

  it('가지가 정본의 조상이면 산출물 확인 없이도 그쪽으로 기운다 — 그 자체가 생존 증거다', () => {
    const result = judge({
      trackerDone: false,
      repo: repo({
        refs: ['feat/PROJ-87'],
        mergedIntoCanonical: true,
        pathsOnCanonical: { 'fe/SlotListPage.tsx': true },
      }),
    })

    assert.equal(result.leaning ?? result.state, 'IMPLEMENTED_STALE_TRACKER')
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

  it('살아남은 언급은 proxy 다 — 키를 경유한 추정이다', () => {
    const result = judge({
      trackerDone: false,
      repo: repo({
        mentionedOnCanonical: ['abc feat: PROJ-87 구현'],
        mentionedOnlyReverts: false,
        mentionedArtifactsPresent: true,
      }),
    })
    assert.equal(result.evidenceGrade, 'proxy')
  })

  it('작업 트리에 파일이 있다는 것만으로는 등급이 서지 않는다 (0.7.0)', () => {
    // 예전에는 이것도 proxy 였다. 구현 증거가 아닌 것을 약한 구현 증거로 세면
    // 같은 오판이 한 칸 낮은 자리에서 다시 난다.
    const result = judge({
      trackerDone: false,
      repo: repo({ pathsExist: { 'fe/a.ts': true } }),
    })
    assert.equal(result.evidenceGrade, 'none')
    assert.equal(result.state, 'ACTIONABLE')
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

describe('A2 보강 — 측정된 반증은 언급-생존 확정을 내린다 (F2)', () => {
  it('mention 생존 + contentEquivalent=false → IMPLEMENTED_STALE_TRACKER 를 확정하지 않는다', () => {
    const result = judge({
      trackerDone: false,
      repo: repo({
        refs: ['feat/PROJ-87'],
        mergedIntoCanonical: false,
        contentEquivalent: false,
        mentionedOnCanonical: ['abc PROJ-87 절반만'],
        mentionedArtifactsPresent: true,
      }),
    })

    assert.equal(result.state, 'DECIDABLE_WITH_LIMITATION')
    assert.equal(result.leaning, 'IMPLEMENTED_STALE_TRACKER')
    assert.ok(result.limitations.some((l) => l.includes('반영되지 않은 커밋')))
  })
})


// ── 0.7.0 / D-01 — 파일이 있다는 것과 이 요구가 구현됐다는 것 ─────────────────
//
// 실측에서 나온 세 현실을 그대로 fixture 로 둔다. 셋은 서로 다른 답을 받아야 한다.

describe('D-01 — 세 현실이 서로 다른 답을 받는다', () => {
  const hud = 'festa-frontend/src/features/world/ui/WorldHud.tsx'

  it('① 파일은 이미 있고 이번 요구는 그 안의 변경이다 → ACTIONABLE', () => {
    // 실측 그대로다. 작업 항목이 WorldHud.tsx 를 가리키고 그 파일은 정본에도 작업
    // 트리에도 있다. 그런데 요구된 4항(Shift·Space·우클릭 드래그·Alt+클릭)은 하나도
    // 없다. 예전에는 이 자리에서 "구현하지 말고 tracker 만 정리하라" 가 나왔다.
    const result = judge({
      trackerDone: false,
      repo: repo({
        refs: [],
        mergedIntoCanonical: false,
        pathsExist: { [hud]: true },
        pathsOnCanonical: { [hud]: true },
      }),
    })

    assert.equal(result.state, 'ACTIONABLE')
    assert.notEqual(result.leaning, 'IMPLEMENTED_STALE_TRACKER')
    assert.equal(result.evidenceGrade, 'none', '파일 존재는 구현 증거가 아니다')
    // 그 파일이 있다는 사실 자체는 숨기지 않는다 — 다만 무엇의 증거인지 분명히 말한다.
    assert.ok(result.evidence.some((line) => line.includes('이 요구가 반영됐다는 증거는 아니다')))
  })

  it('② 요구는 정본에 도달했고 인수가 남았다 → tracker 를 닫으라고 권하지 않는다', () => {
    const result = judge({
      trackerDone: false,
      change: 'UNAVAILABLE',
      repo: repo({
        refs: ['feat/PROJ-460'],
        mergedIntoCanonical: true,
        pathsOnCanonical: { [hud]: true },
      }),
    })

    assert.notEqual(result.state, 'IMPLEMENTED_STALE_TRACKER')
    assert.ok(
      result.limitations.some((line) => line.includes('받아들여졌는지')),
      '인수 여부를 모른다는 사실이 남아야 한다',
    )
  })

  it('③ 요구도 도달했고 검토도 끝났는데 tracker 만 뒤처졌다 → IMPLEMENTED_STALE_TRACKER', () => {
    const result = judge({
      trackerDone: false,
      change: {
        reference: 'PROJ-460',
        changedPaths: [hud],
        revisionMarker: 'r9',
        reviewState: 'MERGED',
      },
      repo: repo({
        refs: ['feat/PROJ-460'],
        mergedIntoCanonical: true,
        pathsOnCanonical: { [hud]: true },
      }),
    })

    assert.equal(result.state, 'IMPLEMENTED_STALE_TRACKER')
    assert.ok(result.evidence.some((line) => line.includes('검토가 끝났다고')))
  })
})

describe('C-4 — 결론은 근거보다 강할 수 없다', () => {
  it('인수를 확인하지 못했다고 적으면서 상태 정리만 남았다고 말하지 않는다', () => {
    for (const observation of [
      repo({ refs: [], mergedIntoCanonical: true }),
      repo({ refs: [], contentEquivalent: true }),
      repo({
        refs: [],
        mentionedOnCanonical: ['abc feat: PROJ-87'],
        mentionedOnlyReverts: false,
        mentionedArtifactsPresent: true,
      }),
    ]) {
      const result = judge({ trackerDone: false, repo: observation })
      const unverified = result.limitations.some((line) => line.includes('받아들여졌는지'))
      if (unverified) {
        assert.notEqual(
          result.state,
          'IMPLEMENTED_STALE_TRACKER',
          '모른다고 적어 놓고 확정하는 결과가 나왔다',
        )
      }
    }
  })
})
