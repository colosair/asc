// Local Presentation — 마지막 안전망 (C-08 §1.3).
//
// 외부 채널이 하나도 없어도, 전부 실패해도, 판단 요청은 사라지지 않아야 한다. 그 보장을
// 지는 것이 이 adapter다 — 여기까지 실패하면 그건 로컬 환경이 망가진 것이다.
//
// 세 능력을 다 제공한다: 묶음도 보이고, 급한 것도 따로 보이고, 결정도 여기서 받는다
// (결정 자체는 기존 승인 경로가 처리한다 — 이 adapter는 보이는 데까지다).

import { renderDigest, type DigestPlan } from '../../core/presentation/digest.ts'
import type { DecisionSummary } from '../../core/view/decision-view.ts'
import type {
  DeliveryOutcome,
  DigestBatch,
  PresentationCapability,
  PresentationPort,
} from '../../ports/presentation.ts'

export type LocalPresentationDeps = {
  /** 어디로 내보낼지. 주입받는 이유는 테스트가 화면을 붙잡지 않기 위해서다. */
  write?: (line: string) => void
}

export class LocalPresentation implements PresentationPort {
  readonly id = 'local'
  readonly capabilities: ReadonlySet<PresentationCapability> = new Set<PresentationCapability>([
    'presentation.digest',
    'presentation.priority',
    'approval.interactive',
  ])
  #write: (line: string) => void

  constructor(deps: LocalPresentationDeps = {}) {
    this.#write = deps.write ?? ((line) => console.log(line))
  }

  async presentDigest(batch: DigestBatch): Promise<DeliveryOutcome> {
    // 계획 없이 batch만 받았을 때도 같은 모양으로 보인다 — 표시 형식이 한 곳에만 있게.
    const plan: DigestPlan = {
      urgent: batch.groups.find((g) => g.priority === 'P0')?.items.slice() ?? [],
      batch,
      skipped: {
        alreadyDecided: batch.suppressed?.alreadyDecided ?? 0,
        alreadyDelivered: 0,
        shadow: batch.suppressed?.shadow ?? 0,
      },
      // Port는 batch만 받는다 — 감시 상태는 계획을 만든 쪽이 알고, 채널은 모른다
      health: [],
    }
    for (const line of renderDigest(plan)) this.#write(line)
    return { ok: true }
  }

  async presentUrgent(item: DecisionSummary): Promise<DeliveryOutcome> {
    this.#write(`🔴 ${item.requestId}  ${item.reference}  ${item.title}`)
    this.#write(`   지금 확인이 필요하다 — asc inbox show ${item.requestId}`)
    return { ok: true }
  }
}
