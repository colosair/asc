// state.md 는 사람이 읽는 파일이다. 객체가 "[object Object]" 로 찍히면 읽을 수 없다.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { MarkdownStateStore } from '../adapters/markdown/state-store.ts'

describe('state.md 렌더', () => {
  it('Write Boundary 점유가 세션과 경로로 읽힌다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asc-state-'))
    try {
      const store = new MarkdownStateStore(root)
      const current = await store.getControlState()
      const result = await store.setControlState(current.version, {
        ...current,
        activeSessions: ['S-20260906-01'],
        writeBoundaryOccupancy: [{ sessionId: 'S-20260906-01', paths: ['src/**', 'docs/a.md'] }],
      })
      assert.equal(result.ok, true)
      const text = await readFile(join(root, 'state.md'), 'utf8')
      assert.doesNotMatch(text, /\[object Object\]/)
      assert.match(text, /Write Boundary 점유: S-20260906-01 → src\/\*\* docs\/a\.md/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
