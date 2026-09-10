// 멈춘 채 잊힌 세션을 이름 댄다 — 닫지는 않는다 (0.8.5).
//
// PAUSED 는 "나중에 잇는다" 는 뜻이고, 그 나중이 오지 않으면 그대로 남는다. 실기계에서
// 한 세션이 사흘 동안 PAUSED 로 있었다: 붙들고 있는 Run 도 없고, 진행 보고도 그때
// 그대로이고, 그 회차가 하려던 일은 이미 다른 회차가 끝냈다.
//
// **자동으로 닫지 않는다.** 원격이 끝났다는 것과 이 계약이 끝났다는 것은 다른 사실이고,
// 그 둘을 잇는 판단은 사람의 것이다. 여기서 하는 일은 근거를 들어 후보로 이름 대고,
// 사람이 칠 명령을 정확히 주는 것뿐이다.

import type { Session } from '../model/entities.ts'

export type StaleSessionInput = {
  session: Pick<Session, 'id' | 'status' | 'goal' | 'checkpoint'>
  /** 이 세션을 붙들고 있는 Run 이 있는가. 있으면 잊힌 것이 아니다. */
  held: boolean
  /** 마지막 진행 보고 시각. 없으면 보고가 없었다는 뜻이다. */
  lastProgressAt?: string
}

export type StaleSession = {
  id: string
  /** 왜 후보인가. 사람이 그대로 읽는다 — 판정만 주면 믿을 근거가 없다. */
  evidence: string[]
  /** 다음에 칠 것. 둘 중 하나이며 우리가 고르지 않는다. */
  next: string[]
}

/** 이 시간이 지나도록 움직이지 않았으면 후보로 본다. 상수는 호출자가 정한다. */
export type StaleThresholds = { quietMs: number }

/**
 * 멈춘 채 아무도 붙들지 않은 세션들.
 *
 * 셋이 모두 맞을 때만 이름을 댄다 — PAUSED 이고, 붙든 Run 이 없고, 오래 조용하다.
 * 하나라도 아니면 후보가 아니다: 붙들고 있는 Run 이 있으면 누가 하고 있는 것이고,
 * 방금 멈춘 것은 잊힌 것이 아니다.
 */
export function staleSessions(
  input: readonly StaleSessionInput[],
  at: string,
  thresholds: StaleThresholds,
): StaleSession[] {
  const now = Date.parse(at)
  const out: StaleSession[] = []

  for (const row of input) {
    if (row.session.status !== 'PAUSED' || row.held) continue
    const since = row.lastProgressAt ?? row.session.checkpoint?.recordedAt
    const elapsed = since ? now - Date.parse(since) : Number.NaN
    if (!Number.isFinite(elapsed) || elapsed < thresholds.quietMs) continue

    const evidence = [
      'PAUSED · 이 세션을 붙들고 있는 Run 이 없다',
      `마지막 움직임 ${since} (${Math.floor(elapsed / 60_000)}분 전)`,
    ]
    if (row.session.checkpoint?.position) evidence.push(`멈춘 자리: ${row.session.checkpoint.position}`)
    if (row.session.checkpoint?.nextAction) evidence.push(`이어갈 것: ${row.session.checkpoint.nextAction}`)

    out.push({
      id: row.session.id,
      evidence,
      // 고르지 않는다. 이 계약이 끝난 것인지 아직 남은 것인지는 사람만 안다.
      next: [
        `asc work resume ${row.session.id}   # 아직 남은 일이면`,
        `asc work finish ${row.session.id} --verified <검증한 것> --next <다음>   # 끝난 일이면`,
      ],
    })
  }
  return out
}
