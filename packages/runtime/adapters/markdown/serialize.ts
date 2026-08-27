// entity ↔ 파일 내용.
//
// 한 파일이 두 독자를 섬긴다: 기계는 HTML 주석 안의 JSON 블록을 읽고, 사람은 그 아래
// Markdown 본문을 읽는다. 정본은 JSON 쪽이고 본문은 매번 다시 그려지는 projection이다 —
// 사람이 본문만 고쳐 봐야 다음 저장에서 덮인다는 뜻이고, 그래서 본문을 정본으로
// 삼으려는 유혹이 애초에 생기지 않는다.
//
// 왕복 무손실은 JSON 블록이 보장한다. 본문 렌더링이 아무리 성기어도 데이터는 잃지 않는다.

import type { EntityKind, EntityMap } from '../../ports/state-store.ts'

const OPEN = '<!-- asc:entity'
const CLOSE = '-->'

export class ParseError extends Error {
  file: string
  constructor(file: string, detail: string) {
    super(`${file}: ${detail}`)
    this.file = file
    this.name = 'ParseError'
  }
}

export function serializeEntity<K extends EntityKind>(kind: K, entity: EntityMap[K]): string {
  const json = JSON.stringify(entity, null, 2)
  return `${OPEN}\n${json}\n${CLOSE}\n\n${renderBody(kind, entity)}\n`
}

export function parseEntity(text: string, file = '<memory>'): unknown {
  const start = text.indexOf(OPEN)
  if (start === -1) throw new ParseError(file, 'missing asc:entity block')
  const end = text.indexOf(CLOSE, start + OPEN.length)
  if (end === -1) throw new ParseError(file, 'unterminated asc:entity block')

  const json = text.slice(start + OPEN.length, end).trim()
  try {
    return JSON.parse(json)
  } catch (error) {
    throw new ParseError(file, `invalid JSON — ${(error as Error).message}`)
  }
}

// ── 사람이 읽는 본문 ────────────────────────────────────────────────────────
// 상태를 눈으로 좇을 수 있을 만큼만 그린다. 완전한 표현은 Renderer Port의 몫이다.

function renderBody<K extends EntityKind>(kind: K, entity: EntityMap[K]): string {
  const lines: string[] = []
  switch (kind) {
    case 'session': {
      const s = entity as EntityMap['session']
      lines.push(`# ${s.id} — ${s.role}`, '', `Status: ${s.status} (v${s.version})`, `Goal: ${s.goal}`)
      if (s.owner) lines.push(`Owner: ${s.owner}`)
      if (s.writeBoundary?.length) lines.push(`Write Boundary: ${s.writeBoundary.join(', ')}`)
      for (const domain of s.decisionDomains ?? []) {
        lines.push(`Decision: ${domain} → ${s.decisionAuthority?.[domain] ?? '(Profile ownership)'}`)
      }
      if (s.dependencies?.length) lines.push(`Dependency: ${s.dependencies.join(', ')}`)
      if (s.policyExceptions?.length) lines.push(`Policy Exception: ${s.policyExceptions.join(', ')}`)
      if (s.doneCriteria.length > 0) {
        lines.push('', '## Done Criteria', ...s.doneCriteria.map((c) => `- ${c}`))
      }
      if (s.checkpoint) lines.push('', '## CHECKPOINT', s.checkpoint.position, `다음: ${s.checkpoint.nextAction}`)
      if (s.handoff) {
        lines.push('', '## HANDOFF', `DONE: ${s.handoff.done.join(', ')}`, `NEXT: ${s.handoff.next}`)
        if (s.handoff.unresolved?.length) lines.push(`UNRESOLVED: ${s.handoff.unresolved.join(' / ')}`)
      }
      break
    }
    case 'request': {
      const r = entity as EntityMap['request']
      lines.push(
        `# ${r.id} · ${r.priority} · ${r.source.reference}`,
        '',
        `Status: ${r.status} (v${r.version})`,
        `Detected: ${r.detectedAt}`,
        '',
        '## 상황',
        r.situation,
      )
      if (r.draft) lines.push('', '## 답변 초안', r.draft)
      if (r.snapshot?.length) {
        lines.push('', '## 정본 스냅샷', ...r.snapshot.map((s) => `- ${s.sourceId} @ ${s.baseline}`))
      }
      if (r.decision) lines.push('', '## 처리 기록', `${r.decision.kind} — ${r.decision.actor} (${r.decision.channel})`)
      break
    }
    case 'grant': {
      const g = entity as EntityMap['grant']
      lines.push(
        `# ${g.id} — ${g.action}`,
        '',
        `Status: ${g.status} (v${g.version})`,
        `Target: ${g.target}`,
        `Request: ${g.requestId}`,
        `Expires: ${g.expiresAt}`,
      )
      if (g.resultRef) lines.push(`Result: ${g.resultRef}`)
      break
    }
    case 'queueItem': {
      const q = entity as EntityMap['queueItem']
      lines.push(`# ${q.id} — ${q.title}`, '', `State: ${q.state} (v${q.version})`)
      if (q.sessionId) lines.push(`Session: ${q.sessionId}`)
      break
    }
    case 'event': {
      const e = entity as EntityMap['event']
      lines.push(
        `# ${e.eventKey}`,
        '',
        `${e.type} · ${e.suggestedPriority} · ${e.processing} (v${e.version})`,
        `Detected: ${e.detectedAt}`,
        `Inbox 후보: ${e.inboxCandidate ? 'yes' : 'no'}`,
      )
      break
    }
  }
  return lines.join('\n')
}

/** 현재 판단 대기 목록. 원본에서 언제든 다시 만들 수 있는 Derived View다 (OM §7.3). */
export function renderInboxView(requests: readonly EntityMap['request'][]): string {
  const pending = requests.filter((r) => r.status === 'AWAITING_APPROVAL' || r.status === 'APPROVED')
  const lines = [
    '<!-- asc:view — 자동 생성물. 직접 고치지 마세요. -->',
    '',
    '# Inbox — 판단 대기',
    '',
    pending.length === 0 ? '_대기 중인 요청 없음_' : '| Request | 우선순위 | 상태 | 감지 | 제목 |',
  ]
  if (pending.length > 0) {
    lines.push('|---|---|---|---|---|')
    for (const r of [...pending].sort((a, b) => a.detectedAt.localeCompare(b.detectedAt))) {
      lines.push(`| ${r.id} | ${r.priority} | ${r.status} | ${r.detectedAt} | ${r.title} |`)
    }
  }
  return lines.join('\n') + '\n'
}
