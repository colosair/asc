// Approval Port — 승인 요청을 사람에게 보이고 사람의 결정을 돌려받는 경계.
// Core는 플랫폼 메시지 구조를 모른다 (OM §11.3). Messenger는 선택 구성요소이며,
// 채널이 하나도 없어도 Local 경로만으로 승인 lifecycle이 완결되어야 한다.
//
// 멀티채널은 여러 요청이 아니라 하나의 요청에 대한 여러 표현이다 (C-01 §7) —
// 모든 채널이 같은 requestId를 쓰고, 최초 유효 결정 이후의 입력은 CAS로 거절된다.

import type { ApprovalDecision } from '../core/model/entities.ts'
import type { DecisionView } from '../core/view/decision-view.ts'

/**
 * 채널이 지원하는 표현 수단 (OM §11.4). Profile은 원하는 UX만 선언하고, Adapter는
 * 지원하지 못하는 수단을 아래로 degrade한다:
 * rich → interactive → text → Local Inbox.
 */
export type ApprovalCapability =
  | 'interactive_actions'
  | 'rich_blocks'
  | 'dialogs'
  | 'ephemeral_feedback'
  | 'threads'
  | 'priority'
  | 'acknowledgement'
  | 'silent_notification'

/**
 * 채널에 표시한 결과. Core는 이 값을 해석하지 않고 그대로 Adapter에게 돌려준다 —
 * 외부 메시지 식별자(PresentationRecord)의 소유자는 Adapter다 (아래 주석 참조).
 */
export type PresentationOutcome =
  | { ok: true; externalRef?: string }
  /** best-effort 실패. canonical state에는 영향이 없어야 한다 (C-01 §9). */
  | { ok: false; error: string }

/**
 * PresentationRecord(request ↔ 외부 표시물 매핑) 소유 결정 — B-02에서 확정.
 *
 * **Adapter-owned metadata로 둔다. Core Logical Entity가 아니다.**
 * 근거:
 *  - Core가 채널별 매핑을 entity로 들면 채널이 늘 때마다 Core 스키마가 흔들린다.
 *    Core는 플랫폼을 몰라야 한다는 OM §11.3과 정면으로 어긋난다.
 *  - 매핑은 정본이 아니다 (C-01 §9). 정본 entity와 같은 저장·전이 규율을 줄 이유가 없다.
 *  - 표시 갱신은 best-effort다. 실패가 canonical state에 영향을 주지 않으려면 매핑이
 *    Core 전이 경로 밖에 있어야 한다.
 * 저장 위치: StateStore.scope(adapterId)의 격리 공간 (ports/state-store.ts).
 * Core가 하는 일은 상태가 바뀐 view를 채널들에 알리는 것까지이고, 어떤 메시지를
 * 고칠지는 각 Adapter가 자기 매핑을 보고 정한다.
 */
export interface ApprovalChannel {
  readonly id: string // 'local' | 'mattermost' | 'web' ...
  readonly capabilities: ReadonlySet<ApprovalCapability>

  /** 새 요청을 사람에게 보인다. */
  present(view: DecisionView): Promise<PresentationOutcome>

  /**
   * 상태가 바뀐 요청의 표현을 갱신한다 (다른 채널에서 결정됨 등).
   * 실패해도 Core는 진행한다 — 낡은 버튼 입력은 어차피 CAS가 거절한다.
   */
  update(view: DecisionView): Promise<PresentationOutcome>
}

/** 결정 제출 결과. 사람에게 무엇이 일어났는지 설명할 수 있을 만큼 구체적이어야 한다. */
export type DecisionOutcome =
  | { ok: true; view: DecisionView }
  /** 다른 채널·다른 시점에 이미 결정됐다 (C-01 §7 STALE / ALREADY_DECIDED). */
  | { ok: false; reason: 'ALREADY_DECIDED'; view: DecisionView }
  /** 읽은 뒤 요청이 바뀌었다 — 다시 읽고 판단해야 한다. */
  | { ok: false; reason: 'STALE'; view: DecisionView }
  /** 승인 권한자가 아니다 (OM §11.6). 시도 자체를 History에 남긴다. */
  | { ok: false; reason: 'FORBIDDEN_ACTOR' }
  | { ok: false; reason: 'NOT_ALLOWED_DECISION' }
  | { ok: false; reason: 'EXPIRED' }
  | { ok: false; reason: 'NOT_FOUND' }

/**
 * 채널이 Core로 결정을 밀어 넣는 입구. 방향이 중요하다 — Core가 채널을 폴링하지 않고,
 * 채널이 사람의 명시적 입력을 받았을 때만 호출한다.
 * Agent는 요청을 읽을 수 있지만 이 함수를 자기 판단으로 호출할 수 없다 (C-01 §5).
 */
export interface DecisionSink {
  submit(decision: ApprovalDecision): Promise<DecisionOutcome>
}

/**
 * 결정 actor가 실제 승인 권한자인지 확인한다 (OM §11.6).
 * Local이라는 이유로 무조건 신뢰하지 않는다 — Identity는 Credential이 아니며,
 * Token은 Secret Store에 남고 여기에는 오지 않는다.
 */
export interface IdentityBinding {
  /** channel에서 인증된 actor가 이 요청의 authorizedApprover와 같은 사람인가. */
  verify(input: { channel: string; actor: string; authorizedApprover: string }): Promise<boolean>
}
