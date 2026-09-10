// Consumption — 답이 왔다는 것과 그 답이 아직 처리되지 않았다는 것은 다른 사실이다 (0.8.5 · C).
//
// 실기계 #148: 내가 Game 파트에 물었고 상대가 답했고 그 스레드에 내 후속 댓글이 없다.
// "상대가 마지막 발언자 → 내 차례" 로 접으면 참이 아니다 — 그 답은 이미 다른 판단에
// 쓰였고, 사람은 같은 것을 두 번 처리하게 된다.
//
// 그래서 마지막 사실 하나를 더 본다: **그 답이 온 뒤에 ASC 가 그 자원을 두고 무언가를
// 했는가.** 했다면 이 자리는 더 물을 곳이 아니다.
//
// 이 파일이 하지 않는 것:
//   - 사람의 처리 여부를 추측하지 않는다. ASC 가 가진 기록만 본다
//   - 기록이 없는 것을 "처리 안 됨" 의 증명으로 쓰지 않는다 — 그것은 모른다는 뜻이다
//   - 새 정본을 만들지 않는다. 전부 기존 append-only 증거에서 파생한다

/** ASC 가 이 자원에 대해 이미 가지고 있는 사실 하나. */
export type ConsumptionSignal = {
  /** 무엇에서 나온 사실인가. 사람이 그대로 읽는다. */
  source: string
  /** 언제 있었던 일인가. */
  at: string
}

export type Consumption =
  /** 답이 온 뒤에 ASC 가 그 자원을 두고 무언가를 했다. */
  | { kind: 'CONSUMED_ELSEWHERE'; by: ConsumptionSignal }
  /** 볼 수 있는 곳을 봤고 그 뒤의 기록이 없다. **처리 안 됐다는 증명은 아니다.** */
  | { kind: 'UNCONSUMED'; checked: readonly string[] }
  /** 볼 곳이 없었다. 답이 처리됐는지 우리는 모른다. */
  | { kind: 'UNKNOWN'; detail: string }

/**
 * 답이 온 뒤에 무언가 있었는가.
 *
 * `since` 는 남이 마지막으로 말한 시각이다. 그보다 **뒤에** 있는 기록만 센다 — 답이 오기
 * 전의 기록은 그 답을 처리한 것일 수 없다.
 */
export function judgeConsumption(
  since: string | undefined,
  signals: readonly ConsumptionSignal[],
  checked: readonly string[],
): Consumption {
  if (checked.length === 0) return { kind: 'UNKNOWN', detail: 'ASC 가 이 자원의 처리 기록을 볼 통로가 없다' }
  if (!since) return { kind: 'UNKNOWN', detail: '답이 언제 왔는지 몰라 그 뒤를 가릴 수 없다' }

  const base = Date.parse(since)
  if (Number.isNaN(base)) return { kind: 'UNKNOWN', detail: `답이 온 시각을 읽지 못했다 (${since})` }

  let latest: ConsumptionSignal | undefined
  for (const signal of signals) {
    const at = Date.parse(signal.at)
    if (Number.isNaN(at) || at < base) continue
    if (!latest || at > Date.parse(latest.at)) latest = signal
  }
  return latest ? { kind: 'CONSUMED_ELSEWHERE', by: latest } : { kind: 'UNCONSUMED', checked }
}

/**
 * 지금 이것이 누구의 차례인가 (0.8.5).
 *
 * **저장하지 않는다.** 방향은 감지 시점의 관측이고 소비는 지금의 기록이라, 둘을 합친
 * 값은 볼 때마다 다시 계산해야 맞다. 저장하면 그 순간부터 두 번째 정본이 된다.
 */
export type Obligation = 'ACTION_REQUIRED_BY_ME' | 'WAITING_ON_OTHER' | 'CONSUMED_ELSEWHERE' | 'UNKNOWN'

export function obligationOf(
  direction: 'INBOUND' | 'OUTBOUND' | 'UNKNOWN' | undefined,
  consumption: Consumption,
): Obligation {
  if (direction === 'OUTBOUND') return 'WAITING_ON_OTHER'
  if (direction !== 'INBOUND') return 'UNKNOWN'
  return consumption.kind === 'CONSUMED_ELSEWHERE' ? 'CONSUMED_ELSEWHERE' : 'ACTION_REQUIRED_BY_ME'
}

/** 사람이 읽는 한 줄. 판정만 주면 왜 그런지 알 수 없다. */
export function obligationLine(obligation: Obligation, consumption: Consumption): string {
  switch (obligation) {
    case 'WAITING_ON_OTHER':
      return '내가 마지막으로 말했다 — 상대 차례다'
    case 'CONSUMED_ELSEWHERE':
      return consumption.kind === 'CONSUMED_ELSEWHERE'
        ? `답이 온 뒤 ${consumption.by.source} (${consumption.by.at}) — 이미 다른 자리에서 다뤄졌다`
        : '이미 다른 자리에서 다뤄졌다'
    case 'ACTION_REQUIRED_BY_ME':
      return consumption.kind === 'UNCONSUMED'
        ? `답이 왔고 그 뒤 기록이 없다 (확인한 곳: ${consumption.checked.join(', ')})`
        : '답이 왔다'
    default:
      return consumption.kind === 'UNKNOWN' ? consumption.detail : '누구 차례인지 가를 근거가 없다'
  }
}
