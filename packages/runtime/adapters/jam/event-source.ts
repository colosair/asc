// JAM Incremental EventSource — 빠른 변경 회수 (C-07 §1.1).
//
// **푸시가 있다고 말하지 않는다.** JAM에는 webhook도 알림 스트림도 없다. 여기서 하는 것은
// `updated >= watermark` 조회이며, 그것은 C-07 §1.1이 Delta에 명시적으로 포함한 형태다
// ("webhook / incremental polling / provider notification / **updated-since**").
//
// 그래서 이 파일이 여는 것은 `observe.delta` 이지 push가 아니다. 둘을 같은 말로 쓰면
// "실시간이다"라는 잘못된 기대가 생기고, 그 기대 위에서 사람들이 감시 주기를 늘린다.
//
// 시각 정밀도가 핵심 위험이다. JAM의 `updated` 는 분 단위라, 같은 분 안에서 일어난
// 변경은 watermark를 그 값으로 올리는 순간 영영 안 보인다. **누락이 중복보다 위험하므로**
// 겹쳐 읽는다 — 중복은 dedupe가 거르지만 누락은 아무도 모른다.

import type { InventoryPort } from '../../ports/inventory.ts'
import type { Cursor, EventBatch, EventSource, RawEvent } from '../../ports/event-source.ts'

/**
 * 분 단위 정밀도를 덮는 겹침. JamInventory의 JQL 변환이 쓰는 값과 같은 이유로 60초다 —
 * 한쪽만 겹치면 겹치지 않은 쪽이 조용히 놓친다.
 */
export const OVERLAP_MS = 60_000

export type JamEventSourceDeps = {
  inventory: InventoryPort
  /** 이 통로의 이름. 관측 기록이 사는 scope가 이 값으로 정해진다. */
  id?: string
  now?: () => string
}

export class JamEventSource implements EventSource {
  readonly id: string
  #inventory: InventoryPort
  #now: () => string

  constructor(deps: JamEventSourceDeps) {
    this.id = deps.id ?? 'jam-updated'
    this.#inventory = deps.inventory
    this.#now = deps.now ?? (() => new Date().toISOString())
  }

  /** "지금부터 보겠다". 처음 붙인 프로젝트의 과거를 통째로 긁으면 그 자체가 잡음이다. */
  cursorFrom(since: string): Cursor {
    return since
  }

  /**
   * cursor 이후로 바뀐 것을 사건으로 흘린다.
   *
   * **cursor는 성공한 회차에만 전진한다.** 목록을 끝까지 못 봤으면(`complete=false`)
   * 그 회차의 최대 시각으로 올리지 않는다 — 못 본 구간을 본 것으로 표시하는 셈이 된다
   * (C-07 §1.5).
   */
  async drain(cursor: Cursor): Promise<EventBatch> {
    const since = cursor ?? undefined
    const page = await this.#inventory.enumerate(
      since ? { updatedSince: overlapped(since) } : {},
    )

    const events: RawEvent[] = page.items.map((item) => ({
      // 같은 항목이 같은 시각으로 다시 와도 같은 키다 — 중복은 여기서 이미 접힌다
      eventKey: `jam:${item.reference}:${item.revisionMarker}`,
      detectedAt: item.updatedAt,
      reference: item.reference,
      hints: {
        ...(item.assignees ? { actors: item.assignees } : {}),
        ...(item.labels ? { labels: item.labels } : {}),
      },
      raw: { kind: 'work_item', state: item.state, title: item.title },
    }))

    if (!page.complete) {
      // 못 본 구간이 있다. cursor를 그대로 두어 다음 회차가 같은 자리에서 다시 본다.
      return { events, cursor: cursor ?? null, hasMore: true }
    }

    const latest = page.items.reduce<string | undefined>(
      (max, item) => (max === undefined || item.updatedAt > max ? item.updatedAt : max),
      undefined,
    )
    // 이번에 아무것도 없었으면 시계를 옮기지 않는다 — 옮길 근거가 없다.
    return { events, cursor: latest ?? cursor ?? this.#now(), hasMore: false }
  }
}

/** watermark를 뒤로 물린다. 분 단위 반올림으로 같은 분의 변경을 놓치지 않기 위해서다. */
function overlapped(since: string): string {
  const at = new Date(since).getTime()
  return Number.isNaN(at) ? since : new Date(at - OVERLAP_MS).toISOString()
}
