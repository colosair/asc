// P0-C Gate — 읽어 온 것으로 계약 초안이 채워지는가, 그리고 없는 것을 지어내지 않는가.
//
// 이 시험의 마지막 단계는 도출한 초안을 **진짜 planSessionContract 에 통과시키는 것**이다.
// 브리지가 목적이므로 플래너를 흉내 내면 아무것도 증명하지 못한다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { planSessionContract } from '../core/operator/contract-draft.ts'
import { deriveSessionContractDraft, type DeriveInput } from '../core/operator/derive-draft.ts'
import type { WorkStateResult } from '../core/operator/work-state.ts'
import type { RepoObservation } from '../ports/local-repo.ts'
import type { ResourceSnapshot } from '../ports/resource-context.ts'

const BODY = [
  '### 작업 목적',
  '',
  'asset:// 참조가 실제로 풀리는지 회귀로 고정한다.',
  '',
  '### 완료 조건',
  '',
  '- [ ] asset:// 참조 해석 단위 테스트 존재',
  '- [ ] 잘못된 참조는 오류로 드러난다',
  '',
  '### 참고',
  '',
  '- spec 016',
].join('\n')

const workItem = (over: Partial<ResourceSnapshot> = {}): ResourceSnapshot => ({
  reference: 'PROJ-187',
  state: '해야 할 일',
  title: 'asset:// 참조 해석·회귀 테스트 작성',
  body: BODY,
  updatedAt: '2026-08-26T17:17:00Z',
  revisionMarker: 'r1',
  ...over,
})

const repo = (over: Partial<RepoObservation> = {}): RepoObservation => ({
  branch: 'front',
  remotes: [],
  refs: [],
  canonicalRef: 'origin/develop',
  pathsExist: { 'fe/src/entities/asset': true, 'be/src': false },
  ...over,
})

const actionable: WorkStateResult = { state: 'ACTIONABLE', evidence: [], limitations: [], missing: [] }

// planSessionContract 에 넘길 정책. 판정에 쓰이는 두 칸만 채운다.
const policy = () =>
  ({
    roleScopes: { implementer: ['fe/**', 'be/**'] },
    lists: { issuanceDelegation: ['implementer'] },
  }) as unknown as Parameters<typeof planSessionContract>[0]['policy']

const input = (over: Partial<DeriveInput> = {}): DeriveInput => ({
  intent: { workRef: 'PROJ-187' },
  workItem: workItem(),
  workState: actionable,
  repo: repo(),
  maxScopes: ['fe/**', 'be/**'],
  existingIds: [],
  today: '20260828',
  ...over,
})

const provenanceOf = (draft: ReturnType<typeof deriveSessionContractDraft>, field: string) =>
  draft.provenance?.find((entry) => entry.field === field)

describe('P0-C — 조사 결과에서 계약 초안 도출', () => {
  it('goal 은 작업 항목에서 온 사실이고, 다시 쓰지 않는다', () => {
    const draft = deriveSessionContractDraft(input())

    assert.equal(draft.goal, 'PROJ-187: asset:// 참조 해석·회귀 테스트 작성')
    assert.equal(provenanceOf(draft, 'goal')?.status, 'FACT')
    assert.equal(provenanceOf(draft, 'goal')?.source, 'work_item')
  })

  it('세션 id 는 작업 항목 키가 아니라 S-YYYYMMDD-NN 이고, 쓰인 번호를 건너뛴다', () => {
    const draft = deriveSessionContractDraft(input({ existingIds: ['S-20260828-01', 'S-20260828-02'] }))

    assert.equal(draft.id, 'S-20260828-03')
    assert.equal(provenanceOf(draft, 'id')?.status, 'PROPOSAL')
  })

  it('boundary 는 절대 FACT 가 아니며 저장소에서 확인된 경로로 좁힌다', () => {
    const draft = deriveSessionContractDraft(input())

    assert.deepEqual(draft.boundary, ['fe/src/entities/asset/**'])
    assert.equal(provenanceOf(draft, 'boundary')?.status, 'PROPOSAL')
    assert.equal(provenanceOf(draft, 'boundary')?.source, 'repository')
  })

  it('작업 항목의 완료 조건을 옮기고, 없는 인수 조건은 지어내지 않는다', () => {
    const withAcceptance = deriveSessionContractDraft(input())
    assert.deepEqual(withAcceptance.criteria, [
      'asset:// 참조 해석 단위 테스트 존재',
      '잘못된 참조는 오류로 드러난다',
    ])
    assert.equal(provenanceOf(withAcceptance, 'criteria')?.status, 'FACT')

    const bare = deriveSessionContractDraft(input({ workItem: workItem({ body: '본문에 완료 조건이 없다' }) }))
    assert.equal(bare.criteria, undefined)
    assert.equal(provenanceOf(bare, 'criteria'), undefined)
  })

  it('완료 조건이 없으면 저장소가 이미 돌리는 검사를 제안으로만 든다', () => {
    const draft = deriveSessionContractDraft(
      input({ workItem: workItem({ body: undefined }), repoChecks: ['npm test'] }),
    )

    assert.deepEqual(draft.criteria, ['저장소 기존 검사 통과: npm test'])
    assert.equal(provenanceOf(draft, 'criteria')?.status, 'PROPOSAL')
    assert.equal(provenanceOf(draft, 'criteria')?.source, 'repository')
  })

  it('owner 를 여기서 정하지 않는다 — 책임 판정은 planSessionContract 것이다', () => {
    const draft = deriveSessionContractDraft(input())
    assert.equal(draft.owner, undefined)
  })

  it('도출한 초안이 실제 planSessionContract 에서 READY_TO_ISSUE 가 된다', () => {
    const derived = deriveSessionContractDraft(input())
    const plan = planSessionContract({ draft: derived, policy: policy(), existingIds: [] })

    assert.equal(plan.status, 'READY_TO_ISSUE', JSON.stringify(plan.unresolved.concat(plan.invalid as never[])))
    assert.equal(plan.issuance.authority, 'delegated')
    assert.ok(plan.facts.some((f) => f.field === 'goal'))
  })

  it('완료 조건도 저장소 검사도 없으면 사람 결정으로 남는다 — 지어내는 대신 묻는다', () => {
    const derived = deriveSessionContractDraft(input({ workItem: workItem({ body: undefined }) }))
    const plan = planSessionContract({ draft: derived, policy: policy(), existingIds: [] })

    assert.equal(plan.status, 'NEEDS_DECISION')
    assert.ok(plan.unresolved.some((u) => u.field === 'criteria'))
  })
})

describe('P0-1 — roleScopes 는 상한이지 boundary 의 출처가 아니다', () => {
  it('상한이 ** 여도 boundary 를 ** 로 만들지 않는다', () => {
    const draft = deriveSessionContractDraft(input({ maxScopes: ['**'] }))

    assert.ok(draft.boundary, 'boundary 가 비었다 — 좁힐 근거가 있었는데 못 찾았다')
    assert.ok(!draft.boundary!.includes('**'), `상한을 그대로 복사했다: ${draft.boundary}`)
  })

  it('정책이 아예 없어도 ** 로 떨어지지 않는다 — 정책 부재는 전체 허용이 아니다', () => {
    const draft = deriveSessionContractDraft(input({ maxScopes: [] }))

    assert.ok(!(draft.boundary ?? []).includes('**'))
  })

  it('좁힐 근거가 없으면 비워 두고, planSessionContract 가 사람에게 묻는다', () => {
    const derived = deriveSessionContractDraft(
      input({
        workItem: workItem({ body: '완료 조건\n[ ] 무언가', title: '경로가 없는 작업' }),
        repo: repo({ pathsExist: {} }),
        maxScopes: ['**'],
      }),
    )

    assert.equal(derived.boundary, undefined)
    const plan = planSessionContract({ draft: derived, policy: policy(), existingIds: [] })
    assert.equal(plan.status, 'NEEDS_DECISION')
    assert.ok(plan.unresolved.some((u) => u.field === 'boundary'))
  })

  it('상한 밖 후보는 버린다 — 넓히는 방향으로는 제안하지 않는다', () => {
    const draft = deriveSessionContractDraft(
      input({ maxScopes: ['be/**'], repo: repo({ pathsExist: { 'fe/src/entities/asset': true } }) }),
    )

    assert.equal(draft.boundary, undefined)
  })

  it('참고 문서 경로는 쓰기 범위로 승격하지 않는다', () => {
    const draft = deriveSessionContractDraft(
      input({
        workItem: workItem({ body: '참고\n- specs/009-project-exhibition/spec.md 를 보라' }),
        repo: repo({ pathsExist: { 'specs/009-project-exhibition/spec.md': true } }),
        maxScopes: ['**'],
      }),
    )

    assert.equal(draft.boundary, undefined, `읽기 근거를 쓰기 범위로 올렸다: ${draft.boundary}`)
  })

  it('분류 이름이 유일하게 맞는 모듈이 있으면 그 모듈로 좁힌다', () => {
    const draft = deriveSessionContractDraft(
      input({
        workItem: workItem({ body: '경로 언급 없음', labels: ['frontend'] }),
        repo: repo({ pathsExist: { 'festa-frontend': true, 'festa-frontend/src': true, backend: true } }),
        maxScopes: ['**'],
      }),
    )

    assert.deepEqual(draft.boundary, ['festa-frontend/src/**'])
  })

  it('분류에 맞는 후보가 둘이면 고르지 않는다', () => {
    const draft = deriveSessionContractDraft(
      input({
        workItem: workItem({ body: '경로 언급 없음', labels: ['front'] }),
        repo: repo({ pathsExist: { 'festa-frontend': true, 'admin-frontend': true } }),
        maxScopes: ['**'],
      }),
    )

    assert.equal(draft.boundary, undefined)
  })
})
