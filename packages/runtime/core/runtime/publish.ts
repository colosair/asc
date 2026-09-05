// Publish — 밖에 하나를 만들되, 두 번 만들지 않는다.
//
// 실 프로젝트에서 이런 일이 있었다:
//
//   생성 요청 → 원격에 실제로 생성됨 → 돌아온 주소 모양이 예상과 다름
//   → 실패로 판정 → 다시 생성 → 같은 것이 둘
//
// 원인은 재시도가 아니라 **성공의 정본이 주소였다**는 것이다. 주소는 사람이 여는 값이고
// 시스템마다 모양이 다르며 바뀌기도 한다. 그것으로 존재를 판정하면 존재하지 않는 실패가
// 만들어진다.
//
// 그래서 순서를 고정한다:
//
//   찾는다 → 정한다 → (필요하면) 만든다 → 되읽는다 → 증거를 남긴다
//
// 그리고 세 판정 중 하나로만 끝난다:
//
//   ATTACH_EXISTING   이미 있다. 만들지 않는다
//   CREATE_NEW        없다. 만든다
//   AMBIGUOUS         모르겠다. **만들지 않는다**
//
// 모호할 때 만드는 것이 중복을 만든다. 제목이 비슷하다는 것은 근거가 아니다 — 안정적인
// 관계 근거가 없으면 모르는 것이 맞고, 그 판단은 사람이 한다.

import type {
  CoordinationSurfacePort,
  PublicPayload,
  SurfaceCandidate,
  SurfaceQuery,
} from '../../ports/coordination-surface.ts'
import type { CoordinationLedger, CommunicationEvidence, RemoteIdentity } from './coordination.ts'

/**
 * 게시 의도. **내부와 공개를 처음부터 다른 필드로 든다** (F4).
 *
 * 한 문자열에 담았다가 나중에 가르는 경로는 여기 없다. `internal` 은 이 타입 밖으로
 * 나가지 않으며, Port 가 받는 것은 `publicPayload` 뿐이다.
 */
export type PublishIntent = {
  /** 어느 기대에 대한 게시인가. */
  queryId: string
  /** 밖으로 나가는 내용 전부. */
  publicPayload: PublicPayload
  /** 상관 관계·근거 출처·라우팅·사적 메모. **경계를 넘지 않는다.** */
  internal?: Record<string, unknown>
  /** 누구에게 닿아야 하는가. 프로젝트 정책이 정한다. */
  audience?: readonly string[]
  /** 이미 아는 게시물. 있으면 찾기의 첫 근거가 된다. */
  known?: readonly Pick<RemoteIdentity, 'objectType' | 'objectId'>[]
  /** 관련 작업 항목. adapter 어휘 그대로. */
  workReference?: string
}

export type PublishDecision =
  | { verdict: 'ATTACH_EXISTING'; candidate: SurfaceCandidate; why: string }
  | { verdict: 'CREATE_NEW'; why: string }
  | { verdict: 'AMBIGUOUS'; candidates: SurfaceCandidate[]; why: string }

/**
 * 찾은 것들을 보고 무엇을 할지 정한다. **밖을 치지 않는다** — 판정만 한다.
 *
 * 강한 근거(이미 아는 신원 · 우리가 심은 상관 관계)가 정확히 하나면 그것에 붙는다.
 * 강한 근거가 여럿이면 고르지 않는다. 약한 근거뿐이면 그것으로 붙지 않고, 그렇다고
 * 새로 만들지도 않는다 — 같은 것이 이미 있을 수 있기 때문이다.
 */
export function decidePublish(candidates: readonly SurfaceCandidate[]): PublishDecision {
  const strong = candidates.filter(
    (candidate) => candidate.matchedBy === 'known-identity' || candidate.matchedBy === 'correlation',
  )
  if (strong.length === 1) {
    return {
      verdict: 'ATTACH_EXISTING',
      candidate: strong[0]!,
      why: `이미 있다 (${strong[0]!.matchedBy})`,
    }
  }
  if (strong.length > 1) {
    return {
      verdict: 'AMBIGUOUS',
      candidates: strong,
      why: `강한 근거를 가진 후보가 ${strong.length}개다 — 고르지 않는다`,
    }
  }

  const weak = candidates.filter(
    (candidate) => candidate.matchedBy === 'work-reference' || candidate.matchedBy === 'weak',
  )
  if (weak.length > 0) {
    // 제목이나 작업 항목이 겹친다는 것은 같은 조율이라는 뜻이 아니다. 붙이지도, 만들지도
    // 않는다 — 여기서 만들면 중복이 나고, 붙이면 남의 스레드에 끼어든다.
    return {
      verdict: 'AMBIGUOUS',
      candidates: weak,
      why: `약한 근거만 있다 (${weak.map((candidate) => candidate.matchedBy).join(', ')}) — 사람이 정한다`,
    }
  }

  return { verdict: 'CREATE_NEW', why: '후보 없음' }
}

export type PublishOutcome =
  /** 새로 만들었고, 되읽어 확인했다. */
  | { ok: true; action: 'CREATED'; identity: RemoteIdentity; evidence: Omit<CommunicationEvidence, 'evidenceId' | 'observedAt'> }
  /** 이미 있던 것에 붙였다. 아무것도 만들지 않았다. */
  | { ok: true; action: 'ATTACHED'; identity: RemoteIdentity; evidence: Omit<CommunicationEvidence, 'evidenceId' | 'observedAt'> }
  /** 사람이 정해야 한다. **만들지 않았다.** */
  | { ok: false; reason: 'AMBIGUOUS'; candidates: SurfaceCandidate[]; detail: string }
  /** 찾지 못했다 — 없는 것과 다르다. 이 상태에서 만들지 않는다. */
  | { ok: false; reason: 'DISCOVERY_FAILED'; detail: string }
  /** 만들었다는데 되읽히지 않는다. 다시 만들지 않는다. */
  | { ok: false; reason: 'NOT_VERIFIED'; identity: RemoteIdentity; detail: string }
  | { ok: false; reason: 'CREATE_FAILED'; detail: string }

export type PublishDeps = {
  surface: CoordinationSurfacePort
  /** 이 binding 이 어떤 역할로 쓰이는가 (C-09). provider 이름이 아니다. */
  bindingRole?: string
  now?: () => string
}

/**
 * 한 번 게시한다.
 *
 * **되읽기가 성공의 정본이다.** 만들기가 예외 없이 끝났다는 것만으로 끝내지 않는다 —
 * 그 반대(만들어졌는데 응답을 잃음)가 실제로 일어났고, 그때 다시 만들면 중복이 된다.
 * 되읽히지 않으면 실패로 적되 **다시 만들지 않는다**: 다음 회차가 찾기부터 다시 한다.
 */
export async function publishOnce(intent: PublishIntent, deps: PublishDeps): Promise<PublishOutcome> {
  const now = deps.now ?? (() => new Date().toISOString())
  const query: SurfaceQuery = {
    correlation: intent.queryId,
    ...(intent.workReference ? { workReference: intent.workReference } : {}),
    ...(intent.known ? { known: intent.known } : {}),
  }

  let candidates: SurfaceCandidate[]
  try {
    candidates = await deps.surface.find(query)
  } catch (error) {
    // 못 찾은 것을 "없다"로 읽으면 그 자리에서 중복이 난다.
    return { ok: false, reason: 'DISCOVERY_FAILED', detail: String(error) }
  }

  const decision = decidePublish(candidates)
  if (decision.verdict === 'AMBIGUOUS') {
    return { ok: false, reason: 'AMBIGUOUS', candidates: decision.candidates, detail: decision.why }
  }

  const evidenceFor = (identity: RemoteIdentity, source: string): Omit<CommunicationEvidence, 'evidenceId' | 'observedAt'> => ({
    queryId: intent.queryId,
    ...(deps.bindingRole ? { bindingRole: deps.bindingRole } : {}),
    identity,
    audience: [...(intent.audience ?? [])],
    publishedAt: now(),
    evidenceSource: source,
  })

  if (decision.verdict === 'ATTACH_EXISTING') {
    return {
      ok: true,
      action: 'ATTACHED',
      identity: decision.candidate.identity,
      evidence: evidenceFor(decision.candidate.identity, 'surface-discovered'),
    }
  }

  let created: RemoteIdentity
  try {
    // **공개될 것만 넘어간다.** `intent.internal` 은 이 호출에 닿지 않는다 (F4).
    created = await deps.surface.create(intent.publicPayload, query)
  } catch (error) {
    return { ok: false, reason: 'CREATE_FAILED', detail: String(error) }
  }

  const snapshot = await deps.surface.read(created).catch(() => null)
  if (!snapshot) {
    return {
      ok: false,
      reason: 'NOT_VERIFIED',
      identity: created,
      detail: '만들었다고 했는데 되읽히지 않는다 — 다시 만들지 않는다. 다음 회차가 찾기부터 다시 한다.',
    }
  }

  return {
    ok: true,
    action: 'CREATED',
    identity: snapshot.identity,
    evidence: evidenceFor(snapshot.identity, 'surface-read-back'),
  }
}

/**
 * 게시 사실을 원장에 남긴다.
 *
 * `evidenceId` 를 **신원에서 만든다** — 같은 게시물을 다시 봐도 같은 id 가 나오고,
 * 원장은 append-only 이므로 두 번째 기록은 조용히 거절된다 (F3). 무작위 id 를 쓰면
 * 재시도할 때마다 같은 게시가 새 사실로 쌓인다.
 */
export async function recordPublication(
  ledger: CoordinationLedger,
  outcome: Extract<PublishOutcome, { ok: true }>,
): Promise<Awaited<ReturnType<CoordinationLedger['publishRecorded']>>> {
  const { identity } = outcome
  const evidenceId = `${outcome.evidence.queryId}:${identity.adapter}:${identity.objectType}:${identity.objectId}`
  return ledger.publishRecorded({ ...outcome.evidence, evidenceId })
}

/** 사람이 읽는 한 줄. 무엇을 했는지·무엇이 남았는지가 여기 있어야 한다. */
export function publishLine(outcome: PublishOutcome): string {
  if (outcome.ok) {
    const at = outcome.identity.locator ?? `${outcome.identity.objectType}:${outcome.identity.objectId}`
    return outcome.action === 'CREATED' ? `published — ${at}` : `already there, attached — ${at}`
  }
  switch (outcome.reason) {
    case 'AMBIGUOUS':
      return `not published — ${outcome.detail}. ${outcome.candidates.length} candidate(s); a person picks one.`
    case 'DISCOVERY_FAILED':
      return `not published — could not look for an existing one (${outcome.detail}). Nothing was created.`
    case 'NOT_VERIFIED':
      return `created but not verified — ${outcome.detail}`
    case 'CREATE_FAILED':
      return `not published — ${outcome.detail}`
  }
}
