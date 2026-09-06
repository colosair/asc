// 이 기계가 돌보는 workspace 들 (설계 §6·§7).
//
// **두 번째 등록부를 만들지 않는다.** `monitorEnabled=true` 같은 플래그를 새로 두면 그것이
// 곧 두 번째 정본이 되고, 붙어 있는데 감시되지 않는(또는 그 반대의) 상태가 생긴다.
// 운영 상태는 **이미 있는 사실에서 계산한다**:
//
//   workspace 가 index 에 있다        → 이 기계가 아는 workspace 다
//   살아 있는 locator 가 하나라도 있다 → 관측할 수 있다
//   하나도 없다                        → DORMANT — 상태는 남기고 밖을 치지 않는다
//
// DORMANT 는 삭제 대상이 아니다 (설계 §3.9). checkout 을 잠시 지웠다고 몇 달치 기록을
// 버리면, 그 삭제를 되돌릴 방법이 없다. 새 locator 가 나타나면 다시 ACTIVE 가 된다.

/** 운영 상태 — 별도 state machine 이 아니라 읽기 모델이다. */
export type WorkspaceHealth = 'ACTIVE' | 'DEGRADED' | 'DORMANT'

export type WorkspaceView = {
  workspaceId: string
  /** 이 workspace 의 runtime 뿌리. */
  root: string
  /** 지금 살아 있는 checkout 들. 비어 있으면 DORMANT 다. */
  liveLocators: string[]
  /** 등록돼 있지만 지금 없는 checkout 들. 지우지 않는다 — 돌아올 수 있다. */
  missingLocators: string[]
  health: WorkspaceHealth
  aliases: readonly string[]
}

export type WorkspaceInput = {
  workspaceId: string
  root: string
  aliases: readonly string[]
  locators: readonly string[]
}

/**
 * 지금 이 기계의 상태를 계산한다. **판정도 삭제도 하지 않는다.**
 *
 * `rootExists` 가 거짓이면 runtime 자체가 사라진 것이다 — locator 가 살아 있어도
 * 관측할 수 없으므로 DEGRADED 로 든다. 사라진 것을 조용히 지우지 않는 이유는 위와 같다.
 */
export function viewWorkspaces(
  workspaces: readonly WorkspaceInput[],
  exists: (path: string) => boolean,
): WorkspaceView[] {
  return workspaces.map((workspace) => {
    const liveLocators = workspace.locators.filter((locator) => exists(locator))
    const missingLocators = workspace.locators.filter((locator) => !exists(locator))
    const rootExists = exists(workspace.root)
    const health: WorkspaceHealth =
      liveLocators.length === 0 ? 'DORMANT' : rootExists ? 'ACTIVE' : 'DEGRADED'
    return {
      workspaceId: workspace.workspaceId,
      root: workspace.root,
      liveLocators,
      missingLocators,
      health,
      aliases: workspace.aliases,
    }
  })
}

/**
 * 이번 회차에 실제로 돌 곳.
 *
 * DORMANT 는 **밖을 치지 않는다** (설계 §19). 살아 있는 checkout 이 없으면 그 저장소를
 * 대신해 무엇을 물어볼 자리도 없고, 없는 자리를 대신해 외부에 질문하면 그것은 관측이
 * 아니라 잡음이다.
 */
export function dueWorkspaces(
  views: readonly WorkspaceView[],
): { workspaceId: string; cwd: string; root: string }[] {
  return views
    .filter((view) => view.health === 'ACTIVE')
    // 여러 checkout 이 있으면 아무 곳에서나 한 번이면 된다 — 관측 대상은 workspace 이지
    // checkout 이 아니다. 첫 번째를 쓰는 것은 안정적인 선택이다(목록 순서가 index 순서다).
    .map((view) => ({ workspaceId: view.workspaceId, cwd: view.liveLocators[0]!, root: view.root }))
}

/** 사람이 읽는 기계 전체 화면. `cd` 없이 지금 무엇이 도는지 보여야 한다 (설계 §13.2). */
export function renderWorkspaces(views: readonly WorkspaceView[]): string[] {
  if (views.length === 0) return ['No workspaces are registered on this machine.']
  const lines: string[] = []
  for (const view of views) {
    const alias = view.aliases[0] ?? '(no alias)'
    lines.push(`${view.workspaceId}  ${view.health}  ${alias}`)
    for (const locator of view.liveLocators) lines.push(`  ${locator}`)
    // 없어진 checkout 도 든다 — 지우지 않았다는 사실이 보여야 사람이 놀라지 않는다
    for (const locator of view.missingLocators) lines.push(`  ${locator} (gone)`)
  }
  return lines
}

/** 회차 하나에서 workspace 하나가 어떻게 끝났는가. */
export type PassResult = { workspaceId: string; code: number }

/**
 * 기계 회차 전체의 결과 (P0-R2).
 *
 * 원칙 둘이 같이 선다: **한 workspace 의 실패가 다른 workspace 를 세우지 않는다** — 그래서
 * 전부 돌린 뒤에 센다. 그리고 **기계 수준 결과는 실패를 삼키지 않는다** — 하나라도 0 이 아니면
 * 회차도 0 이 아니다. 예전에는 무조건 0 을 돌려줘서 OS 기록(LastExitStatus)에는 두 workspace 가
 * 실패한 회차가 정상으로 남았다. 실패를 지운 것이 아니라 볼 수 없게 만든 것이고, 그것이 더 나쁘다.
 */
export function summarizePass(
  ran: readonly PassResult[],
  skipped: readonly { workspaceId: string; health: WorkspaceHealth }[],
): { code: 0 | 1; outcome: 'ok' | 'partial' | 'failed'; failed: PassResult[]; line: string } {
  const failed = ran.filter((result) => result.code !== 0)
  const outcome = failed.length === 0 ? 'ok' : failed.length === ran.length ? 'failed' : 'partial'
  const parts = [`${ran.length - failed.length} passed`]
  if (failed.length > 0) parts.push(`${failed.length} failed (${failed.map((r) => `${r.workspaceId}: ${r.code}`).join(', ')})`)
  if (skipped.length > 0) parts.push(`${skipped.length} skipped (${skipped.map((s) => s.health).join(', ')})`)
  return { code: failed.length === 0 ? 0 : 1, outcome, failed, line: `Machine pass ${outcome} — ${parts.join(' · ')}` }
}
