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
//   3. project-adopted    저장소 안의 `.asc/` — 팀이 채택한 경우 (legacy 개인 사용 포함)
//   4. UNRESOLVED         모르면 모른다고 한다
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
}

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

  const local = await findProjectLocal(input.cwd, input.stopAt, exists)
  if (local) return { kind: 'PROJECT_LOCAL', root: join(local, ASC_DIR), projectRoot: local }

  return { kind: 'UNRESOLVED', detail: '이 경로에 붙은 ASC workspace가 없다' }
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
    // `~/.asc` 를 프로젝트 상태로 오인했다 (실 프로젝트 실측 — setup status가
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
    case 'PROJECT_LOCAL':
      return `runtime: ${resolution.root} (.asc inside the repository — team-adopted, or personal state not yet migrated)`
    case 'UNRESOLVED':
      return `no runtime — ${resolution.detail}`
  }
}

