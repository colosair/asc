// B-48 Gate — 옮기기 전에 누구 것인지부터 판정한다 (C-11 §6).
//
// 이 Gate가 막는 최악: **팀이 채택한 artefact를 개인 상태로 오판해 옮기는 것.**
// 그래서 모르면 옮기지 않고, 옮겨도 원본을 지우지 않는다.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { adoptionLine, judgeAdoption, migrate, type Adoption } from '../core/workspace/migrate.ts'

const personal: Adoption = { kind: 'PERSONAL_LEGACY', evidence: '테스트' }

async function legacyTree(): Promise<{ base: string; from: string; to: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), 'asc-mig-'))
  const from = join(base, 'repo', '.asc')
  await mkdir(join(from, 'sessions', 'active'), { recursive: true })
  await writeFile(join(from, 'state.md'), '# state\n', 'utf8')
  await writeFile(join(from, 'profile.lock'), '{"schemaVersion":1}\n', 'utf8')
  await writeFile(join(from, 'sessions', 'active', 'S-1.md'), '# session\n', 'utf8')
  return { base, from, to: join(base, 'home', 'workspaces', 'W-1'), cleanup: () => rm(base, { recursive: true, force: true }) }
}

describe('B-48 Gate — adoption 판정 (C-11 §6)', () => {
  it('Git이 추적하고 있으면 무조건 팀의 것이다', () => {
    const judged = judgeAdoption({
      projectRoot: '/repo',
      trackedAscPaths: ['.asc/ASC.md'],
      // 추적 제외에도 적혀 있지만 추적이 먼저다 — 커밋된 설정을 옮기면 남의 저장소에서 사라진다
      excludeContent: '.asc/\n',
    })
    assert.equal(judged.kind, 'PROJECT_ADOPTED')
    assert.match(adoptionLine(judged), /팀이 채택한 상태/)
  })

  it('.gitignore 에 선언돼 있으면 팀이 아는 상태다', () => {
    const judged = judgeAdoption({ projectRoot: '/repo', trackedAscPaths: [], gitignoreContent: 'node_modules\n.asc/\n' })
    assert.equal(judged.kind, 'PROJECT_ADOPTED')
  })

  it('.git/info/exclude 에만 있으면 개인 작업 공간이다', () => {
    const judged = judgeAdoption({ projectRoot: '/repo', trackedAscPaths: [], excludeContent: '.asc/\n' })
    assert.equal(judged.kind, 'PERSONAL_LEGACY')
  })

  it('근거가 없으면 개인 것으로 추정하지 않는다', () => {
    const judged = judgeAdoption({ projectRoot: '/repo', trackedAscPaths: [] })
    assert.equal(judged.kind, 'AMBIGUOUS')
    assert.match(adoptionLine(judged), /판단할 근거가 없다/)
  })
})

describe('B-48 Gate — 옮기기 (C-11 불변식 ⑭·⑮)', () => {
  it('개인 것이면 옮기고 내용까지 확인한다', async () => {
    const { from, to, cleanup } = await legacyTree()
    try {
      const outcome = await migrate({ from, to, adoption: personal })
      assert.equal(outcome.ok, true)
      if (!outcome.ok) return
      assert.equal(outcome.plan.entries, 3)
      assert.deepEqual(outcome.verified, ['profile.lock', 'sessions/active/S-1.md', 'state.md'])
      assert.equal(await readFile(join(to, 'state.md'), 'utf8'), '# state\n')
    } finally {
      await cleanup()
    }
  })

  it('옮겨도 원본을 지우지 않는다 — 확인은 사람이 한다', async () => {
    const { from, to, cleanup } = await legacyTree()
    try {
      await migrate({ from, to, adoption: personal })
      await stat(join(from, 'state.md'))
    } finally {
      await cleanup()
    }
  })

  it('팀이 채택한 것은 옮기지 않는다', async () => {
    const { from, to, cleanup } = await legacyTree()
    try {
      const outcome = await migrate({ from, to, adoption: { kind: 'PROJECT_ADOPTED', evidence: '추적됨' } })
      assert.equal(outcome.ok, false)
      if (outcome.ok) return
      assert.equal(outcome.reason, 'PROJECT_ADOPTED')
      await assert.rejects(() => stat(to), '만들지도 않는다')
    } finally {
      await cleanup()
    }
  })

  it('모르면 옮기지 않는다 — 사람이 확인했다고 말할 때만 옮긴다', async () => {
    const { from, to, cleanup } = await legacyTree()
    try {
      const blocked = await migrate({ from, to, adoption: { kind: 'AMBIGUOUS', evidence: '근거 없음' } })
      assert.equal(blocked.ok, false)
      if (blocked.ok) return
      assert.equal(blocked.reason, 'AMBIGUOUS_ADOPTION')

      const forced = await migrate({ from, to, adoption: { kind: 'AMBIGUOUS', evidence: '근거 없음' }, force: true })
      assert.equal(forced.ok, true)
    } finally {
      await cleanup()
    }
  })

  it('대상이 이미 있으면 덮어쓰지 않는다', async () => {
    const { from, to, cleanup } = await legacyTree()
    try {
      await mkdir(to, { recursive: true })
      await writeFile(join(to, 'state.md'), '# 남의 것\n', 'utf8')

      const outcome = await migrate({ from, to, adoption: personal })
      assert.equal(outcome.ok, false)
      if (outcome.ok) return
      assert.equal(outcome.reason, 'TARGET_EXISTS')
      assert.equal(await readFile(join(to, 'state.md'), 'utf8'), '# 남의 것\n', '건드리지 않았다')
    } finally {
      await cleanup()
    }
  })
})
