// Claude Host — 세션이 열리면 지금 상태를 되찾는다 (C-12 §4·C-03 §5.6).
//
// Core는 "여기서 Front가 열렸다"까지만 안다 (`openFront`). 이 파일이 하는 일은 그 판정을
// **Claude Code의 형식으로 옮기는 것**뿐이다:
//
//   Host lifecycle (SessionStart)  →  asc front open  →  additionalContext
//
// hook은 관찰이지 전이 권한이 아니다 (C-03 §5.6). 여기서 세션을 만들지 않고, 상태를
// 옮기지 않으며, 승인 대기를 소비하지 않는다 — 읽고 보여 주는 것이 전부다.
//
// **다른 Host가 생겨도 Core는 그대로다.** 바뀌는 것은 이 파일 같은 adapter 하나다.

/**
 * SessionStart hook이 stdout으로 내는 봉투.
 *
 * 보여 줄 것이 없으면 **아무것도 내지 않는다** (`null`). 빈 봉투를 내면 ASC와 무관한
 * 프로젝트의 모든 세션 첫 화면에 빈 블록이 붙는다 — 남의 도구를 방해하지 않는다
 * (C-11 불변식 ⑪).
 */
export function sessionStartPayload(lines: readonly string[]): string | null {
  if (lines.length === 0) return null
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: ['ASC — what is open in this workspace right now:', ...lines].join('\n'),
    },
  })
}

/**
 * SessionStart hook 본문.
 *
 * `entry` 는 이 hook을 설치한 CLI의 경로다. 그 CLI가 다시 선택된 build로 넘긴다
 * (`runtime use development` 도 그래서 그대로 먹는다) — hook이 build를 고르지 않는다.
 *
 * 계약 셋:
 *   세션을 절대 막지 않는다        — 무슨 일이 나도 exit 0, stdout은 비거나 봉투 하나
 *   ASC 무관 프로젝트에서 조용하다  — index에 없으면 CLI를 부르지도 않는다
 *   기다리게 하지 않는다           — 상한을 두고, 넘으면 그냥 지나간다
 */
export function sessionStartScript(entry: string): string {
  return `#!/usr/bin/env node
// ASC front binding (SessionStart) — 설치·갱신은 \`asc host claude install\` 로만.
// 이 자리에 붙은 ASC workspace가 있으면 지금 무엇이 걸려 있는지 세션 첫 화면에 얹는다.
// ASC와 무관한 프로젝트에서는 아무것도 하지 않는다.
//
// **이 hook은 무엇도 막지 않는다.** 어떤 실패도 exit 0 이고, 그때 stdout은 비어 있다 —
// 상태를 못 읽었다고 사람의 세션이 안 열리면 그것이 더 큰 고장이다.
//
// **workspace 신원을 여기서 판정하지 않는다.** 예전에는 index를 직접 뒤져 걸리지 않으면
// 빠져나갔는데, 그러면 아직 등록되지 않은 linked worktree에서 Host를 처음 여는 경우가
// 통째로 빠진다 — 그 자리를 풀 수 있는 것은 공용 resolver뿐이다 (C-11 §1.3).
// 여기서 보는 것은 "이 기계가 ASC를 쓰기는 하는가" 한 가지이고, 그것은 신원이 아니다.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENTRY = ${JSON.stringify(entry)}
/** 이 안에 못 끝내면 지나간다. 세션 시작을 기다리게 하지 않는다. */
const BUDGET_MS = 10_000

/**
 * 이 기계에 ASC runtime state가 있는가 — 파일 존재 확인 하나.
 *
 * 없으면 어느 경로도 ASC 자리일 수 없으므로 CLI를 부르지 않는다. 이것은 workspace
 * 판정이 아니라 "부를 이유가 있는가"이며, 그 판정은 아래 \`front open\` 이 한다.
 */
function ascUsedHere() {
  const home = process.env.ASC_HOME || join(homedir(), '.asc')
  return existsSync(join(home, 'workspace-index.json')) || existsSync(join(home, 'workspaces'))
}

function main() {
  let cwd = process.cwd()
  try {
    // SessionStart 입력에 cwd가 실린다. 없으면 프로세스의 cwd가 곧 그 자리다.
    const raw = readFileSync(0, 'utf8')
    if (raw.trim()) cwd = JSON.parse(raw).cwd || cwd
  } catch {
    // 읽지 못해도 계속한다 — 입력 형식 하나 때문에 복원을 통째로 버리지 않는다
  }

  if (!ascUsedHere()) return

  // 붙지 않은 자리에서도 이 명령은 성공하고 조용하다. 판정은 전부 저쪽이 한다.
  const run = spawnSync(process.execPath, [ENTRY, 'front', 'open', '--json'], {
    cwd,
    encoding: 'utf8',
    timeout: BUDGET_MS,
    env: process.env,
  })
  if (run.status !== 0 || !run.stdout) return

  let payload
  try {
    payload = JSON.parse(run.stdout).payload
  } catch {
    return
  }
  if (typeof payload === 'string' && payload) process.stdout.write(payload)
}

try {
  main()
} catch {
  // 세션을 막지 않는다
}
process.exit(0)
`
}
