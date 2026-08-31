// 임시 디렉터리 lifecycle — 만든 것은 실패해도 회수된다.
//
// 환경 전체 %TEMP%를 검사하지 않는다(그건 남의 파일까지 보는 brittle 검사다).
// 검증 대상은 tempDir이 소유 등록한 디렉터리의 lifecycle 자체다: 정상 회수와,
// assertion 실패로 죽은 테스트 프로세스의 exit 경로 회수.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { cleanupNow, tempDir } from './support/temp.ts'

const posix = (path: string) => path.split('\\').join('/')

describe('temp hygiene — 테스트 소유 임시 경로의 회수', () => {
  it('tempDir가 만든 디렉터리는 cleanupNow가 지운다', async () => {
    const dir = await tempDir('asc-hygiene-')
    assert.equal(existsSync(dir), true)
    cleanupNow()
    assert.equal(existsSync(dir), false)
  })

  it('assertion 실패로 죽은 테스트도 exit 경로에서 회수한다', async () => {
    // 실패하는 테스트 파일을 자식 node --test로 돌린다. 파일은 tempDir로
    // 디렉터리를 만들고 일부러 throw한다 — 자식이 죽은 뒤 그 디렉터리가
    // 남아 있으면 exit 훅이 실패 경로를 못 덮는 것이다.
    const stage = await mkdtemp(join(tmpdir(), 'asc-hygiene-stage-'))
    const marker = posix(join(stage, 'made.txt'))
    const helper = 'file:///' + posix(join(import.meta.dirname, 'support', 'temp.ts'))
    const script = join(stage, 'failing.test.ts')
    const lines = [
      "import { writeFile } from 'node:fs/promises'",
      "import { test } from 'node:test'",
      "import { tempDir } from '" + helper + "'",
      "test('fails after creating a temp dir', async () => {",
      "  const dir = await tempDir('asc-hygiene-child-')",
      "  await writeFile('" + marker + "', dir, 'utf8')",
      "  throw new Error('deliberate failure')",
      '})',
    ]
    await writeFile(script, lines.join('\n'), 'utf8')
    // node --test 러너가 자식에 넘기는 NODE_TEST_CONTEXT가 있으면 자식 --test가
    // 부모 프로토콜에 붙으려다 exit 0으로 새 버린다 — 자식은 독립 러너로 돌린다.
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const run = spawnSync(process.execPath, ['--test', script], { encoding: 'utf8', env })
    assert.notEqual(run.status, 0, '자식 테스트는 실패해야 한다')
    const childDir = (await readFile(marker, 'utf8')).trim()
    assert.equal(existsSync(childDir), false, `실패한 테스트의 임시 디렉터리가 남았다: ${childDir}`)
    await rm(stage, { recursive: true, force: true })
  })
})
