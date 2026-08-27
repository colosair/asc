// SCM / Issue Provider Port — 외부 협업 시스템(GitHub 등)의 읽기와, 승인된 단일 Action의
// 실행. Core에는 provider 이름이 들어가지 않는다 (OM §12.4).
//
// 쓰기는 이 Port를 통해서만, 그리고 ExecutionGrant를 쥔 Executor를 통해서만 일어난다
// (OM §11.5). Monitor는 이 Port의 읽기만 쓴다.

import type { CanonicalSnapshot } from '../core/model/entities.ts'

/** 스레드(Issue/PR/Review 등) 하나의 현재 상태. Drift Guard가 대조하는 값이다. */
export type ThreadSnapshot = {
  reference: string // 'owner/repo#19'
  lastEventId: string
  /** 스레드가 사라졌거나 접근 불가 — 실행 중단 사유가 된다. */
  missing?: boolean
}

/** canonical source의 현재 baseline. multi-source이므로 source별로 조회한다 (OM §8). */
export type BaselineQuery = { sourceId: string; ref?: string; paths?: readonly string[] }

/**
 * Grant가 지시하는 단일 외부 Action. Executor는 payload를 재작성하지 않는다 —
 * 사람이 승인한 내용 그대로 나간다.
 */
export type ExternalAction = {
  action: string // 'github.issue_comment.create'
  target: string // 'owner/repo#19'
  payload: string
}

export type ExternalActionResult =
  | { ok: true; resultRef: string } // 게시물 URL 등 — Grant.resultRef가 된다
  | { ok: false; error: string }

export interface ScmPort {
  readonly id: string // 'github' | 'gitlab' ...

  getThread(reference: string): Promise<ThreadSnapshot>
  getBaselines(queries: readonly BaselineQuery[]): Promise<CanonicalSnapshot[]>

  /**
   * 외부 쓰기. Grant를 검증하고 Drift Guard를 통과시킨 Executor만 호출한다 —
   * Port 자체는 권한을 판단하지 않으므로, 호출 지점이 좁게 유지되는 것이 계약이다.
   */
  execute(action: ExternalAction): Promise<ExternalActionResult>
}
