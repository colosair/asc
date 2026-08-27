// Presentation Port — 판단 요청을 사람에게 건네는 경계 (C-08 §1).
//
// `ApprovalChannel`(ports/approval.ts)과의 관계를 먼저 밝힌다:
//   ApprovalChannel  요청 **하나**를 보이고 갱신한다. 이미 있고, 그대로 쓴다
//   PresentationPort 요청 **묶음**을 건넨다. 이것이 여기서 새로 생기는 것이다
//
// 둘을 합치지 않는 이유: 묶음 전달을 제공하지만 그 자리에서 결정을 못 받는 채널이 있고
// (메일이 그렇다), 반대도 있다. 하나의 인터페이스로 묶으면 그런 채널이 전체를 구현하지
// 못하거나 빈 구현으로 거짓말을 하게 된다.
//
// 이 Port에는 결정 제출 표면이 없다 (C-08 §4). 묶고 보여주는 데까지이며, approve/dismiss는
// 사람의 명시적 의사표현을 받아 기존 결정 경로로만 간다.

import type { Priority } from '../core/model/entities.ts'
import type { DecisionSummary } from '../core/view/decision-view.ts'

/**
 * 채널 제품이 아니라 **할 수 있는 일**로 정의한다 (C-08 §1.1). 이름을 채널로 잡으면
 * 메신저가 아닌 전달 수단이 2급이 된다.
 */
export type PresentationCapability =
  /** 묶음을 보여줄 수 있다. */
  | 'presentation.digest'
  /** 급한 것을 눈에 띄게 전달할 수 있다. */
  | 'presentation.priority'
  /** 그 자리에서 사람의 결정을 받을 수 있다 (ApprovalChannel 쪽 표면). */
  | 'approval.interactive'

/** 묶음 한 덩어리. 무엇을 어떻게 그릴지는 adapter가 정한다. */
export type DigestBatch = {
  /** 이 묶음을 만든 시각. 사람이 "언제 것"인지 알아야 한다. */
  at: string
  /**
   * 우선순위 구간별 항목. 전부 **같은 request의 또 하나의 표현**이며 새 request가 아니다
   * (C-08 §3.1).
   */
  groups: readonly { priority: Priority; items: readonly DecisionSummary[] }[]
  /**
   * 보이지 않게 걸러진 것의 수. 숫자만 알려도 사람은 "무엇을 못 보고 있는지"를 안다 —
   * 0으로 감추면 걸러졌다는 사실 자체가 사라진다.
   */
  suppressed?: { shadow: number; alreadyDecided: number }
  /**
   * 빠른 경로가 아니라 회수 경로에서 발견된 항목 수. coverage에 대한 정보이며
   * 우선순위와 무관하다 (C-07 §1.6).
   */
  recovered?: number
}

export type DeliveryOutcome =
  | { ok: true; externalRef?: string }
  /** best-effort 실패. canonical state에 영향이 없어야 한다 (C-08 §1.3). */
  | { ok: false; error: string }

export interface PresentationPort {
  readonly id: string
  readonly capabilities: ReadonlySet<PresentationCapability>

  /** 묶음 전달. `presentation.digest`를 제공하는 adapter만 의미 있게 구현한다. */
  presentDigest(batch: DigestBatch): Promise<DeliveryOutcome>

  /**
   * 지금 끊어야 하는 한 건. `presentation.priority`가 없으면 호출자가 digest로 내린다 —
   * 조용히 무시하지 않고 degrade한다.
   *
   * 요약을 받는다. 더 필요하면 채널이 `requestId`로 다시 읽는다 — Core가 전체 view를
   * 만들어 넘기면 전달 한 번에 조사 한 번이 딸려 붙는다.
   */
  presentUrgent?(item: DecisionSummary): Promise<DeliveryOutcome>
}
