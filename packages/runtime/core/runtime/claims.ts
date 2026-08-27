// Claim Provenance — 사실과 추론을 갈라 적고, 뒤집혀도 지우지 않는다 (C-10 §6).
//
// 실전에서 반복된 사고가 이것이다: 어느 시점에 "A가 B를 막고 있다"고 판단했고, 나중에
// 그게 아니었음이 드러났는데, 그 사이의 기록이 통째로 다시 쓰여 **언제 무엇을 근거로
// 그렇게 봤는지가 사라졌다.** 그러면 같은 오판을 또 한다.
//
// 그래서 둘을 나눈다:
//
//   History        당시 판단을 그대로 보존한다. append-only
//   Current View   STALE을 뺀 최신 claim의 projection. 저장하지 않는다
//
// **추론을 정본으로 자동 승격하지 않는다** (C-10 불변식 ⑬). INFERRED는 INFERRED로 남고,
// CONFIRMED가 되려면 실측이 따로 있어야 한다.

import { z } from 'zod'

import type { ScopedStore } from '../../ports/state-store.ts'

/**
 * 이 진술을 무엇으로 보는가 (C-10 §6).
 *
 *   CONFIRMED  실측했다
 *   INFERRED   근거로부터 추론했다
 *   PENDING    확인이 필요하다
 *   STALE      나중 증거가 뒤집었다
 */
export const ClaimStatus = z.enum(['CONFIRMED', 'INFERRED', 'PENDING', 'STALE'])
export type ClaimStatus = z.infer<typeof ClaimStatus>

/** id 문법. 파일명 변환이 단사가 아니라 자유 문자열을 그대로 키에 넣지 않는다. */
export const CLAIM_ID = /^[A-Za-z0-9._-]+$/

export const Claim = z.object({
  claimId: z.string().regex(CLAIM_ID),
  /** 무엇을 주장하는가. 한 문장이어야 뒤집을 때 무엇이 뒤집혔는지 분명하다. */
  statement: z.string().min(1),
  status: ClaimStatus,
  /** 어디서 왔는가 — 명령·문서·사람. 없으면 근거 없는 주장이다. */
  evidenceRefs: z.array(z.string()).default([]),
  observedAt: z.string().min(1),
  /** 이 claim이 대체한 것. */
  supersedes: z.string().optional(),
  /** 이 claim을 대체한 것. **기록에 남기되 원본은 지우지 않는다.** */
  supersededBy: z.string().optional(),
  /** 왜 뒤집혔는가. STALE인데 이유가 없으면 다음 사람이 같은 판단을 또 한다. */
  supersededReason: z.string().optional(),
})
export type Claim = z.infer<typeof Claim>

export type RecordOutcome =
  | { ok: true; claim: Claim }
  | { ok: false; reason: 'DUPLICATE_ID'; detail: string }
  | { ok: false; reason: 'INVALID_ID'; detail: string }

export type SupersedeOutcome =
  | { ok: true; stale: Claim; current: Claim }
  | { ok: false; reason: 'NOT_FOUND' | 'ALREADY_STALE'; detail: string }

const claimKey = (id: string) => `claim:${id}`
const stalePrefix = 'claim-stale:'
/** 뒤집힘 마커. 원본을 고치지 않고 따로 append한다 — Closure Ledger와 같은 형태다. */
const staleKey = (id: string) => `${stalePrefix}${id}`
const CLAIM_PREFIX = 'claim:'

export class ClaimLedger {
  #scope: ScopedStore
  #now: () => string

  constructor(scope: ScopedStore, now: () => string = () => new Date().toISOString()) {
    this.#scope = scope
    this.#now = now
  }

  /**
   * 새 판단을 적는다. **같은 id를 덮어쓰지 않는다** — 덮어쓰면 그게 곧 "다시 쓰기"이고,
   * 이 모듈이 막으려는 것이 정확히 그것이다.
   */
  async record(input: {
    claimId: string
    statement: string
    status: ClaimStatus
    evidenceRefs?: readonly string[]
    observedAt?: string
    supersedes?: string
  }): Promise<RecordOutcome> {
    if (!CLAIM_ID.test(input.claimId)) {
      return { ok: false, reason: 'INVALID_ID', detail: `claim id 형식이 아니다: '${input.claimId}'` }
    }
    const claim = Claim.parse({
      claimId: input.claimId,
      statement: input.statement,
      status: input.status,
      evidenceRefs: input.evidenceRefs ?? [],
      observedAt: input.observedAt ?? this.#now(),
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    })
    if (await this.#scope.setIfAbsent(claimKey(claim.claimId), JSON.stringify(claim))) {
      return { ok: true, claim }
    }
    return { ok: false, reason: 'DUPLICATE_ID', detail: `${claim.claimId} 는 이미 있다 — 새 id로 적으라` }
  }

  /**
   * 새 증거가 옛 판단을 뒤집었다.
   *
   * **옛 claim을 지우지도 고치지도 않는다.** 뒤집힘 마커를 따로 남기고, 읽을 때 합친다.
   * 그래야 "그때는 왜 그렇게 봤는가"가 남는다.
   */
  async supersede(input: {
    staleId: string
    replacement: { claimId: string; statement: string; status: ClaimStatus; evidenceRefs?: readonly string[] }
    reason: string
    at?: string
  }): Promise<SupersedeOutcome> {
    const previous = await this.#read(claimKey(input.staleId))
    if (!previous) return { ok: false, reason: 'NOT_FOUND', detail: `${input.staleId} 를 찾지 못했다` }
    if (previous.status === 'STALE') {
      return { ok: false, reason: 'ALREADY_STALE', detail: `${input.staleId} 는 이미 뒤집힌 기록이다` }
    }

    const at = input.at ?? this.#now()
    const recorded = await this.record({ ...input.replacement, observedAt: at, supersedes: input.staleId })
    if (!recorded.ok) {
      return { ok: false, reason: 'NOT_FOUND', detail: recorded.detail }
    }

    const marker = { supersededBy: recorded.claim.claimId, supersededReason: input.reason, at }
    if (!(await this.#scope.setIfAbsent(staleKey(input.staleId), JSON.stringify(marker)))) {
      return { ok: false, reason: 'ALREADY_STALE', detail: `${input.staleId} 는 이미 뒤집힌 기록이다` }
    }
    return { ok: true, stale: { ...previous, status: 'STALE', ...marker, supersededReason: input.reason }, current: recorded.claim }
  }

  /** 당시 판단 그대로. 뒤집힌 것도 든다 — History는 지우지 않는다. */
  async history(): Promise<Claim[]> {
    const keys = (await this.#scope.keys(CLAIM_PREFIX)).filter((key) => !key.startsWith(stalePrefix)).sort()
    const out: Claim[] = []
    for (const key of keys) {
      const claim = await this.#read(key)
      if (claim) out.push(await this.#compose(claim))
    }
    return out.sort((a, b) => a.observedAt.localeCompare(b.observedAt))
  }

  /**
   * 지금 무엇이 사실로 서 있는가. **STALE을 뺀 최신 claim의 projection이며 저장하지 않는다**
   * (C-10 불변식 ⑫).
   */
  async current(): Promise<Claim[]> {
    return (await this.history()).filter((claim) => claim.status !== 'STALE')
  }

  async get(claimId: string): Promise<Claim | null> {
    const claim = await this.#read(claimKey(claimId))
    return claim ? this.#compose(claim) : null
  }

  async #compose(claim: Claim): Promise<Claim> {
    const raw = await this.#scope.get(staleKey(claim.claimId))
    if (!raw) return claim
    const marker = JSON.parse(raw) as { supersededBy: string; supersededReason: string }
    return { ...claim, status: 'STALE', supersededBy: marker.supersededBy, supersededReason: marker.supersededReason }
  }

  async #read(key: string): Promise<Claim | null> {
    const raw = await this.#scope.get(key)
    if (!raw) return null
    const parsed = Claim.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  }
}

const MARK: Record<ClaimStatus, string> = {
  CONFIRMED: '확인',
  INFERRED: '추론',
  PENDING: '미확인',
  STALE: '뒤집힘',
}

/**
 * 사람이 읽는 줄. **추론을 확인처럼 보이게 하지 않는다** — 이 표시가 흐려지는 순간
 * 사람이 추론 위에서 결정한다.
 */
export function claimLines(claims: readonly Claim[]): string[] {
  if (claims.length === 0) return ['적힌 판단 없음']
  return claims.map((claim) => {
    const evidence = claim.evidenceRefs.length > 0 ? ` [${claim.evidenceRefs.join(', ')}]` : ' [근거 없음]'
    const superseded = claim.supersededBy ? ` → ${claim.supersededBy} (${claim.supersededReason ?? '이유 미기록'})` : ''
    return `${claim.claimId} (${MARK[claim.status]}) ${claim.statement}${evidence}${superseded}`
  })
}
