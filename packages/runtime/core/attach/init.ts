// Project Attach — 프로젝트 하나에 Runtime을 붙인다 (OM §3.3~3.4, C-11 §2·§5).
//
// **기본은 local scope이고, 그때 프로젝트에는 아무것도 생기지 않는다.** runtime은 사용자
// 소유 공간(`ASC_HOME/workspaces/<W-id>`)에 있다. 프로젝트 안의 `.asc/`는 팀이 그렇게
// 하기로 정한 project scope이거나 아직 옮기지 않은 legacy일 때만 존재한다.
//
// 프로젝트는 ASC를 몰라야 하며, runtime을 지우면 아무 일도 없었던 것이 되어야 한다.

import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const EXCLUDE_LINE = '.asc/'

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** `.git`이 있는 곳까지 올라간다. 없으면 여기가 프로젝트 뿌리다. */
export async function discoverProjectRoot(start: string): Promise<{ root: string; git: boolean }> {
  let dir = resolve(start)
  for (;;) {
    if (await exists(join(dir, '.git'))) return { root: dir, git: true }
    const parent = dirname(dir)
    if (parent === dir) return { root: resolve(start), git: false }
    dir = parent
  }
}

export type ExcludeOutcome = 'added' | 'already' | 'no-git'

/**
 * `.asc/`를 Git 추적에서 뺀다. 프로젝트의 `.gitignore`는 팀 파일이라 손대지 않는다 —
 * ASC를 쓰지 않는 사람에게 ASC의 흔적이 보이면 안 된다 (OM §1.2).
 *
 * **project scope에서만 부른다** (C-11 §5). local scope는 저장소 파일을 한 바이트도
 * 건드리지 않으므로 여기에 오지 않는다 — `.git/info/exclude` 자기등록은 legacy·전환기
 * 안전장치이지 개인 사용의 정상 경로가 아니다.
 */
export async function excludeFromGit(projectRoot: string): Promise<ExcludeOutcome> {
  const gitDir = join(projectRoot, '.git')
  if (!(await exists(gitDir))) return 'no-git'

  const excludePath = join(gitDir, 'info', 'exclude')
  await mkdir(dirname(excludePath), { recursive: true })

  let current = ''
  try {
    current = await readFile(excludePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (current.split('\n').some((line) => line.trim() === EXCLUDE_LINE)) return 'already'

  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
  await appendFile(excludePath, `${prefix}${EXCLUDE_LINE}\n`, 'utf8')
  return 'added'
}

/** 개인 몫 서식. 처음 한 번만 만들고 이후엔 사람 것이다 (OM §4.4). */
export function overrideTemplate(): string {
  return `${JSON.stringify(
    {
      $comment: '개인 몫입니다. 팀원마다 이 파일만 다릅니다. 토큰은 값이 아니라 이름으로만 적습니다.',
      // 이 파일은 profile.lock의 digest에 들어간다. 고치고 재고정하지 않으면 다음 명령이
      // LOCK_DRIFT로 멈추는데, 그때 가서 알면 늦다 — 파일을 열었을 때 여기 적혀 있어야 한다.
      $afterEdit: '이 파일을 고친 뒤에는 `asc profile resolve --write` 로 재고정하세요.',
      schemaVersion: 1,
      monitorIdentities: [],
      controller: { identities: {} },
      approval: { preferredChannel: 'local' },
    },
    null,
    2,
  )}\n`
}

/**
 * 승인자 매핑 서식. 비어 있으면 어떤 승인도 통과하지 않는다 (OM §11.6).
 *
 * 예시를 `$example` 안에 두는 이유: loadIdentityMap은 값이 배열인 항목만 매핑으로 받으므로
 * 이 키는 조용히 무시된다. 반대로 예시를 실제 매핑 형태로 바로 적으면 **그 이름이 유효한
 * 승인자가 되어** 아무도 지정하지 않은 사람이 승인을 통과시킨다. 형식을 보여주되 살아나지
 * 않는 자리에 둔다.
 */
export function identitiesTemplate(): string {
  return `${JSON.stringify(
    {
      $comment:
        '승인 권한자 이름과, 그 사람을 알아볼 채널:계정을 잇습니다. 비밀·토큰은 넣지 않습니다. ' +
        '아래 $example 을 참고해 같은 형태로 항목을 추가하세요 ($example 자체는 무시됩니다).',
      $example: { 'controller-이름': ['local:내-계정', '<채널>:@내-계정'] },
    },
    null,
    2,
  )}\n`
}

/** 이미 있으면 건드리지 않는다. 사람이 채운 것을 덮지 않기 위해서다. */
export async function writeIfAbsent(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/**
 * 지금 이 사람을 승인 권한자·감시 대상으로 세운 두 파일의 내용 (P1-F).
 *
 * 순수 함수인 이유: 이 결정은 두 파일에 서로 다른 형식으로 적히고, 한쪽만 채워 두면
 * 게이트가 왜 안 열리는지 알 수 없는 상태가 된다. 그 짝을 코드 한 곳에서 만든다.
 *
 * **비밀은 다루지 않는다** — 이름과 채널만 적힌다.
 */
export function withIdentity(
  identities: Record<string, unknown>,
  override: Record<string, unknown>,
  input: { name: string; actor: string; controller: boolean; monitor: boolean },
): { identities: Record<string, unknown>; override: Record<string, unknown> } {
  const nextIdentities = { ...identities }
  const nextOverride = { ...override }

  if (input.controller) {
    nextIdentities[input.name] = [input.actor]
    const controller = { ...((nextOverride.controller as Record<string, unknown> | undefined) ?? {}) }
    controller.identities = {
      ...((controller.identities as Record<string, unknown> | undefined) ?? {}),
      [input.name]: [input.actor],
    }
    nextOverride.controller = controller
  }

  if (input.monitor) {
    const existing = Array.isArray(nextOverride.monitorIdentities)
      ? (nextOverride.monitorIdentities as unknown[]).filter((v): v is string => typeof v === 'string')
      : []
    nextOverride.monitorIdentities = [...new Set([...existing, input.name])]
  }

  return { identities: nextIdentities, override: nextOverride }
}
