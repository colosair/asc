// Project Closure — 세션이 끝난 뒤에도 남는 마무리 의무 (B-20).
//
// 근거(B-16): Logical Session이 DONE 됐을 때 프로젝트 쪽은 하나도 닫혀 있지 않았다 —
// tasks 0/17, backlog 미갱신, 작업일지 미기록, 수동 검증 미실행. 별도 closure 세션이
// 그걸 다 맞추고 나서야 실제로 끝났다. `Logical Session DONE ≠ Project Closure DONE`.
//
// 왜 Session/Handoff가 아니라 별도 기록인가:
//   ① closure는 회수 **이후**에 온다. Handoff에 넣으면 done 시점에 모르는 것을 적어야 한다.
//   ② 세션은 회수되면 archive로 간다. 거기 매달아 두면 다음 collect에서 사라진다 —
//      그게 정확히 B-20이 고치려는 문제(미완료 사실의 소실)다.
//   ③ 이건 Controller의 기록이지 세션이 스스로 선언한 계약이 아니다.
//
// 확인은 **추론하지 않는다.** Handoff 텍스트에 "backlog 갱신함"이라고 쓰여 있어도 확인이
// 아니다. Controller가 항목 id를 명시로 줄 때만 확인이다 — 문자열을 읽어 판단하는 순간
// Gate가 휴리스틱이 되고, 사람이 확인하지 않은 것을 확인됐다고 기록하게 된다.
//
// 저장은 **전부 setIfAbsent 위에 선다.** ScopedStore에서 원자성이 약속된 것은 그것뿐이고
// (`set`은 계약이 침묵한다), 잃는 것이 표시값이 아니라 사람이 한 확인이기 때문이다.
// 읽고-고쳐-쓰기를 하면 서로 다른 항목을 동시에 확인할 때 하나가 조용히 덮인다 —
// 미완료 사실의 소실을 막겠다는 모듈이 그 기록을 잃는 셈이라, 경쟁 자체가 생기지 않도록
// 항목마다 다른 키에 한 번만 쓴다. 세션당 파일이 1+N개가 되지만, 그 비용이 옳다.

import { z } from 'zod'

import type { ScopedStore } from '../../ports/state-store.ts'

/**
 * 항목 id 문법. Markdown Adapter의 파일명 변환이 단사가 아니라 `a:b`와 `a-b`가 같은
 * 파일이 되고, 그러면 setIfAbsent가 EEXIST를 돌려줘 **조용히 잃는 게 아니라 "이미
 * 확인됨"으로 오판**한다. Profile resolve가 선언 입구에서 먼저 막고, 여기서 한 번 더 본다.
 */
export const CLOSURE_ITEM_ID = /^[A-Za-z0-9._-]+$/

export const ClosureRecord = z.object({
  logicalSessionId: z.string().min(1),
  /**
   * 회수 시점 선언의 스냅샷. Profile이 나중에 바뀌어도 이 세션이 무엇을 지고 있었는지는
   * 흔들리지 않아야 한다.
   */
  declared: z.array(z.string()).default([]),
  confirmed: z.array(z.string()).default([]),
  openedAt: z.string().min(1),
  /** 전부 확인된 시각. 닫혀도 기록은 남는다 — 지우면 무엇을 닫았는지도 사라진다. */
  closedAt: z.string().optional(),
})
export type ClosureRecord = z.infer<typeof ClosureRecord>

export type ConfirmOutcome =
  | { ok: true; record: ClosureRecord; newlyClosed: boolean }
  | { ok: false; reason: 'NOT_FOUND'; detail: string }
  | { ok: false; reason: 'UNKNOWN_ITEM'; detail: string; declared: readonly string[] }
  | { ok: false; reason: 'INVALID_ITEM_ID'; detail: string }

/** 선언 스냅샷. 회수 시점에 한 번 쓰고 이후 바뀌지 않는다. */
const recordKey = (id: string) => `closure:rec:${id}`
/** 항목별 확인 마커. 이 키가 존재하면 확인된 것이다. */
const confirmKey = (id: string, item: string) => `closure:cnf:${id}:${item}`
const confirmPrefix = (id: string) => `closure:cnf:${id}:`
/** CLOSED 전이 마커. 전이를 정확히 한 번만 보고하기 위한 것이다. */
const doneKey = (id: string) => `closure:done:${id}`

type StoredRecord = { logicalSessionId: string; declared: string[]; openedAt: string }

export class ClosureLedger {
  #scope: ScopedStore
  #now: () => string

  constructor(scope: ScopedStore, now: () => string = () => new Date().toISOString()) {
    this.#scope = scope
    this.#now = now
  }

  /**
   * 회수 시점에 의무를 연다. **이미 있으면 손대지 않는다** — collect는 여러 번 돌고,
   * 두 번째 회수가 기록을 덮으면 이미 확인한 항목이 미확인으로 되돌아간다.
   * @returns 이번에 새로 연 기록. 이미 있었거나 선언이 없으면 null
   */
  async open(logicalSessionId: string, declared: readonly string[]): Promise<ClosureRecord | null> {
    if (declared.length === 0) return null // 선언하지 않은 프로젝트에 의무를 지우지 않는다

    // Profile resolve가 이미 걸렀어야 하지만, Core를 직접 부르는 경로가 우회로가 되면 안 된다
    const invalid = declared.filter((item) => !CLOSURE_ITEM_ID.test(item))
    if (invalid.length > 0) {
      throw new Error(`마무리 항목 id로 쓸 수 없는 값: ${invalid.join(', ')} (허용: A-Z a-z 0-9 . _ -)`)
    }

    const stored: StoredRecord = { logicalSessionId, declared: [...declared], openedAt: this.#now() }
    const written = await this.#scope.setIfAbsent(recordKey(logicalSessionId), JSON.stringify(stored))
    if (!written) return null
    return ClosureRecord.parse({ ...stored, confirmed: [] })
  }

  /**
   * Controller의 명시 확인. 항목마다 자기 키에 한 번만 쓰므로 서로 다른 항목을 동시에
   * 확인해도 덮이지 않고, 같은 항목을 두 번 확인해도 처음 것이 남는다.
   */
  async confirm(logicalSessionId: string, items: readonly string[]): Promise<ConfirmOutcome> {
    const stored = await this.#storedRecord(logicalSessionId)
    if (!stored) {
      return { ok: false, reason: 'NOT_FOUND', detail: `${logicalSessionId} 에 열린 마무리 항목이 없다` }
    }

    const malformed = items.filter((item) => !CLOSURE_ITEM_ID.test(item))
    if (malformed.length > 0) {
      return {
        ok: false,
        reason: 'INVALID_ITEM_ID',
        detail: `항목 id로 쓸 수 없는 값: ${malformed.join(', ')} (허용: A-Z a-z 0-9 . _ -)`,
      }
    }

    // 선언에 없는 id는 받지 않는다 — 오타를 삼키면 확인한 줄 안다
    const unknown = items.filter((item) => !stored.declared.includes(item))
    if (unknown.length > 0) {
      return {
        ok: false,
        reason: 'UNKNOWN_ITEM',
        detail: `선언에 없는 항목: ${unknown.join(', ')}`,
        declared: stored.declared,
      }
    }

    const at = this.#now()
    for (const item of items) {
      await this.#scope.setIfAbsent(confirmKey(logicalSessionId, item), at)
    }

    const confirmed = await this.#confirmedItems(logicalSessionId)
    const allDone = stored.declared.every((item) => confirmed.includes(item))

    // 마지막 두 항목을 동시에 확인하면 양쪽 다 "이제 전부 찼다"고 본다.
    // 전이를 계산으로 내면 두 번 보고되므로, 마커를 집은 쪽만 새로 닫은 것으로 친다.
    let newlyClosed = false
    if (allDone) newlyClosed = await this.#scope.setIfAbsent(doneKey(logicalSessionId), at)

    return { ok: true, record: await this.#compose(stored), newlyClosed }
  }

  async get(logicalSessionId: string): Promise<ClosureRecord | null> {
    const stored = await this.#storedRecord(logicalSessionId)
    return stored ? this.#compose(stored) : null
  }

  /** 전부. 닫힌 것도 남는다 — 무엇을 닫았는지가 사라지면 기록이 아니다. */
  async list(): Promise<ClosureRecord[]> {
    const records: ClosureRecord[] = []
    for (const key of await this.#scope.keys('closure:rec:')) {
      const raw = await this.#scope.get(key)
      if (!raw) continue
      records.push(await this.#compose(JSON.parse(raw) as StoredRecord))
    }
    return records.sort((a, b) => a.logicalSessionId.localeCompare(b.logicalSessionId))
  }

  /** 아직 닫히지 않은 것들. 세션이 archive에 있어도 여기 남아 있다. */
  async pending(): Promise<ClosureRecord[]> {
    return (await this.list()).filter((r) => r.closedAt === undefined)
  }

  async #storedRecord(logicalSessionId: string): Promise<StoredRecord | null> {
    const raw = await this.#scope.get(recordKey(logicalSessionId))
    return raw ? (JSON.parse(raw) as StoredRecord) : null
  }

  async #confirmedItems(logicalSessionId: string): Promise<string[]> {
    const prefix = confirmPrefix(logicalSessionId)
    return (await this.#scope.keys(prefix)).map((key) => key.slice(prefix.length))
  }

  /** 선언 스냅샷과 확인 마커를 합쳐 하나의 기록으로 보인다. */
  async #compose(stored: StoredRecord): Promise<ClosureRecord> {
    const confirmed = await this.#confirmedItems(stored.logicalSessionId)
    const closedAt = await this.#scope.get(doneKey(stored.logicalSessionId))
    return ClosureRecord.parse({
      ...stored,
      // 선언 순서대로 보인다 — 파일 나열 순서가 화면에 새지 않게
      confirmed: stored.declared.filter((item) => confirmed.includes(item)),
      ...(closedAt ? { closedAt } : {}),
    })
  }
}

/** 미확인 항목을 사람이 읽을 줄로. collect의 "판단이 필요한 것"에 그대로 들어간다. */
export function pendingLines(records: readonly ClosureRecord[]): string[] {
  const lines: string[] = []
  for (const record of records) {
    const pending = record.declared.filter((item) => !record.confirmed.includes(item))
    for (const item of pending) lines.push(`${record.logicalSessionId}: 마무리 미확인 — ${item}`)
  }
  return lines
}
