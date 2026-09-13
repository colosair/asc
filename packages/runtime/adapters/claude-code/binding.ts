// Claude RuntimeBinding — B-14 소유권 계약의 Claude 인스턴스 (C-03 §3).
//
// 로직은 ScopedRuntimeBindings 그대로다. 소유권의 원자성 보장을 provider마다 다시 쓰면
// 언젠가 서로 다른 것을 보장하게 된다 — 여기는 scope와 provider 이름만 고정한다.
//
// 이 scope의 파일(.asc/adapters/claude-code/runtime-binding-*.json)이 "어느 Run 이 어느
// 논리 세션을 쥐고 있는가" 의 정본이다: 진척 보고·pause·finish 의 소유권 검사가 이것을
// 읽고, `asc work start` 가 현재 Run 을 여기에 묶는다 (0.9.0).

import { ScopedRuntimeBindings } from '../memory/runtime-binding.ts'
import type { StateStore } from '../../ports/state-store.ts'

export const CLAUDE_PROVIDER = 'claude-code'
export const CLAUDE_SCOPE = 'claude-code'

export function claudeBindings(store: StateStore): ScopedRuntimeBindings {
  return new ScopedRuntimeBindings(store.scope(CLAUDE_SCOPE))
}
