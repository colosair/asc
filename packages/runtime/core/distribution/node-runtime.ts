// 이 프로세스를 돌리고 있는 Node가 ASC를 돌릴 수 있는가 (C-14 §3).
//
// **왜 판정이 필요한가**: `engines` 는 npm에게 하는 말이고, npm은 기본값에서 그것을
// 경고로만 낸다. 그래서 Node 22에서 설치하면 "무서운 경고 한 줄 → 그래도 돌아감"이 되고,
// 사용자는 자기가 지원 범위 안에 있는지 알 수 없다. 지원 하한은 결정적으로 답해야 한다.
//
// **여기서 하지 않는 것**: Node를 설치하지 않고, PATH·shell 설정을 고치지 않으며,
// version manager를 다루지 않는다. 이미 이 machine에 있는 것을 **best-effort로 찾아
// 알려 줄** 뿐이다 — 못 찾는 것은 정상이고, 그때는 사람이 답할 일이다.

import { RELEASE_VERSION } from './release.ts'
import type { ProcessRunner } from './runtime-install.ts'

/** ASC가 요구하는 Node 하한. `engines` 와 같은 값이며 어긋나면 release:check가 잡는다. */
export const MINIMUM_NODE_MAJOR = 24

export type NodeCandidate = { path: string; version: string }

export type NodeRuntimeCheck =
  | { ok: true; version: string }
  | {
      ok: false
      code: 'NODE_RUNTIME_REQUIRED'
      version: string
      detail: string
      /**
       * 이 machine에서 찾은, 하한을 넘는 Node. **비어 있는 것이 실패가 아니다** —
       * 그때는 Node를 놓는 일 자체가 사람의 경계다.
       */
      candidates: NodeCandidate[]
    }

export type NodeRuntimeDeps = {
  /** 지금 이 프로세스의 Node 버전 (`process.version` 형태: `v22.23.2`). */
  version: string
  /** 후보 경로가 실제로 있는가. */
  exists: (path: string) => boolean
  /** 디렉터리 목록. 없으면 빈 배열 — 없는 것은 오류가 아니다. */
  list: (path: string) => string[]
  /** `<node> -v` 를 돌린다. 실패는 후보 탈락일 뿐이다. */
  run: ProcessRunner
  /** 사용자 홈. nvm 배치를 찾는 데만 쓴다. */
  home: string
  /** 경로를 잇는다 — 호출자가 `node:path` 를 준다 (core는 파일시스템을 모른다). */
  join: (...parts: string[]) => string
}

/** `v22.23.2` · `22.23.2` 둘 다 받는다. 못 읽으면 `null` — 추측하지 않는다. */
export function majorOf(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version.trim())
  return match ? Number(match[1]) : null
}

/**
 * 이미 있는 Node를 찾아본다. **탐색이지 관리가 아니다.**
 *
 * Homebrew와 nvm의 관례적 배치만 본다. 여기에 없다고 해서 Node가 없는 것은 아니고,
 * 그 경우 후보 없이 돌려주는 것이 정직한 답이다 — 없는 것을 지어내지 않는다.
 */
function candidatePaths(deps: NodeRuntimeDeps): string[] {
  const found: string[] = []

  // Homebrew: /opt/homebrew/opt/node@26/bin/node · /usr/local/opt/node/bin/node
  for (const prefix of ['/opt/homebrew/opt', '/usr/local/opt']) {
    for (const entry of deps.list(prefix)) {
      if (!/^node(@\d+)?$/.test(entry)) continue
      const path = deps.join(prefix, entry, 'bin', 'node')
      if (deps.exists(path)) found.push(path)
    }
  }

  // nvm: ~/.nvm/versions/node/v24.1.0/bin/node
  const nvm = deps.join(deps.home, '.nvm', 'versions', 'node')
  for (const entry of deps.list(nvm)) {
    const path = deps.join(nvm, entry, 'bin', 'node')
    if (deps.exists(path)) found.push(path)
  }

  return [...new Set(found)]
}

/**
 * 돌릴 수 있는가, 못 돌린다면 무엇이 있는가.
 *
 * 하한을 넘으면 **아무것도 하지 않는다** — 정상 경로에 I/O를 얹지 않는다. 못 넘을 때만
 * 후보를 찾고, 후보에 대해서만 `-v` 를 묻는다.
 */
export async function checkNodeRuntime(deps: NodeRuntimeDeps): Promise<NodeRuntimeCheck> {
  const major = majorOf(deps.version)
  if (major !== null && major >= MINIMUM_NODE_MAJOR) return { ok: true, version: deps.version }

  const candidates: NodeCandidate[] = []
  for (const path of candidatePaths(deps)) {
    const probed = await deps.run(path, ['-v'])
    if (!probed.ok) continue
    const version = probed.stdout.trim().split(/\r?\n/)[0] ?? ''
    const found = majorOf(version)
    if (found !== null && found >= MINIMUM_NODE_MAJOR) candidates.push({ path, version })
  }

  return {
    ok: false,
    code: 'NODE_RUNTIME_REQUIRED',
    version: deps.version,
    detail:
      `ASC ${RELEASE_VERSION} needs Node ${MINIMUM_NODE_MAJOR} or newer; this process is ${deps.version}.` +
      (candidates.length > 0
        ? ' A newer Node is already on this machine — use it for the same command.'
        : ' No newer Node was found in the usual places. Installing one is yours to do.'),
    candidates,
  }
}

/**
 * 재실행 감시자. 이 변수가 있으면 이미 후보 Node 로 한 번 건너뛴 프로세스다 —
 * 거기서도 하한 미달이면 후보 자체가 낡은 것이고, 또 건너뛰면 무한 루프다.
 */
export const REEXEC_SENTINEL = 'ASC_NODE_REEXEC'

export type ReexecSpawn = (
  path: string,
  args: string[],
  env: Record<string, string | undefined>,
) => { status: number | null; signal?: string | null; error?: Error }

export type ReexecDeps = {
  env: Record<string, string | undefined>
  spawn: ReexecSpawn
  /** 지금 이 CLI 의 entry 파일 — 같은 명령을 그대로 다시 돌린다. */
  entry: string
}

/**
 * 호환 Node 를 이미 찾았으면 그 Node 로 **이 명령을 그대로 다시 돌린다** (A6).
 *
 * 진단(NODE_RUNTIME_REQUIRED)은 정상 동작이었지만, 후보를 찾아 놓고도 매 호출
 * PATH prefix 를 처방하는 것은 persistent 사용성 결함이다 — 처방 대신 실행한다.
 * PATH·shell profile 은 여전히 건드리지 않는다(불변식 ⑰): 프로세스 안의 재실행일 뿐이다.
 *
 * null 은 "재실행하지 않았다" — 후보 없음, 이미 재실행된 프로세스(sentinel), 또는
 * spawn 실패. 그때는 기존 안내가 그대로 나간다.
 */
export function reexecWithCandidate(
  check: Extract<NodeRuntimeCheck, { ok: false }>,
  argv: readonly string[],
  deps: ReexecDeps,
): number | null {
  if (deps.env[REEXEC_SENTINEL]) return null
  const candidate = check.candidates.find((c) => {
    const major = majorOf(c.version)
    return major !== null && major >= MINIMUM_NODE_MAJOR
  })
  if (!candidate) return null

  const child = deps.spawn(candidate.path, [deps.entry, ...argv], {
    ...deps.env,
    [REEXEC_SENTINEL]: '1',
  })
  if (child.error) return null
  if (child.signal) return 128 + (REEXEC_SIGNALS[child.signal] ?? 15)
  return child.status ?? 0
}

const REEXEC_SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }
