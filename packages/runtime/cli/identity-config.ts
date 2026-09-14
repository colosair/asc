// 승인자 매핑 로드. Profile/Override에서 읽어오는 정식 경로는 B-10에서 붙고,
// 그때까지는 `.asc/identities.json` 하나를 본다.
//
// 파일이 없으면 승인은 전부 거절된다. 매핑이 없다는 것은 "아직 누구도 승인자로 지정되지
// 않았다"는 뜻이고, 그 상태에서 통과시키면 검증이 있으나 마나다 — 없으면 막는 쪽이
// 기본값이어야 한다 (OM §11.6).

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IdentityMap } from '../adapters/local/identity.ts'

export const IDENTITY_FILE = 'identities.json'

/**
 * `{ "controller-a": ["local:colosair", "mattermost:@colosair"] }` 형태.
 * 이름과 채널만 담고 비밀은 담지 않는다 (OM §4.5).
 */
export async function loadIdentityMap(root: string): Promise<IdentityMap> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, IDENTITY_FILE), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return {}

    const map: Record<string, string[]> = {}
    for (const [approver, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids)) map[approver] = ids.filter((id): id is string => typeof id === 'string')
    }
    return map
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

/** CLI 가 이 기계에서 확인할 수 있는 채널. `--as X` 는 `X: [..., "local:X"]` 가 있어야 통한다. */
export const LOCAL_CHANNEL = 'local'

/**
 * 이 기계(local 채널)에서 검증되는 승인자 이름들 — `이름: ["local:이름"]` 인 항목만.
 * 다른 채널만 있는 승인자는 밖에서는 알아보지만 여기서는 승인할 수 없다 (dogfood 2026-09-13 U2).
 */
export function localApprovers(map: IdentityMap): string[] {
  return Object.entries(map)
    .filter(([name, ids]) => ids.includes(`${LOCAL_CHANNEL}:${name}`))
    .map(([name]) => name)
}

export type IssuerResolution =
  | { ok: true; actor: string; given: boolean }
  | { ok: false; reason: 'NONE_MAPPED' | 'SEVERAL_MAPPED'; candidates: string[] }

/**
 * `--as` 를 생략했을 때 누구인가 (0.10.0 P1, 보정 B).
 *
 * "이미 알고 있는 actor" 와 "이번 결정을 내린 actor" 를 섞지 않는다 — 기본값은 **이 기계의
 * local 채널로 검증되는 승인자가 정확히 한 명일 때만** 쓴다. 그때는 결정할 수 있는 사람이
 * 그 한 명뿐이라 같은 값이다. 0 명이면 매핑이 먼저고, 2 명 이상이면 고르는 것이 곧 결정이라
 * `--as` 를 요구한다.
 */
export function resolveIssuer(given: unknown, map: IdentityMap): IssuerResolution {
  if (typeof given === 'string' && given.length > 0) return { ok: true, actor: given, given: true }
  const local = localApprovers(map)
  if (local.length === 1) return { ok: true, actor: local[0]!, given: false }
  return { ok: false, reason: local.length === 0 ? 'NONE_MAPPED' : 'SEVERAL_MAPPED', candidates: local }
}

/** 사람이 읽는 이유 — 같은 어휘를 publish 와 grant issue 가 함께 쓴다. */
export function issuerResolutionLines(failure: Extract<IssuerResolution, { ok: false }>): string[] {
  if (failure.reason === 'NONE_MAPPED') {
    return [
      '이 기계에서 승인할 수 있는 사람이 identities.json 에 없다 — 승인자 이름이 local 채널로 매핑되어야 한다.',
      '  한 번 매핑한다: asc setup identity --actor local:<이름> --role controller   (재고정 불요)',
    ]
  }
  return [
    `이 기계에서 승인할 수 있는 사람이 여럿이다 (${failure.candidates.join(', ')}) — 누가 정했는지는 고르는 것이 곧 결정이다.`,
    '  --as <이름> 으로 말하라.',
  ]
}
