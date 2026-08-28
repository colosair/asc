// Markdown State Store — 기본 State Store 구현 (OM §7.0~7.2).
//
// 동시성 전략은 두 층이다:
//   생성  — O_EXCL(`wx`)이 파일시스템 차원에서 중복을 막는다. 락이 필요 없다.
//   갱신  — 읽기·검사·쓰기가 한 덩어리여야 하므로 락 파일로 임계구역을 만들고,
//           내용은 임시 파일에 쓴 뒤 rename으로 갈아 끼운다. rename은 원자적이라
//           절반만 쓰인 파일이 남지 않는다.
//
// 락 대기와 CAS 충돌은 다른 사건이다. 락은 순간적이므로 잠깐 스핀해 기다리고,
// version 불일치는 "그 사이 누가 결정했다"는 사실이므로 기다리지 않고 그대로 보고한다.

import { constants } from 'node:fs'
import { access, appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

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
import {
  ADAPTER_SCOPE_DIR,
  CONTROL_STATE_FILE,
  archiveDir,
  HISTORY_FILE,
  VIEWS_DIR,
  allDirs,
  entityDir,
  entityFile,
  toFileName,
} from './layout.ts'
import { parseEntity, renderInboxView, serializeEntity } from './serialize.ts'

const LOCK_SPIN_MS = 5
const LOCK_ATTEMPTS = 200
/** 이보다 오래된 락은 죽은 프로세스가 남긴 것으로 보고 회수한다. */
const LOCK_STALE_MS = 30_000

const EMPTY_CONTROL_STATE: ControlState = {
  version: 0,
  activeSessions: [],
  writeBoundaryOccupancy: [],
  awaitingController: [],
  controllerAttention: [],
}

let tmpCounter = 0

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp.${process.pid}.${tmpCounter++}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export class MarkdownStateStore implements StateStore {
  #root: string

  constructor(root: string) {
    this.#root = root
  }

  /** `.asc/` 위치. 감추지 않는다 — 디버깅과 direct-read fallback이 이 경로를 쓴다 (C-01 §12). */
  get root(): string {
    return this.#root
  }

  /** `.asc/` 뼈대를 만든다. 이미 있으면 그대로 쓴다. */
  static async open(root: string): Promise<MarkdownStateStore> {
    for (const dir of allDirs(root)) await mkdir(dir, { recursive: true })
    return new MarkdownStateStore(root)
  }

  // ── 락 ────────────────────────────────────────────────────────────────────

  async #acquire(file: string): Promise<() => Promise<void>> {
    const lock = `${file}.lock`
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      try {
        const handle = await open(lock, 'wx')
        await handle.close()
        return async () => {
          await rm(lock, { force: true })
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // ponytail: mtime 하나로 판단하는 stale 회수. 한 호스트에서만 쓰는 동안은 충분하고,
        // 여러 호스트가 같은 .asc/를 공유하게 되면 임차(lease) 방식으로 올려야 한다.
        try {
          const age = Date.now() - (await stat(lock)).mtimeMs
          if (age > LOCK_STALE_MS) await rm(lock, { force: true })
        } catch {
          // 그 사이 풀렸다 — 다음 시도에서 잡으면 된다
        }
        await delay(LOCK_SPIN_MS)
      }
    }
    throw new Error(`could not acquire lock for ${file}`)
  }

  async #withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.#acquire(file)
    try {
      return await fn()
    } finally {
      await release()
    }
  }

  // ── entity ────────────────────────────────────────────────────────────────

  async #read<K extends EntityKind>(kind: K, file: string): Promise<EntityMap[K] | null> {
    try {
      const text = await readFile(file, 'utf8')
      return parseEntity(text, file) as EntityMap[K]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async get<K extends EntityKind>(kind: K, id: string): Promise<EntityMap[K] | null> {
    return this.#read(kind, entityFile(this.#root, kind, id))
  }

  async list<K extends EntityKind>(kind: K, filter: ListFilter<K> = {}): Promise<EntityMap[K][]> {
    const dir = entityDir(this.#root, kind)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const rows: EntityMap[K][] = []
    for (const name of names) {
      // 락·임시 파일은 entity가 아니다
      if (!name.endsWith('.md')) continue
      const entity = await this.#read(kind, join(dir, name))
      if (entity) rows.push(entity)
    }

    const where = filter.where as Record<string, unknown> | undefined
    const matched = where
      ? rows.filter((row) => Object.entries(where).every(([f, v]) => (row as Record<string, unknown>)[f] === v))
      : rows
    return matched.slice(0, filter.limit ?? matched.length)
  }

  async create<K extends EntityKind>(kind: K, entity: EntityMap[K]): Promise<CreateResult<EntityMap[K]>> {
    const id = String((entity as Record<string, unknown>)[ENTITY_KEY[kind]])
    const file = entityFile(this.#root, kind, id)

    // 회수돼 보관된 id 도 이미 쓴 id 다. 이것을 막지 않으면 같은 이름의 두 계약이 생기고,
    // 보관 파일이 덮이면서 앞의 기록이 사라진다 (실제로 그렇게 잃었다).
    const archived = join(archiveDir(this.#root, kind), `${toFileName(id)}.md`)
    if (await exists(archived)) {
      const current = (await this.#read(kind, archived))!
      return { ok: false, reason: 'ALREADY_EXISTS', current }
    }

    try {
      // 'wx'가 원자적 배타 생성이라 락 없이도 중복이 걸린다
      await writeFile(file, serializeEntity(kind, entity), { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const current = (await this.#read(kind, file))!
      return { ok: false, reason: 'ALREADY_EXISTS', current }
    }
    if (kind === 'request') await this.refreshViews()
    return { ok: true, entity }
  }

  async compareAndSet<K extends EntityKind>(
    kind: K,
    id: string,
    expectedVersion: number,
    next: EntityMap[K],
  ): Promise<CasResult<EntityMap[K]>> {
    if (next.version !== expectedVersion + 1) {
      throw new Error(`CAS contract: next.version must be ${expectedVersion + 1}, got ${next.version}`)
    }
    const file = entityFile(this.#root, kind, id)

    const result = await this.#withLock(file, async (): Promise<CasResult<EntityMap[K]>> => {
      const current = await this.#read(kind, file)
      if (!current) return { ok: false, reason: 'NOT_FOUND' }
      if (current.version !== expectedVersion) return { ok: false, reason: 'VERSION_CONFLICT', current }
      await writeAtomic(file, serializeEntity(kind, next))
      return { ok: true, entity: next }
    })

    if (result.ok && kind === 'request') await this.refreshViews()
    return result
  }

  /** 파일을 보관 디렉터리로 옮긴다. 내용은 그대로다 — 요약도 삭제도 하지 않는다. */
  async archive<K extends EntityKind>(kind: K, id: string): Promise<boolean> {
    const from = entityFile(this.#root, kind, id)
    if (!(await exists(from))) return false
    const dir = archiveDir(this.#root, kind)
    await mkdir(dir, { recursive: true })
    const to = join(dir, `${toFileName(id)}.md`)
    // 보관은 덮어쓰기가 아니다. 같은 이름이 이미 있으면 옮기지 않고 그대로 둔다 —
    // 기록 하나를 살리자고 다른 기록을 지우지 않는다.
    if (await exists(to)) return false
    await rename(from, to)
    return true
  }

  // ── Control State ─────────────────────────────────────────────────────────

  async getControlState(): Promise<ControlState> {
    const file = join(this.#root, CONTROL_STATE_FILE)
    try {
      return parseEntity(await readFile(file, 'utf8'), file) as ControlState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_CONTROL_STATE }
      throw error
    }
  }

  async setControlState(expectedVersion: number, next: ControlState): Promise<CasResult<ControlState>> {
    if (next.version !== expectedVersion + 1) {
      throw new Error(`CAS contract: next.version must be ${expectedVersion + 1}, got ${next.version}`)
    }
    const file = join(this.#root, CONTROL_STATE_FILE)
    return this.#withLock(file, async () => {
      const current = await this.getControlState()
      if (current.version !== expectedVersion) return { ok: false as const, reason: 'VERSION_CONFLICT' as const, current }
      await writeAtomic(file, renderControlState(next))
      return { ok: true as const, entity: next }
    })
  }

  // ── History ───────────────────────────────────────────────────────────────

  async appendHistory(entry: HistoryEntry): Promise<void> {
    const file = join(this.#root, HISTORY_FILE)
    const line = [entry.at, entry.actor, entry.kind, entry.ref, entry.detail ?? ''].join(' | ')
    // append-only. 요약하거나 줄이지 않는다 — 오래된 것은 archive로 옮길 뿐이다 (OM §7.4).
    await this.#withLock(file, () => appendFile(file, `${line}\n`, 'utf8'))
  }

  async readHistory(limit?: number): Promise<HistoryEntry[]> {
    const file = join(this.#root, HISTORY_FILE)
    if (!(await exists(file))) return []
    const rows = (await readFile(file, 'utf8'))
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        // detail에 구분자가 들어 있어도 잃지 않도록 앞 네 칸만 자르고 나머지는 합친다
        const [at, actor, kind, ref, ...rest] = line.split(' | ')
        const detail = rest.join(' | ')
        return { at: at!, actor: actor!, kind: kind!, ref: ref!, ...(detail ? { detail } : {}) }
      })
    return limit ? rows.slice(-limit) : rows
  }

  // ── Adapter scope ─────────────────────────────────────────────────────────

  scope(adapterId: string): ScopedStore {
    const dir = join(this.#root, ADAPTER_SCOPE_DIR, toFileName(adapterId))
    const fileFor = (key: string) => join(dir, `${toFileName(key)}.json`)

    return {
      async get(key) {
        try {
          return JSON.parse(await readFile(fileFor(key), 'utf8')).value as string
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }
      },
      async set(key, value) {
        await mkdir(dir, { recursive: true })
        // key도 함께 적는다 — 파일명은 문자를 바꿔 저장하므로 되돌릴 수 없다
        await writeAtomic(fileFor(key), JSON.stringify({ key, value }, null, 2))
      },
      async setIfAbsent(key, value) {
        await mkdir(dir, { recursive: true })
        try {
          // 'wx'가 파일시스템 차원의 배타 생성이라, 프로세스가 여럿이어도 하나만 성공한다
          await writeFile(fileFor(key), JSON.stringify({ key, value }, null, 2), { encoding: 'utf8', flag: 'wx' })
          return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
          throw error
        }
      },
      async delete(key) {
        await rm(fileFor(key), { force: true })
      },
      async keys(prefix = '') {
        let names: string[]
        try {
          names = await readdir(dir)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
          throw error
        }
        const keys: string[] = []
        for (const name of names) {
          if (!name.endsWith('.json')) continue
          const { key } = JSON.parse(await readFile(join(dir, name), 'utf8'))
          if (typeof key === 'string' && key.startsWith(prefix)) keys.push(key)
        }
        return keys
      },
    }
  }

  // ── Derived View ──────────────────────────────────────────────────────────

  /** 지워도 되고 언제든 다시 만들 수 있다 (OM §7.3). */
  async refreshViews(): Promise<void> {
    const requests = await this.list('request')
    await mkdir(join(this.#root, VIEWS_DIR), { recursive: true })
    await writeAtomic(join(this.#root, VIEWS_DIR, 'inbox.md'), renderInboxView(requests))
  }
}

function renderControlState(state: ControlState): string {
  const lines = [
    '<!-- asc:entity',
    JSON.stringify(state, null, 2),
    '-->',
    '',
    '# Execution',
    `활성 Block: ${state.activeBlock ?? '없음'}`,
    `활성 세션: ${state.activeSessions.join(', ') || '없음'}`,
    `Write Boundary 점유: ${state.writeBoundaryOccupancy.join(', ') || '없음'}`,
    `승인 대기: ${state.awaitingController.join(', ') || '없음'}`,
    '',
    '# Monitoring',
    '포인터만 둔다 — 숫자·시각은 갱신자가 없으므로 적지 않는다.',
    'Inbox 미처분: monitor/views/inbox.md',
    '',
    '# Controller Attention',
    ...(state.controllerAttention.length > 0 ? state.controllerAttention.map((a) => `- ${a}`) : ['- (없음)']),
  ]
  return lines.join('\n') + '\n'
}
