// SCM / Issue Provider Port — 외부 협업 시스템(GitHub 등)의 읽기와, 승인된 단일 Action의
// 실행. Core에는 provider 이름이 들어가지 않는다 (OM §12.4).
//
// 쓰기는 이 Port를 통해서만, 그리고 ExecutionGrant를 쥔 Executor를 통해서만 일어난다
// (OM §11.5). Monitor는 이 Port의 읽기만 쓴다.

import type { CanonicalSnapshot } from '../core/model/entities.ts'
import type { RemoteFacts } from '../core/execution/remote-review.ts'

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

  /**
   * 이 통로가 그 행위를 수행할 수 있는가.
   *
   * 발급 시점에 묻기 위한 것이다. 예전에는 아무 action 으로나 Grant 가 발급됐고, 사람이
   * 승인한 **뒤에** 실행에서 "unsupported" 가 나왔다 — 승인의 의미가 그 자리에서 무너진다.
   * 두지 않아도 되며, 그때는 호출자가 확인하지 못했다는 사실을 그대로 다룬다.
   */
  supports?(action: string): boolean

  getThread(reference: string): Promise<ThreadSnapshot>
  getBaselines(queries: readonly BaselineQuery[]): Promise<CanonicalSnapshot[]>

  /**
   * 이 행위를 하기 전에 밖에서 읽히는 사실 (0.8.0 §D). **mutation 0** 이다.
   *
   * 판정은 하지 않는다 — 본 것을 그대로 돌려주고, 판정은 Core 의 Remote Review 가 한다.
   * 그래야 사람이 보는 검수와 Agent 가 따르는 검수가 같은 판정이 된다.
   */
  review?(action: ExternalAction): Promise<RemoteFacts>

  /**
   * 행위 뒤의 되돌려 읽기 (0.8.0 §L·§M·§N). **mutation 0** 이다.
   *
   * 명령이 0 으로 끝났다는 것과 밖에 그것이 있다는 것은 다르다. 여기서 읽은 사실이
   * 기대치와 다르면 호출자는 성공이라고 적지 않는다.
   */
  verify?(action: ExternalAction, result: { resultRef: string }): Promise<{
    observed: Record<string, string | undefined>
    /** 이 통로가 이 행위의 되돌림을 지원하지 않으면 그 사실을 그대로 말한다. */
    unsupported?: boolean
  }>

  /**
   * 외부 쓰기. Grant를 검증하고 Drift Guard를 통과시킨 Executor만 호출한다 —
   * Port 자체는 권한을 판단하지 않으므로, 호출 지점이 좁게 유지되는 것이 계약이다.
   */
  execute(action: ExternalAction): Promise<ExternalActionResult>
}
