// Claude RuntimeBinding — B-14 소유권 계약의 Claude 인스턴스 (C-03 §3).
//
// 로직은 ScopedRuntimeBindings 그대로다. 소유권의 원자성 보장을 provider마다 다시 쓰면
// 언젠가 서로 다른 것을 보장하게 된다 — 여기는 scope와 provider 이름만 고정한다.
//
// 이 scope의 파일(.asc/adapters/claude-code/runtime-binding-*.json)은 guard hook의
// 판별 목록이기도 하다: binding에 등록된 physical session만 ASC 규칙(외부 write 차단)을
// 받는다. 관리를 주장한 세션만 관리 규칙을 받는 것이다.

import { ScopedRuntimeBindings } from '../memory/runtime-binding.ts'
import type { StateStore } from '../../ports/state-store.ts'

export const CLAUDE_PROVIDER = 'claude-code'
export const CLAUDE_SCOPE = 'claude-code'

export function claudeBindings(store: StateStore): ScopedRuntimeBindings {
  return new ScopedRuntimeBindings(store.scope(CLAUDE_SCOPE))
}
