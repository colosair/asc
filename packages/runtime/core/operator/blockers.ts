// 지금 무엇이 막혀 있고 누가 풀 수 있는가 — 하나의 모델 (0.10.0 P2).
//
// 0.9.1 까지는 status·bootstrap guard·setup 화면·work start 가 각자 문자열을 만들었다. 같은
// LOCK_DRIFT 를 두 곳은 `profile resolve --write` 로, 한 곳은 `asc setup` 으로 안내했고, 세 번
// 막힌 publish 동안 status 의 `Next:` 는 내내 `asc inbox` 였다 (dogfood 2026-09-13 F5).
//
// 여기서는 **사실과 의미만** 든다. 명령 문자열은 없다 — 어느 명령이 그 remediation 인지는
// Surface(CLI) 가 정하고, 이 모듈은 provider 도 host 도 모른다. status 는 이 목록을 그대로
// 렌더하고, 다른 명령은 자기 invocation error 를 같은 어휘로 설명한다.

/** 무엇을 하면 풀리는가 — 의미만. */
export type Remediation =
  | 'ATTACH_WORKSPACE'
  | 'REPAIR_ATTACHMENT'
  | 'RESOLVE_PROFILE_DRIFT'
  | 'REFRESH_HOST'
  | 'FORCE_HOST_INSTALL'
  | 'STEP_DOWN_OR_FIX_AUTO'
  | 'MAP_LOCAL_IDENTITY'
  | 'RECLAIM_SESSION'
  | 'RELEASE_TERMINAL_HOLDER'

export type Blocker = {
  /** 안정된 식별자 — 테스트와 JSON 이 문구 대신 이것을 본다. */
  id: string
  /** 무엇이 막혔는가 (사람 문장). */
  what: string
  /** 왜 (사실). */
  why: string
  /** 누가 풀 수 있는가. `person` 은 결정이 필요하고, `agent` 는 명령 하나면 된다. */
  resolver: 'person' | 'agent'
  remediation: Remediation
  scope: 'workspace' | 'run' | 'session'
  /** 세션·Run 범위일 때 그 대상. */
  ref?: string
}

export type BlockerInput = {
  /** 붙어 있는가. 붙지 않았으면(`undefined`) 그것부터다. */
  attachment?: 'READY' | 'BROKEN' | 'LOCK_DRIFT' | 'UNATTACHED' | undefined
  host?: { id: string; status: string }
  mode?: { mode: 'MANUAL' | 'AUTO'; ready: boolean; blocking: readonly { axis: string; state: string; detail?: string }[] }
  approval?: { hasApprovers: boolean; hasLocalApprover: boolean }
  /** 지금 Run 이 잡고 있는 결합들 — logical ↔ physical, 그리고 그 세션의 상태. */
  bindings?: readonly { sessionId: string; holder: string; sessionStatus?: string | undefined }[]
  /** 이 명령을 부른 Run. 없으면 Run 범위 판정을 하지 않는다. */
  thisRun?: string | undefined
}

export function collectBlockers(input: BlockerInput): Blocker[] {
  const out: Blocker[] = []

  switch (input.attachment) {
    case undefined:
    case 'UNATTACHED':
      out.push({
        id: 'attachment',
        what: 'no ASC runtime is attached here',
        why: 'nothing can be judged without a workspace',
        resolver: 'agent',
        remediation: 'ATTACH_WORKSPACE',
        scope: 'workspace',
      })
      break
    case 'BROKEN':
      out.push({
        id: 'attachment',
        what: 'the attachment is half-finished',
        why: 'a runtime exists but profile.lock does not',
        resolver: 'agent',
        remediation: 'REPAIR_ATTACHMENT',
        scope: 'workspace',
      })
      break
    case 'LOCK_DRIFT':
      out.push({
        id: 'attachment',
        what: 'the configuration differs from profile.lock',
        why: 'it was edited without re-locking, so every attached command stops',
        resolver: 'person',
        remediation: 'RESOLVE_PROFILE_DRIFT',
        scope: 'workspace',
      })
      break
    case 'READY':
      break
  }

  if (input.host && input.host.status !== 'INSTALLED_CURRENT') {
    const modified = input.host.status === 'INSTALLED_MODIFIED'
    out.push({
      id: `host:${input.host.id}`,
      what: `host integration is ${input.host.status}`,
      why: modified ? 'the installed files were edited by a person' : 'the installed files do not match this build',
      resolver: modified ? 'person' : 'agent',
      remediation: modified ? 'FORCE_HOST_INSTALL' : 'REFRESH_HOST',
      scope: 'workspace',
    })
  }

  if (input.mode?.mode === 'AUTO' && !input.mode.ready) {
    out.push({
      id: 'auto-readiness',
      what: 'AUTO is chosen but the managed execution path is not usable',
      why: input.mode.blocking.map((axis) => `${axis.axis} ${axis.state}${axis.detail ? ` — ${axis.detail}` : ''}`).join('; '),
      resolver: 'person',
      remediation: 'STEP_DOWN_OR_FIX_AUTO',
      scope: 'workspace',
    })
  }

  if (input.approval && !input.approval.hasLocalApprover) {
    out.push({
      id: 'approval',
      what: 'no approver is mapped to this machine',
      why: input.approval.hasApprovers
        ? 'identities.json names an approver, but not on the local channel this CLI verifies'
        : 'identities.json lists no approver',
      resolver: 'person',
      remediation: 'MAP_LOCAL_IDENTITY',
      scope: 'workspace',
    })
  }

  for (const binding of input.bindings ?? []) {
    const finished = binding.sessionStatus === undefined || binding.sessionStatus === 'DONE'
    if (finished) {
      out.push({
        id: `terminal-holder:${binding.sessionId}`,
        what: `${binding.sessionId} is finished but still held by a Run`,
        why: `${binding.holder} never released it`,
        resolver: 'agent',
        remediation: 'RELEASE_TERMINAL_HOLDER',
        scope: 'session',
        ref: binding.sessionId,
      })
      continue
    }
    if (input.thisRun && binding.holder !== input.thisRun) {
      out.push({
        id: `held:${binding.sessionId}`,
        what: `${binding.sessionId} is held by another Run`,
        why: `${binding.holder} holds it; only the holder can report, pause or finish it`,
        resolver: 'person',
        remediation: 'RECLAIM_SESSION',
        scope: 'session',
        ref: binding.sessionId,
      })
    }
  }

  return out
}
