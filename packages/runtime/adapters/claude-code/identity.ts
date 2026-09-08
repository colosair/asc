// Physical Run identity — 결합이 가리키는 것과 Guard 가 조회하는 것을 같게 한다 (0.8.4).
//
// 실기계에서 이랬다:
//
//   asc host claude bind S-… --physical windows-ssafesta-57   → 성공했다고 기록됐다
//   guard 는 hook payload 의 session_id 로 결합을 찾는다        → 그 결합을 못 본다
//
// 그래서 "결합돼 있다"고 화면이 말하는 Run 이 AUTO 에서 계속 "논리 세션 밖" 으로 막혔다.
// 막지 못하는 것을 막는 척한 것이 아니라 그 반대다 — 결합했다고 말해 놓고 결합의 효력이
// 없었다. 어느 쪽이든 화면과 집행이 갈리는 것은 같은 종류의 거짓말이다.
//
// 고치는 방법은 하나뿐이다: **bind 가 받는 값과 guard 가 읽는 값을 같은 것으로 고정한다.**
// ASC 가 스스로 알 수 있으면 스스로 취하고, 사람이 넘기면 실제 값과 대조한다.

/** Claude Code 가 자기 Run id 를 심어 두는 자리. Host 계약이라 여기서만 안다. */
export const RUN_ID_ENV = 'CLAUDE_CODE_SESSION_ID'

/**
 * Claude Run id 의 모양. hook payload 의 `session_id` 가 이 모양으로 온다.
 *
 * 모양 검사는 신원 증명이 아니다 — 그것으로 막는 것은 오타와 사람이 지어낸 라벨이지
 * 위조가 아니다. 위조를 막는 일은 Host 신뢰 경계의 몫이고, 여기서 하려 들면 못 하는 것을
 * 하는 척하게 된다.
 */
export const RUN_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 지금 이 프로세스가 도는 Run. 값이 없으면 Claude 밖에서 도는 것이다. */
export function observedRunId(env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env[RUN_ID_ENV]
  return value && value.trim().length > 0 ? value.trim() : undefined
}

export type PhysicalIdVerdict =
  | {
      ok: true
      id: string
      /**
       * observed  이 Run 을 스스로 알아냈다
       * given     사람이 넘긴 값이고 이 Run 이다
       * other-run 사람이 넘긴 값이고 **다른 Run** 이다 — 정당하지만 말은 해야 한다
       */
      source: 'observed' | 'given' | 'other-run'
      observed?: string
    }
  /** 넘긴 값이 Host 가 주는 Run id 의 모양이 아니다 — 라벨은 신원이 아니다. */
  | { ok: false; reason: 'NOT_A_RUN_ID'; detail: string; observed?: string }
  /** 아무것도 없다. */
  | { ok: false; reason: 'UNKNOWN_RUN'; detail: string; observed?: string }

/**
 * 이 결합에 쓸 physical id 를 정한다.
 *
 * ```text
 * 관측됨 + 값 없음        관측값을 쓴다        — 사람이 적을 이유가 없다
 * 관측됨 + 값 같음        그 값을 쓴다
 * 관측됨 + 값 다름        모양이 맞으면 쓴다   — 다른 Run 을 대신 묶는 정당한 경우다.
 *                                            다만 화면이 그 사실을 말한다
 * 관측 안 됨 + 모양 맞음   그 값을 쓴다
 * 모양 틀림               거부한다             — 이것이 실기계에서 났던 그 사고다
 * 관측 안 됨 + 값 없음     거부한다
 * ```
 *
 * **모양을 요구하는 것이 이 함수의 전부다.** 그 이상은 못 한다 — 다른 Run 의 id 가 진짜인지
 * 여기서 확인할 방법이 없고, 확인하는 척하면 그것이 또 하나의 거짓말이 된다. 다만 이
 * 한 가지로 실제 사고는 닫힌다: `windows-ssafesta-57` 같은 라벨은 어떤 Run 도 아니어서
 * guard 가 영영 찾지 못했고, 그 결합은 있는데도 없는 것으로 다뤄졌다.
 */
export function judgePhysicalId(input: { provided?: string; observed?: string }): PhysicalIdVerdict {
  const provided = input.provided?.trim()
  const observed = input.observed?.trim()

  if (!provided) {
    if (observed) return { ok: true, id: observed, source: 'observed', observed }
    return {
      ok: false,
      reason: 'UNKNOWN_RUN',
      detail:
        `이 Run 의 id 를 관측하지 못했다 (${RUN_ID_ENV} 없음). ` +
        '--physical 로 Run id 를 넘겨라 — guard 가 조회하는 값과 같아야 한다.',
    }
  }

  if (!RUN_ID_SHAPE.test(provided)) {
    return {
      ok: false,
      reason: 'NOT_A_RUN_ID',
      ...(observed ? { observed } : {}),
      detail:
        `'${provided}' 는 Host 가 주는 Run id 의 모양이 아니다. guard 는 Run 자신의 id 로 결합을 ` +
        '찾으므로, 사람이 붙인 라벨로 묶으면 그 결합은 기록에만 있고 아무것도 막지 못한다.',
    }
  }

  if (observed && provided !== observed) {
    return { ok: true, id: provided, source: 'other-run', observed }
  }
  return { ok: true, id: provided, source: 'given', ...(observed ? { observed } : {}) }
}
