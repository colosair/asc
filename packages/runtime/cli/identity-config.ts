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
