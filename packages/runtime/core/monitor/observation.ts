// Observation Ledger — reference 하나를 계속 지켜본 기록 (C-07 §4·§5).
//
// 두 가지를 같은 자리에서 푼다. 둘 다 "이 reference를 지난번에 어떻게 봤나"가 있어야
// 성립하기 때문이다:
//
//   Material Change  같은 스레드에서 실질 변화 없이 다시 부를 때 패킷을 만들지 않는다
//   Shadow Watch     지금은 내 일이 아니라고 본 것을 버리지 않고 계속 본다
//
// 왜 Request 상태가 아닌가: 상태를 하나 더 만들면 승인 lifecycle 전체가 영향을 받는다
// (OM §11.2 열거는 동결이다). 그리고 이건 요청에 대한 사실이 아니라 **외부 리소스에 대한
// 우리 관측**이다 — 요청이 만들어지기 전에도, 만들어지지 않아도 존재한다.
//
// 저장은 adapter-scope다 (C-07 §0.2, Closure Ledger·Bounded Query 선례).
//
// 여기는 closure.ts와 달리 읽고-고쳐-쓴다. 기록이 갱신돼야 하는 물건이라 setIfAbsent로는
// 표현되지 않기 때문이다. 안전한 이유는 Monitor Run이 프로젝트 단위 lease로 직렬화되어
// 같은 scope를 두 Run이 동시에 만지지 않기 때문이다 (engine.ts scan lease).

import { z } from 'zod'

import type { ScopedStore } from '../../ports/state-store.ts'
import type { Disposition, Relevance } from './relevance.ts'

/**
 * 이번에 본 모습. 셋 중 하나라도 달라지면 실질 변화다 (C-07 §4.3).
 *
 * evidence를 넣는 이유: 같은 스레드라도 근거가 달라졌으면 새 사건이다. 변경 경로가 내
 * 영역까지 넓어진 것을 "같은 스레드"라고 묶으면 그게 정확히 놓치는 경우다.
 */
export type Fingerprint = {
  revisionMarker: string
  evidence: readonly string[]
}

export const Observation = z.object({
  reference: z.string().min(1),
  revisionMarker: z.string(),
  evidence: z.array(z.string()).default([]),
  /** 지난번 처분. SHADOW면 숨긴 것이고 INBOX면 올린 것이다. */
  disposition: z.enum(['INBOX', 'SHADOW']),
  /** 왜 그렇게 처분했는지. 나중에 사람이 "왜 안 보였나"를 물을 때 답이 된다. */
  reason: z.string().optional(),
  firstSeenAt: z.string().min(1),
  lastSeenAt: z.string().min(1),
})
export type Observation = z.infer<typeof Observation>

export type SurfaceDecision =
  | { surface: true; reason: 'NEW' | 'MATERIAL_CHANGE' | 'PROMOTED' }
  /**
   * 올리지 않는다. 두 이유를 나누는 까닭: `SHADOWED`는 관련 근거가 없어서이고
   * `NO_MATERIAL_CHANGE`는 관련은 있는데 지난번과 같아서다. 사람이 "왜 안 보였나"를
   * 물을 때 답이 다르다.
   */
  | { surface: false; reason: 'SHADOWED' | 'NO_MATERIAL_CHANGE'; previous?: Observation }

const key = (reference: string) => `obs:${reference}`

/** 근거를 비교 가능한 문자열로. 순서가 흔들려 오탐하지 않게 정렬한다. */
export const fingerprintOf = (relevance: Relevance, revisionMarker: string): Fingerprint => ({
  revisionMarker,
  evidence: relevance.evidence
    .filter((e) => e.supports)
    .map((e) => `${e.kind}:${e.detail}`)
    .sort(),
})

export class ObservationLedger {
  #scope: ScopedStore
  #now: () => string

  constructor(scope: ScopedStore, now: () => string = () => new Date().toISOString()) {
    this.#scope = scope
    this.#now = now
  }

  /**
   * 이번 관측을 올릴 것인가.
   *
   * 처음 보는 것은 올린다. 지난번에 Shadow로 내렸던 것이 이번에 INBOX 판정이면 **승격**이다 —
   * 그게 Shadow를 버리지 않고 두는 이유다.
   */
  async decide(
    reference: string,
    fingerprint: Fingerprint,
    disposition: Disposition,
  ): Promise<SurfaceDecision> {
    const previous = await this.get(reference)
    if (!previous) {
      return disposition === 'INBOX'
        ? { surface: true, reason: 'NEW' }
        : { surface: false, reason: 'SHADOWED' }
    }

    if (previous.disposition === 'SHADOW' && disposition === 'INBOX') {
      return { surface: true, reason: 'PROMOTED' }
    }
    if (disposition === 'SHADOW') return { surface: false, reason: 'SHADOWED', previous }

    const changed =
      previous.revisionMarker !== fingerprint.revisionMarker ||
      previous.evidence.join(' ') !== fingerprint.evidence.join(' ')

    return changed
      ? { surface: true, reason: 'MATERIAL_CHANGE' }
      : { surface: false, reason: 'NO_MATERIAL_CHANGE', previous }
  }

  /** 이번 관측을 기록한다. 처음 본 시각은 보존한다 — 언제부터 지켜봤는지가 사라지면 안 된다. */
  async record(
    reference: string,
    fingerprint: Fingerprint,
    disposition: Disposition,
    reason?: string,
  ): Promise<Observation> {
    const previous = await this.get(reference)
    const at = this.#now()
    const observation = Observation.parse({
      reference,
      revisionMarker: fingerprint.revisionMarker,
      evidence: [...fingerprint.evidence],
      disposition,
      ...(reason ? { reason } : {}),
      firstSeenAt: previous?.firstSeenAt ?? at,
      lastSeenAt: at,
    })
    await this.#scope.set(key(reference), JSON.stringify(observation))
    return observation
  }

  async get(reference: string): Promise<Observation | null> {
    const raw = await this.#scope.get(key(reference))
    return raw ? Observation.parse(JSON.parse(raw)) : null
  }

  async list(): Promise<Observation[]> {
    const out: Observation[] = []
    for (const stored of await this.#scope.keys('obs:')) {
      const raw = await this.#scope.get(stored)
      if (raw) out.push(Observation.parse(JSON.parse(raw)))
    }
    return out.sort((a, b) => a.reference.localeCompare(b.reference))
  }

  /**
   * 지금 숨겨 두고 보는 것들. **숨김이지 폐기가 아니다** — 사람이 물으면 그대로 보여준다
   * (C-07 §5.4).
   */
  async shadowed(): Promise<Observation[]> {
    return (await this.list()).filter((o) => o.disposition === 'SHADOW')
  }
}

/** 사람이 읽는 줄. 왜 숨겼는지를 함께 적는다 — 이유 없는 숨김은 폐기와 구분되지 않는다. */
export function shadowLines(records: readonly Observation[]): string[] {
  return records.map(
    (o) => `${o.reference} — ${o.reason ?? '관련 근거 없음'} (처음 ${o.firstSeenAt} · 마지막 ${o.lastSeenAt})`,
  )
}
