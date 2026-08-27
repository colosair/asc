// Renderer Port — Shared Decision View Model을 사람이 읽는 표현으로 바꾸는 경계.
// CLI·Messenger·Web UI가 같은 view를 각자의 방식으로 그리되, 필드의 의미와 request
// reference는 바꾸지 않는다 (C-01 §3).
//
// Approval Channel과 역할이 다르다: Channel은 전달과 결정 수신, Renderer는 표현 생성.
// 한 Adapter가 둘 다 구현할 수 있지만 계약은 분리해 둔다.

import type { DecisionSummary, DecisionView } from '../core/view/decision-view.ts'

/** 표현 밀도. 같은 view에서 채널 UX에 맞게 접거나 펼친다 (C-01 §3). */
export type RenderDensity =
  | 'summary' // MM 카드 — 핵심 + 버튼
  | 'full' // Local — 전체 보고서
  | 'collapsible' // Web — 전체 + 접이식

/**
 * 렌더 결과. Core는 내용물을 해석하지 않는다 — 문자열이든 채널별 블록 구조든
 * 그대로 Channel에 넘긴다.
 */
export type Rendered = { density: RenderDensity; text: string; blocks?: unknown }

export interface Renderer {
  readonly id: string // 'text' | 'mattermost-blocks' | 'html' ...

  /**
   * 상세 표현. reference는 어떤 density에서도 생략하지 않는다 — 사용자가 다른 채널에서
   * 같은 요청을 지목하는 유일한 수단이기 때문이다 (C-01 §2).
   * Stored Packet과 Current Context Overlay는 구분해 보여야 한다 (C-01 §6).
   */
  renderDecision(view: DecisionView, density: RenderDensity): Rendered

  /** 목록 표현. 복수 후보를 사람이 고를 수 있게 나열한다 (C-01 §11). */
  renderList(items: readonly DecisionSummary[]): Rendered
}
