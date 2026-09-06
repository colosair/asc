// 0.7.0 / Phase J — 붙어 있다는 것과 실제로 돌고 있다는 것은 다른 사실이다.
//
// 실측: 이 기계의 workspace 세 개 중 둘이 여러 릴리스 동안 회차를 한 번도 통과하지
// 못했는데 화면 어디에도 그 말이 없었다. 붙어 있었고, 등록물도 서 있었고, 그래서
// 건강해 보였다. 실패는 service.log 로만 흘러갔고 아무도 그것을 읽지 않는다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryStateStore } from '../adapters/memory/state-store.ts'
import { passLine, readBackground, recordPass, renderBackground } from '../core/runtime/background.ts'

const scopeOf = () => new MemoryStateStore().scope('runtime')
const STALE = 15 * 60_000

describe('회차 결말을 그 자리에 적는다', () => {
  it('실패는 연속으로 세어진다', async () => {
    const scope = scopeOf()
    await recordPass(scope, 2, '2026-09-06T00:00:00.000Z')
    const second = await recordPass(scope, 2, '2026-09-06T00:05:00.000Z')

    assert.equal(second.consecutiveFailures, 2)
    assert.equal(second.lastOkAt, undefined, '한 번도 통과한 적이 없다')
  })

  it('통과 한 번이 실패의 역사를 지운다 — 사람이 볼 것은 지금이다', async () => {
    const scope = scopeOf()
    await recordPass(scope, 2, '2026-09-06T00:00:00.000Z')
    const ok = await recordPass(scope, 0, '2026-09-06T00:05:00.000Z')

    assert.equal(ok.consecutiveFailures, 0)
    assert.equal(ok.lastOkAt, '2026-09-06T00:05:00.000Z')
  })

  it('마지막으로 통과한 시각은 실패를 넘어 남는다', async () => {
    const scope = scopeOf()
    await recordPass(scope, 0, '2026-09-06T00:00:00.000Z')
    const failed = await recordPass(scope, 2, '2026-09-06T00:05:00.000Z')

    assert.equal(failed.lastOkAt, '2026-09-06T00:00:00.000Z')
    assert.equal(failed.consecutiveFailures, 1)
  })
})

describe('어긋나 있으면 화면이 그렇게 말한다', () => {
  it('통과한 회차는 아무 말도 만들지 않는다', () => {
    assert.equal(
      passLine({ at: '2026-09-06T00:00:00.000Z', code: 0, consecutiveFailures: 0, lastOkAt: '2026-09-06T00:00:00.000Z' }),
      null,
    )
  })

  it('DEGRADED 와 함께 몇 번째인지, 마지막 통과가 언제인지 말한다', () => {
    const line = passLine({ at: '2026-09-06T00:05:00.000Z', code: 2, consecutiveFailures: 7 })
    assert.match(line ?? '', /DEGRADED/)
    assert.match(line ?? '', /7 in a row/)
    assert.match(line ?? '', /no pass has ever succeeded/)
    assert.match(line ?? '', /Attached is not the same as observed/)
  })

  it('background 화면이 그 줄을 lease 상태보다 먼저 낸다', async () => {
    const scope = scopeOf()
    await recordPass(scope, 2)
    const lines = renderBackground(await readBackground(scope, STALE))

    assert.match(lines[0] ?? '', /DEGRADED/, '아래 줄들은 "돌고 있다"로 읽힌다')
  })

  it('한 번도 회차가 없었으면 아무 말도 지어내지 않는다', async () => {
    const lines = renderBackground(await readBackground(scopeOf(), STALE))
    assert.equal(
      lines.some((line) => line.includes('DEGRADED')),
      false,
    )
  })
})
