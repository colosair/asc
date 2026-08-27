// State Store Port — Core가 entity를 읽고 쓰는 유일한 통로.
// Core Contract는 이 인터페이스이지 파일 배치가 아니다 (OM §7.0). Markdown Adapter는
// 기본 구현일 뿐이고, SQLite/JSON으로 바꿔도 Core는 그대로여야 한다.
// 동시성 보장(compare-and-set, atomic rename 등)은 전부 Adapter 책임이다 (OM §7.2).

import type {
  ApprovalRequest,
  ControlState,
  ExecutionGrant,
  MonitorEvent,
  QueueItem,
  Session,
} from '../core/model/entities.ts'

/**
 * 저장 가능한 entity 종류. 모든 entity는 `version`을 갖고, 그 값이 CAS 토큰이다 —
 * 별도 etag를 두지 않는다 (C-01 §8).
 */
export type EntityMap = {
  session: Session
  request: ApprovalRequest
  grant: ExecutionGrant
  queueItem: QueueItem
  event: MonitorEvent
}
export type EntityKind = keyof EntityMap

/** entity별 primary key. event는 id 대신 eventKey를 쓴다. */
export const ENTITY_KEY: { [K in EntityKind]: keyof EntityMap[K] & string } = {
  session: 'id',
  request: 'id',
  grant: 'id',
  queueItem: 'id',
  event: 'eventKey',
}

// ── CAS semantics (C-01 §8) ───────────────────────────────────────────────────
// 전이는 예외가 아니라 결과값으로 실패한다. 두 채널이 같은 요청을 동시에 결정하는 것은
// 오류 상황이 아니라 일상이며, 호출자는 실패 사유를 보고 STALE / ALREADY_DECIDED를
// 사용자에게 설명해야 한다.

export type CasOk<T> = { ok: true; entity: T }
/**
 * 기대한 version이 아니었다 — 그 사이 누군가(다른 채널·다른 Run) 전이시켰다.
 * `current`는 실패 시점의 실제 entity로, 호출자가 이미 결정된 요청인지 판별하는 근거다.
 */
export type CasConflict<T> = { ok: false; reason: 'VERSION_CONFLICT'; current: T }
export type CasMissing = { ok: false; reason: 'NOT_FOUND'; current?: undefined }
export type CasResult<T> = CasOk<T> | CasConflict<T> | CasMissing

/** 같은 id로 두 번 만들 수 없다 — 생성도 원자적이어야 한다. */
export type CreateResult<T> = CasOk<T> | { ok: false; reason: 'ALREADY_EXISTS'; current: T }

export type ListFilter<K extends EntityKind> = {
  /** 부분 일치 조건. 지정한 필드가 전부 같은 entity만 반환한다. */
  where?: Partial<EntityMap[K]>
  limit?: number
}

/**
 * append-only History. 감지 이력과 최종 처분을 남기며, 요약·압축하지 않는다 (OM §7.3~7.4).
 * 회전은 Adapter가 무손실 이동으로 처리한다.
 */
export type HistoryEntry = {
  at: string
  actor: string
  kind: string
  ref: string
  detail?: string
}

/**
 * Adapter가 자기 부가 정보를 두는 격리된 저장 공간. Core는 이 안의 형태를 모른다 —
 * PresentationRecord 같은 채널별 metadata가 여기 산다 (§ports/approval.ts).
 */
export interface ScopedStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  keys(prefix?: string): Promise<string[]>
  /**
   * 없을 때만 쓰고, 썼는지 알려준다. 프로세스가 여럿이어도 정확히 하나만 성공해야 하므로
   * 확인과 쓰기 사이에 틈이 있으면 안 된다 — Adapter가 원자적으로 구현한다.
   * Monitor Run 하나만 돌게 하는 lease가 이 위에 선다 (OM §10.1).
   */
  setIfAbsent(key: string, value: string): Promise<boolean>
}

export interface StateStore {
  get<K extends EntityKind>(kind: K, id: string): Promise<EntityMap[K] | null>
  list<K extends EntityKind>(kind: K, filter?: ListFilter<K>): Promise<EntityMap[K][]>

  /** version 0으로 새 entity를 만든다. */
  create<K extends EntityKind>(kind: K, entity: EntityMap[K]): Promise<CreateResult<EntityMap[K]>>

  /**
   * 유일한 갱신 경로. `next.version`은 `expectedVersion + 1`이어야 하며, 저장된 version이
   * expectedVersion과 다르면 아무것도 쓰지 않고 실패한다.
   */
  compareAndSet<K extends EntityKind>(
    kind: K,
    id: string,
    expectedVersion: number,
    next: EntityMap[K],
  ): Promise<CasResult<EntityMap[K]>>

  /** Controller single-writer 상태 문서 (OM §7.2). 갱신도 CAS를 거친다. */
  getControlState(): Promise<ControlState>
  setControlState(expectedVersion: number, next: ControlState): Promise<CasResult<ControlState>>

  /**
   * 끝난 entity를 보관소로 옮긴다 (OM §7.4). 지우거나 요약하지 않는다 — 옮기기만 한다.
   * 옮겨진 것은 `get`·`list`에 더는 나타나지 않으므로, 회수처럼 "한 번만 일어나야 하는"
   * 절차가 저절로 멱등해진다.
   */
  archive<K extends EntityKind>(kind: K, id: string): Promise<boolean>

  appendHistory(entry: HistoryEntry): Promise<void>
  readHistory(limit?: number): Promise<HistoryEntry[]>

  scope(adapterId: string): ScopedStore
}
