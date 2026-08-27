// Background Orchestrator — 실행 계기를 갖는 자리 (C-12 §1).
//
// 지금까지 감시는 사람이 `asc monitor scan` 을 칠 때만 돌았다. lease·retry·cursor 같은
// 재진입 안전장치는 완비인데 **재진입시키는 주체가 없었다.**
//
// 이 모듈이 하는 일은 계기뿐이다:
//
//   하는 일    언제 무엇을 부를지 정한다
//   안 하는 일 판정한다 / 상태를 만든다 / 승인한다
//
// 같은 함수를 사람이 부르든 여기가 부르든 결과가 같아야 한다 (C-12 불변식 ②).
// 그래서 이 파일에는 Monitor·Approval의 로직이 한 줄도 없다 — 호출만 있다.
//
// 주기는 Core 상수가 아니다 (C-12 불변식 ③). 호출자가 정해 넣는다.
// scheduler 제품도 모른다 (불변식 ④) — cron이 이걸 부르든, 이게 스스로 돌든 같다.

export type TickKind = 'delta' | 'reconcile' | 'census' | 'digest'

/** 한 회차에 무엇을 할지. 실패는 다음 회차로 넘어간다 — 한 번 실패가 루프를 죽이지 않는다. */
export type TickOutcome = {
  at: string
  ran: TickKind[]
  skipped: TickKind[]
  failures: { kind: TickKind; detail: string }[]
}

export type Schedule = {
  /** 각 작업의 최소 간격(ms). 0이면 매 회차마다. */
  deltaMs: number
  reconcileMs: number
  censusMs: number
  digestMs: number
}

export type OrchestratorDeps = {
  schedule: Schedule
  /** 실제 일. 없는 갈래는 아예 돌리지 않는다 — 없는 것을 있는 척하지 않는다. */
  actions: Partial<Record<TickKind, () => Promise<void>>>
  /**
   * 마지막 실행 시각을 어디에 남길지. 재기동 후 복원의 근거가 이것뿐이다 (C-12 §1.1).
   * 저장에 실패하면 다음 회차가 더 자주 도는 것으로 끝난다 — 감지가 멈추는 것보다 낫다.
   */
  lastRunAt: {
    read: () => Promise<Partial<Record<TickKind, string>>>
    write: (kind: TickKind, at: string) => Promise<void>
  }
  now?: () => string
  /** 진행 상황을 사람이 볼 수 있게. 조용히 도는 것은 상시성이 아니라 불투명이다. */
  log?: (line: string) => void
}

const ORDER: TickKind[] = ['delta', 'reconcile', 'census', 'digest']

export class Orchestrator {
  #deps: OrchestratorDeps
  #now: () => string
  #stopped = false

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps
    this.#now = deps.now ?? (() => new Date().toISOString())
  }

  /**
   * 한 회차. **호출 자체가 계기다** — 이 함수를 cron이 불러도, 아래 run()이 불러도 같다.
   *
   * 간격이 안 됐으면 건너뛴다. 건너뛴 것도 결과에 남긴다 — "돌았는데 아무 일도 없었다"와
   * "아예 안 돌았다"는 다른 사실이다.
   */
  async tick(): Promise<TickOutcome> {
    const at = this.#now()
    const last = await this.#deps.lastRunAt.read()
    const outcome: TickOutcome = { at, ran: [], skipped: [], failures: [] }

    for (const kind of ORDER) {
      const action = this.#deps.actions[kind]
      if (!action) continue
      if (!due(last[kind], at, intervalOf(this.#deps.schedule, kind))) {
        outcome.skipped.push(kind)
        continue
      }
      try {
        await action()
        outcome.ran.push(kind)
        // 성공한 것만 시각을 옮긴다. 실패한 회차를 "했다"로 적으면 다음 회차가 건너뛴다.
        await this.#deps.lastRunAt.write(kind, at)
      } catch (error) {
        outcome.failures.push({ kind, detail: error instanceof Error ? error.message : String(error) })
      }
    }
    return outcome
  }

  /**
   * 멈출 때까지 돈다.
   *
   * 회차 하나가 터져도 루프는 계속한다 — 외부가 잠깐 죽었다고 감시가 영영 서면
   * 그 사이의 변화는 아무도 보지 못한다. 대신 실패를 조용히 삼키지 않고 남긴다.
   */
  async run(intervalMs: number, sleep: (ms: number) => Promise<void>): Promise<void> {
    this.#stopped = false
    while (!this.#stopped) {
      const outcome = await this.tick()
      this.#deps.log?.(renderTick(outcome))
      if (this.#stopped) break
      await sleep(intervalMs)
    }
  }

  stop(): void {
    this.#stopped = true
  }
}

const intervalOf = (schedule: Schedule, kind: TickKind): number =>
  kind === 'delta'
    ? schedule.deltaMs
    : kind === 'reconcile'
      ? schedule.reconcileMs
      : kind === 'census'
        ? schedule.censusMs
        : schedule.digestMs

/** 간격이 찼는가. 기록이 없으면 처음이므로 돈다. */
function due(lastAt: string | undefined, at: string, intervalMs: number): boolean {
  if (!lastAt) return true
  const elapsed = new Date(at).getTime() - new Date(lastAt).getTime()
  // 시계가 뒤로 갔거나 기록이 깨졌으면 도는 쪽을 고른다 — 멈춰 있는 것이 더 나쁘다
  return Number.isNaN(elapsed) || elapsed >= intervalMs
}

export function renderTick(outcome: TickOutcome): string {
  const parts = [`${outcome.at}`]
  parts.push(outcome.ran.length > 0 ? `실행 ${outcome.ran.join(', ')}` : '실행 없음')
  if (outcome.skipped.length > 0) parts.push(`간격 대기 ${outcome.skipped.join(', ')}`)
  for (const failure of outcome.failures) parts.push(`실패 ${failure.kind}: ${failure.detail}`)
  return parts.join(' · ')
}
