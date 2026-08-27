// ASC.md 생성 — Agent가 세션 시작할 때 맨 먼저 읽는 파일 (OM §7.1·§9).
//
// 이것은 **생성물**이지 정책의 정본이 아니다. Core Policy와 Profile/Preset/Override를
// Resolver가 해석한 결과를 사람과 Agent가 읽기 좋게 옮겨 적은 것뿐이며, 직접 고치면
// 다음 resolve에서 덮인다. 정책을 바꾸려면 입력 계층을 고치고 다시 만든다.
//
// controller.md는 여기서 만들지 않는다. 그건 사람이 쓰는 현재 지시이고 Resolver 입력이
// 아니다 — 둘을 한 파일에 섞으면 "시스템 규칙"과 "오늘의 지시"가 구분되지 않는다.

import { decisionDomains, lookupAuthority } from '../policy/ownership.ts'
import type { ResolvedRuntime } from './load.ts'

export function renderAscMd(runtime: ResolvedRuntime, generatedAt: string): string {
  const { resolved, layers } = runtime
  const profile = layers.profile
  const lines: string[] = []

  lines.push(
    '<!-- 생성물입니다. 직접 고치지 마세요 — 다음 resolve에서 덮입니다.',
    `     입력: ${resolved.policy.layers.join(' → ')}`,
    `     생성: ${generatedAt} -->`,
    '',
    `# Agent Session Control — ${profile.id}`,
    '',
    '이 파일은 지금 적용되는 운영 규칙이다. 정책을 바꾸려면 이 파일이 아니라',
    'Profile · Preset · User Override를 고치고 다시 생성한다.',
    '',
    '## 부트스트랩 (모든 Run 공통)',
    '',
    '1. 이 파일 → `controller.md` → `state.md` → 자기 Session Contract → CHECKPOINT(있으면)',
    '2. Session Contract의 Canonical Sources를 **실제로 다시 읽는다**. 세션 파일의 요약을 믿지 않는다',
    '3. 정본이 기록된 baseline과 다르면 diff를 확인하고, 계약에 영향이 있으면 중단·보고한다',
    '',
    '## 절대 규칙',
    '',
    '- 이 목록의 행위는 Session Contract로 열 수 없다. Policy Exception으로도 열리지 않는다:',
    ...resolved.policy.hardDeny.map((item) => `  - \`${item}\``),
    '- 외부로 나가는 길은 Execution Grant 하나뿐이다. 승인은 게시 권한이 아니다',
    '- 미결은 임의로 확정하지 않는다 — UNRESOLVED로 회수한다',
    '- Verifier는 발견하고 반환한다. 고치지 않는다',
    '',
    '## Controller 허가가 필요한 행위',
    '',
    resolved.policy.softDeny.length > 0
      ? '아래는 기본 금지다. 이번 세션에 한해 Controller가 Policy Exception을 주면 열린다:'
      : '_없음_',
    ...resolved.policy.softDeny.map((item) => `- \`${item}\``),
    '',
    '## Role별 쓰기 범위',
    '',
    '| Role | 최대 범위 |',
    '|---|---|',
    ...Object.entries(resolved.policy.roleScopes).map(
      ([role, scopes]) => `| ${role} | ${scopes.length > 0 ? scopes.map((s) => `\`${s}\`` ).join(', ') : '_없음_'} |`,
    ),
    '',
    'Session Contract는 이보다 **좁아야** 한다. 넓은 범위를 요청하면 발급이 거절된다.',
    '',
    '## 정본 (Canonical Sources)',
    '',
    '| id | provider | ref | 경로 |',
    '|---|---|---|---|',
    ...profile.canonical.sources.map(
      (s) => `| ${s.id} | ${s.provider} | ${s.ref ?? '—'} | ${s.paths.length > 0 ? s.paths.join(', ') : '—'} |`,
    ),
    '',
    '스냅샷은 source별로 따로 기록한다. 하나로 뭉뚱그리지 않는다.',
    '',
    '## 파일별 쓰기 주체',
    '',
    '| 파일 | 쓰는 주체 |',
    '|---|---|',
    '| `ASC.md`, `cache/resolved-profile`, `profile.lock` | Resolver (생성물) |',
    '| `controller.md` | 사람 |',
    '| `state.md`, `blocks/`, `monitor/queue` | Controller 전용 |',
    '| `sessions/S-*` | 해당 Logical Session |',
    '| `monitor/M-*`, `monitor/inbox/`, `log-current` | Monitor / 처분 주체 |',
    '',
    '세션이 끝나면 Agent는 자기 세션 파일에 Handoff를 쓰는 데까지다.',
    'state·block·queue 갱신은 Controller가 회수한 뒤에 한다.',
    '',
  )

  if (runtime.ownership) {
    const domains = decisionDomains(runtime.ownership)
    lines.push(
      '## 책임 지도 (Ownership)',
      '',
      '| 역할 | 쓰기 영역 |',
      '|---|---|',
      ...Object.entries(runtime.ownership).map(
        ([role, spec]) =>
          `| ${role} | ${spec.paths.length > 0 ? spec.paths.map((p) => `\`${p}\``).join(', ') : '_없음 (결정만)_'} |`,
      ),
      '',
      '| 결정 영역 | 결정권자 |',
      '|---|---|',
      ...domains.map((domain) => {
        const found = lookupAuthority(runtime.ownership, domain)
        // domain 목록을 이 map에서 뽑았으므로 UNDECLARED는 나올 수 없다. 그래도 조용히
        // 넘기지 않는다 — 표에 빈칸이 뜨면 "결정권자가 없다"로 읽힌다.
        const who =
          found.kind === 'RESOLVED'
            ? found.role
            : found.kind === 'AMBIGUOUS'
              ? `**갈림 — ${found.candidates.join(' / ')}**`
              : '_선언 없음_'
        return `| ${domain} | ${who} |`
      }),
      '',
      '결정권자가 갈린 영역은 프로젝트가 아직 정하지 않은 것이다. ASC는 그중 하나를 고르지',
      '않는다 — 그 결정이 필요한 세션은 발급 전에 멈춘다.',
      '',
    )
  }

  if (Object.keys(profile.terminology).length > 0) {
    lines.push('## 이 프로젝트의 말', '', '| Core 개념 | 이 프로젝트에서 |', '|---|---|')
    for (const [core, local] of Object.entries(profile.terminology)) lines.push(`| ${core} | ${local} |`)
    lines.push('')
  }

  if (runtime.degraded.length > 0) {
    lines.push(
      '## 지금 꺼져 있는 기능',
      '',
      ...runtime.degraded.map((cap) => `- \`${cap}\` — 제공하는 Adapter가 없다`),
      '',
      '없어도 Local 경로만으로 승인은 완결된다.',
      '',
    )
  }

  return lines.join('\n')
}

/** 사람이 처음 채우는 파일. 한 번 만들고 나면 Resolver가 손대지 않는다. */
export function renderControllerMd(profileId: string): string {
  return [
    `# Controller Contract — ${profileId}`,
    '',
    '사람이 쓰는 파일이다. Resolver 입력이 아니므로 여기를 고쳐도 ASC.md는 다시 생성되지 않는다.',
    '',
    '## 현재 목표',
    '- (여기에 지금 무엇을 하려는지 적는다)',
    '',
    '## 우선순위',
    '- (포인터로 적는다. 내용을 복사하지 않는다)',
    '',
    '## 이번에 허용한 Policy Exception',
    '- (세션 id와 항목을 함께 적는다. 없으면 비워 둔다)',
    '',
    '## Controller Attention',
    '- ',
    '',
  ].join('\n')
}
