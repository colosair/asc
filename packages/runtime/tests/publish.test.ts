// 게시 — 밖에 하나를 만들되, 두 번 만들지 않는다.
//
// 지키는 문장 다섯:
//   응답을 잃어도 다시 만들지 않는다 (R3)
//   주소 모양이 달라도 같은 것을 다시 만들지 않는다 (R3)
//   내부 값은 경계를 넘지 않는다 (R4)
//   모호하면 만들지 않는다
//   못 찾은 것을 없는 것으로 읽지 않는다

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FixtureSurfaceAdapter } from '../adapters/fixture-surface/index.ts'
import { CoordinationLedger } from '../core/runtime/coordination.ts'
import {
  decidePublish,
  publishLine,
  publishOnce,
  recordPublication,
  type PublishIntent,
} from '../core/runtime/publish.ts'
import type { ScopedStore } from '../ports/state-store.ts'

function memoryScope(): ScopedStore {
  const data = new Map<string, string>()
  return {
    async get(key) {
      return data.get(key) ?? null
    },
    async set(key, value) {
      data.set(key, value)
    },
    async delete(key) {
      data.delete(key)
    },
    async keys(prefix) {
      return [...data.keys()].filter((key) => (prefix ? key.startsWith(prefix) : true))
    },
    async setIfAbsent(key, value) {
      if (data.has(key)) return false
      data.set(key, value)
      return true
    },
  }
}

const intent = (over: Partial<PublishIntent> = {}): PublishIntent => ({
  queryId: 'X-20260905-01',
  publicPayload: { title: 'Contract question', body: 'Which side owns the retry?' },
  ...over,
})

describe('publish', () => {
  it('응답을 잃어도 다음 회차가 다시 만들지 않는다 (R3)', async () => {
    // 만들기는 성공했는데 응답이 오지 않는다 — 실제로 중복을 만든 그 상황.
    const surface = new FixtureSurfaceAdapter({ loseNextResponses: 1 })

    const first = await publishOnce(intent(), { surface })
    assert.equal(first.ok, false)
    assert.equal(first.ok === false && first.reason, 'CREATE_FAILED')
    assert.equal(surface.objects.length, 1, '객체는 밖에 남아 있다')

    const second = await publishOnce(intent(), { surface })
    assert.equal(second.ok, true)
    assert.equal(second.ok === true && second.action, 'ATTACHED')
    assert.equal(surface.createCalls, 1, '두 번째 회차는 만들지 않는다')
    assert.equal(surface.objects.length, 1)
  })

  it('주소 모양이 바뀌어도 같은 것으로 본다 (R3)', async () => {
    const surface = new FixtureSurfaceAdapter()
    const created = await publishOnce(intent(), { surface })
    assert.equal(created.ok, true)

    // 같은 게시판인데 주소를 다르게 짓기 시작한다. 신원은 그대로다.
    const renamed = new FixtureSurfaceAdapter({ locatorShape: (id) => `https://other.example/t/${id}` })
    renamed.objects.push(...surface.objects)

    const again = await publishOnce(intent(), { surface: renamed })
    assert.equal(again.ok, true)
    assert.equal(again.ok === true && again.action, 'ATTACHED')
    assert.equal(renamed.createCalls, 0, '주소가 달라도 다시 만들지 않는다')
    assert.notEqual(
      created.ok === true && created.identity.locator,
      again.ok === true && again.identity.locator,
      '주소는 실제로 달라졌다 — 그런데도 같은 것으로 판정했다',
    )
    assert.equal(
      created.ok === true && created.identity.objectId,
      again.ok === true && again.identity.objectId,
    )
  })

  it('내부 값은 공개 경계를 넘지 않는다 (R4)', async () => {
    const canary = 'CANARY-ffb0c2-internal-only'
    const surface = new FixtureSurfaceAdapter()

    const outcome = await publishOnce(
      intent({
        internal: { note: canary, routedBy: canary, evidenceSource: canary },
        audience: ['owner'],
      }),
      { surface },
    )
    assert.equal(outcome.ok, true)

    // 밖으로 나간 것 전부를 직렬화해 canary 를 찾는다. 관례가 아니라 관측으로 확인한다.
    const published = JSON.stringify(surface.objects)
    assert.equal(published.includes(canary), false, '내부 값이 게시물에 실렸다')
    assert.equal(published.includes('Contract question'), true, '공개 내용은 실제로 나갔다')
  })

  it('모호하면 만들지 않는다', async () => {
    const surface = new FixtureSurfaceAdapter()
    surface.seed({ payload: { title: 'A', body: 'a' }, correlation: 'X-20260905-01' })
    surface.seed({ payload: { title: 'B', body: 'b' }, correlation: 'X-20260905-01' })

    const outcome = await publishOnce(intent(), { surface })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.reason, 'AMBIGUOUS')
    assert.equal(surface.createCalls, 0)
    assert.match(publishLine(outcome), /a person picks one/)
  })

  it('작업 항목만 겹치는 것은 근거가 되지 않는다', async () => {
    const surface = new FixtureSurfaceAdapter()
    surface.seed({ payload: { title: '다른 조율', body: '…' }, correlation: 'X-20260905-99', workReference: 'ABC-123' })

    const outcome = await publishOnce(intent({ workReference: 'ABC-123' }), { surface })
    assert.equal(outcome.ok, false, '약한 근거로 남의 스레드에 붙지 않는다')
    assert.equal(outcome.ok === false && outcome.reason, 'AMBIGUOUS')
    assert.equal(surface.createCalls, 0, '약한 근거가 있는 동안에는 새로 만들지도 않는다')
  })

  it('못 찾은 것을 없는 것으로 읽지 않는다', async () => {
    const surface = new FixtureSurfaceAdapter({ findFails: true })
    const outcome = await publishOnce(intent(), { surface })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.reason, 'DISCOVERY_FAILED')
    assert.equal(surface.createCalls, 0)
  })

  it('되읽히지 않으면 성공이라고 하지 않는다', async () => {
    const surface = new FixtureSurfaceAdapter()
    const forgetful = {
      id: surface.id,
      find: surface.find.bind(surface),
      create: surface.create.bind(surface),
      read: async () => null,
    }
    const outcome = await publishOnce(intent(), { surface: forgetful })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.reason, 'NOT_VERIFIED')
    assert.equal(surface.createCalls, 1, '다시 만들지 않는다')
  })

  it('아는 신원이 우선이고, 없으면 만든다', () => {
    assert.equal(decidePublish([]).verdict, 'CREATE_NEW')
    const one = decidePublish([
      {
        identity: { adapter: 'x', objectType: 'thread', objectId: 'OBJ-1' },
        title: 't',
        matchedBy: 'known-identity',
      },
    ])
    assert.equal(one.verdict, 'ATTACH_EXISTING')
  })

  it('같은 게시를 두 번 적지 않는다 (F3)', async () => {
    const surface = new FixtureSurfaceAdapter()
    const ledger = new CoordinationLedger(memoryScope())

    const first = await publishOnce(intent(), { surface })
    assert.equal(first.ok, true)
    if (first.ok !== true) return
    assert.equal((await recordPublication(ledger, first)).ok, true)

    // 다음 회차는 이미 있는 것에 붙는다 — 같은 신원이므로 같은 증거 id 가 나온다.
    const again = await publishOnce(intent(), { surface })
    assert.equal(again.ok, true)
    if (again.ok !== true) return
    const second = await recordPublication(ledger, again)
    assert.equal(second.ok, false)
    assert.equal(second.ok === false && second.reason, 'ALREADY_EXISTS')
    assert.equal((await ledger.communications()).length, 1)
  })

  it('증거는 게시 사실만 담고 답의 의미를 담지 않는다', async () => {
    const surface = new FixtureSurfaceAdapter()
    const outcome = await publishOnce(intent({ audience: ['front', 'back'] }), {
      surface,
      bindingRole: 'coordination-surface',
    })
    assert.equal(outcome.ok, true)
    if (outcome.ok !== true) return
    assert.equal(outcome.evidence.queryId, 'X-20260905-01')
    assert.equal(outcome.evidence.bindingRole, 'coordination-surface')
    assert.equal(outcome.evidence.evidenceSource, 'surface-read-back')
    assert.deepEqual([...outcome.evidence.audience], ['front', 'back'])
    assert.equal('answered' in outcome.evidence, false)
  })
})
