// Capability Probe — 버전표가 아니라 실측 (C-03 §5.2).
//
// 공식 Docs와 CHANGELOG가 일시적으로 다를 수 있으므로 실제 확인이 우선한다. 다만 정직해야
// 한다: CLI에서 실행해 알 수 있는 것과, Claude 세션 안에서만 보이는 것(runtime tool)은
// 다르다. 후자를 CLI가 아는 척하면 probe가 버전표보다 나을 게 없다. 그래서 판정마다
// 어떻게 알았는지(source)를 함께 기록하고, 모르는 것은 unknown으로 남긴다 —
// 호스트 세션이 자기 도구 목록을 보고 채우는 것은 별도 경로(host-report)다.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const CAPABILITIES = [
  'cross_session_message',
  'list_live_sessions',
  'notify_when_idle',
  'fork_subagent',
  'background_agent',
  'agent_view_json',
  'worktree_isolation',
  'goal_loop',
  'hooks',
  'remote_control',
  'agent_teams',
  'dynamic_workflows',
  'external_write_guard',
] as const
export type CapabilityName = (typeof CAPABILITIES)[number]

export type CapabilityVerdict = {
  available: boolean | 'unknown'
  source: 'cli-probe' | 'host-report' | 'not-probed'
  detail?: string
}

export type ProbeResult = {
  claudeVersion: string | null
  probedAt: string
  capabilities: Record<CapabilityName, CapabilityVerdict>
}

/** 안전에 필수인 capability — 없으면 degrade가 아니라 STOP이다 (C-03 §5.2). */
export const SAFETY_CRITICAL: readonly CapabilityName[] = ['external_write_guard']

/**
 * 외부 명령 한 번. 실패 이유는 구분하지 않는다 — 미설치든 비정상 종료든 "실측하지 못했다"는
 * 같은 결론이기 때문이다.
 */
export type CommandRunner = (command: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>

const tryRun: CommandRunner = async (command, args) => {
  try {
    const { stdout } = await run(command, args, { timeout: 15_000 })
    return { ok: true, stdout }
  } catch {
    return { ok: false, stdout: '' }
  }
}

/**
 * CLI에서 실측 가능한 범위의 probe. runtime tool 여부는 unknown으로 남긴다.
 * @param guardInstalled install manifest 검증 결과 — hook이 실제로 배치·등록됐는가.
 */
export async function probe(input: {
  /** user-scope: hook 스크립트·settings 등록이 온전한가 (3층). */
  guardInstalled: boolean
  /** project-scope: worker-settings.json(permissions.deny)이 준비됐는가 (2층). 프로젝트 밖이면 undefined. */
  workerSettingsReady?: boolean
  now?: () => string
  /**
   * 외부 명령 실행 통로. 생략하면 실제 CLI를 부른다 — 테스트가 호스트에 무엇이 깔렸는지에
   * 좌우되지 않도록 주입만 열어 두고, 기본값은 바꾸지 않는다.
   */
  run?: CommandRunner
}): Promise<ProbeResult> {
  const at = (input.now ?? (() => new Date().toISOString()))()
  const exec = input.run ?? tryRun

  const version = await exec('claude', ['--version'])
  const claudeVersion = version.ok ? version.stdout.trim().split(/\s/)[0] ?? null : null

  const unknown = (detail: string): CapabilityVerdict => ({ available: 'unknown', source: 'not-probed', detail })
  const capabilities = {} as Record<CapabilityName, CapabilityVerdict>

  if (!claudeVersion) {
    for (const name of CAPABILITIES) capabilities[name] = unknown('claude CLI를 찾지 못했다')
    capabilities.external_write_guard = {
      available: false,
      source: 'cli-probe',
      detail: 'claude CLI가 없으면 guard 등록을 확인할 수 없다',
    }
    return { claudeVersion, probedAt: at, capabilities }
  }

  // Agent View — 실제로 실행해 본다 (read-only)
  const agents = await exec('claude', ['agents', '--json'])
  let agentViewDetail = 'claude agents --json 실행 실패'
  let agentViewOk = false
  if (agents.ok) {
    try {
      JSON.parse(agents.stdout)
      agentViewOk = true
      agentViewDetail = 'claude agents --json 정상 파싱'
    } catch {
      agentViewDetail = '실행은 됐으나 JSON이 아니다'
    }
  }
  capabilities.agent_view_json = { available: agentViewOk, source: 'cli-probe', detail: agentViewDetail }
  // Agent View가 돌면 background 세션 표면도 있는 것이다
  capabilities.background_agent = { available: agentViewOk, source: 'cli-probe', detail: 'agent_view_json에서 추론' }
  capabilities.list_live_sessions = { available: agentViewOk, source: 'cli-probe', detail: 'agent_view_json에서 추론' }

  // hooks — 설정 표면이 있는지는 CLI로 단정할 수 없으나, guard 설치 검증이 실질 판정이다
  capabilities.hooks = input.guardInstalled
    ? { available: true, source: 'cli-probe', detail: 'ASC guard hook이 등록·검증됨' }
    : unknown('guard 미설치 — asc host claude install 후 재probe')

  // 안전 필수: 3층 중 enforcement 두 층(hook + worker permission deny)이 실제로 서 있는가.
  // 프로젝트 밖에서는 worker-settings를 판정할 수 없으므로 false로 둔다 — worker는
  // 프로젝트에서 돌고, 모르는 것을 있다고 치지 않는다.
  const workerReady = input.workerSettingsReady === true
  capabilities.external_write_guard = {
    available: input.guardInstalled && workerReady,
    source: 'cli-probe',
    detail: !input.guardInstalled
      ? 'guard hook 미설치 — asc host claude install'
      : !workerReady
        ? 'worker-settings 미준비 — attach된 프로젝트에서 asc host claude guard'
        : 'hook(3층) + worker permission deny(2층) 검증 통과',
  }

  // runtime tool — Claude 세션 안에서만 보인다. 아는 척하지 않는다
  for (const name of [
    'cross_session_message',
    'notify_when_idle',
    'fork_subagent',
    'worktree_isolation',
    'goal_loop',
    'remote_control',
    'agent_teams',
    'dynamic_workflows',
  ] as const) {
    capabilities[name] = unknown('runtime tool — 호스트 세션의 self-report(host-report)로 채운다')
  }

  return { claudeVersion, probedAt: at, capabilities }
}

/**
 * 호스트 세션(Claude 자신)이 자기 도구 목록을 보고 채우는 경로.
 * skill이 안내하는 self-report가 여기로 들어온다.
 */
export function applyHostReport(
  result: ProbeResult,
  report: Partial<Record<CapabilityName, boolean>>,
  at: string,
): ProbeResult {
  const merged = { ...result, probedAt: at, capabilities: { ...result.capabilities } }
  for (const [name, available] of Object.entries(report) as [CapabilityName, boolean][]) {
    // cli-probe가 이미 확정한 것은 self-report가 덮지 못한다 — 실측이 자기 보고보다 세다
    if (merged.capabilities[name]?.source === 'cli-probe') continue
    merged.capabilities[name] = { available, source: 'host-report' }
  }
  return merged
}

export type Readiness =
  | { ok: true; degraded: CapabilityName[] }
  | { ok: false; reason: 'STOP'; missing: CapabilityName[] }

/** optional 부재는 degrade, 안전 필수 부재·unknown은 STOP (C-03 §5.2). */
export function assessReadiness(result: ProbeResult): Readiness {
  const missing = SAFETY_CRITICAL.filter((name) => result.capabilities[name]?.available !== true)
  if (missing.length > 0) return { ok: false, reason: 'STOP', missing }

  const degraded = CAPABILITIES.filter(
    (name) => !SAFETY_CRITICAL.includes(name) && result.capabilities[name]?.available !== true,
  )
  return { ok: true, degraded }
}
