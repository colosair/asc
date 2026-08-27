// `.asc/` 파일 배치. 이건 Markdown Adapter의 표현일 뿐 Core Contract가 아니다 —
// Core는 entity kind와 id만 알고, 어느 디렉터리에 놓이는지는 모른다 (OM §7.0).
// 배치 근거: OM §7.1.

import { join } from 'node:path'
import type { EntityKind } from '../../ports/state-store.ts'

/** entity 한 종류가 사는 디렉터리. 파일 하나가 entity 하나다 (OM §7.2). */
const ENTITY_DIR: Record<EntityKind, string> = {
  session: 'sessions/active',
  request: 'monitor/inbox',
  grant: 'monitor/grants',
  queueItem: 'monitor/queue',
  event: 'monitor/events',
}

export const CONTROL_STATE_FILE = 'state.md'
export const HISTORY_FILE = 'monitor/log-current.md'
export const VIEWS_DIR = 'monitor/views'
export const ADAPTER_SCOPE_DIR = 'adapters'

/**
 * 파일명으로 쓸 수 없는 문자를 바꾼다. event key의 `comment:531245`가 대표적이다.
 * 되돌릴 필요는 없다 — 원본 id는 파일 안에 그대로 들어 있고, 목록은 파일을 읽어 만든다.
 */
export function toFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '-')
}

export function entityDir(root: string, kind: EntityKind): string {
  return join(root, ENTITY_DIR[kind])
}

export function entityFile(root: string, kind: EntityKind, id: string): string {
  return join(entityDir(root, kind), `${toFileName(id)}.md`)
}

/** 끝난 entity가 가는 곳. 종류마다 자기 보관함을 갖는다 (OM §7.4). */
const ARCHIVE_DIR: Record<EntityKind, string> = {
  session: 'sessions/archive',
  request: 'monitor/archive/inbox',
  grant: 'monitor/archive/grants',
  queueItem: 'monitor/archive/queue',
  event: 'monitor/archive/events',
}

export function archiveDir(root: string, kind: EntityKind): string {
  return join(root, ARCHIVE_DIR[kind])
}

/** bootstrap 시 만들어 두는 디렉터리 목록. */
export function allDirs(root: string): string[] {
  return [
    ...Object.values(ENTITY_DIR).map((dir) => join(root, dir)),
    join(root, VIEWS_DIR),
    join(root, ADAPTER_SCOPE_DIR),
    ...Object.values(ARCHIVE_DIR).map((dir) => join(root, dir)),
  ]
}
