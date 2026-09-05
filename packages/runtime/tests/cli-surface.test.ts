// CLI 표면 — 사용자 입력 오류에 Node 스택을 던지지 않는다 (SSAFESTA Windows 실측
// ASC-1·ASC-3·ASC-5의 회귀 고정). 실행 중인 버전을 묻는 통로도 여기 산다.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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

// 실측에서 나온 것 — 감시 경로가 도구 자식(JAM MCP 서버)을 열게 되자 명령이 할 일을 다
// 하고도 끝나지 않았다. 등록된 서비스가 회차마다 그 프로세스를 하나씩 남긴다.
describe('도구 자식은 나가는 문에서 닫힌다', () => {
  it('명령마다가 아니라 진입점 한 곳에서 닫는다', async () => {
    const source = await readFile('cli/asc.ts', 'utf8')
    const entry = source.slice(source.indexOf('export async function runAscCommand'))
    const body = entry.slice(0, entry.indexOf('\nfunction parseArgsOrThrow'))
    // finally 안에서 닫아야 실패한 명령도 자식을 남기지 않는다
    assert.match(body, /finally\s*\{[\s\S]{0,600}closeToolClients\(\)/)
  })
})
