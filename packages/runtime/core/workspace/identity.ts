// Workspace Identity — 이것이 어떤 논리적 프로젝트인가 (C-11 §1).
//
// 지금까지 identity는 사실상 "walk-up이 멈춘 경로"였다. 그러면 디렉터리를 한 번 옮기는
// 것만으로 다른 프로젝트가 되고, 같은 저장소를 두 곳에 clone하면 서로를 알아보지 못한다.
//
// 네 개념을 분리한다:
//
//   Workspace Identity   안정적인 내부 id. 사람이 바꾸지 않는다
//   Alias                외부 시스템이 부르는 이름들. 여러 개고 바뀔 수 있다
//   Locator              이 기계에서 지금 어디에 있는가. 자주 바뀐다
//   Execution Instance   그 Locator에서 실제로 도는 작업 단위 (worktree)
//
// 내부 id가 정본인 이유: remote가 없는 저장소도, remote가 바뀌는 저장소도 있어야 하기
// 때문이다. alias가 필요한 이유: 새 clone을 같은 프로젝트로 알아보는 유일한 단서이기
// 때문이다. **alias 일치는 recover candidate이지 동일성 증명이 아니다** (C-11 불변식 ③).

import { randomUUID } from 'node:crypto'

import { z } from 'zod'

/** `W-` + 32 hex. 날짜·순번을 쓰지 않는다 — 두 기계가 같은 날 만든 id가 부딪히면 안 된다. */
export const WORKSPACE_ID = /^W-[0-9a-f]{32}$/
export const WorkspaceId = z.string().regex(WORKSPACE_ID)

/** 팀이 채택했는가, 개인이 쓰는가 (C-11 §2). **추론으로 승격되지 않는다.** */
export const AdoptionScope = z.enum(['local', 'project'])
export type AdoptionScope = z.infer<typeof AdoptionScope>

export const Locator = z.object({
  /** 이 기계의 checkout 경로. 정규화해 저장한다 — 대소문자·구분자 차이로 갈라지지 않게. */
  path: z.string().min(1),
  /** 이 경로가 worktree인가 main checkout인가. 모르면 적지 않는다. */
  kind: z.enum(['checkout', 'worktree']).optional(),
  platform: z.string().min(1),
  observedAt: z.string().min(1),
})
export type Locator = z.infer<typeof Locator>

export const Workspace = z.object({
  workspaceId: WorkspaceId,
  /** 정규화된 외부 이름들. `host/group/project` 형태이며 자격·포트·질의는 들어가지 않는다. */
  aliases: z.array(z.string()).default([]),
  adoptionScope: AdoptionScope.default('local'),
  createdAt: z.string().min(1),
  lastSeenAt: z.string().min(1),
})
export type Workspace = z.infer<typeof Workspace>

export const newWorkspaceId = (): string => `W-${randomUUID().replace(/-/g, '')}`

/**
 * remote URL을 identity alias로 정규화한다 (C-11 §1.2).
 *
 * 자격·userinfo·포트·질의는 **넣지 않는다.** 비밀이 identity에 섞이면 index와 로그에
 * 비밀이 남는다. 형태가 달라도 같은 저장소면 같은 문자열이 나와야 한다:
 *
 *   git@host:group/project.git
 *   https://user:token@host:8443/group/project.git?ref=main
 *   ssh://git@host:2222/group/project
 *   → host/group/project
 */
export function normalizeRemote(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  // 로컬 경로는 identity가 아니다. `C:\work\repo` 는 scp 문법(`host:path`)과 모양이 같아
  // 그냥 두면 드라이브 문자가 host가 된다 — 실측에서 실제로 그렇게 나왔다.
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('file://')) return null

  let host: string | undefined
  let path: string | undefined

  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/]+)\/(.+)$/.exec(trimmed)
  if (scheme) {
    host = scheme[1]
    path = scheme[2]
  } else {
    // scp 문법 — `user@host:group/project`. 콜론 뒤가 경로다.
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed)
    if (scp) {
      host = scp[1]
      path = scp[2]
    } else if (/^[^/]+\/.+$/.test(trimmed)) {
      // 이미 `host/group/project` 형태로 정규화된 값
      const slash = trimmed.indexOf('/')
      host = trimmed.slice(0, slash)
      path = trimmed.slice(slash + 1)
    }
  }
  if (!host || !path) return null

  // userinfo·포트를 떼고 host만 남긴다. 대소문자는 host에서 의미가 없다.
  const bare = host.slice(host.lastIndexOf('@') + 1).replace(/:\d+$/, '').toLowerCase()
  const cleaned = path
    .split(/[?#]/)[0]!
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '')
  if (!bare || !cleaned) return null
  return `${bare}/${cleaned}`
}

/**
 * 경로를 비교 가능한 형태로. Windows의 역슬래시·대소문자와 후행 구분자를 흡수한다.
 *
 * **경로는 identity가 아니다** — 이 값은 locator 조회 키일 뿐이며, 이동하면 바뀐다.
 */
export function normalizeLocator(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  // 드라이브 문자만 대소문자를 흡수한다. 나머지는 그대로 둔다 — 대소문자를 구분하는
  // 파일시스템에서 서로 다른 두 디렉터리를 하나로 합치면 그게 더 큰 사고다.
  return /^[a-zA-Z]:/.test(slashed) ? slashed[0]!.toUpperCase() + slashed.slice(1) : slashed
}

/**
 * 같은 workspace로 볼 근거가 있는가 (C-11 §1.1).
 *
 * **동일성 증명이 아니다.** alias가 겹치면 "그 프로젝트일 수 있다"까지이며, 실제로
 * 이어붙일지는 호출자가 정한다. remote가 하나도 없으면 후보가 아니다 — 없는 근거로
 * 이어붙이는 것이 경로를 identity로 쓰는 것과 같은 실수다.
 */
export function recoverCandidates(
  workspaces: readonly Workspace[],
  remotes: readonly string[],
): { workspace: Workspace; matched: string[] }[] {
  const normalized = remotes.map(normalizeRemote).filter((alias): alias is string => alias !== null)
  if (normalized.length === 0) return []

  return workspaces
    .map((workspace) => ({
      workspace,
      matched: workspace.aliases.filter((alias) => normalized.includes(alias)),
    }))
    .filter((hit) => hit.matched.length > 0)
}

/** 사람이 읽는 줄. 후보가 여럿이면 고르지 않고 여럿이라고 말한다. */
export function recoverLines(hits: readonly { workspace: Workspace; matched: string[] }[]): string[] {
  if (hits.length === 0) return ['알아볼 수 있는 workspace 없음 — 새로 만들거나 --root 로 지정하라']
  if (hits.length === 1) {
    const [only] = hits
    return [`후보 1개: ${only!.workspace.workspaceId} (일치 ${only!.matched.join(', ')})`]
  }
  return [
    `후보가 ${hits.length}개다 — 고르지 않는다. 사람이 정하라:`,
    ...hits.map((hit) => `  ${hit.workspace.workspaceId} (일치 ${hit.matched.join(', ')})`),
  ]
}
