// B-44 Gate — Workspace Identity ≠ Locator ≠ SCM Binding (C-11 §1).
//
// 지키는 문장 셋:
//   디렉터리를 옮겨도 같은 workspace다
//   provider를 바꿔도 같은 workspace다
//   근거 없이 같은 workspace라고 말하지 않는다

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

import {
  WORKSPACE_ID,
  newWorkspaceId,
  normalizeLocator,
  normalizeRemote,
  recoverCandidates,
  recoverLines,
  type Workspace,
} from '../core/workspace/identity.ts'
import {
  emptyIndex,
  forgetLocator,
  locatorsOf,
  lookupLocator,
  readIndex,
  register,
  writeIndex,
} from '../core/workspace/index-store.ts'
import { resolveWorkspace, resolutionLine } from '../core/workspace/resolve.ts'

const NOW = '2026-08-26T21:00:00+09:00'

const workspaceAt = (id: string, aliases: string[]): Workspace => ({
  workspaceId: id,
  aliases,
  adoptionScope: 'local',
  createdAt: NOW,
  lastSeenAt: NOW,
})

const locatorAt = (path: string) => ({ path, platform: 'linux', observedAt: NOW })

describe('B-44 Gate — remote 정규화 (C-11 §1.2)', () => {
  it('같은 저장소는 형태가 달라도 같은 이름이 된다', () => {
    const expected = 'lab.example.com/team/sub/project'
    for (const url of [
      'git@lab.example.com:team/sub/project.git',
      'https://lab.example.com/team/sub/project.git',
      'https://lab.example.com/team/sub/project',
      'ssh://git@lab.example.com:2222/team/sub/project',
      'lab.example.com/team/sub/project',
    ]) {
      assert.equal(normalizeRemote(url), expected, url)
    }
  })

  it('자격은 identity에 들어가지 않는다 — index에 비밀을 남기지 않는다', () => {
    const normalized = normalizeRemote('https://user:ghp_secrettoken@github.com/org/repo.git?ref=main')
    assert.equal(normalized, 'github.com/org/repo')
    assert.doesNotMatch(normalized!, /secret|user|token/)
  })

  it('host 대소문자는 흡수하고 경로 대소문자는 남긴다', () => {
    assert.equal(normalizeRemote('git@GitHub.com:Org/Repo.git'), 'github.com/Org/Repo')
  })

  it('읽을 수 없는 값은 없는 것으로 둔다 — 지어내지 않는다', () => {
    for (const bad of ['', '   ', 'not-a-remote', '/local/path']) {
      assert.equal(normalizeRemote(bad), null, bad)
    }
  })

  it('workspace id는 날짜·순번이 아니라 충돌하지 않는 값이다', () => {
    const first = newWorkspaceId()
    assert.match(first, WORKSPACE_ID)
    assert.notEqual(first, newWorkspaceId())
  })
})

describe('B-44 Gate — 경로는 조회 키일 뿐이다', () => {
  it('구분자·후행 슬래시·드라이브 문자를 흡수한다', () => {
    assert.equal(normalizeLocator('C:\\work\\proj\\'), 'C:/work/proj')
    assert.equal(normalizeLocator('c:/work/proj'), 'C:/work/proj')
    assert.equal(normalizeLocator('/home/me/proj/'), '/home/me/proj')
  })

  it('경로 대소문자는 합치지 않는다 — 다른 디렉터리를 하나로 보면 더 큰 사고다', () => {
    assert.notEqual(normalizeLocator('/home/me/Proj'), normalizeLocator('/home/me/proj'))
  })
})

describe('B-44 Gate — 이동·재clone·worktree (C-11 §1)', () => {
  it('디렉터리를 옮기면 locator만 바뀌고 workspace는 그대로다', () => {
    const id = newWorkspaceId()
    let index = register(emptyIndex(), {
      workspaceId: id,
      root: '/home/me/.asc/workspaces/' + id,
      locator: locatorAt('/home/me/old-place'),
      aliases: ['lab.example.com/team/project'],
      now: NOW,
    })
    index = register(index, {
      workspaceId: id,
      root: '/home/me/.asc/workspaces/' + id,
      locator: locatorAt('/home/me/new-place'),
      now: NOW,
    })
    index = forgetLocator(index, '/home/me/old-place')

    assert.equal(lookupLocator(index, '/home/me/old-place'), null)
    assert.equal(lookupLocator(index, '/home/me/new-place')!.workspaceId, id)
    assert.equal(Object.keys(index.workspaces).length, 1, 'workspace를 새로 만들지 않았다')
  })

  it('하위 디렉터리에서 불러도 같은 workspace를 찾는다', () => {
    const id = newWorkspaceId()
    const index = register(emptyIndex(), {
      workspaceId: id,
      root: '/root',
      locator: locatorAt('/home/me/proj'),
      now: NOW,
    })
    const found = lookupLocator(index, '/home/me/proj/src/deep/nested')
    assert.equal(found!.workspaceId, id)
    assert.equal(found!.locator, '/home/me/proj')
  })

  it('등록되지 않은 경로에는 반응하지 않는다 — 상위의 남의 것을 집지 않는다', () => {
    const index = register(emptyIndex(), {
      workspaceId: newWorkspaceId(),
      root: '/root',
      locator: locatorAt('/home/me/proj'),
      now: NOW,
    })
    assert.equal(lookupLocator(index, '/home/me/other'), null)
    assert.equal(lookupLocator(index, '/home/me'), null)
    assert.equal(lookupLocator(index, '/'), null)
  })

  it('worktree는 같은 workspace의 다른 execution instance다', () => {
    const id = newWorkspaceId()
    let index = register(emptyIndex(), {
      workspaceId: id,
      root: '/root',
      locator: { ...locatorAt('/home/me/proj'), kind: 'checkout' as const },
      now: NOW,
    })
    index = register(index, {
      workspaceId: id,
      root: '/root',
      locator: { ...locatorAt('/home/me/proj-feature'), kind: 'worktree' as const },
      now: NOW,
    })

    assert.equal(Object.keys(index.workspaces).length, 1, 'worktree가 workspace를 쪼개지 않는다')
    assert.deepEqual(
      locatorsOf(index, id).map((l) => l.kind),
      ['checkout', 'worktree'],
    )
  })

  it('provider가 바뀌면 alias가 늘고 workspace는 그대로다', () => {
    const id = newWorkspaceId()
    let index = register(emptyIndex(), {
      workspaceId: id,
      root: '/root',
      locator: locatorAt('/home/me/proj'),
      aliases: ['github.com/org/repo'],
      now: NOW,
    })
    index = register(index, {
      workspaceId: id,
      root: '/root',
      locator: locatorAt('/home/me/proj'),
      aliases: ['lab.example.com/team/project'],
      now: NOW,
    })

    assert.deepEqual(index.workspaces[id]!.aliases, ['github.com/org/repo', 'lab.example.com/team/project'])
  })

  it('adoption은 추론으로 승격되지 않는다', () => {
    const id = newWorkspaceId()
    let index = register(emptyIndex(), {
      workspaceId: id,
      root: '/root',
      locator: locatorAt('/home/me/proj'),
      now: NOW,
    })
    assert.equal(index.workspaces[id]!.adoptionScope, 'local')

    // 다시 발견해도 local 그대로 — 명시적으로 넘길 때만 바뀐다
    index = register(index, { workspaceId: id, root: '/root', locator: locatorAt('/home/me/proj2'), now: NOW })
    assert.equal(index.workspaces[id]!.adoptionScope, 'local')

    index = register(index, {
      workspaceId: id,
      root: '/root',
      locator: locatorAt('/home/me/proj'),
      adoptionScope: 'project',
      now: NOW,
    })
    assert.equal(index.workspaces[id]!.adoptionScope, 'project')
  })
})

describe('B-44 Gate — 재clone은 후보이지 증명이 아니다 (C-11 불변식 ③)', () => {
  const alpha = workspaceAt(newWorkspaceId(), ['lab.example.com/team/project', 'github.com/org/mirror'])
  const beta = workspaceAt(newWorkspaceId(), ['github.com/other/repo'])

  it('alias가 겹치면 후보로 든다', () => {
    const hits = recoverCandidates([alpha, beta], ['git@lab.example.com:team/project.git'])
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.workspace.workspaceId, alpha.workspaceId)
    assert.match(recoverLines(hits)[0]!, /후보 1개/)
  })

  it('mirror remote로도 같은 workspace를 알아본다', () => {
    const hits = recoverCandidates([alpha, beta], ['https://github.com/org/mirror.git'])
    assert.equal(hits[0]!.workspace.workspaceId, alpha.workspaceId)
  })

  it('remote가 없으면 후보가 없다 — 없는 근거로 이어붙이지 않는다', () => {
    assert.deepEqual(recoverCandidates([alpha, beta], []), [])
    assert.match(recoverLines([])[0]!, /알아볼 수 있는 workspace 없음/)
  })

  it('후보가 여럿이면 고르지 않는다', () => {
    const twin = workspaceAt(newWorkspaceId(), ['lab.example.com/team/project'])
    const hits = recoverCandidates([alpha, twin], ['git@lab.example.com:team/project.git'])
    assert.equal(hits.length, 2)
    assert.match(recoverLines(hits)[0]!, /고르지 않는다/)
  })
})

describe('B-44 Gate — index 파일 (C-11 §3)', () => {
  it('없으면 빈 index지만 깨졌으면 던진다 — 조용히 지우지 않는다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'asc-index-'))
    try {
      assert.deepEqual(await readIndex(home), emptyIndex())

      await writeFile(join(home, 'workspace-index.json'), '{ 이건 JSON이 아니다', 'utf8')
      await assert.rejects(() => readIndex(home))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('guard가 읽을 수 있는 형태로 저장된다 — 한 번 읽고 한 번 파싱한다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'asc-index-'))
    try {
      const id = newWorkspaceId()
      const index = register(emptyIndex(), {
        workspaceId: id,
        root: join(home, 'workspaces', id),
        locator: locatorAt('/home/me/proj'),
        aliases: ['github.com/org/repo'],
        now: NOW,
      })
      await writeIndex(home, index)

      // guard가 하는 일 그대로: 한 번 읽고 한 번 파싱한다
      const raw = JSON.parse(await readFile(join(home, 'workspace-index.json'), 'utf8'))
      assert.equal(raw.locators['/home/me/proj'].workspaceId, id)
      assert.equal(raw.locators['/home/me/proj'].root, join(home, 'workspaces', id))
      assert.deepEqual(await readIndex(home), index)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('index에 비밀이 남지 않는다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'asc-index-'))
    try {
      const id = newWorkspaceId()
      await writeIndex(
        home,
        register(emptyIndex(), {
          workspaceId: id,
          root: '/root',
          locator: locatorAt('/home/me/proj'),
          aliases: [normalizeRemote('https://me:ghp_secrettoken@github.com/org/repo.git')!],
          now: NOW,
        }),
      )
      const raw = await readFile(join(home, 'workspace-index.json'), 'utf8')
      assert.doesNotMatch(raw, /secrettoken/)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

// B-45 Gate — 뿌리를 정하는 문은 하나다 (C-11 §3).
describe('B-45 Gate — Workspace Resolution 단일화', () => {
  // resolver는 경로를 resolve() 해서 본다 — 플랫폼마다 드라이브가 붙으므로 비교도 같게 맞춘다
  const existing = (paths: string[]) => async (path: string) =>
    paths.map((p) => normalizeLocator(resolve(p))).includes(normalizeLocator(resolve(path)))

  const indexWith = (locator: string, root: string, workspaceId = newWorkspaceId()) =>
    register(emptyIndex(), { workspaceId, root, locator: locatorAt(locator), now: NOW })

  it('사람이 말한 것이 이긴다', async () => {
    const index = indexWith('/home/me/proj', '/home/me/.asc/workspaces/W-1')
    const resolved = await resolveWorkspace({
      cwd: '/home/me/proj',
      explicitRoot: '/somewhere/else/.asc',
      index,
      exists: existing([]),
    })
    assert.equal(resolved.kind, 'EXPLICIT')
    assert.equal(resolved.kind === 'EXPLICIT' && resolved.root, '/somewhere/else/.asc')
  })

  it('등록된 workspace가 저장소 안 .asc 보다 먼저다', async () => {
    const id = newWorkspaceId()
    const index = indexWith('/home/me/proj', '/home/me/.asc/workspaces/registered', id)
    const resolved = await resolveWorkspace({
      cwd: '/home/me/proj/src',
      index,
      exists: existing(['/home/me/.asc/workspaces/registered', '/home/me/proj/.asc']),
      stopAt: '/home/me',
    })
    assert.equal(resolved.kind, 'REGISTERED')
    assert.equal(resolved.kind === 'REGISTERED' && resolved.workspaceId, id)
  })

  it('등록됐는데 runtime이 없으면 다음 후보로 조용히 넘어가지 않는다', async () => {
    const index = indexWith('/home/me/proj', '/home/me/.asc/workspaces/gone')
    const resolved = await resolveWorkspace({
      cwd: '/home/me/proj',
      index,
      // 등록된 뿌리는 없고, 저장소 안에는 .asc 가 있다 — 그래도 그리로 붙지 않는다
      exists: existing(['/home/me/proj/.asc']),
      stopAt: '/home/me',
    })
    assert.equal(resolved.kind, 'UNRESOLVED')
    assert.match(resolved.kind === 'UNRESOLVED' ? resolved.detail : '', /옮겼거나 지워졌다/)
  })

  it('등록이 없으면 저장소 안 .asc 를 쓴다 — 기존 사용을 끊지 않는다', async () => {
    const resolved = await resolveWorkspace({
      cwd: '/home/me/proj/src/deep',
      exists: existing(['/home/me/proj/.asc']),
      stopAt: '/home/me',
    })
    assert.equal(resolved.kind, 'PROJECT_LOCAL')
    assert.equal(
      resolved.kind === 'PROJECT_LOCAL' && normalizeLocator(resolved.projectRoot),
      normalizeLocator(resolve('/home/me/proj')),
    )
  })

  it('홈의 ~/.asc 를 프로젝트 상태로 읽지 않는다', async () => {
    // 홈에 user runtime이 있고 그 아래 저장소에는 .asc 가 없다.
    // 경계가 없으면 이 저장소가 홈의 runtime에 붙어 버린다.
    const resolved = await resolveWorkspace({
      cwd: '/home/me/some-repo',
      exists: existing(['/home/me/.asc']),
      stopAt: '/home/me',
    })
    assert.equal(resolved.kind, 'UNRESOLVED')
  })

  it('경계 위로는 아예 올라가지 않는다', async () => {
    const resolved = await resolveWorkspace({
      cwd: '/home/me/some-repo',
      exists: existing(['/.asc', '/home/.asc']),
      stopAt: '/home/me',
    })
    assert.equal(resolved.kind, 'UNRESOLVED')
  })

  it('모르면 모른다고 한다', async () => {
    const resolved = await resolveWorkspace({ cwd: '/tmp/nothing', exists: existing([]), stopAt: '/tmp' })
    assert.equal(resolved.kind, 'UNRESOLVED')
    assert.match(resolutionLine(resolved), /no runtime/)
  })

  it('사람이 읽는 줄이 왜 그 뿌리인지 말한다', async () => {
    const id = newWorkspaceId()
    const index = indexWith('/home/me/proj', '/root', id)
    const registered = await resolveWorkspace({ cwd: '/home/me/proj', index, exists: existing(['/root']) })
    assert.match(resolutionLine(registered), new RegExp(id))

    const local = await resolveWorkspace({
      cwd: '/home/me/proj',
      exists: existing(['/home/me/proj/.asc']),
      stopAt: '/home/me',
    })
    assert.match(resolutionLine(local), /\.asc inside the repository/)
  })
})

describe('B-45 Gate — CLI가 한 문만 지난다', () => {
  it('모든 root 판정이 같은 resolver를 부른다', async () => {
    const source = await readFile('cli/asc.ts', 'utf8')
    // 예전에는 host 계열 3개 명령이 --root 를 무시했다. 그 비대칭이 돌아오면 여기서 잡힌다.
    const calls = source.match(/await discoverRoot\(.*$/gm) ?? []
    assert.ok(calls.length >= 4, `discoverRoot 호출을 찾지 못했다: ${calls.length}`)
    for (const call of calls) {
      assert.match(call, /values\.root/, `--root 를 무시하는 호출이 있다: ${call}`)
    }
    // walk-up 복제본이 CLI에 다시 생기지 않았는지
    assert.doesNotMatch(source, /for \(;;\) \{[\s\S]{0,200}join\(dir, '\.asc'\)/)
  })
})
