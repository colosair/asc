// 조율 증거 — 물었다·전달됐다·답이 왔다를 따로 적는다.
//
// 지키는 문장 다섯:
//   기대만 있고 게시가 없으면 그렇게 말한다 (F1·F2)
//   상태를 저장하지 않고 증거에서 파생한다
//   응답 증거가 답의 의미가 되지 않는다 (C-13 과 섞지 않는다)
//   같은 것을 두 번 적지 않는다 (F3)
//   provider 이름을 모른다 (C-09)

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CoordinationLedger,
  coordinationLines,
  deriveCoordination,
  viewCoordination,
  type CommunicationEvidence,
} from '../core/runtime/coordination.ts'
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

const AT = '2026-09-05T00:00:00.000Z'
const identity = (objectId: string) => ({
  adapter: 'fixture',
  objectType: 'discussion',
  objectId,
  resource: 'org/repo',
  locator: `https://example.invalid/org/repo/d/${objectId}`,
})

const published = (overrides: Partial<CommunicationEvidence> = {}): Parameters<CoordinationLedger['publishRecorded']>[0] => ({
  evidenceId: 'CE-1',
  queryId: 'X-20260905-01',
  bindingRole: 'coordination',
  identity: identity('101'),
  audience: ['other-part'],
  publishedAt: AT,
  evidenceSource: 'adapter-read-back',
  ...overrides,
})

describe('파생 — 상태를 저장하지 않는다', () => {
  it('기대만 있고 게시가 없으면 UNPUBLISHED (F1·F2)', () => {
    const view = deriveCoordination({
      queryId: 'X-20260905-01',
      expectsResponse: true,
      communications: [],
      responses: [],
    })
    assert.equal(view.state, 'UNPUBLISHED')
  })

  it('게시됐고 답을 기다리면 WAITING_EXTERNAL', async () => {
    const ledger = new CoordinationLedger(memoryScope(), () => AT)
    await ledger.publishRecorded(published())
    const [view] = await viewCoordination(ledger, [{ id: 'X-20260905-01', expectsResponse: true }])
    assert.equal(view!.state, 'WAITING_EXTERNAL')
  })

  it('답이 오면 RESPONSE_RECEIVED', async () => {
    const ledger = new CoordinationLedger(memoryScope(), () => AT)
    await ledger.publishRecorded(published())
    await ledger.responseRecorded({
      evidenceId: 'RE-1',
      communicationId: 'CE-1',
      identity: identity('101#c1'),
      responder: 'someone',
      receivedAt: AT,
      evidenceSource: 'adapter-observed',
    })
    const [view] = await viewCoordination(ledger, [{ id: 'X-20260905-01', expectsResponse: true }])
    assert.equal(view!.state, 'RESPONSE_RECEIVED')
  })

  it('답을 기대하지 않는 통보는 게시만으로 끝난다', () => {
    const view = deriveCoordination({
      queryId: 'X-20260905-01',
      expectsResponse: false,
      communications: [published() as unknown as CommunicationEvidence],
      responses: [],
    })
    // 기다린다고 그리면 영영 안 끝나는 항목이 하나 생긴다
    assert.equal(view.state, 'PUBLISHED')
  })

  it('상태가 저장되지 않는다 — 저장소에 상태 키가 없다', async () => {
    const scope = memoryScope()
    const ledger = new CoordinationLedger(scope, () => AT)
    await ledger.publishRecorded(published())
    const keys = await scope.keys()
    assert.ok(keys.every((key) => key.startsWith('coord:pub:') || key.startsWith('coord:res:')), keys.join(','))
    assert.ok(!keys.some((key) => key.includes('state') || key.includes('health')))
  })
})

describe('원장 — 증거는 한 번만 쓰인다', () => {
  it('같은 증거 id 를 덮지 않는다', async () => {
    const ledger = new CoordinationLedger(memoryScope(), () => AT)
    assert.equal((await ledger.publishRecorded(published())).ok, true)
    const again = await ledger.publishRecorded(published({ audience: ['someone-else'] }))
    assert.equal(again.ok, false)
    assert.equal(again.ok === false && again.reason, 'ALREADY_EXISTS')
    // 먼저 쓴 것이 남는다
    const [stored] = await ledger.communications()
    assert.deepEqual(stored!.audience, ['other-part'])
  })

  it('게시된 적 없는 것에 응답을 붙이지 않는다', async () => {
    const ledger = new CoordinationLedger(memoryScope(), () => AT)
    const outcome = await ledger.responseRecorded({
      evidenceId: 'RE-1',
      communicationId: 'CE-missing',
      identity: identity('x'),
      receivedAt: AT,
      evidenceSource: 'adapter-observed',
    })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.reason, 'COMMUNICATION_NOT_FOUND')
  })

  it('원격 신원으로 기존 게시물을 찾는다 — 링크가 아니라 안정 id 로 (F3)', async () => {
    const ledger = new CoordinationLedger(memoryScope(), () => AT)
    await ledger.publishRecorded(published())

    // 같은 객체인데 사람이 보는 주소만 다르게 돌아온 경우
    const found = await ledger.findByIdentity({ adapter: 'fixture', objectType: 'discussion', objectId: '101' })
    assert.ok(found, '링크 모양이 달라도 같은 객체로 찾힌다')
    assert.equal(found.evidenceId, 'CE-1')

    assert.equal(await ledger.findByIdentity({ adapter: 'fixture', objectType: 'discussion', objectId: '102' }), null)
  })

  it('반복 조회에서 증거가 늘지 않는다 (R11)', async () => {
    const ledger = new CoordinationLedger(memoryScope(), () => AT)
    await ledger.publishRecorded(published())
    await ledger.publishRecorded(published())
    await ledger.publishRecorded(published())
    assert.equal((await ledger.communications()).length, 1)
  })
})

describe('경계 — 다른 것이 되지 않는다', () => {
  // 산문에 이름이 나오는 것은 설명이고, 코드가 그것을 아는 것과 다르다.
  // 그래서 주석을 걷어낸 코드만 본다 — 앞선 회차에 산문 검사로 잘못 잡은 적이 있다.
  const codeOnly = async (): Promise<string> => {
    const source = await (await import('node:fs/promises')).readFile(
      new URL('../core/runtime/coordination.ts', import.meta.url),
      'utf8',
    )
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
  }

  it('응답 증거가 답·승인·상신으로 넘어가는 경로가 없다 (C-13 과 분리)', async () => {
    const code = await codeOnly()
    assert.doesNotMatch(code, /ApprovalRequest|ExecutionGrant|EscalationLedger|QueryAnswer/)
    // 다른 계층을 부르지 않는다 — 이 모듈은 증거만 다룬다
    assert.doesNotMatch(code, /from '\.\.\/\.\.\/adapters\//)
    assert.doesNotMatch(code, /from '\.\.\/approval\/|from '\.\.\/execution\//)
  })

  // provider 어휘 자체는 core/** 전체에 걸린 기존 게이트가 더 엄하게 본다
  // (주석까지 포함해 등장 자체를 막는다). 여기서 약한 사본을 만들지 않는다.

  it('링크는 판정에 쓰이지 않는다 — 없어도 상태가 선다', async () => {
    const ledger = new CoordinationLedger(memoryScope(), () => AT)
    await ledger.publishRecorded(
      published({ identity: { adapter: 'fixture', objectType: 'discussion', objectId: '101' } }),
    )
    const [view] = await viewCoordination(ledger, [{ id: 'X-20260905-01', expectsResponse: true }])
    assert.equal(view!.state, 'WAITING_EXTERNAL')
    // 사람이 읽는 줄에서도 링크가 없으면 안정 신원을 보인다
    assert.match(coordinationLines([view!]).join('\n'), /fixture:discussion:101/)
  })

  it('기대가 없으면 조율도 없다 — 0 으로 그리지 않는다', async () => {
    const ledger = new CoordinationLedger(memoryScope(), () => AT)
    assert.deepEqual(await viewCoordination(ledger, []), [])
    assert.match(coordinationLines([]).join('\n'), /No external expectation/)
  })

  it('다른 기대의 증거가 섞이지 않는다 (R12)', async () => {
    const ledger = new CoordinationLedger(memoryScope(), () => AT)
    await ledger.publishRecorded(published())
    await ledger.publishRecorded(published({ evidenceId: 'CE-2', queryId: 'X-20260905-02' }))

    const views = await viewCoordination(ledger, [
      { id: 'X-20260905-01', expectsResponse: true },
      { id: 'X-20260905-02', expectsResponse: true },
    ])
    assert.equal(views[0]!.communications.length, 1)
    assert.equal(views[1]!.communications.length, 1)
    assert.notEqual(views[0]!.communications[0]!.evidenceId, views[1]!.communications[0]!.evidenceId)
  })
})

// 이 기능이 붙어도 달라지면 안 되는 것들.
describe('영향 경계', () => {
  it('작업 항목 provider 가 없는 프로젝트에는 아무 요구도 생기지 않는다 (R10)', async () => {
    // 기대가 없으면 조율도 없다. 어떤 외부 도구도 부르지 않고, 설치를 요구하지도 않는다.
    const ledger = new CoordinationLedger(memoryScope(), () => AT)
    const views = await viewCoordination(ledger, [])
    assert.deepEqual(views, [])

    const code = await (await import('node:fs/promises')).readFile(
      new URL('../core/runtime/coordination.ts', import.meta.url),
      'utf8',
    )
    // 외부를 부르는 경로가 이 모듈에 없다 — 조회도 실행도 전부 호출자의 몫이다
    assert.doesNotMatch(code.replace(/\/\/.*/g, ''), /fetch\(|spawn|execFile|http/)
  })

  it('한 provider 의 증거가 없어도 다른 provider 증거는 그대로 선다 (R9)', async () => {
    const ledger = new CoordinationLedger(memoryScope(), () => AT)
    // adapter 가 둘이고 한쪽만 게시에 성공한 상태
    await ledger.publishRecorded(published({ evidenceId: 'CE-a', queryId: 'X-20260905-01' }))
    await ledger.publishRecorded(
      published({
        evidenceId: 'CE-b',
        queryId: 'X-20260905-02',
        identity: { adapter: 'other-fixture', objectType: 'thread', objectId: '9' },
      }),
    )

    const views = await viewCoordination(ledger, [
      { id: 'X-20260905-01', expectsResponse: true },
      { id: 'X-20260905-02', expectsResponse: true },
      // 세 번째 기대는 어느 provider 로도 나가지 못했다
      { id: 'X-20260905-03', expectsResponse: true },
    ])
    assert.deepEqual(views.map((view) => view.state), [
      'WAITING_EXTERNAL',
      'WAITING_EXTERNAL',
      'UNPUBLISHED',
    ])
  })

  it('같은 증거를 다시 관측해도 상태가 늘거나 바뀌지 않는다 (R8·R11)', async () => {
    // 상시 runtime 이 회차마다 같은 것을 본다. 그때 새 사실이 생기면 안 된다.
    const ledger = new CoordinationLedger(memoryScope(), () => AT)
    await ledger.publishRecorded(published())

    const once = await viewCoordination(ledger, [{ id: 'X-20260905-01', expectsResponse: true }])
    await ledger.publishRecorded(published())
    await ledger.publishRecorded(published())
    const again = await viewCoordination(ledger, [{ id: 'X-20260905-01', expectsResponse: true }])

    assert.deepEqual(once, again)
  })

  it('탐지에 Host 가 필요하지 않다 (R8)', async () => {
    const code = await (await import('node:fs/promises')).readFile(
      new URL('../core/runtime/coordination.ts', import.meta.url),
      'utf8',
    )
    // Host 어휘도 세션 생성 경로도 없다 — 회차가 부르든 사람이 부르든 같은 답이다
    assert.doesNotMatch(code.replace(/\/\/.*/g, ''), /host|session\.create|SessionRuntime/i)
  })
})
