// 지금 이 저장소를 설명하는 Profile을 만든다 (P0 — Two-URL agent bootstrap).
//
// **왜 필요한가**: 배포본에는 예시 Profile 둘뿐이고 둘 다 실 프로젝트용이 아니다. URL만
// 받은 agent는 `ASC_PROFILE_SELECTION_REQUIRED` 앞에서 고를 것이 없어 사람에게 되물었다.
// 되물음을 없애려면 "고른다"가 아니라 "만든다"가 있어야 한다.
//
// **무엇을 만드는가 — 추론 가능한 최소치뿐이다.** git remote에서 읽히는 사실
// (id · scm · repository)만 적는다. branch 정본·role 경계·정책은 이 저장소를 봐서
// 알 수 없다. 모르는 것을 그럴듯하게 채우면 두 가지가 같이 무너진다:
//
//   canonical source를 지어내면  세션 발급이 그 정본을 실제로 읽으려 하고, 자격이 없는
//                               기계에서 issue 자체가 실패한다 (session.ts §readBaselines)
//   role 경계를 지어내면         지어낸 경계가 곧 사람이 겪는 SCOPE_ESCALATION이 된다 —
//                               FAIL 회차에서 번들 Profile이 정확히 그렇게 막았다
//
// 그래서 adopt의 산출물은 **시작점**이다. 팀의 정책은 팀이 이 파일을 키워서 정한다.
//
// **provider 어휘는 여기 없다** (C-09 §6.1). 어느 host가 어느 provider인지는 Adapter를
// 아는 쪽이 정하고, 여기서는 `scmForHost` 로 받는다 — core가 특정 provider 이름으로
// 갈라지기 시작하면 그 다음 provider는 반드시 이 파일을 고쳐야 들어온다.

import { normalizeRemote } from '../workspace/identity.ts'

/** git이 부르는 이름과 URL. 이름을 버리지 않는 이유는 `origin` 을 알아보기 위해서다. */
export type RemoteEntry = { name: string; url: string }

export type AdoptInput = {
  /** 프로젝트 뿌리의 디렉터리 이름. remote가 없을 때 id와 repository의 근거가 된다. */
  dirName: string
  remotes: readonly RemoteEntry[]
  /** 사람이 `--id` 로 준 이름. 있으면 추론보다 앞선다. */
  requestedId?: string
  /**
   * 이 host를 어느 SCM 이름으로 적을 것인가. 모르면 `'git'` 이면 된다 — 그것이 사실이다.
   * provider를 아는 쪽(조립부)이 넘긴다.
   */
  scmForHost?: (host: string) => string
}

export type AdoptedProfile = {
  id: string
  /** `ProjectProfile` 로 파싱되는 객체. 파일에 그대로 쓴다. */
  profile: Record<string, unknown>
  /** 추론하지 못해 비워 둔 것. 숨기지 않고 사람에게 보인다. */
  warnings: string[]
}

export class AdoptError extends Error {
  readonly code: 'NO_USABLE_ID'

  constructor(code: 'NO_USABLE_ID', message: string) {
    super(message)
    this.name = 'AdoptError'
    this.code = code
  }
}

/** Profile id는 디렉터리 이름 한 칸이다 (profile-source.ts SAFE_ID와 같은 문법). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 이름 하나를 id 문법으로 깎는다. 못 깎으면 `null` — 조용히 아무 이름이나 만들지 않는다.
 * `.` 과 `..` 은 문법은 통과하지만 디렉터리로서 뜻이 다르므로 여기서 뺀다.
 */
export function toProfileId(name: string): string | null {
  const cut = name
    .trim()
    .replace(/\.git$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-+$/, '')
  if (!cut || cut === '.' || cut === '..' || !SAFE_ID.test(cut)) return null
  return cut
}

/** `origin` 이 있으면 그것이다. 없으면 첫 번째 — 다만 그 사실을 경고로 남긴다. */
function primaryRemote(remotes: readonly RemoteEntry[]): RemoteEntry | undefined {
  return remotes.find((r) => r.name === 'origin') ?? remotes[0]
}

/**
 * 이 저장소를 설명하는 최소 Profile. **파일을 읽지도 쓰지도 않는다** — 사실은 호출자가
 * 관측해 넘기고, 여기서는 판단만 한다. 그래야 같은 판단을 테스트가 그대로 돌린다.
 */
export function buildAdoptedProfile(input: AdoptInput): AdoptedProfile {
  const warnings: string[] = []
  const remote = primaryRemote(input.remotes)
  const distinctUrls = new Set(input.remotes.map((r) => r.url))
  if (remote && remote.name !== 'origin' && distinctUrls.size > 1) {
    warnings.push(`No 'origin' remote — used '${remote.name}' (${remote.url}) to identify this project.`)
  }

  // `host/group/project` 로 정규화된다. 자격·포트·질의는 여기 들어오지 않는다.
  const alias = remote ? normalizeRemote(remote.url) : null
  const slash = alias?.indexOf('/') ?? -1
  const host = alias && slash > 0 ? alias.slice(0, slash) : null
  // repository는 host를 뺀 `owner/repo` 다 — Adapter가 API에 그대로 넘기는 형태가 그것이다.
  const repository = alias && slash > 0 ? alias.slice(slash + 1) : null

  const id = input.requestedId ?? (repository ? toProfileId(repository.split('/').pop()!) : null) ?? toProfileId(input.dirName)
  if (id === null) {
    throw new AdoptError(
      'NO_USABLE_ID',
      `Could not make a profile id out of '${input.dirName}' — pass one with --id <name> (letters, digits, '.', '_', '-').`,
    )
  }
  if (input.requestedId !== undefined && !SAFE_ID.test(input.requestedId)) {
    throw new AdoptError(
      'NO_USABLE_ID',
      `'${input.requestedId}' is not a profile id — use a single name made of letters, digits, '.', '_' or '-'.`,
    )
  }

  if (!repository) {
    warnings.push(
      remote
        ? `Remote '${remote.url}' is not a shared repository address — this profile describes a local project.`
        : 'This repository has no remote — this profile describes a local project.',
    )
  }
  warnings.push(
    'canonical.sources is empty: no branch is treated as the source of truth yet. Declare one before' +
      ' relying on canonical verification.',
  )
  warnings.push('policy.roleScopes is empty: no role is narrowed yet. Declare scopes when the team agrees on them.')

  return {
    id,
    warnings,
    profile: {
      schemaVersion: 1,
      $comment:
        'Adopted from this repository by `asc profile adopt`. It carries only what a git remote can prove —' +
        ' the project identity. Canonical branches, role boundaries and policy are decisions this tool cannot' +
        ' make for you: add them here as the team agrees on them.',
      id,
      project: {
        // 공유 주소가 없으면 로컬 프로젝트다. 있으면 host를 아는 쪽이 이름을 준다.
        scm: host === null ? 'local' : (input.scmForHost?.(host) ?? 'git'),
        repository: repository ?? `local/${toProfileId(input.dirName) ?? id}`,
      },
      canonical: {
        $comment:
          'Empty means canonical verification does not apply. Add a source (id, provider, remote, ref) to' +
          ' have sessions check the project against a real baseline.',
        sources: [],
      },
    },
  }
}
