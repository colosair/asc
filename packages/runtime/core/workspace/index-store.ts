// Workspace Index — 이 기계의 경로에서 workspace를 되찾는 역색인 (C-11 §3).
//
// 저장 위치가 저장소 밖으로 나가면 "여기가 어느 workspace인가"를 경로 탐색만으로는
// 알 수 없다. 그 답을 이 파일 하나가 진다.
//
// **가장 까다로운 독자는 Host guard hook이다.** hook은 어떤 프로젝트에서든 도는 무의존
// 단일 파일이고, 매 Bash 호출마다 실행된다. 그래서 포맷의 상한이 정해져 있다:
//
//   readFileSync 한 번 + JSON.parse 한 번 + 문자열 조회
//
// 데이터베이스도, 다단 조회도, 스키마 협상도 두지 않는다 (C-11 불변식 ⑩).
//
// 쓰기는 tmp+rename이다. 반쯤 쓰인 index를 guard가 읽으면 관리 대상 판정이 흔들린다
// (C-11 불변식 ⑨).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { z } from 'zod'

import { Workspace, normalizeLocator, type Locator } from './identity.ts'

export const WORKSPACE_INDEX_FILE = 'workspace-index.json'

const LocatorEntry = z.object({
  workspaceId: z.string().min(1),
  /** 이 locator에 붙는 ASC runtime 뿌리. guard가 이 값만 있으면 판정할 수 있다. */
  root: z.string().min(1),
  kind: z.enum(['checkout', 'worktree']).optional(),
  platform: z.string().min(1),
  observedAt: z.string().min(1),
})
export type LocatorEntry = z.infer<typeof LocatorEntry>

export const WorkspaceIndex = z.object({
  version: z.literal(1),
  workspaces: z.record(Workspace).default({}),
  /** 정규화된 경로 → workspace. guard가 cwd에서 위로 올라가며 찾는 표다. */
  locators: z.record(LocatorEntry).default({}),
})
export type WorkspaceIndex = z.infer<typeof WorkspaceIndex>

export const emptyIndex = (): WorkspaceIndex => ({ version: 1, workspaces: {}, locators: {} })

/**
 * index를 읽는다. 없으면 빈 index다 — 없는 것과 깨진 것을 구분하지 않는 쪽이 위험하므로
 * 깨진 파일은 던진다. 조용히 빈 index로 시작하면 등록된 workspace가 통째로 사라진 것처럼
 * 보이고, 그 위에 새로 쓰면 진짜로 사라진다.
 */
export async function readIndex(homeDir: string): Promise<WorkspaceIndex> {
  let raw: string
  try {
    raw = await readFile(join(homeDir, WORKSPACE_INDEX_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyIndex()
    throw error
  }
  return WorkspaceIndex.parse(JSON.parse(raw))
}

/** tmp+rename. 같은 디렉터리 안에서 rename해야 원자성이 선다. */
export async function writeIndex(homeDir: string, index: WorkspaceIndex): Promise<void> {
  const file = join(homeDir, WORKSPACE_INDEX_FILE)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/**
 * cwd에서 위로 올라가며 이 경로가 속한 workspace를 찾는다.
 *
 * **경계가 있다.** 등록된 locator에만 반응하므로, 상위 어딘가에 우연히 있는 디렉터리를
 * 프로젝트 상태로 오인하지 않는다 — 무한 walk-up이 만들던 문제가 여기서는 생기지 않는다.
 */
export function lookupLocator(index: WorkspaceIndex, cwd: string): (LocatorEntry & { locator: string }) | null {
  let path = normalizeLocator(cwd)
  for (;;) {
    const entry = index.locators[path]
    if (entry) return { ...entry, locator: path }
    const parent = path.slice(0, path.lastIndexOf('/'))
    // 루트(`C:` 나 빈 문자열)에 닿으면 끝이다
    if (!parent || parent === path || /^[a-zA-Z]:$/.test(path)) return null
    path = parent
  }
}

export type RegisterInput = {
  workspaceId: string
  root: string
  locator: Locator
  aliases?: readonly string[]
  adoptionScope?: 'local' | 'project'
  now: string
}

/**
 * workspace와 locator를 등록한다. **기존 alias를 지우지 않는다** — provider가 바뀌어도
 * 옛 이름으로 알아볼 수 있어야 하고(C-11 불변식 ②), 이름이 사라지면 그 근거도 사라진다.
 *
 * 순수 함수다. 저장은 호출자가 writeIndex로 한다 — 읽고-고쳐-쓰기의 경계를 한 군데로 모은다.
 */
export function register(index: WorkspaceIndex, input: RegisterInput): WorkspaceIndex {
  const existing = index.workspaces[input.workspaceId]
  const aliases = [...new Set([...(existing?.aliases ?? []), ...(input.aliases ?? [])])]
  const workspace = Workspace.parse({
    workspaceId: input.workspaceId,
    aliases,
    // adoption은 추론으로 승격되지 않는다 — 명시적으로 넘길 때만 바뀐다 (C-11 불변식 ⑤)
    adoptionScope: input.adoptionScope ?? existing?.adoptionScope ?? 'local',
    createdAt: existing?.createdAt ?? input.now,
    lastSeenAt: input.now,
  })
  return {
    ...index,
    workspaces: { ...index.workspaces, [workspace.workspaceId]: workspace },
    locators: {
      ...index.locators,
      [normalizeLocator(input.locator.path)]: LocatorEntry.parse({
        workspaceId: input.workspaceId,
        root: input.root,
        ...(input.locator.kind ? { kind: input.locator.kind } : {}),
        platform: input.locator.platform,
        observedAt: input.locator.observedAt,
      }),
    },
  }
}

/** 이 workspace에 달린 locator들. 하나의 논리 workspace가 여러 곳에 있을 수 있다. */
export function locatorsOf(index: WorkspaceIndex, workspaceId: string): (LocatorEntry & { locator: string })[] {
  return Object.entries(index.locators)
    .filter(([, entry]) => entry.workspaceId === workspaceId)
    .map(([locator, entry]) => ({ ...entry, locator }))
}

/** 더 이상 없는 checkout을 목록에서 뺀다. workspace 자체는 지우지 않는다. */
export function forgetLocator(index: WorkspaceIndex, path: string): WorkspaceIndex {
  const key = normalizeLocator(path)
  if (!(key in index.locators)) return index
  const locators = { ...index.locators }
  delete locators[key]
  return { ...index, locators }
}
