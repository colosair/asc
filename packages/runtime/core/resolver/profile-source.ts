// Profile이 어디서 오는가 — 설치된 배포본 안, 그리고 사용자 소유 공간.
//
// v0.1까지 Profile은 **설치 경로 안에만** 있었다. 그래서 공개 패키지를 설치한 사람은
// 자기 프로젝트의 Profile을 쓸 방법이 없었다 — 팀에 배포할 수 없다는 뜻이다.
// 여기서 여는 것은 그 한 갈래다: `ASC_HOME/profiles/<id>/profile.json`.
//
// 자리를 고르는 규칙이 이 파일의 전부다:
//   1. 사람이 명시한 것            Surface가 이미 id로 넘긴다
//   2. 사용자 소유 external        ASC_HOME — 팀이 나눠 갖는 실 Profile이 여기 온다
//   3. 배포본 내장 built-in        예시·fixture. 아무것도 없을 때의 바닥
//
// **같은 id가 양쪽에 있으면 멈춘다.** 조용히 하나를 고르면 "무엇을 읽었는가"를 사람이
// 알 수 없고, 그 답이 정책이 되므로 틀린 쪽으로 조용히 도는 것보다 서는 편이 낫다.
//
// Profile은 코드가 아니라 데이터다. 여기서 하는 일은 **경로를 고르는 것뿐**이고,
// 읽기·검증·digest는 기존 resolver 계약(load.ts)이 그대로 한다.

import { constants } from 'node:fs'
import { access, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export type ProfileOrigin = 'built-in' | 'external'

export type ProfileLocation = {
  id: string
  origin: ProfileOrigin
  /** `profile.json` 의 절대 경로. 파일이 아직 없을 수도 있다 — 읽는 쪽이 그 사실을 만난다. */
  path: string
}

export type ProfileRoots = {
  /** 설치된 배포본의 뿌리. `profiles/` 가 그 아래 있다. */
  installRoot: string
  /** 사용자 소유 Profile 디렉터리. 보통 `ASC_HOME/profiles`. 없으면 external은 없는 것이다. */
  externalRoot?: string
}

/** 왜 Profile을 고르지 못했는가. 문장이 아니라 코드로 든다 — Surface가 다르게 말해야 한다. */
export type ProfileSourceCode = 'INVALID_PROFILE_ID' | 'PROFILE_COLLISION'

export class ProfileSourceError extends Error {
  code: ProfileSourceCode

  constructor(code: ProfileSourceCode, message: string) {
    super(message)
    this.name = 'ProfileSourceError'
    this.code = code
  }
}

/**
 * Profile id는 **디렉터리 이름 한 칸**이다.
 *
 * 경로 조각을 허용하면 id 하나로 `profiles/` 밖의 파일을 읽게 된다 — `../../secrets`
 * 같은 것. 그래서 여기서 문법으로 막고, 아래에서 실제 경로가 뿌리 안에 있는지 한 번 더 본다
 * (문법만 믿지 않는다 — symlink는 문법을 통과한다).
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function assertProfileId(id: string): void {
  if (!SAFE_ID.test(id) || id === '.' || id === '..') {
    throw new ProfileSourceError(
      'INVALID_PROFILE_ID',
      `'${id}' is not a profile id — use a single name made of letters, digits, '.', '_' or '-'`,
    )
  }
}

/** 이 경로가 정말 그 뿌리 안인가. 문법 검사 뒤의 두 번째 자물쇠다. */
function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

const profilePath = (root: string, id: string) => join(root, id, 'profile.json')

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** 이 뿌리들 아래에 실제로 있는 Profile 전부. external이 먼저 온다. */
export async function listProfileLocations(roots: ProfileRoots): Promise<ProfileLocation[]> {
  const found: ProfileLocation[] = []
  const dirs: [ProfileOrigin, string | undefined][] = [
    ['external', roots.externalRoot],
    ['built-in', join(roots.installRoot, 'profiles')],
  ]
  for (const [origin, dir] of dirs) {
    if (!dir) continue
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // 없는 디렉터리는 "Profile 0개"다. 오류가 아니다.
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!SAFE_ID.test(entry.name)) continue // 이름이 문법 밖이면 고를 수 없는 것이다
      const path = profilePath(dir, entry.name)
      if (!within(dir, path)) continue
      if (await exists(path)) found.push({ id: entry.name, origin, path })
    }
  }
  return found
}

/**
 * 이 id의 Profile은 어디 있는가.
 *
 * 아무 데도 없으면 **built-in 자리를 돌려준다** — 파일이 없다는 사실은 읽는 쪽에서
 * 그대로 드러나야 하고, 그 오류 모양은 v0.1과 같아야 한다.
 */
export async function resolveProfileLocation(
  id: string,
  roots: ProfileRoots,
): Promise<ProfileLocation> {
  assertProfileId(id)
  const builtInDir = join(roots.installRoot, 'profiles')
  const builtIn = profilePath(builtInDir, id)

  const externalDir = roots.externalRoot
  const external = externalDir ? profilePath(externalDir, id) : undefined
  if (external && !within(externalDir!, external)) {
    throw new ProfileSourceError('INVALID_PROFILE_ID', `'${id}' escapes the profile directory`)
  }

  const hasExternal = external ? await exists(external) : false
  const hasBuiltIn = await exists(builtIn)

  if (hasExternal && hasBuiltIn) {
    throw new ProfileSourceError(
      'PROFILE_COLLISION',
      `two profiles claim the id '${id}' — ${external} and ${builtIn}. ` +
        'Rename one of them: which policy applies must not depend on lookup order.',
    )
  }
  if (hasExternal) return { id, origin: 'external', path: external! }
  return { id, origin: 'built-in', path: builtIn }
}
