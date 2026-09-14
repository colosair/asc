// 발급 전 계약 초안 — 일회성이고, 사람의 한 마디로 세션이 된다 (0.10.0 P3).
//
// 0.9.1 까지 `work start` 는 초안을 화면에만 내고 잊었다. 발급이 Controller 의 것이면 사람은
// agent 가 만든 초안 전체를 `session issue …` 로 다시 쳐야 했다 (dogfood 2026-09-13 F1). 여기서는
// 초안을 **보존**해 사람이 id 하나로 발급한다. 새 권한이 아니다 — 발급 경로는 그대로 SessionRuntime
// 이고, 이 장부는 "무엇이 제안됐는가" 만 적는다.
//
// lifecycle:  CREATED → ISSUED | REVISED | REJECTED | OBSOLETE
//   ISSUED    사람이 발급했다. 세션 id 가 남는다
//   REVISED   같은 작업 항목의 새 제안이 이것을 대체했다 (supersededBy)
//   REJECTED  사람이 거절했다 (이유)
//   OBSOLETE  발급하려는 순간 작업 항목이 저장 시점과 달랐다 — 다시 계획한다
// Run 이 끊겨도 제안은 살아 있다 — Run 의 것이 아니라 workspace 의 것이다. `createdBy` 는 기록일 뿐이다.
// monitor 원장이 아니다: `store.scope('proposals')` 아래 파일이고, 보관(archive)되지 않는다.

import { z } from 'zod'

import type { ScopedStore } from '../../ports/state-store.ts'
import type { SessionContractDraft } from './contract-draft.ts'

export const ProposalStatus = z.enum(['CREATED', 'ISSUED', 'REVISED', 'REJECTED', 'OBSOLETE'])
export type ProposalStatus = z.infer<typeof ProposalStatus>

/** 발급 시점에 작업 항목이 그대로인지 견줄 지문. 없는 항목은 비교하지 않는다. */
export const WorkItemFingerprint = z.object({
  title: z.string().optional(),
  trackerDone: z.boolean().optional(),
})
export type WorkItemFingerprint = z.infer<typeof WorkItemFingerprint>

export const ContractProposal = z.object({
  /** 제안된 세션 id — 발급되면 그대로 세션 id 가 된다. */
  id: z.string().min(1),
  status: ProposalStatus,
  workRef: z.string().optional(),
  /** 초안 전문. 발급은 이것으로 한다 — 사람이 다시 치지 않는다. */
  draft: z.custom<SessionContractDraft>((v) => typeof v === 'object' && v !== null),
  workItem: WorkItemFingerprint.optional(),
  createdAt: z.string().min(1),
  /** 어느 Run 이 제안했는가 — 소유가 아니라 기록. */
  createdBy: z.string().optional(),
  closedAt: z.string().optional(),
  /** ISSUED 면 세션 id, REVISED 면 대체한 제안 id, REJECTED/OBSOLETE 면 이유. */
  issuedSessionId: z.string().optional(),
  supersededBy: z.string().optional(),
  reason: z.string().optional(),
})
export type ContractProposal = z.infer<typeof ContractProposal>

const keyOf = (id: string): string => `proposal:${id}`

export class ProposalLedger {
  readonly #scope: ScopedStore
  readonly #now: () => string

  constructor(scope: ScopedStore, now: () => string = () => new Date().toISOString()) {
    this.#scope = scope
    this.#now = now
  }

  /**
   * 새 제안. 같은 작업 항목의 열린 제안은 REVISED 로 닫는다 — 열린 제안이 둘이면 사람이 무엇을
   * 발급하는지 모른다. 같은 id 가 이미 있으면 만들지 않는다.
   */
  async create(input: {
    id: string
    workRef?: string
    draft: SessionContractDraft
    workItem?: WorkItemFingerprint
    createdBy?: string
  }): Promise<{ ok: true; proposal: ContractProposal; revised: string[] } | { ok: false; reason: 'ALREADY_EXISTS' }> {
    const revised: string[] = []
    if (input.workRef) {
      for (const open of await this.open()) {
        if (open.workRef !== input.workRef || open.id === input.id) continue
        await this.#write({ ...open, status: 'REVISED', closedAt: this.#now(), supersededBy: input.id })
        revised.push(open.id)
      }
    }
    const proposal = ContractProposal.parse({
      id: input.id,
      status: 'CREATED',
      ...(input.workRef ? { workRef: input.workRef } : {}),
      draft: input.draft,
      ...(input.workItem ? { workItem: input.workItem } : {}),
      createdAt: this.#now(),
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    })
    if (!(await this.#scope.setIfAbsent(keyOf(proposal.id), JSON.stringify(proposal)))) {
      return { ok: false, reason: 'ALREADY_EXISTS' }
    }
    return { ok: true, proposal, revised }
  }

  async get(id: string): Promise<ContractProposal | null> {
    const raw = await this.#scope.get(keyOf(id))
    if (raw === null) return null
    const parsed = ContractProposal.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  }

  /** 아직 발급되지 않은 제안들. */
  async open(): Promise<ContractProposal[]> {
    const out: ContractProposal[] = []
    for (const key of await this.#scope.keys('proposal:')) {
      const proposal = await this.get(key.slice('proposal:'.length))
      if (proposal?.status === 'CREATED') out.push(proposal)
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** 열린 제안을 닫는다. 이미 닫힌 것은 그대로 둔다 — 닫힌 이유를 덮어쓰지 않는다. */
  async close(
    id: string,
    outcome:
      | { status: 'ISSUED'; issuedSessionId: string }
      | { status: 'REJECTED'; reason: string }
      | { status: 'OBSOLETE'; reason: string },
  ): Promise<{ ok: true; proposal: ContractProposal } | { ok: false; reason: 'NOT_FOUND' | 'NOT_OPEN'; current?: ContractProposal }> {
    const current = await this.get(id)
    if (!current) return { ok: false, reason: 'NOT_FOUND' }
    if (current.status !== 'CREATED') return { ok: false, reason: 'NOT_OPEN', current }
    const next: ContractProposal = { ...current, ...outcome, closedAt: this.#now() }
    await this.#write(next)
    return { ok: true, proposal: next }
  }

  async #write(proposal: ContractProposal): Promise<void> {
    await this.#scope.set(keyOf(proposal.id), JSON.stringify(ContractProposal.parse(proposal)))
  }
}

/** 작업 항목이 저장 시점과 같은가. 지문이 없으면 비교하지 않는다 — 모르는 것을 다르다고 하지 않는다. */
export function fingerprintMatches(saved: WorkItemFingerprint | undefined, now: WorkItemFingerprint): boolean {
  if (!saved) return true
  if (saved.title !== undefined && now.title !== undefined && saved.title !== now.title) return false
  if (saved.trackerDone !== undefined && now.trackerDone !== undefined && saved.trackerDone !== now.trackerDone) return false
  return true
}
