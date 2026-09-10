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
  // 0.8.0 보정: 기록 없는 workspace 는 AUTO 가 아니다 (§B). 강제를 검사하려면 이 자리가
  // AUTO 라고 적혀 있어야 한다 — guard 가 읽는 그 파일 형태 그대로 쓴다.
  const policy = join(root, 'adapters', 'policy')
  await mkdir(policy, { recursive: true })
  await writeFile(
    join(policy, 'execution-mode.json'),
    JSON.stringify({ key: 'execution-mode', value: JSON.stringify({ mode: 'AUTO', since: NOW, by: 'controller-a' }) }),
    'utf8',
  )
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

  it('관리 대상이 아닌 세션의 읽기는 등록된 workspace 안이어도 통과한다', async () => {
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

      // 0.7.0 — 읽기는 그대로 통과한다. 밖으로 나가는 쓰기만 논리 세션을 요구한다.
      const read = runGuard(hook, home, {
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        session_id: 'someone-elses-session',
        cwd: project,
      })
      assert.equal(read.code, 0, '조사까지 막으면 guard 가 아니라 방해다')

      const result = runGuard(hook, home, push(project, 'someone-elses-session'))
      assert.equal(result.code, 2, 'ASC 가 맡은 자리에서 밖으로 나가는 쓰기는 계약 안에서만 나간다')
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

describe('B-46 Gate — runtime 을 읽지 못하면 말은 하되 막지는 않는다 (0.8.0 §B)', () => {
  it('실행 축을 확인할 수 없다는 사실을 말한다 — 고르지 않은 강제를 켜지 않는다', async () => {
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

      // 0.7 에서는 여기서 막았다. mode 가 그 runtime 안에 있으므로, 읽지 못한 상태의
      // 차단은 **사람이 고른 적 없는 enforcement** 를 켜는 것이 된다 — 그래서 이제는
      // 통과시키고 무엇이 깨졌는지 말한다. 조용히 넘어가지도 않는다.
      const result = runGuard(hook, home, push(project))
      assert.equal(result.code, 0)
      assert.match(result.stderr, /runtime 을 읽지 못했다/)
      assert.match(result.stderr, /asc status/)
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

// ── K — 한 세션에서 다른 저장소로 나가는 쓰기 (#74, 0.8.5) ────────────────────────
//
// guard 는 세션의 작업 디렉터리로 workspace 를 정한다. 명령이 건드리는 저장소로 정하지
// 않는다 — 셸 한 줄에서 그것을 알아낼 방법이 없기 때문이다.
//
// 그 자체는 안전한 선택이다. 틀렸던 것은 그 다음이었다: A 에서 B 로 나가는 쓰기를 막고는
// **A 의 관리 경로**를 해결책으로 내밀었다. `asc work publish` 는 A 의 Grant 를 만들 뿐
// B 로는 아무것도 실어 나르지 못한다. 사람은 그것을 두 번 쳐 보고서야 안다.
//
// 여기서 고정하는 것은 둘이다 — 말할 수 있을 때만 대상을 말하고, 모를 때도 통과시키지
// 않는다.

/** 서로 다른 두 workspace. A 만 관리 대상이고, B 는 그저 등록돼 있다. */
async function twoWorkspaces(home: string, a: string, b: string): Promise<void> {
  const idA = newWorkspaceId()
  const idB = newWorkspaceId()
  await managedRuntime(join(home, 'workspaces', idA), 'phys-1')
  let index = register(emptyIndex(), {
    workspaceId: idA,
    root: join(home, 'workspaces', idA),
    locator: { path: a, platform: process.platform, observedAt: NOW },
    now: NOW,
  })
  index = register(index, {
    workspaceId: idB,
    root: join(home, 'workspaces', idB),
    locator: { path: b, platform: process.platform, observedAt: NOW },
    now: NOW,
  })
  await writeIndex(home, index)
}

const inA = (cwd: string, command: string) => ({
  tool_name: 'Bash',
  session_id: 'phys-1',
  cwd,
  tool_input: { command },
})

describe('K — cwd 는 A 인데 쓰기는 B 로 나간다 (#74)', () => {
  it('대상을 말할 수 있으면 말하고, A 의 관리 경로를 내밀지 않는다', async () => {
    const { home, project: a, hook, cleanup } = await scratch()
    const b = join(a, '..', 'other-repo')
    try {
      await mkdir(b, { recursive: true })
      await twoWorkspaces(home, a, b)

      const result = runGuard(hook, home, inA(a, `git -C "${b}" push origin main`))
      assert.equal(result.code, 2, 'fail-open 금지 — 대상을 알아냈다고 문이 열리지는 않는다')
      assert.match(result.stderr, /를 가리킨다/, '어디로 나가는 쓰기인지 말한다')
      assert.doesNotMatch(
        result.stderr,
        /asc work publish/,
        'A 의 Grant 는 B 로 아무것도 실어 나르지 못한다 — 그것을 해결책이라 부르면 거짓말이다',
      )
      assert.match(result.stderr, /판정 기준 workspace/, '무엇을 근거로 막았는지 함께 말한다')
    } finally {
      await cleanup()
    }
  })

  it('등록조차 안 된 경로로 나가도 A 의 것으로 읽지 않는다', async () => {
    const { home, project: a, hook, cleanup } = await scratch()
    const stranger = join(a, '..', 'not-registered')
    try {
      await mkdir(stranger, { recursive: true })
      await twoWorkspaces(home, a, join(a, '..', 'other-repo'))

      const result = runGuard(hook, home, inA(a, `git -C ${stranger} push origin main`))
      assert.equal(result.code, 2)
      assert.match(result.stderr, /를 가리킨다/)
      assert.doesNotMatch(result.stderr, /asc work publish/)
    } finally {
      await cleanup()
    }
  })

  it('대상을 모를 때도 막는다 — 그리고 관리 경로를 단정하지 않는다', async () => {
    const { home, project: a, hook, cleanup } = await scratch()
    const b = join(a, '..', 'other-repo')
    try {
      await mkdir(b, { recursive: true })
      await twoWorkspaces(home, a, b)

      // `cd` 한 뒤의 push 다. 셸을 해석하지 않는 이상 이 명령의 대상은 알 수 없다.
      const result = runGuard(hook, home, inA(a, `cd "${b}" && git push origin main`))
      assert.equal(result.code, 2, '모르면 통과시킨다는 것은 guard 를 끄는 것과 같다')
      assert.doesNotMatch(result.stderr, /를 가리킨다/, '모르는 것을 아는 척하지 않는다')
      assert.match(
        result.stderr,
        /이 쓰기가 이 workspace 의 것이라면: asc work publish/,
        '관리 경로는 조건을 달아 제시한다 — 단정하면 그 절반은 틀린 말이 된다',
      )
      assert.match(result.stderr, /다른 저장소로 나가는 것이라면/, '나머지 절반의 출구도 함께 준다')
    } finally {
      await cleanup()
    }
  })

  it('이 workspace 안을 가리키는 쓰기에는 그대로 관리 경로를 준다', async () => {
    const { home, project: a, hook, cleanup } = await scratch()
    try {
      await twoWorkspaces(home, a, join(a, '..', 'other-repo'))

      const result = runGuard(hook, home, inA(a, `git -C "${a}" push origin main`))
      assert.equal(result.code, 2)
      assert.doesNotMatch(result.stderr, /를 가리킨다/, '자기 자리를 남의 자리로 말하지 않는다')
      assert.match(result.stderr, /asc work publish/)
    } finally {
      await cleanup()
    }
  })

  it('어느 쪽이든 이 Run 만 내리는 출구를 준다', async () => {
    const { home, project: a, hook, cleanup } = await scratch()
    const b = join(a, '..', 'other-repo')
    try {
      await mkdir(b, { recursive: true })
      await twoWorkspaces(home, a, b)

      for (const command of [`git -C "${b}" push origin main`, `cd "${b}" && git push origin main`]) {
        const result = runGuard(hook, home, inA(a, command))
        assert.match(
          result.stderr,
          /asc mode manual --this-run/,
          'workspace 전체를 내리라고 하면 같은 workspace 의 다른 Run 까지 함께 풀린다',
        )
      }
    } finally {
      await cleanup()
    }
  })
})
