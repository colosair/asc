// B-47 Gate — 채택하지 않은 저장소에는 흔적을 남기지 않는다 (C-11 §0·§5).
//
// `git status` 하나로 통과시키지 않는다. tracked 내용·untracked 목록·`.git` 내부까지
// 각각 대조한다 — status는 "ASC가 만든 파일이 이미 제외돼 있는" 상태도 깨끗하다고 말한다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { describe, it } from 'node:test'

const CLI = join(process.cwd(), 'cli', 'asc.ts')

type Snapshot = { files: Record<string, string>; gitFiles: string[]; status: string }

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return result.stdout ?? ''
}

/** 저장소를 통째로 훑는다. `.git` 은 목록만 보고 내용은 보지 않는다(객체는 매번 바뀐다). */
async function snapshot(repo: string): Promise<Snapshot> {
  const files: Record<string, string> = {}
  const gitFiles: string[] = []

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const rel = relative(repo, full).split(sep).join('/')
      if (rel.startsWith('.git/') || rel === '.git') {
        if (entry.isDirectory()) await walk(full)
        else gitFiles.push(rel)
        continue
      }
      if (entry.isDirectory()) await walk(full)
      else files[rel] = await readFile(full, 'utf8')
    }
  }
  await walk(repo)
  return { files, gitFiles: gitFiles.sort(), status: git(repo, ['status', '--porcelain']) }
}

async function scratchRepo(): Promise<{ repo: string; home: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), 'asc-zf-'))
  const repo = join(base, 'repo')
  const home = join(base, 'home')
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' })
  await writeFile(join(repo, 'README.md'), '# project\n', 'utf8')
  git(repo, ['add', '-A'])
  git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  git(repo, ['remote', 'add', 'origin', 'git@lab.example.com:team/project.git'])
  return { repo, home, cleanup: () => rm(base, { recursive: true, force: true }) }
}

function runCli(cwd: string, home: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, ASC_HOME: home },
    encoding: 'utf8',
  })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('B-47 Gate — Zero-Footprint init (C-11 §5)', () => {
  it('local scope init은 저장소를 한 바이트도 건드리지 않는다', async () => {
    const { repo, home, cleanup } = await scratchRepo()
    try {
      const before = await snapshot(repo)
      const init = runCli(repo, home, ['init', '--profile', 'pilot-local'])
      assert.equal(init.code, 0, init.stderr)

      const after = await snapshot(repo)
      assert.deepEqual(after.files, before.files, '작업 트리 파일 내용이 바뀌었다')
      assert.deepEqual(after.gitFiles, before.gitFiles, '.git 내부에 파일이 생겼다')
      assert.equal(after.status, before.status)
      assert.equal(Object.keys(after.files).some((f) => f.startsWith('.asc')), false)
    } finally {
      await cleanup()
    }
  })

  it('.gitignore 도 .git/info/exclude 도 만들지 않는다', async () => {
    const { repo, home, cleanup } = await scratchRepo()
    try {
      runCli(repo, home, ['init', '--profile', 'pilot-local'])

      await assert.rejects(() => stat(join(repo, '.gitignore')))
      const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8').catch(() => '')
      assert.doesNotMatch(exclude, /\.asc/)
    } finally {
      await cleanup()
    }
  })

  it('runtime은 사용자 소유 공간에만 생긴다', async () => {
    const { repo, home, cleanup } = await scratchRepo()
    try {
      const init = runCli(repo, home, ['init', '--profile', 'pilot-local'])
      const workspaceId = /W-[0-9a-f]{32}/.exec(init.stdout)?.[0]
      assert.ok(workspaceId, `workspace id를 출력하지 않았다: ${init.stdout}`)

      await stat(join(home, 'workspaces', workspaceId!, 'sessions', 'active'))
      const index = JSON.parse(await readFile(join(home, 'workspace-index.json'), 'utf8'))
      assert.equal(Object.keys(index.workspaces).length, 1)
    } finally {
      await cleanup()
    }
  })

  it('하위 디렉터리에서도 같은 runtime을 쓴다', async () => {
    const { repo, home, cleanup } = await scratchRepo()
    try {
      runCli(repo, home, ['init', '--profile', 'pilot-local'])
      const issued = runCli(repo, home, [
        'session',
        'issue',
        'S-20260826-01',
        '--role',
        'implementer',
        '--goal',
        '확인',
        '--issued-by',
        'alice',
      ])
      assert.equal(issued.code, 0, issued.stderr)

      const after = await snapshot(repo)
      assert.equal(after.status, '', '세션을 발급해도 저장소는 그대로다')
      assert.equal(Object.keys(after.files).length, 1, 'README.md 하나뿐이어야 한다')
    } finally {
      await cleanup()
    }
  })

  it('--scope project 일 때만 저장소 안에 만든다 — 채택은 명시로만', async () => {
    const { repo, home, cleanup } = await scratchRepo()
    try {
      const init = runCli(repo, home, ['init', '--profile', 'pilot-local', '--scope', 'project'])
      assert.equal(init.code, 0, init.stderr)

      await stat(join(repo, '.asc', 'sessions', 'active'))
      const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
      assert.match(exclude, /\.asc/, '팀 채택 시에는 추적 제외를 손댄다')
    } finally {
      await cleanup()
    }
  })

  it('알 수 없는 scope는 조용히 기본값으로 떨어지지 않는다', async () => {
    const { repo, home, cleanup } = await scratchRepo()
    try {
      const init = runCli(repo, home, ['init', '--profile', 'pilot-local', '--scope', 'team'])
      assert.equal(init.code, 2)
      assert.match(init.stderr, /must be local or project/)
    } finally {
      await cleanup()
    }
  })
})

describe('B-47 Gate — 이동은 사람이 잇는다 (C-11 불변식 ③)', () => {
  it('옮긴 저장소는 후보로 알리되 자동으로 이어붙이지 않는다', async () => {
    const { repo, home, cleanup } = await scratchRepo()
    try {
      const first = runCli(repo, home, ['init', '--profile', 'pilot-local'])
      const original = /W-[0-9a-f]{32}/.exec(first.stdout)![0]

      const moved = join(repo, '..', 'moved')
      await rm(moved, { recursive: true, force: true })
      spawnSync('git', ['clone', '-q', repo, moved], { encoding: 'utf8' })
      // clone의 origin은 로컬 경로다 — 로컬 경로는 alias가 아니므로 실제 remote를 붙인다
      git(moved, ['remote', 'set-url', 'origin', 'git@lab.example.com:team/project.git'])

      const second = runCli(moved, home, ['init', '--profile', 'pilot-local'])
      assert.match(second.stdout, /후보 1개/, 'alias가 겹치면 알린다')
      assert.match(second.stdout, new RegExp(`--workspace ${original}`), '사람이 이을 방법을 알려준다')
      const created = /workspace (W-[0-9a-f]{32}) —/.exec(second.stdout)?.[1]
      assert.notEqual(created, original, '말하지 않았는데 이어붙이지 않는다')
    } finally {
      await cleanup()
    }
  })

  it('사람이 말하면 같은 workspace에 이어붙고 상태가 그대로 보인다', async () => {
    const { repo, home, cleanup } = await scratchRepo()
    try {
      const first = runCli(repo, home, ['init', '--profile', 'pilot-local'])
      const original = /W-[0-9a-f]{32}/.exec(first.stdout)![0]
      runCli(repo, home, [
        'session',
        'issue',
        'S-20260826-01',
        '--role',
        'implementer',
        '--goal',
        '이동 확인',
        '--issued-by',
        'alice',
      ])

      const moved = join(repo, '..', 'moved2')
      spawnSync('git', ['clone', '-q', repo, moved], { encoding: 'utf8' })
      git(moved, ['remote', 'set-url', 'origin', 'git@lab.example.com:team/project.git'])
      const second = runCli(moved, home, ['init', '--profile', 'pilot-local', '--workspace', original])
      assert.equal(second.code, 0, second.stderr)

      const list = runCli(moved, home, ['session', 'list'])
      assert.match(list.stdout, /S-20260826-01/, '옮긴 자리에서 같은 상태가 보인다')
    } finally {
      await cleanup()
    }
  })

  // local scope가 기본인데 감지가 저장소 안의 `.asc` 만 보면, 정상적으로 붙은 프로젝트가
  // 매번 "아직 붙지 않았다"로 나온다. 그 상태에서 사람은 이미 한 attach를 또 한다.
  it('붙은 뒤의 감지는 local scope workspace를 알아본다', async () => {
    const { repo, home, cleanup } = await scratchRepo()
    try {
      const attach = runCli(repo, home, ['init', '--profile', 'pilot-local'])
      assert.equal(attach.code, 0, attach.stderr)

      const detect = runCli(repo, home, ['init'])
      assert.equal(detect.code, 0, detect.stderr)
      assert.match(detect.stdout, /ASC: 이미 붙어 있다/)
      assert.match(detect.stdout, /Profile: pilot-local/)
      assert.doesNotMatch(detect.stdout, /아직 붙지 않았다/)
    } finally {
      await cleanup()
    }
  })

  it('모르는 workspace를 대면 만들지 않고 거부한다', async () => {
    const { repo, home, cleanup } = await scratchRepo()
    try {
      const init = runCli(repo, home, [
        'init',
        '--profile',
        'pilot-local',
        '--workspace',
        'W-00000000000000000000000000000000',
      ])
      assert.equal(init.code, 2)
      assert.match(init.stderr, /not a registered workspace/)
    } finally {
      await cleanup()
    }
  })
})
