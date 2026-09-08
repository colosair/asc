// Inbox reconciliation — 물음이 아직 서 있는지 원본에 물어본다 (0.8.4).
//
// 고친 것은 계약의 자기모순이다. `asc status` 는 `Waiting for a person: N` 이라 세고
// `asc inbox` 는 그것을 결정 대기 목록으로 보여 준다 — 그러면 그것은 **지금 사람이
// 결정해야 하는 것들**이라는 주장이다. 그런데 구현은 사건 스냅샷 보관함이었다:
// 요청이 만들어진 뒤 원본을 다시 보는 코드가 한 줄도 없었다. `transitionRequest` 의
// 호출자는 둘뿐이고(사람의 결정, 실행 결과) 둘 다 밖을 읽지 않는다.
//
// 실기계에서 이렇게 나왔다:
//
//   #122 가 닫힌 시각 17:22:58.235
//   그 이슈로 만들어진 REQ-0010 의 detectedAt 17:22:57.347
//   → 요청은 **태어날 때 이미 낡아 있었고** 17시간 뒤 사람이 손으로 치웠다
//
// 이 파일이 하는 일은 판정 하나뿐이다. 읽는 것도 쓰는 것도 호출자가 한다.
//
// 하지 않는 것:
//   - 사람의 결정을 추론하지 않는다. 닫혔다는 사실은 "안 하기로 했다" 가 아니다
//   - 이미 결정된 요청을 건드리지 않는다
//   - 읽지 못한 것을 최신으로 치지 않는다 — 못 읽었으면 못 읽었다고 답한다
//   - "같은 이슈면 하나" 로 접지 않는다. 한 스레드 안에 다른 물음이 설 수 있다

import type { ApprovalRequest, EventType, Priority } from '../model/entities.ts'
import type { ResourceSnapshot } from '../../ports/resource-context.ts'

/** 원본을 읽어 본 결과. **못 읽은 것을 값으로 만든다** — 그래야 화면이 거짓말을 안 한다. */
export type OriginObservation =
  | { kind: 'READ'; snapshot: ResourceSnapshot; at: string }
  /** 통로가 없거나 조회가 실패했다. 원본이 어떤 상태인지 우리는 모른다. */
  | { kind: 'UNREADABLE'; detail: string; at: string }

export type ReconcileVerdict =
  /** 그대로 둔다. 아직 사람의 결정을 기다린다. */
  | { kind: 'STANDS' }
  /** 물음이 사라졌다. 근거와 함께 OBSOLETE 로 옮긴다. */
  | { kind: 'OBSOLETE'; reason: 'ORIGIN_SETTLED'; evidence: string; observedAt: string }
  /**
   * 원본을 못 읽었다. **상태를 바꾸지 않는다** — 다만 화면이 "최신이다" 라고 말하지
   * 못하게 이 사실을 그대로 들고 간다.
   */
  | { kind: 'UNKNOWN'; detail: string }

/**
 * 이 요청이 아직 사람의 결정을 기다리는가.
 *
 * `settled` 하나만 본다. `missing` 으로는 옮기지 않는다 — 목록에서 사라졌다는 사실은
 * 삭제·권한·가시성·조회 오류 중 무엇인지 말해 주지 않고(engine 의 RESOURCE_MISSING 이
 * 같은 이유로 판정하지 않는다), 그 넷은 사람이 할 일이 전부 다르다.
 */
export function judgeReconcile(request: ApprovalRequest, origin: OriginObservation): ReconcileVerdict {
  // 이미 처분된 것은 다시 묻지 않는다. 사람이 낸 답 위에 관측을 덮지 않는다.
  if (request.status !== 'AWAITING_APPROVAL' && request.status !== 'DEFERRED') return { kind: 'STANDS' }

  if (origin.kind === 'UNREADABLE') return { kind: 'UNKNOWN', detail: origin.detail }

  const snapshot = origin.snapshot
  if (snapshot.missing) {
    return {
      kind: 'UNKNOWN',
      detail: `${snapshot.reference} 를 지금 읽을 수 없다 — 지워졌는지 권한이 없는지 조회가 실패한 것인지 모른다`,
    }
  }
  if (snapshot.settled !== true) return { kind: 'STANDS' }

  return {
    kind: 'OBSOLETE',
    reason: 'ORIGIN_SETTLED',
    evidence: `원본 ${snapshot.reference} 이 '${snapshot.state}' 로 끝나 있다 (updated ${snapshot.updatedAt}). 이 자리에서 결정할 것이 남아 있지 않다 — 작업이 끝났다는 뜻은 아니다.`,
    observedAt: origin.at,
  }
}

/**
 * 같은 사람 결정을 가리키는 키 (C-5).
 *
 * 세 가지를 잇는다. 하나라도 빼면 실패한다:
 *
 * ```text
 * reference   어느 자원에 대한 물음인가
 * type        어떤 성격의 물음인가 (actionable · work · informational)
 * signals     무엇이 나를 불렀는가 (호명 · 배정 · 리뷰 요청 …)
 * ```
 *
 * `reference` 만 쓰면 한 스레드의 서로 다른 물음이 하나로 뭉개진다 — 리뷰 요청과 호명은
 * 사람이 할 일이 다르다. `eventKey` 만 쓰면 같은 물음의 최신판이 매번 새 요청이 된다 —
 * 실기계에서 그렇게 #131 하나가 요청 둘이 됐고, 사람은 1.2초 간격으로 같은 처분을 두 번
 * 내렸다.
 *
 * **판본(revision)은 넣지 않는다.** 넣으면 답글 하나에 키가 갈려 dedup 이 다시 무의미해진다.
 * 최신판이 옛판을 대신하는 것이 이 키의 뜻이다.
 */
export function decisionSubject(input: {
  reference: string
  type: EventType
  signals?: readonly string[]
}): string {
  const signals = [...(input.signals ?? [])].sort().join(',')
  return `${input.reference}|${input.type}|${signals}`
}

/**
 * 새 요청이 옛 요청을 대신하는가.
 *
 * **더 새로운 것만 대신한다.** 회수 경로가 늦게 발견한 옛 사건이 이미 올라온 최신
 * 물음을 밀어내면, 사람이 보는 것이 뒤로 간다.
 */
export function supersedes(
  incoming: { subject?: string; detectedAt: string },
  existing: Pick<ApprovalRequest, 'id' | 'status' | 'detectedAt'> & { source: { subject?: string } },
): boolean {
  if (!incoming.subject || !existing.source.subject) return false
  if (incoming.subject !== existing.source.subject) return false
  if (existing.status !== 'AWAITING_APPROVAL' && existing.status !== 'DEFERRED') return false
  return new Date(incoming.detectedAt).getTime() > new Date(existing.detectedAt).getTime()
}

/** 사람이 읽는 한 줄. 상태와 근거를 같이 준다 — 상태만 주면 왜 사라졌는지 알 수 없다. */
export function obsoleteLine(request: ApprovalRequest): string | undefined {
  if (request.status !== 'OBSOLETE' || !request.obsolete) return undefined
  return request.obsolete.reason === 'SUPERSEDED'
    ? `결정 전에 대체됨 — ${request.obsolete.evidence}`
    : `결정 전에 물음이 사라짐 — ${request.obsolete.evidence}`
}

/** 이 우선순위·유형이 사람의 결정을 기다리는 상태인가. 화면 여러 곳이 같은 답을 써야 한다. */
export function awaitsPerson(status: ApprovalRequest['status']): boolean {
  return status === 'AWAITING_APPROVAL' || status === 'APPROVED' || status === 'QUEUED'
}

export type { Priority }
