// 텍스트 Renderer — 터미널과 로그에 쓰는 기본 표현.
//
// 지키는 것 둘 (C-01 §2·§6):
//   1. reference는 어떤 밀도에서도 첫 줄에 남는다. 다른 채널에서 같은 요청을 지목하는
//      유일한 수단이라 접기의 대상이 아니다.
//   2. 알림 당시 분석과 지금 다시 읽은 사실은 다른 제목 아래 놓는다. 한 문단에 섞으면
//      읽는 사람이 과거 판단을 현재 사실로 받아들인다.

import type { Rendered, RenderDensity, Renderer } from '../../ports/renderer.ts'
import type { DecisionSummary, DecisionView, Freshness } from '../../core/view/decision-view.ts'

/** 조회 시점에 무엇이 달라졌는지 한 줄로 알려준다 — 사용자가 먼저 읽어야 할 경고다. */
const FRESHNESS_NOTE: Record<Freshness, string> = {
  CURRENT: '알림 이후 달라진 것 없음',
  STALE_CONTEXT: '주의 — 알림 이후 작업 맥락이 바뀌었다',
  SOURCE_CHANGED: '주의 — 알림 이후 원본(스레드·정본)이 바뀌었다',
  ALREADY_DECIDED: '이미 결정된 요청이다',
}

/**
 * 원본을 확인하지 못한 채 얻은 "변화 없음"을 확인하고 얻은 것처럼 보이게 두지 않는다.
 * 무엇을 근거로 한 판단인지 밝히는 것이 판단 자체보다 중요할 때가 있다.
 */
function freshnessLine(view: DecisionView): string[] {
  const unverifiedSource = view.verification.source === 'UNAVAILABLE'
  const scope = unverifiedSource && view.freshness === 'CURRENT' ? ' (로컬 기준)' : ''
  const lines = [`상태: ${view.stored.status} (v${view.version})  ·  ${FRESHNESS_NOTE[view.freshness]}${scope}`]
  if (unverifiedSource) lines.push('원본 변경 여부 미확인 — 외부 연결 없음')
  if (view.verification.localContext === 'NOT_APPLICABLE') {
    lines.push('현재 작업과의 관계 판단 불가 — 요청이 영향 세션을 지목하지 않았다')
  }
  return lines
}

export class TextRenderer implements Renderer {
  readonly id = 'text'

  renderDecision(view: DecisionView, density: RenderDensity): Rendered {
    const lines: string[] = [view.reference, view.stored.title, '']

    lines.push(...freshnessLine(view))
    if (view.decided) {
      lines.push(`결정: ${view.decided.kind} — ${view.decided.actor} (${view.decided.channel}) ${view.decided.decidedAt}`)
      if (view.resultRef) lines.push(`결과: ${view.resultRef}`)
    }

    if (density === 'summary') {
      lines.push('', `선택: ${view.allowedDecisions.join(' / ')}`)
      return { density, text: lines.join('\n') }
    }

    lines.push('', '[알림 당시 분석]', `감지: ${view.stored.detectedAt} · ${view.stored.source}`, view.stored.situation)
    if (view.stored.context) lines.push('', `맥락: ${view.stored.context}`)
    lines.push(
      '',
      `작업 중단 필요: ${view.stored.interruptRequired ? 'Yes' : 'No'}`,
      `기준 세션: ${view.stored.affectedSessions.join(', ') || '없음'}`,
    )
    if (view.stored.rationale) lines.push(`판단 근거: ${view.stored.rationale}`)
    if (view.stored.snapshot.length > 0) {
      lines.push('스냅샷: ' + view.stored.snapshot.map((s) => `${s.sourceId} @ ${s.baseline}`).join(' · '))
    }
    if (view.stored.recommendation) lines.push('', `권장 대응: ${view.stored.recommendation}`)
    if (view.stored.draft) lines.push('', '[답변 초안]', view.stored.draft)

    if (view.current) {
      lines.push(
        '',
        '[현재 작업 기준]',
        `관측: ${view.current.observedAt}`,
        `활성 세션: ${view.current.activeSessions.join(', ') || '없음'}`,
        `영향: ${view.current.affectsCurrentWork ? '있음' : '없음'}`,
      )
      for (const change of view.current.canonicalChanges) {
        lines.push(`정본 변경: ${change.sourceId} ${change.before ?? '(기록 없음)'} → ${change.after}`)
      }
      for (const note of view.current.notes) lines.push(`· ${note}`)
    }

    lines.push('', `승인 권한자: ${view.authorizedApprover}`, `선택: ${view.allowedDecisions.join(' / ')}`)
    if (view.expiresAt) lines.push(`만료: ${view.expiresAt}`)
    return { density, text: lines.join('\n') }
  }

  renderList(items: readonly DecisionSummary[]): Rendered {
    if (items.length === 0) return { density: 'summary', text: '대기 중인 요청 없음' }
    const text = items
      .map((i) => {
        const stale = i.freshness === 'CURRENT' ? '' : `  [${i.freshness}]`
        return `${i.requestId}  ${i.priority}  ${i.status}  ${i.title}${stale}\n         ${i.reference}`
      })
      .join('\n')
    return { density: 'summary', text }
  }
}
