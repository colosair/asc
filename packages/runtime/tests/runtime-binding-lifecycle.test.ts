// 0.7.0 — 결합의 수명 (D-03).
//
// 조사에서 실기계 이력을 복원해 보니 같은 Physical Run 이 회차마다 두 Logical Session 을
// 겹쳐 잡고 있었다:
//
//   S-03  claimed 08:49:24  ended 09:00:15
//   S-03  claimed 09:01:36  ended 09:15:42
//   S-04  claimed 09:15:00  ended 09:15:26   ← S-03 이 아직 살아 있는 동안
//   S-05  claimed 09:18:59  ended 09:19:09   ← S-04 가 아직 살아 있는 동안
//
// 그 상태에서 guard 가 "이 physical 은 관리 대상" 이라고 답할 때 어느 계약을 말하는지가
// 정해지지 않는다. 여기 있는 검사들이 그 자리를 닫는다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { ScopedRuntimeBindings } from '../adapters/memory/runtime-binding.ts'

const NOW = '2026-09-06T00:00:00.000Z'
const LATER = '2026-09-06T00:10:00.000Z'
const PHYS = 'phys-1'

const bindingsOn = () => new ScopedRuntimeBindings(new MemoryStateStore().scope('test-host'))
const spec = (logical: string, physical = PHYS) => ({
  logicalSessionId: logical,
  provider: 'test-host',
  physicalSessionId: physical,
})

describe('한 Physical Run 은 한 Logical Session 만 잡는다', () => {
  it('다른 세션이 같은 physical 을 집으려 하면 충돌이다 — 뺏지 않는다', async () => {
    const bindings = bindingsOn()
    assert.ok((await bindings.claim(spec('S-20260906-01'), NOW)).ok)

    const second = await bindings.claim(spec('S-20260906-02'), LATER)
    assert.equal(second.ok, false)
    assert.equal(second.ok === false && second.reason, 'RUNTIME_CONFLICT')
    // 무엇과 부딪혔는지 말한다 — 사람이 어느 세션을 놓을지 정한다
    assert.equal(second.ok === false && second.current.logicalSessionId, 'S-20260906-01')
    assert.equal(await bindings.get('S-20260906-02'), null, '진 쪽은 결합이 생기지 않는다')
  })

  it('놓은 뒤에는 같은 physical 로 다음 세션을 잡을 수 있다', async () => {
    const bindings = bindingsOn()
    await bindings.claim(spec('S-20260906-01'), NOW)
    assert.equal(await bindings.release('S-20260906-01', PHYS), true)

    assert.ok((await bindings.claim(spec('S-20260906-02'), LATER)).ok)
    const live = await bindings.current()
    assert.deepEqual(live.map((b) => b.logicalSessionId), ['S-20260906-02'])
    assert.equal(live.length, 1, '살아 있는 결합은 언제나 하나다')
  })

  it('같은 세션을 다시 집는 것은 충돌이 아니다', async () => {
    const bindings = bindingsOn()
    await bindings.claim(spec('S-20260906-01'), NOW)
    assert.ok((await bindings.claim(spec('S-20260906-01'), LATER)).ok, '이어 잡기는 막지 않는다')
  })

  it('서로 다른 physical 이 서로 다른 세션을 잡는 것은 정상이다', async () => {
    const bindings = bindingsOn()
    await bindings.claim(spec('S-20260906-01', 'phys-a'), NOW)
    assert.ok((await bindings.claim(spec('S-20260906-02', 'phys-b'), LATER)).ok)
    assert.equal((await bindings.current()).length, 2)
  })
})

describe('놓으면 실제로 사라진다 — guard 가 그 파일 하나로 판정한다', () => {
  it('release 뒤 현재 결합이 없고 이력은 남는다', async () => {
    const bindings = bindingsOn()
    await bindings.claim(spec('S-20260906-01'), NOW)
    await bindings.release('S-20260906-01', PHYS)

    assert.equal(await bindings.get('S-20260906-01'), null)
    assert.deepEqual(
      (await bindings.history('S-20260906-01')).map((entry) => entry.kind),
      ['CLAIMED', 'RELEASED'],
    )
  })

  it('owner 가 아니면 놓지 못하고 결합도 그대로다', async () => {
    const bindings = bindingsOn()
    await bindings.claim(spec('S-20260906-01'), NOW)
    assert.equal(await bindings.release('S-20260906-01', 'someone-else'), false)
    assert.ok(await bindings.get('S-20260906-01'))
  })
})

describe('지워졌어야 할 결합을 알아본다 (0.6.x 잔재)', () => {
  it('마지막 사건이 끝남인데 결합이 남아 있으면 stale 이다', async () => {
    const store = new MemoryStateStore()
    const bindings = new ScopedRuntimeBindings(store.scope('test-host'))
    await bindings.claim(spec('S-20260906-01'), NOW)
    await bindings.release('S-20260906-01', PHYS)
    // 놓았는데 파일만 되살아난 상태를 만든다 — 0.6.x 에서 나올 수 있던 모양이다
    await store.scope('test-host').set(
      'runtime-binding:S-01',
      JSON.stringify({ ...spec('S-20260906-01'), updatedAt: NOW }),
    )

    const stale = await bindings.stale()
    assert.deepEqual(stale.map((b) => b.logicalSessionId), ['S-20260906-01'])
  })

  it('끝난 뒤 **다시 집은** 것은 stale 이 아니다', async () => {
    // 이 구분이 없으면 정상 재결합을 죽은 것으로 읽고 사람의 세션을 끊는다.
    const bindings = bindingsOn()
    await bindings.claim(spec('S-20260906-01'), NOW)
    await bindings.release('S-20260906-01', PHYS)
    await bindings.claim(spec('S-20260906-01'), LATER)

    assert.deepEqual(await bindings.stale(), [])
  })

  it('치우는 것은 결합뿐이다 — 이력은 건드리지 않는다', async () => {
    const bindings = bindingsOn()
    await bindings.claim(spec('S-20260906-01'), NOW)
    const before = (await bindings.history('S-20260906-01')).length

    assert.equal(await bindings.forget('S-20260906-01'), true)
    assert.equal(await bindings.get('S-20260906-01'), null)
    assert.equal((await bindings.history('S-20260906-01')).length, before)
    assert.equal(await bindings.forget('S-20260906-01'), false, '두 번째는 할 일이 없다')
  })
})
