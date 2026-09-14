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
 * ASC 가 의미를 알고 관리 실행 대상으로 다루는 canonical action vocabulary.
 *
 * `supports()` 는 술어라 "무엇을 할 수 있나" 를 물을 수 없다. 물으려면 후보 목록이
 * 있어야 하고, 그 목록은 한 곳이어야 한다 — adapter 마다 두면 아무도 안 읽는 사본이
 * 는다 (`GITLAB_ACTIONS` 가 그렇게 됐다: import 하는 곳이 테스트 하나뿐이다).
 *
 * **여기 없는 외부 행위가 있을 수 있다.** 이 목록은 "외부 쓰기 전부" 가 아니라 그중
 * ASC 가 관리 실행으로 다루는 것이다. 셸에서 가능한 것 전부를 세지 않는다 — `gh api` 처럼
 * 한 행위로 환원되지 않는 명령은 ASC 가 관리하지 않는다.
 */
export const MANAGED_EXTERNAL_ACTIONS = [
  'git.push',
  'coordination.publish',
  'gitlab.mr.create',
  'gitlab.mr.merge',
  'gitlab.note.create',
  'gitlab.issue.update',
  'github.issue_comment.create',
] as const

export type ManagedExternalAction = (typeof MANAGED_EXTERNAL_ACTIONS)[number]

/**
 * 행위마다 본문(payload)이 무엇인가 (0.10.0 P1).
 *
 *   required   사람이 준 내용이 그대로 나간다 — 없으면 발급하지 않는다
 *   optional   있으면 싣고 없어도 성립한다
 *   forbidden  이 행위에는 본문이 없다 — 주면 무엇이 나가는지 아무도 모르므로 거절한다
 *
 * `git.push` 가 forbidden 인 이유: 나가는 것은 commit 이지 글이 아니다. 그런데 0.9.1 까지는
 * 모든 행위가 본문을 요구해 사람이 더미 한 줄을 지어 넣어야 했다 (dogfood 2026-09-13 N4).
 * 표가 여기 있는 이유는 행위 목록이 여기 있기 때문이다 — Core 는 이 표를 읽지 않고
 * `payloadRequired` 라는 사실만 입력으로 받는다.
 */
export type PayloadContract = 'required' | 'optional' | 'forbidden'

export const ACTION_PAYLOAD: Readonly<Record<ManagedExternalAction, PayloadContract>> = {
  'git.push': 'forbidden',
  'coordination.publish': 'required',
  'gitlab.mr.create': 'required',
  'gitlab.mr.merge': 'optional',
  'gitlab.note.create': 'required',
  'gitlab.issue.update': 'required',
  'github.issue_comment.create': 'required',
}

/** 모르는 행위는 required 다 — 본문 없이 나가는 것을 기본값으로 두지 않는다. */
export function payloadContractOf(action: string): PayloadContract {
  return (ACTION_PAYLOAD as Record<string, PayloadContract>)[action] ?? 'required'
}

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
   * 이 행위를 **되돌려 읽을 수 있는가** (0.8.0 보정 P1-2).
   *
   * 읽어 확인할 수 없는 쓰기를 자율 실행 가능한 것으로 광고하지 않기 위한 질문이다.
   * 답하지 않는 통로는 "모른다" 이고, 그때 호출자는 확인했다고 적지 않는다.
   */
  verifies?(action: string): boolean

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
