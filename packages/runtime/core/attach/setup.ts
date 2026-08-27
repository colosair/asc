// Setup 상태 — 지금 무엇이 되고 무엇이 막혀 있는가 (B-21).
//
// 근거(B-16): attach 후 override.json·identities.json을 손으로 채워야 했는데, 무엇을 왜
// 채워야 하는지가 어디에도 없었다. 게다가 override는 고친 뒤 재고정하지 않으면 다음
// 명령이 통째로 멈추는데 그 사실을 drift가 난 뒤에야 알게 된다.
//
// 다시 재어 본 결과 이 문제는 생각보다 좁았다 — **막히는 것은 바깥 경로뿐이고**
// (외부 감시·승인 결정·외부 반영), 세션 발급부터 회수·마무리까지 로컬 루프는 설정 편집
// 0회로 전부 돈다. 그래서 이 모듈이 하는 일은 "설정을 받아 채우는 것"이 아니라
// **무엇이 열려 있고 무엇이 아직 안 열렸는지를 정직하게 말하는 것**이다.
//
// 판정만 한다. 파일도 env도 직접 읽지 않고 전부 주입받으며, 아무것도 고치지 않는다.

/** 붙어 있는 상태 자체. 이게 READY가 아니면 gate 판정보다 이쪽이 먼저 답이다. */
export type AttachmentState = 'READY' | 'UNATTACHED' | 'BROKEN' | 'LOCK_DRIFT'

/**
 * OPEN 열림 · BLOCKED 못 씀 · DEGRADED 돌긴 하는데 반쪽.
 *
 * 반쪽을 BLOCKED로 적으면 사람이 "안 되는구나" 하고 덮어 버린다. monitor scan이 돌면서도
 * 나에게 온 것을 못 알아보는 상태가 정확히 그렇다 — 실행 자체가 막힌 것과 구분해야 한다.
 */
export type GateState = 'OPEN' | 'BLOCKED' | 'DEGRADED'

export type SetupGate = {
  id: 'approval' | 'monitor' | 'external-write'
  label: string
  state: GateState
  /** 무엇이 없어서 막혔는지. */
  missing: string[]
  /** 돌긴 하지만 알아야 할 것. */
  warnings: string[]
  /** 어떻게 여는지. 재고정이 필요한 것과 아닌 것을 구분해서 적는다. */
  howTo: string[]
}

export type SetupStatus = {
  attachment: AttachmentState
  /** 지금 붙어 있는 Profile과 그 출처. 붙지 않았으면 없다. */
  profile?: { id: string; origin: 'built-in' | 'external' }
  /** 설정과 무관하게 지금 되는 것. */
  ready: string[]
  gates: SetupGate[]
}

export type SetupInput = {
  attachment: AttachmentState
  /** 붙어 있는 Profile의 id와 출처. **Surface가 읽어 넘긴다** — Core는 경로를 모른다. */
  profile?: { id: string; origin: 'built-in' | 'external' }
  /** 승인 권한자 매핑이 하나라도 있는가. */
  hasApprovers: boolean
  /** override의 controller.identities가 채워졌는가. */
  hasControllerIdentities: boolean
  /** override의 monitorIdentities가 채워졌는가. */
  hasMonitorIdentities: boolean
  /** SCM 토큰을 찾았는가. 값은 받지 않는다 — 있는지만 안다. */
  hasScmToken: boolean
}

/**
 * 설정을 하나도 안 채워도 되는 것들. B-16 이후 늘어난 표면(progress·preflight·closure)까지
 * 포함한다 — "attach가 끝나야 아무것도 할 수 있다"는 오해를 이 목록이 직접 깬다.
 */
const ALWAYS_READY = [
  'issue, run, pause, resume and finish sessions (asc session, asc proceed)',
  'record and read progress (asc progress)',
  'check output paths up front (asc preflight)',
  'collect finished work and confirm closure (asc controller collect, asc closure)',
  'read incoming requests (asc inbox list/show)',
  'install and check the host (asc host)',
]

const RESOLVE_AGAIN =
  'after editing, re-lock with `asc profile resolve --write` (otherwise the next command stops)'

export function assessSetup(input: SetupInput): SetupStatus {
  return {
    attachment: input.attachment,
    ...(input.profile ? { profile: input.profile } : {}),
    ready: [...ALWAYS_READY],
    gates: [approvalGate(input), monitorGate(input), externalWriteGate(input)],
  }
}

/** 승인 결정. identities.json은 lock digest에 없어 재고정이 필요 없다. */
function approvalGate(input: SetupInput): SetupGate {
  if (input.hasApprovers) {
    return { id: 'approval', label: 'approval decisions', state: 'OPEN', missing: [], warnings: [], howTo: [] }
  }
  return {
    id: 'approval',
    label: 'approval decisions',
    state: 'BLOCKED',
    missing: ['identities.json lists no approver'],
    warnings: [],
    // 여기에 재고정을 적지 않는다 — 필요 없는 절차를 시키면 다음부터 안내를 안 믿는다
    howTo: ['open identities.json and add an approver in the $example form (no re-lock needed)'],
  }
}

/**
 * 외부 감시. 두 설정이 서로 다른 것을 막는다 —
 * controller.identities가 없으면 실행 자체가 안 되고(단 --as로 우회 가능),
 * monitorIdentities가 없으면 실행은 되는데 나에게 온 것을 못 알아본다.
 */
function monitorGate(input: SetupInput): SetupGate {
  const missing: string[] = []
  const warnings: string[] = []
  const howTo: string[] = []

  if (!input.hasControllerIdentities) {
    missing.push('controller.identities in override.json is empty')
    howTo.push(`list an approver in controller.identities, or pass \`--as <name>\` — ${RESOLVE_AGAIN}`)
  }
  if (!input.hasMonitorIdentities) {
    warnings.push('monitorIdentities is empty, so mentions and assignments to you are not recognised')
    howTo.push(`put your account name in monitorIdentities — ${RESOLVE_AGAIN}`)
  }
  if (!input.hasScmToken) {
    missing.push('no SCM token found')
    howTo.push('set ASC_GITHUB_TOKEN, or run `gh auth login`')
  }

  return {
    id: 'monitor',
    label: 'external monitoring',
    state: missing.length > 0 ? 'BLOCKED' : warnings.length > 0 ? 'DEGRADED' : 'OPEN',
    missing,
    warnings,
    howTo,
  }
}

/** 외부 반영. 승인된 Grant를 실제로 내보내려면 토큰과 발급 권한이 둘 다 있어야 한다. */
function externalWriteGate(input: SetupInput): SetupGate {
  const missing: string[] = []
  const howTo: string[] = []

  if (!input.hasApprovers) {
    missing.push('no one can issue a grant (identities.json)')
    howTo.push('add an approver to identities.json (no re-lock needed)')
  }
  if (!input.hasScmToken) {
    missing.push('no SCM token found')
    howTo.push('set ASC_GITHUB_TOKEN, or run `gh auth login`')
  }

  return {
    id: 'external-write',
    label: 'external writes',
    state: missing.length > 0 ? 'BLOCKED' : 'OPEN',
    missing,
    warnings: [],
    howTo,
  }
}

/** 사람이 읽는 형태. 상태가 먼저 오고, 되는 것, 막힌 것 순이다. */
export function renderSetup(status: SetupStatus): string {
  const lines: string[] = []

  switch (status.attachment) {
    case 'UNATTACHED':
      lines.push('Not attached yet — run `asc init --profile <id>` first.')
      return lines.join('\n')
    case 'BROKEN':
      lines.push('Attachment is half-finished: a runtime exists but profile.lock does not.')
      lines.push('  Re-attach with `asc init --profile <id>`, or lock it with `asc profile resolve --write`.')
      return lines.join('\n')
    case 'LOCK_DRIFT':
      // 이 상태에서 gate를 나열하면 "설정이 덜 찼다"로 잘못 읽힌다. 원인을 먼저 말한다.
      lines.push('Configuration differs from the lock, so commands stop — it was edited without re-locking.')
      lines.push('  Re-lock with `asc profile resolve --write` and the state below applies again.')
      lines.push('')
      break
    case 'READY':
      break
  }

  // 어떤 Profile로 도는지, 그리고 그것이 **어디서 왔는지**. 배포본에 딸려 온 예시로
  // 실 프로젝트를 돌리고 있는 상태를 사람이 모르고 지나가지 않게 한다.
  if (status.profile) {
    const origin =
      status.profile.origin === 'external'
        ? 'your own profile directory'
        : 'bundled with the installed package'
    lines.push(`profile: ${status.profile.id} — ${origin}`)
    lines.push('')
  }

  lines.push('Working now:')
  for (const item of status.ready) lines.push(`  ${item}`)

  const notOpen = status.gates.filter((g) => g.state !== 'OPEN')
  const open = status.gates.filter((g) => g.state === 'OPEN')

  if (open.length > 0) {
    lines.push('', `Open outward paths: ${open.map((g) => g.label).join(' · ')}`)
  }

  if (notOpen.length > 0) {
    lines.push('', 'Not open yet:')
    for (const gate of notOpen) {
      lines.push(`  [${gate.state === 'DEGRADED' ? '~' : ' '}] ${gate.label}`)
      for (const item of gate.missing) lines.push(`      ${item}`)
      for (const item of gate.warnings) lines.push(`      ${item}`)
      for (const item of gate.howTo) lines.push(`      → ${item}`)
    }
  }

  return lines.join('\n')
}
