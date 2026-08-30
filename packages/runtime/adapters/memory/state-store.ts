// In-memory State Store — Port 계약의 참조 구현이자 테스트 기본값.
// 실제 운용 저장소는 Markdown Adapter(B-04)이고, 이 구현은 Core 로직을 파일 시스템 없이
// 검증하기 위해 존재한다. 두 Adapter가 같은 CAS semantics를 보이는지가 계약의 핵심이다.

import type { ControlState } from '../../core/model/entities.ts'
import {
  ENTITY_KEY,
  type CasResult,
  type CreateResult,
  type EntityKind,
  type EntityMap,
  type HistoryEntry,
  type ListFilter,
  type ScopedStore,
  type StateStore,
} from '../../ports/state-store.ts'

const clone = <T>(value: T): T => structuredClone(value)

const keyOf = <K extends EntityKind>(kind: K, entity: EntityMap[K]): string =>
  String((entity as Record<string, unknown>)[ENTITY_KEY[kind]])

export class MemoryStateStore implements StateStore {
  #tables = new Map<EntityKind, Map<string, unknown>>()
  #archived = new Map<EntityKind, Map<string, unknown>>()
  #scopes = new Map<string, Map<string, string>>()
  #history: HistoryEntry[] = []
  #control: ControlState = { version: 0, activeSessions: [], writeBoundaryOccupancy: [], awaitingController: [], controllerAttention: [] }

  #table<K extends EntityKind>(kind: K): Map<string, EntityMap[K]> {
    let table = this.#tables.get(kind)
    if (!table) {
      table = new Map()
      this.#tables.set(kind, table)
    }
    return table as Map<string, EntityMap[K]>
  }

  async get<K extends EntityKind>(kind: K, id: string): Promise<EntityMap[K] | null> {
    const found = this.#table(kind).get(id)
    return found ? clone(found) : null
  }

  async list<K extends EntityKind>(kind: K, filter: ListFilter<K> = {}): Promise<EntityMap[K][]> {
    const where = filter.where as Record<string, unknown> | undefined
    let rows = [...this.#table(kind).values()]
    if (where) {
      rows = rows.filter((row) =>
        Object.entries(where).every(([field, value]) => (row as Record<string, unknown>)[field] === value),
      )
    }
    return rows.slice(0, filter.limit ?? rows.length).map(clone)
  }

  async create<K extends EntityKind>(kind: K, entity: EntityMap[K]): Promise<CreateResult<EntityMap[K]>> {
    const table = this.#table(kind)
    const id = keyOf(kind, entity)
    const existing = table.get(id)
    if (existing) return { ok: false, reason: 'ALREADY_EXISTS', current: clone(existing) }
    // 회수된 것도 쓴 id 다. 다시 쓰면 그 기록 위에 다른 계약이 앉는다.
    const archived = this.#archived.get(kind)?.get(id)
    if (archived) return { ok: false, reason: 'ALREADY_EXISTS', current: clone(archived) as EntityMap[K] }
    table.set(id, clone(entity))
    return { ok: true, entity: clone(entity) }
  }

  async compareAndSet<K extends EntityKind>(
    kind: K,
    id: string,
    expectedVersion: number,
    next: EntityMap[K],
  ): Promise<CasResult<EntityMap[K]>> {
    // 버전을 올리지 않은 갱신은 계약 위반이지 경쟁 실패가 아니다 — 호출자 버그이므로 던진다.
    if (next.version !== expectedVersion + 1) {
      throw new Error(`CAS contract: next.version must be ${expectedVersion + 1}, got ${next.version}`)
    }
    const table = this.#table(kind)
    const current = table.get(id)
    if (!current) return { ok: false, reason: 'NOT_FOUND' }
    if (current.version !== expectedVersion) {
      return { ok: false, reason: 'VERSION_CONFLICT', current: clone(current) }
    }
    table.set(id, clone(next))
    return { ok: true, entity: clone(next) }
  }

  async archive<K extends EntityKind>(kind: K, id: string): Promise<boolean> {
    const table = this.#table(kind)
    const entity = table.get(id)
    if (!entity) return false
    let bucket = this.#archived.get(kind)
    if (!bucket) {
      bucket = new Map()
      this.#archived.set(kind, bucket)
    }
    bucket.set(id, entity)
    table.delete(id)
    return true
  }

  /** 테스트에서 옮겨진 것을 확인할 때 쓴다. 옮겼을 뿐 잃지 않았음을 보이기 위함이다. */
  archived<K extends EntityKind>(kind: K, id: string): EntityMap[K] | null {
    const found = this.#archived.get(kind)?.get(id)
    return found ? clone(found as EntityMap[K]) : null
  }

  async getControlState(): Promise<ControlState> {
    return clone(this.#control)
  }

  async setControlState(expectedVersion: number, next: ControlState): Promise<CasResult<ControlState>> {
    if (next.version !== expectedVersion + 1) {
      throw new Error(`CAS contract: next.version must be ${expectedVersion + 1}, got ${next.version}`)
    }
    if (this.#control.version !== expectedVersion) {
      return { ok: false, reason: 'VERSION_CONFLICT', current: clone(this.#control) }
    }
    this.#control = clone(next)
    return { ok: true, entity: clone(next) }
  }

  async appendHistory(entry: HistoryEntry): Promise<void> {
    this.#history.push(clone(entry))
  }

  async readHistory(limit?: number): Promise<HistoryEntry[]> {
    const rows = this.#history.map(clone)
    return limit ? rows.slice(-limit) : rows
  }

  scope(adapterId: string): ScopedStore {
    let bucket = this.#scopes.get(adapterId)
    if (!bucket) {
      bucket = new Map()
      this.#scopes.set(adapterId, bucket)
    }
    const store = bucket
    return {
      async get(key) {
        return store.get(key) ?? null
      },
      async set(key, value) {
        store.set(key, value)
      },
      async setIfAbsent(key, value) {
        // 단일 스레드라 확인과 쓰기 사이에 다른 코드가 끼어들지 않는다
        if (store.has(key)) return false
        store.set(key, value)
        return true
      },
      async delete(key) {
        store.delete(key)
      },
      async keys(prefix = '') {
        return [...store.keys()].filter((k) => k.startsWith(prefix))
      },
    }
  }
}
