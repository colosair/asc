// RuntimeBindings의 ScopedStore 구현 — B-14의 fake host 검증용이자 참조 구현.
//
// memory 디렉터리에 있지만 특정 저장소에 매이지 않는다: ScopedStore를 받아 그 위에서
// 동작하므로, Host Adapter가 자기 scope를 넘겨 그대로 재사용한다 —
// 소유권 로직을 provider마다 다시 쓰는 순간 원자성 보장이 갈라진다.

import type { ScopedStore } from '../../ports/state-store.ts'
import {
  RuntimeBinding,
  type ClaimOutcome,
  type RuntimeBindings,
} from '../../core/operator/runtime-binding.ts'

const keyOf = (logicalSessionId: string) => `runtime-binding:${logicalSessionId}`
/**
 * 내려놓은 소유권의 묘비 (C-10 §1.3 불변식 ④).
 *
 * 현재 소유권은 사라져도 "그때 그 Physical Run이 이 세션을 잡고 있었다"는 사실은 남아야
 * 한다. 지금까지는 release가 파일을 지워서 회수 뒤에는 몇 개의 실행이 거쳐 갔는지조차
 * 복원할 수 없었다.
 *
 * **접두어가 `runtime-binding`이면 안 된다.** Host Adapter의 guard hook은 이 scope에서
 * `runtime-binding` 으로 시작하는 파일을 훑어 관리 대상 세션을 찾는다. 묘비가 그 앞에
 * 걸리면 이미 내려놓은 세션이 계속 관리 대상으로 읽혀 죽은 소유권으로 차단 판정이 선다.
 */
const logKey = (logicalSessionId: string, seq: number) => `binding-log:${logicalSessionId}:${seq}`
const logPrefix = (logicalSessionId: string) => `binding-log:${logicalSessionId}:`

/**
 * 집음·내려놓음·승계의 흔적. 현재 view가 아니라 이력이다.
 *
 * `CLAIMED` 가 여기 있는 이유는 실측이다. 내려놓음만 적으니 이력이 반쪽이 되어,
 * "log 의 마지막이 RELEASED 인데 현재 binding 이 남아 있다" 를 stale 로 읽을 수 없었다 —
 * 다시 집은 사실이 어디에도 없어서 정상 재결합과 지워지지 않은 묘비가 같은 모양이었다.
 */
export type BindingLogEntry = {
  logicalSessionId: string
  physicalSessionId: string
  provider: string
  workerId?: string
  kind: 'CLAIMED' | 'RELEASED' | 'SUPERSEDED'
  /** 집은 시각. CLAIMED 에서는 `endedAt` 과 같다 — 아직 끝나지 않았다. */
  claimedAt: string
  endedAt: string
}

export class ScopedRuntimeBindings implements RuntimeBindings {
  #scope: ScopedStore
  #now: () => string

  constructor(scope: ScopedStore, now: () => string = () => new Date().toISOString()) {
    this.#scope = scope
    this.#now = now
  }

  async claim(binding: Omit<RuntimeBinding, 'updatedAt'>, at: string): Promise<ClaimOutcome> {
    const parsed = RuntimeBinding.parse({ ...binding, updatedAt: at })

    // **한 Physical Run 은 한 번에 한 Logical Session 만 잡는다.**
    //
    // 지금까지 원자성은 Logical 쪽에서만 봤다 — 같은 physical 이 다른 세션을 하나 더
    // 집는 것은 아무도 막지 않았고, 실측에서 그 겹침이 회차마다 나타났다
    // (S-03 이 살아 있는 동안 S-04 가 같은 physical 로 집혔고, 그 뒤로도 계속).
    // 그 상태에서는 guard 가 "이 physical 은 관리 대상" 이라고 답할 때 어느 계약을
    // 말하는지 정해지지 않는다. 뺏지 않는다 — 그 결정은 사람의 것이다 (C-03 §3.2).
    const held = await this.#currentOf(parsed.physicalSessionId)
    if (held && held.logicalSessionId !== parsed.logicalSessionId) {
      return { ok: false, reason: 'RUNTIME_CONFLICT', current: held }
    }

    // setIfAbsent가 원자성을 진다 — 확인과 쓰기 사이에 다른 Physical Session이 끼지 못한다.
    if (await this.#scope.setIfAbsent(keyOf(parsed.logicalSessionId), JSON.stringify(parsed))) {
      await this.#log(parsed, 'CLAIMED')
      return { ok: true, binding: parsed }
    }
    const current = await this.get(parsed.logicalSessionId)
    if (!current) {
      // 그 사이 owner가 내려놨다 — 한 번 더 집어 본다. 또 지면 진 것이다.
      if (await this.#scope.setIfAbsent(keyOf(parsed.logicalSessionId), JSON.stringify(parsed))) {
        await this.#log(parsed, 'CLAIMED')
        return { ok: true, binding: parsed }
      }
      return { ok: false, reason: 'RUNTIME_CONFLICT', current: (await this.get(parsed.logicalSessionId))! }
    }
    // 같은 Physical Session의 재-claim은 충돌이 아니라 이어 잡기다 (respawn 아님).
    // 이력에 다시 적지 않는다 — 같은 결합이 이어진 것이지 새로 집은 것이 아니다.
    if (current.physicalSessionId === parsed.physicalSessionId) {
      const refreshed = { ...current, updatedAt: at }
      await this.#scope.set(keyOf(parsed.logicalSessionId), JSON.stringify(refreshed))
      return { ok: true, binding: refreshed }
    }
    return { ok: false, reason: 'RUNTIME_CONFLICT', current }
  }

  /** 이 Physical Run 이 지금 잡고 있는 결합. 없으면 `null`. */
  async #currentOf(physicalSessionId: string): Promise<RuntimeBinding | null> {
    for (const binding of await this.current()) {
      if (binding.physicalSessionId === physicalSessionId) return binding
    }
    return null
  }

  /** 지금 살아 있는 결합 전부. 이력(log)은 여기 없다. */
  async current(): Promise<RuntimeBinding[]> {
    const out: RuntimeBinding[] = []
    for (const key of await this.#scope.keys('runtime-binding:')) {
      const raw = await this.#scope.get(key)
      if (raw) out.push(RuntimeBinding.parse(JSON.parse(raw)))
    }
    return out
  }

  async observe(
    logicalSessionId: string,
    physicalSessionId: string,
    patch: Partial<Pick<RuntimeBinding, 'workerId' | 'runtimeKind' | 'lastObservedState' | 'capabilitySnapshot'>>,
    at: string,
  ): Promise<ClaimOutcome> {
    const current = await this.get(logicalSessionId)
    if (!current || current.physicalSessionId !== physicalSessionId) {
      // owner가 아니면 관찰도 못 쓴다 — 남의 binding을 덮는 경로를 만들지 않는다
      return current
        ? { ok: false, reason: 'RUNTIME_CONFLICT', current }
        : { ok: false, reason: 'RUNTIME_CONFLICT', current: RuntimeBinding.parse({
            logicalSessionId, provider: 'unknown', physicalSessionId: '(none)', updatedAt: at,
          }) }
    }
    const next = RuntimeBinding.parse({ ...current, ...patch, updatedAt: at })
    await this.#scope.set(keyOf(logicalSessionId), JSON.stringify(next))
    return { ok: true, binding: next }
  }

  async release(logicalSessionId: string, physicalSessionId: string): Promise<boolean> {
    const current = await this.get(logicalSessionId)
    if (!current || current.physicalSessionId !== physicalSessionId) return false
    // 지우기 전에 남긴다. 순서가 반대면 그 사이에 죽었을 때 흔적 없이 사라진다.
    await this.#log(current, 'RELEASED')
    await this.#scope.delete(keyOf(logicalSessionId))
    return true
  }

  async rebind(binding: Omit<RuntimeBinding, 'updatedAt'>, at: string): Promise<RuntimeBinding> {
    const previous = await this.get(binding.logicalSessionId)
    // 승계는 덮어쓰기지만, 덮이는 쪽도 있었던 일이다.
    if (previous && previous.physicalSessionId !== binding.physicalSessionId) {
      await this.#log(previous, 'SUPERSEDED')
    }
    const next = RuntimeBinding.parse({ ...binding, updatedAt: at })
    await this.#scope.set(keyOf(next.logicalSessionId), JSON.stringify(next))
    if (!previous || previous.physicalSessionId !== next.physicalSessionId) {
      await this.#log(next, 'CLAIMED')
    }
    return next
  }

  /**
   * 살아 있어야 할 이유가 없는 결합 (0.7.0).
   *
   * 판정은 이력과 시각으로만 한다: 이 세션의 마지막 사건이 **끝남**(RELEASED·SUPERSEDED)
   * 인데 현재 결합이 그 시각보다 나중에 갱신되지 않았다면, 지워졌어야 할 것이 남은 것이다.
   * 나중에 갱신됐으면 그것은 다시 집은 것이고 정상이다 — 그 구분이 없으면 정상 재결합을
   * 죽은 것으로 읽는다.
   *
   * **아무것도 지우지 않는다.** 무엇이 그런 상태인지만 답하고, 치우는 것은 호출자가 한다.
   */
  async stale(): Promise<RuntimeBinding[]> {
    const out: RuntimeBinding[] = []
    for (const binding of await this.current()) {
      const history = await this.history(binding.logicalSessionId)
      const last = history.at(-1)
      if (!last || last.kind === 'CLAIMED') continue
      if (last.physicalSessionId !== binding.physicalSessionId) continue
      // 끝남 이후에 갱신됐으면 다시 집은 것이다.
      if (binding.updatedAt > last.endedAt) continue
      out.push(binding)
    }
    return out
  }

  /**
   * 그 결합을 치운다. **이력은 건드리지 않는다** — 있었던 일은 남는다.
   * 이미 없으면 아무 일도 하지 않는다(멱등).
   */
  async forget(logicalSessionId: string): Promise<boolean> {
    if (!(await this.get(logicalSessionId))) return false
    await this.#scope.delete(keyOf(logicalSessionId))
    return true
  }

  /** 이 세션을 거쳐 간 소유권 이력. 현재 owner는 여기 없다 — get()이 답한다. */
  async history(logicalSessionId: string): Promise<BindingLogEntry[]> {
    const keys = await this.#scope.keys(logPrefix(logicalSessionId))
    const out: BindingLogEntry[] = []
    for (const key of keys.sort()) {
      const raw = await this.#scope.get(key)
      if (raw) out.push(JSON.parse(raw) as BindingLogEntry)
    }
    return out
  }

  /**
   * 묘비를 append한다. 순번은 setIfAbsent가 성공할 때까지 올린다 — 같은 세션의 두
   * 내려놓음이 겹쳐도 하나가 조용히 사라지지 않는다.
   */
  async #log(binding: RuntimeBinding, kind: BindingLogEntry['kind']): Promise<void> {
    const entry: BindingLogEntry = {
      logicalSessionId: binding.logicalSessionId,
      physicalSessionId: binding.physicalSessionId,
      provider: binding.provider,
      ...(binding.workerId ? { workerId: binding.workerId } : {}),
      kind,
      claimedAt: binding.updatedAt,
      endedAt: this.#now(),
    }
    const existing = await this.#scope.keys(logPrefix(binding.logicalSessionId))
    let seq = existing.reduce((max, key) => Math.max(max, Number(key.slice(key.lastIndexOf(':') + 1)) || 0), 0) + 1
    while (!(await this.#scope.setIfAbsent(logKey(binding.logicalSessionId, seq), JSON.stringify(entry)))) {
      seq += 1
    }
  }

  async get(logicalSessionId: string): Promise<RuntimeBinding | null> {
    const raw = await this.#scope.get(keyOf(logicalSessionId))
    return raw ? RuntimeBinding.parse(JSON.parse(raw)) : null
  }
}
