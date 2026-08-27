// B-46 Gate — user-owned runtime에서도 guard가 자기 자리를 안다 (C-11 §3·§4).
//
// hook은 생성된 문자열이라 단위 테스트로 부를 수 없다. 그래서 **실제로 파일로 써서
// node로 돌린다** — 설치될 물건 그대로를 검사하지 않으면 이 Gate는 아무것도 지키지 않는다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { hookScript } from '../adapters/claude-code/guard.ts'
import { emptyIndex, register, writeIndex } from '../core/workspace/index-store.ts'
import { newWorkspaceId } from '../core/workspace/identity.ts'

const NOW = '2026-08-26T21:00:00+09:00'

type GuardResult = { code: number; stderr: string }

/**
 * hook은 stdin으로 payload를 받는다. 비동기 execFile에는 stdin을 넣는 자리가 없어
 * hook이 입력을 기다리며 멈춘다 — 여기서는 동기 spawn으로 실제 실행 형태를 재현한다.
 */
function runGuard(hook: string, home: string, payload: unknown): GuardResult {
  const result = spawnSync(process.execPath, [hook], {
    env: { ...process.env, ASC_HOME: home },
    input: JSON.stringify(payload),
    encoding: 'utf8',
  })
  return { code: result.status ?? 1, stderr: result.stderr ?? '' }
}

/**
 * 관리 대상 세션 하나가 등록된 ASC runtime을 만든다.
 * guard가 실제로 읽는 파일 형태(ScopedStore의 {key, value} 이중 인코딩)를 그대로 쓴다.
 */
async function managedRuntime(root: string, physicalSessionId: string): Promise<void> {
  const dir = join(root, 'adapters', 'claude-code')
  await mkdir(dir, { recursive: true })
  const binding = { logicalSessionId: 'S-20260826-01', provider: 'claude-code', physicalSessionId, updatedAt: NOW }
  await writeFile(
    join(dir, `runtime-binding-S-20260826-01.json`),
    JSON.stringify({ key: 'runtime-binding:S-20260826-01', value: JSON.stringify(binding) }),
    'utf8',
  )
}

async function scratch(): Promise<{ home: string; project: string; hook: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), 'asc-guard-'))
  const home = join(base, 'home')
  const project = join(base, 'project')
  await mkdir(home, { recursive: true })
  await mkdir(join(project, 'src'), { recursive: true })
  const hook = join(base, 'guard-hook.mjs')
  await writeFile(hook, hookScript(), 'utf8')
  return { home, project, hook, cleanup: () => rm(base, { recursive: true, force: true }) }
}

const push = (cwd: string, sessionId = 'phys-1') => ({
  tool_name: 'Bash',
  session_id: sessionId,
  cwd,
  tool_input: { command: 'git push origin main' },
})

describe('B-46 Gate — guard가 역색인으로 workspace를 찾는다 (C-11 §3)', () => {
  it('user-owned runtime의 관리 대상 세션에서 외부 write를 막는다', async () => {
    const { home, project, hook, cleanup } = await scratch()
    try {
      const id = newWorkspaceId()
      const root = join(home, 'workspaces', id)
      await managedRuntime(root, 'phys-1')
      await writeIndex(
        home,
        register(emptyIndex(), {
          workspaceId: id,
          root,
          locator: { path: project, platform: process.platform, observedAt: NOW },
          now: NOW,
        }),
      )

      // 저장소 안에는 .asc 가 없다 — index만으로 찾아야 한다
      const result = runGuard(hook, home, push(join(project, 'src')))
      assert.equal(result.code, 2)
      assert.match(result.stderr, /ASC guard/)
    } finally {
      await cleanup()
    }
  })

  it('관리 대상이 아닌 세션은 등록된 workspace 안이어도 통과한다', async () => {
    const { home, project, hook, cleanup } = await scratch()
    try {
      const id = newWorkspaceId()
      const root = join(home, 'workspaces', id)
      await managedRuntime(root, 'phys-1')
      await writeIndex(
        home,
        register(emptyIndex(), {
          workspaceId: id,
          root,
          locator: { path: project, platform: process.platform, observedAt: NOW },
          now: NOW,
        }),
      )

      const result = runGuard(hook, home, push(project, 'someone-elses-session'))
      assert.equal(result.code, 0, '사람의 일반 세션까지 막지 않는다')
    } finally {
      await cleanup()
    }
  })

  it('ASC와 무관한 경로는 소유권을 주장하지 않는다', async () => {
    const { home, project, hook, cleanup } = await scratch()
    try {
      await writeIndex(home, emptyIndex())
      const result = runGuard(hook, home, push(project))
      assert.equal(result.code, 0)
      assert.equal(result.stderr, '')
    } finally {
      await cleanup()
    }
  })
})

describe('B-46 Gate — 조건부 fail-closed (C-11 §4)', () => {
  it('등록됐는데 runtime을 읽지 못하면 보호 대상 명령을 막는다', async () => {
    const { home, project, hook, cleanup } = await scratch()
    try {
      const id = newWorkspaceId()
      // runtime 디렉터리를 만들지 않는다 — 옮겼거나 지워진 상태
      await writeIndex(
        home,
        register(emptyIndex(), {
          workspaceId: id,
          root: join(home, 'workspaces', id),
          locator: { path: project, platform: process.platform, observedAt: NOW },
          now: NOW,
        }),
      )

      const result = runGuard(hook, home, push(project))
      assert.equal(result.code, 2, '조용히 열리면 관리 대상의 외부 write가 그냥 나간다')
      assert.match(result.stderr, /runtime을 읽지 못했다/)
    } finally {
      await cleanup()
    }
  })

  it('runtime을 못 읽어도 보호 대상이 아닌 명령까지 막지는 않는다', async () => {
    const { home, project, hook, cleanup } = await scratch()
    try {
      const id = newWorkspaceId()
      await writeIndex(
        home,
        register(emptyIndex(), {
          workspaceId: id,
          root: join(home, 'workspaces', id),
          locator: { path: project, platform: process.platform, observedAt: NOW },
          now: NOW,
        }),
      )

      const result = runGuard(hook, home, {
        tool_name: 'Bash',
        session_id: 'phys-1',
        cwd: project,
        tool_input: { command: 'npm test' },
      })
      assert.equal(result.code, 0, '전역 차단이 아니라 보호 대상 연산만 막는다')
    } finally {
      await cleanup()
    }
  })
})

describe('B-46 Gate — 저장소 안 .asc 도 계속 동작한다', () => {
  it('index가 없어도 기존 방식으로 관리 대상을 찾는다', async () => {
    const { home, project, hook, cleanup } = await scratch()
    try {
      // index 파일 자체를 만들지 않는다 — 이전하지 않은 설치
      await managedRuntime(join(project, '.asc'), 'phys-1')
      const result = runGuard(hook, home, push(join(project, 'src')))
      assert.equal(result.code, 2)
    } finally {
      await cleanup()
    }
  })
})
