// 0.7.0 / D-06 — 인계는 회수를 지나 화면까지 간다.
//
// 데이터는 한 번도 잃은 적이 없다. 세션 파일에 next·verified·done·unresolved 가 그대로
// 적혔고 보관소로 옮겨진 뒤에도 남아 있었다. 잃은 것은 **화면**이다:
//
//   collect → store.archive('session', id)      active 에서 archive 로 옮긴다
//   render  → store.list('session')             list 는 active 만 읽는다
//   find(id) → undefined                        방금 거둔 것을 못 찾는다
//   화면     → "(다음 작업 없음)"
//
// 회수가 인계를 읽은 주체이므로, 읽은 것을 그대로 넘긴다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { collectSessions, renderCollect } from '../core/runtime/controller.ts'
import { Session } from '../core/model/entities.ts'

const NOW = '2026-09-06T00:00:00.000Z'

const finished = () =>
  Session.parse({
    id: 'S-20260906-03',
    version: 1,
    status: 'DONE',
    role: 'implementer',
    goal: 'WorldHud 조작 안내 4항',
    doneCriteria: ['4항이 보인다'],
    writeBoundary: ['fe/**'],
    handoff: {
      done: ['WorldHud 4항 추가'],
      changed: ['fe/WorldHud.tsx', 'fe/__tests__/worldHudControls.test.tsx'],
      verified: '완료조건 5개 자체 검증 — vitest 577/577',
      unresolved: ['실 브라우저 육안 확인 미실행 — 09-08 이월'],
      next: '09-08 runtime acceptance',
      recordedAt: NOW,
    },
  })

describe('거둔 뒤에도 인계가 화면에 남는다', () => {
  it('next · verified · done · 바꾼 것이 전부 나온다', async () => {
    const store = new MemoryStateStore()
    await store.create('session', finished())

    const outcome = await collectSessions(store, NOW)
    const text = renderCollect(outcome)

    assert.match(text, /09-08 runtime acceptance/, 'next 가 사라졌다')
    assert.match(text, /완료: WorldHud 4항 추가/)
    assert.match(text, /검증: 완료조건 5개/)
    assert.match(text, /바꾼 것: fe\/WorldHud\.tsx/)
  })

  it('미결은 판단이 필요한 것으로 올라온다', async () => {
    const store = new MemoryStateStore()
    await store.create('session', finished())

    const text = renderCollect(await collectSessions(store, NOW))
    assert.match(text, /판단이 필요한 것:/)
    assert.match(text, /실 브라우저 육안 확인 미실행/)
  })

  it('보관소의 값과 화면의 값이 같다', async () => {
    const store = new MemoryStateStore()
    const session = finished()
    await store.create('session', session)

    const outcome = await collectSessions(store, NOW)

    // 옮겨졌다 — 현재 목록에는 없다
    assert.deepEqual(await store.list('session'), [])
    // 그런데 회수 결과는 그 값을 그대로 들고 있다
    assert.equal(outcome.handoffs.length, 1)
    assert.deepEqual(outcome.handoffs[0]!.handoff, session.handoff)
  })

  it('인계를 적지 않은 세션은 여전히 "다음 작업 없음" 이다 — 지어내지 않는다', async () => {
    const store = new MemoryStateStore()
    const bare = finished()
    delete (bare as { handoff?: unknown }).handoff
    await store.create('session', Session.parse(bare))

    const text = renderCollect(await collectSessions(store, NOW))
    assert.match(text, /\(다음 작업 없음\)/)
  })
})
