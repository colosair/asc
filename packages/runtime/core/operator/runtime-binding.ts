// RuntimeBinding — Logical Session과 Physical Host 실행의 연결 (C-03 §3).
//
// 여기에는 provider-neutral한 형태와 계약만 있다. 실제 저장(StateStore.scope)은 Adapter
// 몫이다 — PresentationRecord와 같은 이유다(C-02 §3): provider가 늘 때 Core 스키마가
// 흔들리면 안 되고, runtime 관찰값은 정본이 아니다. Core EntityMap에 physical id가
// 들어가는 순간 이 경계는 무너진다.
//
// Binding은 관찰 metadata이자 **ownership claim**이다. Logical ≠ Physical은 승계를
// 허용하는 것이지 동시 실행을 허용하는 것이 아니다 — 서로 다른 Physical Session 둘이
// 같은 ACTIVE 세션을 동시에 이어가면 같은 계약 위에서 두 손이 움직인다.

import { z } from 'zod'
import { SessionId, Timestamp } from '../model/ids.ts'

export const RuntimeBinding = z.object({
  logicalSessionId: SessionId,
  provider: z.string().min(1), // Adapter가 자기 이름을 댄다 — Core는 값을 해석하지 않는다
  physicalSessionId: z.string().min(1),
  workerId: z.string().optional(),
  runtimeKind: z.string().optional(), // 'interactive' | 'background' | 'subagent' 등 provider 어휘
  lastObservedState: z.string().optional(), // provider가 주는 상태 그대로 — Core는 해석하지 않는다
  capabilitySnapshot: z.record(z.boolean()).optional(),
  updatedAt: Timestamp,
})
export type RuntimeBinding = z.infer<typeof RuntimeBinding>

export type ClaimOutcome =
  | { ok: true; binding: RuntimeBinding }
  /** 이미 다른 Physical owner가 있다. 자동 탈취는 없다 — 명시적 rebind가 필요하다. */
  | { ok: false; reason: 'RUNTIME_CONFLICT'; current: RuntimeBinding }

/**
 * Adapter가 구현해야 하는 소유권 계약 (C-03 §3.2).
 *
 * 하나의 Logical Session에 동시 active Physical owner는 최대 1개다.
 * claim은 원자적이어야 한다(`ScopedStore.setIfAbsent` 기반) — 두 Physical Session이
 * 동시에 집으면 정확히 하나만 성공한다.
 */
export interface RuntimeBindings {
  /** owner가 없으면 잡는다. 있으면 RUNTIME_CONFLICT — 기다리지도 뺏지도 않는다. */
  claim(binding: Omit<RuntimeBinding, 'updatedAt'>, at: string): Promise<ClaimOutcome>

  /** 관찰값 갱신. owner가 아닌 Physical Session의 갱신은 거부한다. */
  observe(
    logicalSessionId: string,
    physicalSessionId: string,
    patch: Partial<Pick<RuntimeBinding, 'workerId' | 'runtimeKind' | 'lastObservedState' | 'capabilitySnapshot'>>,
    at: string,
  ): Promise<ClaimOutcome>

  /** owner 스스로 내려놓는다. 남의 것은 못 놓는다. */
  release(logicalSessionId: string, physicalSessionId: string): Promise<boolean>

  /**
   * 죽은 owner를 사람이 확인하고 갈아끼운다. 자동 탈취가 아니라 명시적 복구다 —
   * stale 자동 회수는 MVP에 넣지 않는다 (C-03 §3.2).
   */
  rebind(binding: Omit<RuntimeBinding, 'updatedAt'>, at: string): Promise<RuntimeBinding>

  get(logicalSessionId: string): Promise<RuntimeBinding | null>
}
