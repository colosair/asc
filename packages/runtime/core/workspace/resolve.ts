// Workspace Resolution — "지금 여기는 어느 ASC runtime인가"를 정하는 **한 곳** (C-11 §3·B-45).
//
// 지금까지 이 질문의 답은 네 군데에 따로 있었다: CLI의 discoverRoot, attach의
// discoverProjectRoot, bootstrap의 내부 조립, 그리고 guard hook 안의 복제본.
// 넷이 조금씩 다르게 답하면 "어디는 되고 어디는 안 되는" 상태가 생기고, 실제로 그랬다
// (`--root` 가 host 명령에만 안 먹던 비대칭).
//
// 우선순위는 명시 > 등록 > 발견이다:
//
//   1. explicit root      사람이 말한 것이 이긴다
//   2. workspace index    이 기계에 등록된 locator (경로가 바뀌어도 따라온다)
//   3. linked worktree    같은 Git repository의 다른 checkout이 등록돼 있다 (C-11 §1.3)
//   4. project-adopted    저장소 안의 `.asc/` — 팀이 채택한 경우 (legacy 개인 사용 포함)
//   5. UNRESOLVED         모르면 모른다고 한다
//
// **3번은 index가 빗나갔을 때만 돈다.** 등록된 locator로 풀리는 정상 경로는 예전 그대로
// 파일 접근 하나이며, Git을 부르지 않는다 — guard hook이 매 Bash 호출마다 지나는 길이다.
//
// **3번의 탐색에는 경계가 있다.** 예전에는 파일시스템 루트까지 올라갔는데, 사용자 홈에
// `~/.asc` 가 생기는 순간 홈 아래 아무 저장소나 그 뿌리로 오인 매칭된다. 그래서 홈을
// 넘지 않고, 정지선(`stopAt`)을 지난 뒤에는 더 올라가지 않는다.

import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { normalizeLocator } from './identity.ts'
import { lookupLocator, type WorkspaceIndex } from './index-store.ts'

export const ASC_DIR = '.asc'

export type Resolution =
  | { kind: 'EXPLICIT'; root: string }
  /** 이 기계에 등록된 workspace. 경로가 바뀌어도 따라온다. */
  | { kind: 'REGISTERED'; root: string; workspaceId: string; locator: string }
  /**
   * 등록된 적은 없지만 **같은 Git repository의 다른 checkout이 등록돼 있다.**
   * 같은 논리 workspace의 다른 execution instance다 (C-11 §1.3) — 쪼개지도 합치지도 않는다.
   */
  | {
      kind: 'LINKED_WORKTREE'
      root: string
      workspaceId: string
      /** 지금 이 checkout의 최상위. 호출자가 이 값을 index에 등록해 다음 번을 빠르게 만든다. */
      locator: string
      /** 근거가 된, 이미 등록돼 있던 형제 checkout. */
      via: string
      /** main checkout인가 linked worktree인가. */
      kindOfLocator: 'checkout' | 'worktree'
    }
  /** 저장소 안의 `.asc/` — 팀이 채택했거나 아직 이전하지 않은 개인 legacy다. */
  | { kind: 'PROJECT_LOCAL'; root: string; projectRoot: string }
  | { kind: 'UNRESOLVED'; detail: string }

export type ResolveInput = {
  cwd: string
  /** `--root` 로 사람이 지정한 값. 있으면 무조건 이긴다. */
  explicitRoot?: string
  index?: WorkspaceIndex
  /** 여기를 넘어서는 위로 올라가지 않는다. 보통 사용자 홈. */
  stopAt?: string
  exists?: (path: string) => Promise<boolean>
  /**
   * 이 경로가 속한 Git repository의 checkout 전부(main + linked). 없으면 이 갈래를 건너뛴다.
   *
   * **주입이 기본값이다** — guard hook처럼 매 호출마다 도는 소비자는 이것을 넘기지 않고,
   * 그러면 예전과 똑같이 index만 본다.
   */
  worktrees?: WorktreeProbe
}

/**
 * 같은 Git repository에 속한 checkout 경로들. 첫 번째가 main worktree다.
 * git이 없거나 저장소가 아니면 `null` — "없다"와 "못 봤다"를 구분한다.
 */
export type WorktreeProbe = (cwd: string) => Promise<readonly string[] | null>

const defaultExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function resolveWorkspace(input: ResolveInput): Promise<Resolution> {
  if (input.explicitRoot) return { kind: 'EXPLICIT', root: input.explicitRoot }

  const exists = input.exists ?? defaultExists

  if (input.index) {
    const found = lookupLocator(input.index, input.cwd)
    // 등록돼 있는데 뿌리가 없으면 **넘어가지 않는다.** 조용히 다음 후보로 가면
    // 사라진 workspace 대신 엉뚱한 것에 붙는다 (C-11 §4 조건부 fail-closed와 같은 태도).
    if (found) {
      return (await exists(found.root))
        ? { kind: 'REGISTERED', root: found.root, workspaceId: found.workspaceId, locator: found.locator }
        : {
            kind: 'UNRESOLVED',
            detail: `${found.workspaceId} 가 등록돼 있으나 runtime(${found.root})이 없다 — 옮겼거나 지워졌다`,
          }
    }
  }

  // index가 빗나갔다. 여기서 처음으로 Git에게 **구조**를 묻는다 — remote가 같다는 이유로
  // 이어붙이지 않는다 (C-11 불변식 ③). 같은 linked repository라는 것은 로컬에서 증명된다.
  if (input.index && input.worktrees) {
    const linked = await resolveLinkedWorktree(input.cwd, input.index, input.worktrees, exists)
    if (linked) return linked
  }

  const local = await findProjectLocal(input.cwd, input.stopAt, exists)
  if (local) return { kind: 'PROJECT_LOCAL', root: join(local, ASC_DIR), projectRoot: local }

  return { kind: 'UNRESOLVED', detail: '이 경로에 붙은 ASC workspace가 없다' }
}

/**
 * 이 checkout이 **이미 등록된 checkout과 같은 Git repository**인가.
 *
 * `git worktree list` 는 그 저장소의 checkout만 든다. 그래서 remote가 같은 **독립 clone**은
 * 서로의 경로를 담지 않고, 여기서 절대 이어붙지 않는다 — 그것이 이 판정이 alias 대조가
 * 아니라 worktree 목록을 쓰는 이유다 (C-11 불변식 ③: alias 일치는 recover candidate일 뿐).
 *
 * 후보 workspace가 둘 이상이면 **고르지 않는다.** 고르면 사람이 그 선택을 보지 못한다.
 */
async function resolveLinkedWorktree(
  cwd: string,
  index: WorkspaceIndex,
  probe: WorktreeProbe,
  exists: (path: string) => Promise<boolean>,
): Promise<Resolution | null> {
  const paths = await probe(cwd)
  if (!paths || paths.length === 0) return null

  const normalized = paths.map(normalizeLocator)
  const here = currentWorktree(normalized, normalizeLocator(cwd))
  if (!here) return null

  const hits = new Map<string, { root: string; via: string }>()
  for (const path of normalized) {
    if (path === here) continue
    const found = lookupLocator(index, path)
    if (found) hits.set(found.workspaceId, { root: found.root, via: found.locator })
  }

  if (hits.size === 0) return null
  if (hits.size > 1) {
    return {
      kind: 'UNRESOLVED',
      detail: `이 저장소의 다른 checkout들이 서로 다른 workspace에 등록돼 있다 (${[...hits.keys()].join(', ')}) — 고르지 않는다`,
    }
  }

  const [[workspaceId, hit]] = [...hits.entries()]
  // 등록은 돼 있는데 뿌리가 없으면 넘어가지 않는다 — REGISTERED와 같은 태도다.
  if (!(await exists(hit.root))) {
    return {
      kind: 'UNRESOLVED',
      detail: `${workspaceId} 가 등록돼 있으나 runtime(${hit.root})이 없다 — 옮겼거나 지워졌다`,
    }
  }

  return {
    kind: 'LINKED_WORKTREE',
    root: hit.root,
    workspaceId,
    locator: here,
    via: hit.via,
    // 목록의 첫 항목이 main worktree다 (git worktree list 의 계약).
    kindOfLocator: here === normalized[0] ? 'checkout' : 'worktree',
  }
}

/**
 * 목록 중 지금 서 있는 checkout. cwd는 그 아래 하위 디렉터리일 수 있으므로 **가장 긴
 * 접두어**를 고른다. 경계는 구분자에서만 인정한다 — `/a/repo` 가 `/a/repo-2` 를 삼키면 안 된다.
 */
function currentWorktree(paths: readonly string[], cwd: string): string | null {
  let best: string | null = null
  for (const path of paths) {
    if (cwd !== path && !cwd.startsWith(`${path}/`)) continue
    if (best === null || path.length > best.length) best = path
  }
  return best
}

/**
 * 기본 통로 — `git worktree list --porcelain`. 첫 `worktree` 항목이 main checkout이다.
 *
 * git이 없거나 저장소가 아니면 `null`을 돌려준다. 빈 배열이 아니다 — "checkout이 하나도
 * 없다"와 "물어보지 못했다"는 다른 사실이고, 후자를 전자로 적으면 조용한 오판이 된다.
 */
export const gitWorktrees: WorktreeProbe = async (cwd) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  try {
    const { stdout } = await promisify(execFile)('git', ['worktree', 'list', '--porcelain'], {
      cwd,
      // 목록은 짧다. 오래 걸리면 그것 자체가 "물어보지 못했다"이다 — 명령을 세우지 않는다.
      timeout: 5_000,
    })
    return parseWorktreeList(stdout)
  } catch {
    return null
  }
}

/** porcelain 출력에서 checkout 경로만. 순서를 보존한다 — 첫 줄이 main worktree다. */
export function parseWorktreeList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean)
}

/**
 * 저장소 안의 `.asc/` 를 위로 올라가며 찾되 **경계를 지킨다**.
 *
 * `stopAt`(보통 홈)을 포함해 그 위로는 보지 않는다. 홈에 `~/.asc` 가 있는 것은 정상이고,
 * 그것을 프로젝트 상태로 읽으면 홈 아래 모든 저장소가 한 workspace가 된다.
 */
async function findProjectLocal(
  start: string,
  stopAt: string | undefined,
  exists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  const boundary = stopAt ? normalizeLocator(resolve(stopAt)) : null
  let dir = resolve(start)

  for (;;) {
    const normalized = normalizeLocator(dir)
    // 정지선 자체는 보지 않는다 — 홈의 `.asc` 는 user runtime이지 프로젝트 상태가 아니다
    if (boundary && normalized === boundary) return null
    const candidate = join(dir, ASC_DIR)
    // 정지선이 홈이어도 **다른 홈**의 `.asc` 는 걸러지지 않는다. Windows는 temp
    // 디렉터리가 사용자 프로필 아래라, temp의 프로젝트에서 위로 걷다 실사용자
    // `~/.asc` 를 프로젝트 상태로 오인했다 (SSAFESTA 실측 — setup status가
    // UNATTACHED 대신 BROKEN을 답한 원인). user runtime은 내용으로 알아본다:
    // workspaces/·profiles/·runtime.json 은 홈에만 생긴다.
    if ((await exists(candidate)) && !(await looksLikeUserRuntime(candidate, exists))) return dir

    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** `~/.asc` 꼴인가 — 프로젝트 부착이 아니라 이 기계의 user runtime 홈인가. */
async function looksLikeUserRuntime(
  ascDir: string,
  exists: (path: string) => Promise<boolean>,
): Promise<boolean> {
  for (const marker of ['workspaces', 'profiles', 'runtime.json']) {
    if (await exists(join(ascDir, marker))) return true
  }
  return false
}

/** 사람이 읽는 한 줄. 왜 그 뿌리인지가 함께 와야 사람이 틀린 결합을 알아챈다. */
export function resolutionLine(resolution: Resolution): string {
  switch (resolution.kind) {
    case 'EXPLICIT':
      return `runtime: ${resolution.root} (given with --root)`
    case 'REGISTERED':
      return `runtime: ${resolution.root} (workspace ${resolution.workspaceId} · ${resolution.locator})`
    case 'LINKED_WORKTREE':
      return `runtime: ${resolution.root} (workspace ${resolution.workspaceId} · same git repository as ${resolution.via})`
    case 'PROJECT_LOCAL':
      return `runtime: ${resolution.root} (.asc inside the repository — team-adopted, or personal state not yet migrated)`
    case 'UNRESOLVED':
      return `no runtime — ${resolution.detail}`
  }
}
