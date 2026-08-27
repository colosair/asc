// Controller 회수 — 끝난 세션을 사람이 거둬들이는 절차 (OM §7.2·§9).
//
// 세션은 자기 파일에 Handoff를 쓰는 데까지 하고 멈춘다. state·block·queue를 세션이
// 직접 고치게 두면 여러 세션이 같은 문서를 두고 다투게 되고, 무엇보다 Controller가
// 상태를 모르는 채로 흘러간다. 그래서 회수는 별도 행위이고 사람이 시작한다.

import type { Session } from '../model/entities.ts'
import type { StateStore } from '../../ports/state-store.ts'
import { ClosureLedger, pendingLines } from './closure.ts'
import type { AuditLedger } from './audit.ts'
import { escalatedLines, queryLines, type QueryLedger } from './query.ts'
import type { EscalationLedger } from './escalation.ts'

export type CollectOutcome = {
  active: string[]
  /** 이번에 거둔 세션들. Handoff를 읽었다는 뜻이다. */
  collected: string[]
  /** 사람이 판단할 것 — 미결과 막힌 세션. */
  awaiting: string[]
  occupancy: { sessionId: string; paths: string[] }[]
}

export type CollectOptions = {
  /** Profile이 선언한 마무리 항목. Core는 Profile을 모른다 — Surface가 꺼내 넘긴다. */
  closureChecklist?: readonly string[]
  closureLedger?: ClosureLedger
  /** 답을 기다리는 질의와 막힌 되던지기 (B-25). 사람이 보는 유일한 창구가 여기다. */
  queryLedger?: QueryLedger
  /** 아직 결정되지 않은 상신 (C-13). 사람이 결정해야 풀리는 것들이다. */
  escalationLedger?: EscalationLedger
  /**
   * 회수 주체 (C-10 §2.4). 모르면 `'controller'` 라는 익명 문자열이 History에 남는데,
   * 그건 감사 대상이 아니라 감사 공백이다 — 누가 거뒀는지 아는 쪽이 넘긴다.
   */
  reclaimedBy?: string
  /** 회수 사실을 증거로도 남긴다. archive 뒤에는 세션에서 복원할 수 없다. */
  auditLedger?: AuditLedger
}

/**
 * 지금 세션들을 훑어 Controller 상태를 다시 쓴다.
 * 요약하지 않는다 — 미결은 미결대로, 점유는 점유대로 남긴다.
 */
export async function collectSessions(
  store: StateStore,
  at: string,
  options: CollectOptions = {},
): Promise<CollectOutcome> {
  const sessions = await store.list('session')

  const active = sessions.filter((s) => s.status === 'ACTIVE' || s.status === 'PAUSED').map((s) => s.id)
  const finished = sessions.filter((s) => s.status === 'DONE')
  const blocked = sessions.filter((s) => s.status === 'BLOCKED' || s.status === 'FAILED')

  // 미결은 세션이 끝났다고 사라지지 않는다. 누가 판단해야 하는지 이름과 함께 남긴다.
  const awaiting: string[] = []
  for (const session of finished) {
    for (const item of session.handoff?.unresolved ?? []) awaiting.push(`${session.id}: ${item}`)
  }
  for (const session of blocked) awaiting.push(`${session.id}: ${session.status}`)

  // 프로젝트 마무리 의무. 세션은 회수되면 archive로 가지만 이 기록은 남아, 확인될 때까지
  // 매 회수에 계속 올라온다 — 한 번 보이고 사라지면 그게 B-20이 고치려는 문제다.
  const ledger = options.closureLedger
  if (ledger) {
    for (const session of finished) await ledger.open(session.id, options.closureChecklist ?? [])
    awaiting.push(...pendingLines(await ledger.pending()))
  }

  // 결정이 Agent 사이에서 멈춰 있거나 돌고 있었다는 사실. 세션 상태로는 드러나지 않는다 —
  // 답을 기다리는 쪽은 멀쩡히 ACTIVE이고, 막힌 되던지기는 세션 어디에도 남지 않는다.
  const queries = options.queryLedger
  if (queries) {
    awaiting.push(...queryLines(await queries.pending(), await queries.violations()))
    // 사람에게 넘긴 질의도 아직 끝난 것이 아니다 — 답이 쓰였다고 pending에서만 빼면
    // 상신은 어느 화면에도 뜨지 않는 write-only 로그가 된다.
    awaiting.push(...escalatedLines(await queries.escalated()))
  }

  // 아직 결정되지 않은 상신 (C-13). 무엇이 막혔고 무엇이 계속 가는지 함께 든다.
  const escalations = options.escalationLedger
  if (escalations) {
    for (const record of await escalations.pending()) {
      awaiting.push(
        `${record.escalationId} [${record.predicates.join(', ')}] ${record.question}` +
          ` — 막힘 ${record.blockedNodes.join(', ')}` +
          (record.stillRunnableNodes.length > 0 ? ` · 계속 ${record.stillRunnableNodes.join(', ')}` : ''),
      )
    }
  }

  // 멈춰 있는 세션이 무엇 때문에 멈췄다고 적었는지 (C-13 불변식 ⑤ — 표면화까지다).
  for (const session of sessions) {
    if (session.status !== 'PAUSED') continue
    for (const blocker of session.checkpoint?.blockers ?? []) {
      awaiting.push(`${session.id}: 진행 중 막힌 것 — ${blocker}`)
    }
  }

  // 병렬 세션이 같은 경로를 잡고 있는지 보이게 한다. 잠금은 걸지 않는다 —
  // 겹치게 발급하지 않는 것이 Controller의 몫이고, 이 표가 그 판단의 근거다 (OM §9).
  const occupancy = sessions
    .filter((s) => (s.status === 'ACTIVE' || s.status === 'PAUSED') && (s.writeBoundary?.length ?? 0) > 0)
    .map((s) => ({ sessionId: s.id, paths: s.writeBoundary ?? [] }))

  const state = await store.getControlState()
  await store.setControlState(state.version, {
    ...state,
    version: state.version + 1,
    activeSessions: active,
    ...(finished.at(-1) ? { recentHandoff: finished.at(-1)!.id } : {}),
    writeBoundaryOccupancy: occupancy,
    awaitingController: awaiting,
  })

  const reclaimedBy = options.reclaimedBy ?? 'controller'
  for (const session of finished) {
    await store.appendHistory({
      at,
      actor: reclaimedBy,
      kind: 'session_collected',
      ref: session.id,
      detail: session.handoff?.next ?? '',
    })
    // archive 직전이 실행 증거가 아직 살아 있는 마지막 순간이다 (C-10 §2.4).
    await options.auditLedger?.reclaim({
      sessionId: session.id,
      reclaimedBy,
      reclaimedAt: at,
      ...(session.handoff ? { handoffRef: session.handoff.recordedAt } : {}),
    })
    // 거둔 것은 보관소로 옮긴다. 옮기고 나면 목록에 나오지 않으므로 두 번째 회수가
    // 같은 세션을 다시 거두지 않는다 — 멱등을 따로 구현할 필요가 없다 (OM §7.4).
    await store.archive('session', session.id)
  }

  return { active, collected: finished.map((s) => s.id), awaiting, occupancy }
}

/** 사람이 읽는 회수 결과. 다음에 무엇을 할지가 맨 아래 오도록 짠다. */
export function renderCollect(outcome: CollectOutcome, sessions: readonly Session[]): string {
  const lines: string[] = []
  lines.push(`활성 세션: ${outcome.active.join(', ') || '없음'}`)

  if (outcome.occupancy.length > 0) {
    lines.push('', '쓰기 범위 점유:')
    for (const item of outcome.occupancy) lines.push(`  ${item.sessionId} → ${item.paths.join(', ')}`)
  }

  if (outcome.collected.length > 0) {
    lines.push('', '거둔 세션:')
    for (const id of outcome.collected) {
      const session = sessions.find((s) => s.id === id)
      lines.push(`  ${id} — ${session?.handoff?.next ?? '(다음 작업 없음)'}`)
      for (const done of session?.handoff?.done ?? []) lines.push(`    완료: ${done}`)
      if (session?.handoff?.verified) lines.push(`    검증: ${session.handoff.verified}`)
    }
  }

  if (outcome.awaiting.length > 0) {
    lines.push('', '판단이 필요한 것:')
    for (const item of outcome.awaiting) lines.push(`  - ${item}`)
  }

  return lines.join('\n')
}
