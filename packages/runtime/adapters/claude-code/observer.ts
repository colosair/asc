// Runtime Observer — hook에서 관찰되는 활동 신호 (B-18).
//
// Safety Guard(guard.ts)와 코드를 나눈 이유: 둘은 실패의 의미가 다르다. 차단이 실패하면
// 막아야 할 것이 나가고, 관찰이 실패하면 화면 한 줄이 비는 것뿐이다. 같은 hook 안에서
// 돌더라도 telemetry가 safety 판정을 흔들 수 없어야 하고, 그 경계가 파일로 보여야 한다.
//
// 무엇을 기록하지 않는가가 더 중요하다:
//
//   heartbeat는 "worker가 살아 있다"가 아니라 **"Bash가 관찰됐다"** 까지다.
//   파일만 고치는 구간, 모델이 생각하는 구간, subagent를 기다리는 구간에는 신호가 없다 —
//   신호가 없다는 것이 멈췄다는 뜻이 아니다. 그래서 이 값으로 inactive·stale을
//   판정하지 않는다 (Renderer 규칙: render.ts).
//
// 왜 RuntimeBinding에 쓰지 않는가: binding 파일은 guard가 "이 세션이 ASC-managed인가"를
// 판별하는 근거다. 매 Bash마다 그 파일을 다시 쓰면, 쓰기 중 읽히거나 한 번 깨졌을 때
// 세션이 unmanaged로 보이고 외부 write 차단이 통째로 풀린다. 관찰값이 안전 판정을
// 망가뜨리는 구조는 만들지 않는다 — 그래서 별도 키다.

import { z } from 'zod'

import type { ScopedStore } from '../../ports/state-store.ts'

export const Heartbeat = z.object({
  logicalSessionId: z.string().min(1),
  /** binding의 owner. subagent가 여럿이어도 heartbeat는 Logical Session당 하나다. */
  physicalSessionId: z.string().min(1),
  /** 실제로 관찰된 세션 — owner일 수도 workerId일 수도 있다. */
  observedSessionId: z.string().min(1),
  lastTool: z.string().optional(),
  lastActivityAt: z.string().min(1),
})
export type Heartbeat = z.infer<typeof Heartbeat>

export const heartbeatKey = (logicalSessionId: string) => `heartbeat:${logicalSessionId}`

/** 읽는 쪽. 깨진 기록은 없는 것으로 친다 — 관찰값 때문에 화면이 죽으면 안 된다. */
export async function readHeartbeat(scope: ScopedStore, logicalSessionId: string): Promise<Heartbeat | null> {
  try {
    const raw = await scope.get(heartbeatKey(logicalSessionId))
    if (!raw) return null
    const parsed = Heartbeat.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * hook에 텍스트로 삽입되는 observer 본문. hook은 의존성 없는 단일 파일이어야 하므로
 * (guard.ts 주석) 저장 계약을 여기서 하드코딩한다 — 형식이 바뀌면 이 파일과
 * Markdown ScopedStore가 함께 움직여야 한다.
 *
 * 규약 셋:
 *   - 절대 throw하지 않는다. 호출자는 try/catch로 한 번 더 감싸지만 여기서도 삼킨다.
 *   - 아무것도 반환하지 않는다 — 호출자의 분기에 영향을 줄 값이 없어야 한다.
 *   - tmp+rename으로 쓴다. 반쯤 쓰인 파일을 다른 프로세스가 읽지 않도록.
 */
export function observerSnippet(): string {
  return `
// ── 여기부터 telemetry다 ──────────────────────────────────────────────
// 실패해도 차단 판정에 영향이 없어야 한다. 반환값 없음, 예외 없음.
function recordActivity(ascRoot, entry, observedSessionId, toolName) {
  try {
    const dir = join(ascRoot, 'adapters', 'claude-code')
    const key = 'heartbeat:' + entry.logicalSessionId
    const file = join(dir, key.replace(/[^A-Za-z0-9._-]/g, '-') + '.json')
    const value = JSON.stringify({
      logicalSessionId: entry.logicalSessionId,
      // owner를 적는다 — workerId로 매치됐어도 소유권 기록과 어긋나면 안 된다
      physicalSessionId: entry.physicalSessionId,
      observedSessionId,
      lastTool: toolName,
      lastActivityAt: new Date().toISOString(),
    })
    const tmp = file + '.tmp-' + process.pid
    writeFileSync(tmp, JSON.stringify({ key, value }, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    // 관찰 실패는 관찰 실패일 뿐이다
  }
}
`
}
