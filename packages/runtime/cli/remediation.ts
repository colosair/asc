// Blocker 의 remediation 을 이 CLI 의 명령으로 (0.10.0 P2).
//
// Core 는 `RESOLVE_PROFILE_DRIFT` 라고만 말한다. 그것이 `asc profile resolve --write` 인 것은
// 이 표면의 사정이고, 여기 한 곳에만 적는다 — status·bootstrap guard·work start 가 같은 blocker 를
// 같은 명령으로 말하게 하려면 표가 하나여야 한다.

import type { Blocker, Remediation } from '../core/operator/blockers.ts'

export function remediationCommand(remediation: Remediation, ref?: string): string {
  switch (remediation) {
    case 'ATTACH_WORKSPACE':
      return 'asc setup'
    case 'REPAIR_ATTACHMENT':
      return 'asc setup'
    case 'RESOLVE_PROFILE_DRIFT':
      return 'asc profile resolve --write'
    case 'REFRESH_HOST':
      return 'asc refresh'
    case 'FORCE_HOST_INSTALL':
      return 'asc host claude install --force'
    case 'STEP_DOWN_OR_FIX_AUTO':
      return 'asc mode manual — or fix what AUTO needs, then `asc mode auto`'
    case 'MAP_LOCAL_IDENTITY':
      return 'asc setup identity --actor local:<name> --role controller'
    case 'RECLAIM_SESSION':
      return `asc work reclaim ${ref ?? '<S-ID>'}`
    case 'RELEASE_TERMINAL_HOLDER':
      return `asc work reclaim ${ref ?? '<S-ID>'}`
  }
}

/** 한 blocker 를 사람이 읽는 두 줄로 — 무엇이·왜, 그리고 다음 명령. */
export function renderBlocker(blocker: Blocker): string[] {
  const who = blocker.resolver === 'person' ? 'a person decides' : 'one command'
  return [
    `  - ${blocker.what} — ${blocker.why}`,
    `      ${who}: ${remediationCommand(blocker.remediation, blocker.ref)}`,
  ]
}
