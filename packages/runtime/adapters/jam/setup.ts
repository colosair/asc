// JAM 준비 상태를 JAM 의 공식 경로로 되살린다 (설계 §9.2·§9.3).
//
// **진단도 수리도 JAM 이 한다.** ASC 가 하는 일은 셋뿐이다:
//
//   언제 부를지 정한다      Profile 이 work binding 을 선언했는데 JAM 이 준비되지 않았을 때
//   무엇을 부를지 고른다     JAM 이 스스로 말한 버전의 공식 bootstrap
//   어디서 멈출지 판단한다   사람만 할 수 있는 것은 사람에게 넘긴다
//
// ASC 는 Jira 토큰을 받지도 저장하지도 않고, 프로젝트 키를 만들어 내지도 않는다.
// 키는 Profile 에 이미 사람이 적어 둔 것이고, 그 결정을 다시 묻지 않는다.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** JAM 의 zero-install 진입. **버전을 여기 박지 않는다** — JAM 이 말한 값을 쓴다. */
export const JAM_BOOTSTRAP = '@jam-mcp/bootstrap'

/**
 * 정확한 버전으로 고정한 공식 명령.
 *
 * JAM 문서가 `@latest` 를 금지하고 정확한 핀을 요구한다. 그 버전을 ASC 가 정하면 두
 * 제품의 릴리스가 묶이므로, **돌고 있는 JAM 이 스스로 말한 버전**(doctor 의
 * `axes.packageVersion`)을 그대로 쓴다.
 */
export function jamBootstrapCommand(version: string, args: readonly string[]): { command: string; args: string[] } {
  return { command: 'npx', args: ['--yes', `${JAM_BOOTSTRAP}@${version}`, ...args] }
}

/** `setup plan --json` 에서 우리가 읽는 부분. */
export type JamSetupPlan = {
  status?: string
  /** 사람이 결정해야 하는 것이 남아 있는가. 남아 있으면 ASC 는 손대지 않는다. */
  requiresUserAction?: boolean
  changes?: unknown[]
  project?: { key?: string; keySource?: string }
  code?: string
  error?: string
}

export type JamHealOutcome =
  /** 고칠 것이 없었다. */
  | { kind: 'ALREADY_READY' }
  /** ASC 가 JAM 공식 setup 으로 고쳤다. */
  | { kind: 'HEALED'; changes: number }
  /** 사람이 해야 한다 — 자격, 또는 진짜 프로젝트 선택. */
  | { kind: 'NEEDS_HUMAN'; detail: string }
  /** 다시 돌려도 달라지지 않는다. */
  | { kind: 'FAILED'; detail: string }

export type JamSetupDeps = {
  cwd: string
  /** JAM 이 말한 자기 버전. 없으면 부를 수 없다 — 버전을 지어내지 않는다. */
  version: string
  /** 프로세스 실행 통로. 테스트가 실제 npx 를 부르지 않기 위한 주입점. */
  exec?: (command: string, args: readonly string[], cwd: string) => Promise<string>
}

const defaultExec = async (command: string, args: readonly string[], cwd: string): Promise<string> => {
  try {
    const { stdout } = await run(command, [...args], { cwd, maxBuffer: 8 * 1024 * 1024 })
    return stdout
  } catch (error) {
    // JAM 은 준비되지 않았을 때도 JSON 을 내면서 0 이 아닌 코드로 끝난다.
    const stdout = (error as { stdout?: string }).stdout
    if (stdout) return stdout
    throw error
  }
}

/**
 * 준비되지 않은 JAM 을 공식 경로로 되살린다.
 *
 * **계획을 먼저 본다.** 계획이 사람을 요구하면 적용하지 않는다 — 그것이 자격이거나 진짜
 * 프로젝트 선택이고, 둘 다 ASC 가 대신할 수 없는 것이다 (설계 §9.4).
 */
export async function healJam(deps: JamSetupDeps): Promise<JamHealOutcome> {
  const exec = deps.exec ?? defaultExec
  const read = async (args: readonly string[]): Promise<JamSetupPlan> => {
    const { command, args: full } = jamBootstrapCommand(deps.version, args)
    try {
      return JSON.parse(await exec(command, full, deps.cwd)) as JamSetupPlan
    } catch (error) {
      return { error: String((error as { message?: string }).message ?? error).slice(0, 300) }
    }
  }

  const plan = await read(['setup', 'plan', '--json'])
  if (plan.error) return { kind: 'FAILED', detail: `JAM setup plan 을 읽지 못했다 — ${plan.error}` }
  if (plan.requiresUserAction) {
    // 사람만 할 수 있는 것이 남았다. 대신 하지 않고, 무엇인지 그대로 전한다.
    return { kind: 'NEEDS_HUMAN', detail: plan.code ?? plan.status ?? 'JAM setup requires a person' }
  }
  if ((plan.changes?.length ?? 0) === 0) return { kind: 'ALREADY_READY' }

  const applied = await read(['setup', 'apply', '--non-interactive', '--json'])
  if (applied.error) return { kind: 'FAILED', detail: `JAM setup apply 가 실패했다 — ${applied.error}` }
  if (applied.requiresUserAction) {
    return { kind: 'NEEDS_HUMAN', detail: applied.code ?? applied.status ?? 'JAM setup requires a person' }
  }
  return { kind: 'HEALED', changes: plan.changes?.length ?? 0 }
}

/** 사람이 읽는 한 줄. 무엇을 했는지·무엇이 남았는지가 여기 있어야 한다. */
export function healLine(outcome: JamHealOutcome): string {
  switch (outcome.kind) {
    case 'ALREADY_READY':
      return 'JAM: already set up for this project'
    case 'HEALED':
      return `JAM: repaired through its own setup (${outcome.changes} change${outcome.changes === 1 ? '' : 's'})`
    case 'NEEDS_HUMAN':
      return `JAM: needs you — ${outcome.detail}. ASC does not sign in for you.`
    case 'FAILED':
      return `JAM: ${outcome.detail}`
  }
}
