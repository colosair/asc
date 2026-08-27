// Mattermost Presentation — 묶음과 급한 것을 메신저로 건넨다 (C-08 §1, B-13).
//
// **PresentationPort를 바꾸지 않는다.** 채널 하나가 늘었다고 계약이 흔들리면 그건 계약이
// 아니라 첫 구현의 형태였다는 뜻이다. 여기서 하는 일은 그 계약을 이 provider의 어휘로
// 옮기는 것뿐이다.
//
// 이 adapter가 지키는 세 가지:
//
//   ① 결정 표면이 없다 — 묶어서 보여주는 데까지다. approve/dismiss는 기존 결정 경로로만
//      간다 (C-08 §4). 메신저에서 버튼을 눌러 승인하는 것은 별도 계약(ApprovalChannel)이며
//      그 자리는 아직 열지 않는다.
//   ② 전달 실패가 canonical state를 흔들지 않는다 (C-08 §1.3). 못 보냈으면 못 보냈다고
//      돌려주고, 그 사실로 요청 상태를 바꾸지 않는다.
//   ③ 자격을 남기지 않는다. 토큰은 환경에서만 오고 어디에도 적히지 않는다.

import type { DecisionSummary } from '../../core/view/decision-view.ts'
import type {
  DeliveryOutcome,
  DigestBatch,
  PresentationCapability,
  PresentationPort,
} from '../../ports/presentation.ts'

/** 이 provider가 실제로 하는 것만 적는다. 결정 수신은 없다. */
const CAPABILITIES: ReadonlySet<PresentationCapability> = new Set(['presentation.digest', 'presentation.priority'])

const PRIORITY_LABEL: Record<string, string> = { P0: '🔴 지금', P1: '🟡 오늘', P2: '⚪ 이번 주' }

export type MattermostPost = { channel_id: string; message: string; root_id?: string }

export type MattermostTransport = {
  /** 게시 한 번. 성공하면 provider의 post id를 돌려준다. */
  post(payload: MattermostPost): Promise<{ ok: true; id: string } | { ok: false; error: string }>
}

export type MattermostPresentationDeps = {
  transport: MattermostTransport
  channelId: string
  /** 이 채널의 이름. 사람이 읽는 표시에만 쓰고 판정에는 쓰지 않는다. */
  id?: string
}

export class MattermostPresentation implements PresentationPort {
  readonly id: string
  readonly capabilities = CAPABILITIES
  #transport: MattermostTransport
  #channelId: string

  constructor(deps: MattermostPresentationDeps) {
    this.id = deps.id ?? 'mattermost'
    this.#transport = deps.transport
    this.#channelId = deps.channelId
  }

  async presentDigest(batch: DigestBatch): Promise<DeliveryOutcome> {
    return this.#send(renderBatch(batch))
  }

  /**
   * 지금 끊어야 하는 한 건.
   *
   * 요약만 받는다 — 전체 view를 실어 나르면 전달 한 번에 조사 한 번이 딸려 붙는다
   * (Port 주석). 더 필요하면 사람이 `requestId` 로 ASC에서 읽는다.
   */
  async presentUrgent(item: DecisionSummary): Promise<DeliveryOutcome> {
    return this.#send(renderUrgent(item))
  }

  async #send(message: string): Promise<DeliveryOutcome> {
    let result: Awaited<ReturnType<MattermostTransport['post']>>
    try {
      result = await this.#transport.post({ channel_id: this.#channelId, message })
    } catch (error) {
      // 전달 실패는 전달 실패일 뿐이다 — 요청 상태를 바꾸지 않는다 (C-08 §1.3)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    return result.ok ? { ok: true, externalRef: result.id } : { ok: false, error: result.error }
  }
}

/**
 * 묶음 한 덩어리를 메시지로. **결정 버튼을 만들지 않는다** — 여기에 버튼이 생기는 순간
 * 메신저가 결정 경로가 되고, 그건 다른 계약이다.
 */
export function renderBatch(batch: DigestBatch): string {
  const lines = [`**ASC** · ${batch.at}`]

  for (const group of batch.groups) {
    lines.push(`${PRIORITY_LABEL[group.priority] ?? group.priority} ${group.items.length}건`)
    for (const item of group.items) {
      lines.push(`- \`${item.requestId}\` ${item.reference} — ${item.title}`)
      // 묶은 뒤 값이 변한 것은 새 상태를 만들지 않고 freshness로 말한다 (C-08 §3.3)
      if (item.freshness !== 'CURRENT') lines.push(`  _(${item.freshness})_`)
    }
  }

  if (batch.suppressed?.shadow) lines.push(`⚪ 숨김 ${batch.suppressed.shadow} — 관련 근거 없음(계속 본다)`)
  if (batch.suppressed?.alreadyDecided) lines.push(`⚪ 이미 결정됨 ${batch.suppressed.alreadyDecided}`)
  if (batch.recovered) lines.push(`↺ 회수 경로에서 발견 ${batch.recovered}`)
  if (batch.groups.length === 0) lines.push('건넬 것이 없다.')

  // 결정은 ASC에서 한다. 그 사실을 매번 같이 보낸다 — 채널이 결정 표면이 아님을 사람이 알게.
  lines.push('')
  lines.push('_결정은 `asc inbox decide` 로 한다 — 이 메시지는 알림이지 승인 창구가 아니다._')
  return lines.join('\n')
}

export function renderUrgent(item: DecisionSummary): string {
  return [
    `🔴 **지금 판단이 필요하다** · \`${item.requestId}\``,
    `${item.reference} — ${item.title}`,
    `감지 ${item.detectedAt}${item.freshness === 'CURRENT' ? '' : ` · ${item.freshness}`}`,
    '',
    '_결정은 `asc inbox decide` 로 한다._',
  ].join('\n')
}
