// Remote Freeze — 원격을 얼려도 로컬 일은 계속 돈다 (C-10 §7 계열 · 지시 §27).
//
// 실전 근거: 프로젝트 운영 중 "지금은 원격에 아무것도 보내지 마라"는 상태가 실제로 있다.
// 그때 필요한 것은 두 가지다.
//
//   ① 원격 쓰기가 **정말로** 안 나가야 한다 — "조심하겠다"는 약속이 아니라 차단이어야 한다
//   ② 로컬 작업은 계속 돌아야 한다 — 얼렸다고 구현·테스트까지 멈추면 아무도 안 쓴다
//
// 그리고 녹일 때가 더 위험하다. 얼어 있는 동안 쌓인 것을 **자동으로 재생하지 않는다**:
// 그 사이 대상이 바뀌었을 수 있고, 승인 근거가 낡았을 수 있다. 다시 확인하고 다시 승인한다.

import { z } from 'zod'

import type { ScopedStore } from '../../ports/state-store.ts'

/**
 * 이 행위를 지금 해도 되는가.
 *
 *   ALLOW  그대로 한다
 *   DENY   하지 않는다. 다시 시도할 대상도 아니다 (읽기는 얼려도 다시 밀리지 않는다)
 *   DEFER  지금은 못 하지만 **해야 할 일이다** — 큐에 남겨 녹은 뒤 사람이 다시 본다
 */
export const FreezeDecision = z.enum(['ALLOW', 'DENY', 'DEFER'])
export type FreezeDecision = z.infer<typeof FreezeDecision>

/** 행위의 갈래. provider 이름이 아니라 **무엇을 하는가**로 가른다. */
export const RemoteAction = z.enum([
  'remote.read',
  'remote.write',
  'local.inspect',
  'local.implement',
  'local.test',
])
export type RemoteAction = z.infer<typeof RemoteAction>

export const FreezePolicy = z.object({
  frozen: z.boolean().default(false),
  /** 언제부터. 얼린 시점을 모르면 무엇이 그 뒤에 쌓였는지도 모른다. */
  since: z.string().optional(),
  /** 왜 얼렸는가. 이유 없는 freeze는 다음 사람이 언제 녹여도 되는지 모른다. */
  reason: z.string().optional(),
  /**
   * 원격 **읽기**까지 막을 것인가. 기본은 허용이다 — 읽기까지 막으면 조사 자체가 서지 않고,
   * 대개 문제가 되는 것은 쓰기다. 완전 오프라인이면 명시적으로 켠다.
   */
  denyRemoteRead: z.boolean().default(false),
})
export type FreezePolicy = z.infer<typeof FreezePolicy>

export const DeferredAction = z.object({
  id: z.string().min(1),
  action: RemoteAction,
  /** 무엇을 하려 했는가. 사람이 읽고 다시 판단할 만큼은 남는다. */
  intent: z.string().min(1),
  /** 그때 무엇을 근거로 했는가 — 녹은 뒤 그 근거가 아직 유효한지 대조할 대상이다. */
  basis: z.array(z.string()).default([]),
  deferredAt: z.string().min(1),
  /** 승인·Grant가 걸려 있던 것이면 그 참조. 자동 재사용하지 않는다. */
  grantRef: z.string().optional(),
})
export type DeferredAction = z.infer<typeof DeferredAction>

/**
 * 이 행위를 지금 해도 되는가 (지시 §27).
 *
 * **로컬은 얼리지 않는다.** 구현·테스트·조사가 멈추면 freeze가 곧 작업 중단이 되고,
 * 그러면 사람이 freeze를 안 쓴다 — 안 쓰이는 안전장치는 안전장치가 아니다.
 */
export function judgeAction(policy: FreezePolicy, action: RemoteAction): { decision: FreezeDecision; detail: string } {
  if (!policy.frozen) return { decision: 'ALLOW', detail: '얼지 않았다' }

  switch (action) {
    case 'remote.write':
      // 해야 할 일이지만 지금은 아니다 — 버리지 않고 미룬다
      return { decision: 'DEFER', detail: `원격 쓰기는 얼어 있다${policy.reason ? ` (${policy.reason})` : ''}` }
    case 'remote.read':
      return policy.denyRemoteRead
        ? { decision: 'DENY', detail: '완전 오프라인 — 원격 읽기도 막혀 있다' }
        : { decision: 'ALLOW', detail: '읽기는 허용된다 — 막히는 것은 쓰기다' }
    default:
      return { decision: 'ALLOW', detail: '로컬 작업은 얼리지 않는다' }
  }
}

const POLICY_KEY = 'freeze-policy'
const deferredKey = (id: string) => `freeze-deferred:${id}`
const DEFERRED_PREFIX = 'freeze-deferred:'

export class FreezeLedger {
  #scope: ScopedStore
  #now: () => string

  constructor(scope: ScopedStore, now: () => string = () => new Date().toISOString()) {
    this.#scope = scope
    this.#now = now
  }

  async policy(): Promise<FreezePolicy> {
    const raw = await this.#scope.get(POLICY_KEY)
    return raw ? FreezePolicy.parse(JSON.parse(raw)) : FreezePolicy.parse({})
  }

  /** 얼린다. 이유를 요구한다 — 이유 없는 freeze는 언제 녹여도 되는지 아무도 모른다. */
  async freeze(reason: string, options: { denyRemoteRead?: boolean } = {}): Promise<FreezePolicy> {
    const policy = FreezePolicy.parse({
      frozen: true,
      since: this.#now(),
      reason,
      denyRemoteRead: options.denyRemoteRead ?? false,
    })
    await this.#scope.set(POLICY_KEY, JSON.stringify(policy))
    return policy
  }

  /**
   * 녹인다. **쌓인 것을 자동으로 실행하지 않는다** (지시 §27).
   *
   * 미뤄 둔 것을 그대로 돌려주기만 한다. 그 사이 대상이 바뀌었을 수 있고 승인 근거가
   * 낡았을 수 있으므로, 다시 확인하고 다시 승인하는 것은 사람의 일이다.
   */
  async thaw(): Promise<{ policy: FreezePolicy; deferred: DeferredAction[] }> {
    const policy = FreezePolicy.parse({ frozen: false })
    await this.#scope.set(POLICY_KEY, JSON.stringify(policy))
    return { policy, deferred: await this.deferred() }
  }

  /** 미뤄 둔 것을 남긴다. 같은 id를 덮어쓰지 않는다 — 미룬 사실도 기록이다. */
  async defer(input: Omit<DeferredAction, 'deferredAt'> & { deferredAt?: string }): Promise<boolean> {
    const record = DeferredAction.parse({ ...input, deferredAt: input.deferredAt ?? this.#now() })
    return this.#scope.setIfAbsent(deferredKey(record.id), JSON.stringify(record))
  }

  async deferred(): Promise<DeferredAction[]> {
    const keys = (await this.#scope.keys(DEFERRED_PREFIX)).sort()
    const out: DeferredAction[] = []
    for (const key of keys) {
      const raw = await this.#scope.get(key)
      if (!raw) continue
      const parsed = DeferredAction.safeParse(JSON.parse(raw))
      if (parsed.success) out.push(parsed.data)
    }
    return out
  }

  /** 사람이 다시 판단해 처리했다. **여기서 실행하지 않는다** — 실행은 기존 Grant 경로다. */
  async release(id: string): Promise<boolean> {
    if (!(await this.#scope.get(deferredKey(id)))) return false
    await this.#scope.delete(deferredKey(id))
    return true
  }
}

/** 사람이 읽는 줄. 녹인 뒤 무엇을 다시 봐야 하는지가 이 목록이다. */
export function freezeLines(policy: FreezePolicy, deferred: readonly DeferredAction[]): string[] {
  const lines: string[] = []
  lines.push(
    policy.frozen
      ? `원격 얼림 (${policy.since ?? '시점 미상'})${policy.reason ? ` — ${policy.reason}` : ''}`
      : '원격 얼림 없음',
  )
  if (policy.frozen && policy.denyRemoteRead) lines.push('  읽기도 막혀 있다 (완전 오프라인)')

  if (deferred.length > 0) {
    lines.push(`미뤄 둔 것 ${deferred.length}건 — 녹은 뒤 자동으로 나가지 않는다. 다시 확인하고 승인하라:`)
    for (const item of deferred) {
      lines.push(`  ${item.id} [${item.action}] ${item.intent} (${item.deferredAt})`)
      if (item.basis.length > 0) lines.push(`    당시 근거: ${item.basis.join(', ')} — 아직 유효한지 보라`)
    }
  }
  return lines
}
