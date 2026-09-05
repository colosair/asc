// Background Runtime — 대화가 닫혀 있어도 도는 자리 (C-12 §0·§1.1).
//
// Orchestrator는 "언제 무엇을 부를지"를 이미 안다. 없던 것은 그 회차를 **누가 계속
// 돌리는가**와, 돌고 있는지를 **사람이 어떻게 보는가**였다:
//
//   asc runtime start   터미널을 잡고 있어야 했다 — 창을 닫으면 감시가 죽는다
//   asc runtime tick    한 회차만 돈다. 부를 사람이 없으면 아무 일도 안 일어난다
//   asc runtime status  어느 빌드를 쓰는지만 답했다 (C-14 §4) — 감시가 사는지는 몰랐다
//
// 여기는 그 셋을 잇는 **상태**만 다룬다. 판정도, 감시도, 승인도 하지 않는다
// (C-12 불변식 ②). scheduler 제품도 모른다 (불변식 ④) — cron이 tick을 부르든, 떨어져
// 나간 프로세스가 스스로 돌든 같은 lease를 지난다.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ScopedStore } from '../../ports/state-store.ts'
import type { TickKind } from './orchestrator.ts'

/** 이 lease가 사는 열쇠. Monitor의 scan-lease와 다른 층이다 — 저쪽은 한 회차, 이쪽은 루프. */
export const RUNTIME_LEASE_KEY = 'runtime-lease'
/** 마지막 회차 시각이 사는 열쇠. Orchestrator가 쓰고 status가 읽는다. */
export const LAST_RUN_KEY = 'last-run'

/**
 * lease가 죽은 것으로 보이기까지의 최소 시간.
 *
 * **주기보다 길어야 한다.** 10분마다 도는 루프에 5분 만료를 걸면 회차 사이에 자기 lease가
 * 죽은 것으로 보이고, 두 번째 프로세스가 조용히 끼어든다. 그래서 회수 기준은 주기의
 * 3배이며, 이 값은 그 아래로 내려가지 않게 막는 바닥이다.
 */
export const MIN_STALE_MS = 5 * 60_000

/** 주기에서 회수 기준을 정한다. 상수를 Core에 박지 않는다 (C-12 불변식 ③). */
export const staleAfter = (intervalMs: number): number => Math.max(MIN_STALE_MS, intervalMs * 3)

export type LeaseRecord = {
  /** 누가 잡고 있는가. 사람이 읽고 죽일 수 있어야 한다. */
  owner: string
  pid: number
  /** 마지막으로 살아 있다고 말한 시각. 회차마다 갱신된다. */
  at: string
  /** 언제부터 돌고 있는가. `at`과 달리 갱신되지 않는다. */
  startedAt: string
}

export type LeaseState =
  /** 아무도 안 잡고 있다. */
  | { kind: 'FREE' }
  /** 살아 있는 주인이 있다. */
  | { kind: 'HELD'; record: LeaseRecord }
  /** 기록은 있는데 오래됐다 — 비정상 종료로 남은 것으로 본다. */
  | { kind: 'STALE'; record: LeaseRecord; silentFor: number }

/**
 * 루프 하나만 돌게 하는 lease.
 *
 * **이중 기동은 오류가 아니다** (C-12 불변식 ⑥). 늦게 온 쪽은 조용히 물러나고, 이미
 * 도는 쪽이 계속한다. 비정상 종료로 남은 lease는 시간이 지나면 회수된다 — 한 번 죽었다고
 * 영영 못 켜지면 그것이 더 나쁜 고장이다.
 */
export class RuntimeLease {
  #scope: ScopedStore
  #owner: string
  #pid: number
  #staleMs: number
  #now: () => string
  #startedAt: string | undefined

  constructor(deps: {
    scope: ScopedStore
    owner: string
    pid?: number
    staleMs?: number
    now?: () => string
  }) {
    this.#scope = deps.scope
    this.#owner = deps.owner
    this.#pid = deps.pid ?? process.pid
    this.#staleMs = deps.staleMs ?? MIN_STALE_MS
    this.#now = deps.now ?? (() => new Date().toISOString())
  }

  /** 지금 누가 잡고 있는가. 읽기만 한다 — status가 이것을 그린다. */
  async read(): Promise<LeaseState> {
    const raw = await this.#scope.get(RUNTIME_LEASE_KEY)
    if (!raw) return { kind: 'FREE' }
    let record: LeaseRecord
    try {
      record = JSON.parse(raw) as LeaseRecord
    } catch {
      // 읽을 수 없는 lease는 죽은 것으로 본다. 다만 무엇이 있었는지는 남긴다.
      return { kind: 'STALE', record: { owner: '(unreadable)', pid: 0, at: '', startedAt: '' }, silentFor: Infinity }
    }
    const silentFor = new Date(this.#now()).getTime() - new Date(record.at).getTime()
    // 시계가 뒤로 갔거나 기록이 깨졌으면 살아 있는 쪽으로 읽는다 — 남의 lease를 뺏는
    // 것보다 한 회차 쉬는 편이 싸다.
    if (Number.isNaN(silentFor)) return { kind: 'HELD', record }
    return silentFor >= this.#staleMs ? { kind: 'STALE', record, silentFor } : { kind: 'HELD', record }
  }

  /**
   * 잡는다. 이미 살아 있는 주인이 있으면 `false` — 조용히 물러나는 것이 계약이다.
   *
   * Monitor scan-lease와 같은 모양이다: `setIfAbsent` 로 원자적으로 걸고, 오래된 것만
   * 지우고 다시 건다. 확인과 쓰기 사이의 틈은 Adapter가 막는다.
   */
  async acquire(): Promise<boolean> {
    const at = this.#now()
    this.#startedAt = at
    const mine = JSON.stringify({ owner: this.#owner, pid: this.#pid, at, startedAt: at } satisfies LeaseRecord)
    if (await this.#scope.setIfAbsent(RUNTIME_LEASE_KEY, mine)) return true

    const state = await this.read()
    if (state.kind === 'HELD') return false
    await this.#scope.delete(RUNTIME_LEASE_KEY)
    return this.#scope.setIfAbsent(RUNTIME_LEASE_KEY, mine)
  }

  /**
   * 살아 있다고 말한다. 회차마다 부른다 — 이것이 없으면 주기가 만료보다 긴 순간
   * 자기 lease가 죽은 것으로 보인다.
   *
   * **남의 lease를 갱신하지 않는다.** 주인이 바뀌어 있으면 `false` 를 돌려주고, 호출자는
   * 그것을 "내가 밀려났다"로 읽는다.
   */
  async renew(): Promise<boolean> {
    const raw = await this.#scope.get(RUNTIME_LEASE_KEY)
    if (raw) {
      try {
        const held = JSON.parse(raw) as LeaseRecord
        if (held.owner !== this.#owner) return false
        this.#startedAt ??= held.startedAt
      } catch {
        // 못 읽는 lease 위에 내 것을 덮어쓴다 — 아래에서 다시 쓴다
      }
    }
    const at = this.#now()
    this.#startedAt ??= at
    await this.#scope.set(
      RUNTIME_LEASE_KEY,
      JSON.stringify({ owner: this.#owner, pid: this.#pid, at, startedAt: this.#startedAt } satisfies LeaseRecord),
    )
    return true
  }

  /** 내 것일 때만 놓는다. 남이 이미 잡았으면 건드리지 않는다. */
  async release(): Promise<void> {
    const raw = await this.#scope.get(RUNTIME_LEASE_KEY)
    if (!raw) return
    try {
      if ((JSON.parse(raw) as LeaseRecord).owner !== this.#owner) return
    } catch {
      // 못 읽는 것은 내가 남긴 것으로 보고 치운다
    }
    await this.#scope.delete(RUNTIME_LEASE_KEY)
  }
}

export type BackgroundStatus = {
  lease: LeaseState
  /** 갈래별 마지막 실행 시각. 없는 갈래는 한 번도 돌지 않았다. */
  lastRun: Partial<Record<TickKind, string>>
  /** 회수 기준. 사람이 "얼마나 조용하면 죽은 것인가"를 알아야 판단할 수 있다. */
  staleMs: number
}

/** 상태를 모은다. **읽기만 한다** — 보는 것이 상태를 바꾸면 아무도 못 본다. */
export async function readBackground(scope: ScopedStore, staleMs: number, now: () => string = () => new Date().toISOString()): Promise<BackgroundStatus> {
  const lease = await new RuntimeLease({ scope, owner: '(reader)', staleMs, now }).read()
  const raw = await scope.get(LAST_RUN_KEY)
  let lastRun: Partial<Record<TickKind, string>> = {}
  if (raw) {
    try {
      lastRun = JSON.parse(raw) as Partial<Record<TickKind, string>>
    } catch {
      // 깨진 기록은 없는 것으로 본다 — 아래 렌더가 "한 번도 돌지 않았다"로 말한다
    }
  }
  return { lease, lastRun, staleMs }
}

const ORDER: TickKind[] = ['delta', 'reconcile', 'census', 'digest']

/**
 * 사람이 읽는 줄.
 *
 * **"안 돌고 있다"와 "돌았는데 변화가 없다"를 합치지 않는다** (C-12 불변식 ⑫과 같은 태도).
 * 그래서 lease 상태와 마지막 회차 시각을 각각 말한다 — 둘 중 하나만 보면 오해한다.
 */
export function renderBackground(status: BackgroundStatus): string[] {
  const lines: string[] = []
  switch (status.lease.kind) {
    case 'FREE':
      lines.push('Background runtime: not running — `asc runtime start --detach` keeps it observing')
      break
    case 'HELD':
      lines.push(
        `Background runtime: running (pid ${status.lease.record.pid}, since ${status.lease.record.startedAt}, last heartbeat ${status.lease.record.at})`,
      )
      break
    case 'STALE':
      lines.push(
        `Background runtime: not running — a lease from pid ${status.lease.record.pid} has been silent for ` +
          `${Math.round(status.lease.silentFor / 60_000)} min and will be reclaimed on the next start`,
      )
      break
  }

  const ran = ORDER.filter((kind) => status.lastRun[kind])
  if (ran.length === 0) {
    // 설정만 하고 켜지 않은 상태다. 조용한 것과 구분해서 말한다.
    lines.push('  no pass has run yet')
    return lines
  }
  for (const kind of ORDER) {
    lines.push(`  ${kind}: ${status.lastRun[kind] ?? 'never run'}`)
  }
  return lines
}

/**
 * 파일 하나짜리 ScopedStore (설계 §5.1).
 *
 * **서비스 lease 와 workspace lease 는 다른 소유 영역이다.** 저쪽은 "이 workspace 의
 * 이번 회차를 누가 잡았는가"이고, 이쪽은 "이 기계의 runtime 을 지금 누가 도는가"다.
 * 둘을 합치면 workspace 가 늘 때마다 기계 수준 직렬화가 무너진다.
 *
 * workspace 상태 저장소를 기계 뿌리에 열지 않는 이유: 그러면 ~/.asc 에 workspace 용
 * 파일들이 생기고, 그것은 그 자리에 없어야 할 것들이다.
 */
export function fileScope(path: string): ScopedStore {
  const read = async (): Promise<Record<string, string>> => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Record<string, string>
    } catch {
      // 없거나 깨진 파일은 빈 것으로 본다 — lease 는 시간으로 회수되므로 안전하다
      return {}
    }
  }
  // tmp+rename. 반쯤 쓰인 lease 를 다른 프로세스가 읽으면 판정이 흔들린다 (C-11 불변식 ⑨).
  const write = async (data: Record<string, string>): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}`
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  }

  return {
    async get(key) {
      return (await read())[key] ?? null
    },
    async set(key, value) {
      await write({ ...(await read()), [key]: value })
    },
    async delete(key) {
      const data = await read()
      delete data[key]
      await write(data)
    },
    async keys(prefix) {
      return Object.keys(await read()).filter((key) => (prefix ? key.startsWith(prefix) : true))
    },
    async setIfAbsent(key, value) {
      const data = await read()
      if (key in data) return false
      await write({ ...data, [key]: value })
      return true
    },
  }
}
