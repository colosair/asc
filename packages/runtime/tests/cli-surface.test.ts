// CLI 표면 — 사용자 입력 오류에 Node 스택을 던지지 않는다 (SSAFESTA Windows 실측
// ASC-1·ASC-3·ASC-5의 회귀 고정). 실행 중인 버전을 묻는 통로도 여기 산다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runAscCommand } from '../cli/asc.ts'
import { RELEASE_VERSION } from '../core/distribution/release.ts'

type Captured = { code: number; out: string; err: string }

async function run(argv: string[]): Promise<Captured> {
  const out: string[] = []
  const err: string[] = []
  const log = console.log
  const error = console.error
  console.log = (...parts: unknown[]) => void out.push(parts.join(' '))
  console.error = (...parts: unknown[]) => void err.push(parts.join(' '))
  try {
    const code = await runAscCommand(argv)
    return { code, out: out.join('\n'), err: err.join('\n') }
  } finally {
    console.log = log
    console.error = error
  }
}

describe('ASC-1 — 실행 중인 버전을 물을 수 있다', () => {
  it('asc --version 은 패키지 버전 한 줄이다', async () => {
    const result = await run(['--version'])
    assert.equal(result.code, 0)
    assert.equal(result.out.trim(), RELEASE_VERSION)
  })

  it('asc version 도 같은 답이다', async () => {
    const result = await run(['version'])
    assert.equal(result.code, 0)
    assert.equal(result.out.trim(), RELEASE_VERSION)
  })
})

describe('입력 오류는 사용자 오류로 답한다 — 스택 없음', () => {
  it('모르는 옵션은 안내와 함께 exit 2', async () => {
    const result = await run(['--no-such-flag'])
    assert.equal(result.code, 2)
    assert.match(result.err, /--help/)
    assert.doesNotMatch(result.err, /at .*parse_args|ERR_PARSE_ARGS/s)
  })
})
