// 읽기 → 전이 → CAS를 한 묶음으로 수행하는 공통 뼈대.
// Session·Request·Grant 오케스트레이션이 전부 이 위에 올라간다.
//
// 자동 재시도는 없다. 충돌은 "그 사이 누군가 결정했다"는 사실이고, 사람 판단이 걸린
// 전이를 몰래 다시 시도하면 이미 내려진 결정을 덮어쓴다 (C-01 §8).

import { TransitionError } from '../model/transitions.ts'
import type { EntityKind, EntityMap, StateStore } from '../../ports/state-store.ts'

export type ApplyOutcome<T> =
  | { ok: true; entity: T }
  | { ok: false; reason: 'NOT_FOUND' }
  /** 읽은 뒤 값이 바뀌었다. `current`가 호출자에게 무슨 일이 있었는지 설명할 근거다. */
  | { ok: false; reason: 'CONFLICT'; current: T }
  /** 전이 자체가 불가하다 — 잘못된 상태·권한 없는 actor·빠진 필수 항목. */
  | { ok: false; reason: 'REJECTED'; failure: TransitionError }

export async function applyTransition<K extends EntityKind>(
  store: StateStore,
  kind: K,
  id: string,
  mutate: (current: EntityMap[K]) => EntityMap[K],
): Promise<ApplyOutcome<EntityMap[K]>> {
  const current = await store.get(kind, id)
  if (!current) return { ok: false, reason: 'NOT_FOUND' }

  let next: EntityMap[K]
  try {
    next = mutate(current)
  } catch (error) {
    if (error instanceof TransitionError) return { ok: false, reason: 'REJECTED', failure: error }
    throw error
  }

  const result = await store.compareAndSet(kind, id, current.version, next)
  if (result.ok) return { ok: true, entity: result.entity }
  if (result.reason === 'NOT_FOUND') return { ok: false, reason: 'NOT_FOUND' }
  return { ok: false, reason: 'CONFLICT', current: result.current }
}
