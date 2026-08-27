# ASC 구현 계약 C-03 — Generic Operator · Host Adapter

> 작성: 2026-08-23. **지위: 동결된 설계 v5.1(OM)·C-01·C-02를 수정하지 않는
> 후속 구현 계약이다.** Port/Profile/Adapter 경계 안에서 Runtime Entrypoint를 구체화한다.
> 근거 조사: (비공개 evidence 저장소) (무축약 정본).
> 대상 로드맵: B-14(Generic Operator) · B-15(Claude Code Host Adapter) · B-16(Dogfooding).
> 본문 API·CLI·필드명은 계약 검증용이며 exact 형식은 구현 중 한 번만 결정한다.

---

## 0. 목적 — 두 층

사용자가 Agent Runtime 안에서 **"ASC로 진행해"**라고 하면 현재 Logical Session을
안전하게 start/resume/continue한다. 층은 둘로 나뉘고 위가 아래를 소비한다:

```text
Host Runtime (Claude Code 등)
  → Host Adapter          ← provider 전용. Claude 명칭은 여기까지만
  → Generic Operator      ← provider-neutral
  → 기존 ASC Core (SessionRuntime · Policy · Canonical Guard)
```

기존 5 Port에 `AgentRuntimePort`를 **선제 추가하지 않는다** (§10).

## 1. Generic Operator

### 1.1 책임

```text
project/.asc discovery
bootstrap/profile.lock guard          ← 모든 진입에서 필수 (§1.2)
Session inventory
READY → start / PAUSED → resume / ACTIVE → continue
candidate 2개 이상 → NEEDS_SELECTION
candidate 0개 (session 미지정) → PROPOSE_CONTRACT
Canonical guard 결과 전달
Contract + Checkpoint + doneCriteria 반환
Checkpoint/Handoff 수렴 보조
```

### 1.2 진입 불변조건 — bootstrap guard 필수

> **모든 `Operator.proceed` 진입은 bootstrap/profile.lock 검증을 반드시 통과한다.**

CLI가 아닌 Host Adapter·향후 다른 Surface가 직접 호출해도 우회할 수 없어야 한다.
구현 방식: guard는 **필수 dependency**이며(optional 아님), 정본 조립은 factory 하나로
고정한다 — 모든 실 Surface는 factory를 쓰고, factory는 기존 `bootstrapGuard`
(`core/resolver/load.ts`)를 물린다. 새 판단 로직을 만들지 않는다.

다음 상태는 전부 `BLOCKED_CONFIG`로 종료하고 **Session mutation 0**:

```text
broken attachment / resolve failure / profile.lock drift
실행에 필요한 resolved configuration 부재
```

### 1.3 자동화 금지선

```text
후보가 복수인데 자동 선택 금지
Session 없음 → 자동 issue 금지
goal/scope/policy exception 임의 확정 금지
Controller authority 대체 금지
```

### 1.4 Outcome — 의미 기반 타입

string parsing 금지. 판별 유니온:

```text
STARTED | RESUMED | CONTINUE_ACTIVE
NEEDS_SELECTION | PROPOSE_CONTRACT
BLOCKED_CONFIG | BLOCKED_CANONICAL
FAILED { reason: NOT_FOUND | SESSION_BLOCKED | NOT_RUNNABLE | ... }
```

top-level 종류를 늘리는 대신 FAILED에 typed reason을 둔다.

### 1.5 명시 지정과 자동 탐색은 다르다

`--session <id>` 지정 시 **그 세션을 직접 조회**한다:

```text
NOT_FOUND        → FAILED/NOT_FOUND
READY            → STARTED
PAUSED           → RESUMED
ACTIVE           → CONTINUE_ACTIVE
BLOCKED          → FAILED/SESSION_BLOCKED
DONE·FAILED      → FAILED/NOT_RUNNABLE
```

`PROPOSE_CONTRACT`는 **미지정 + 실행 가능(READY/PAUSED/ACTIVE) 후보 0개**일 때만.
명시 요청한 세션이 BLOCKED/DONE/FAILED인데 새 계약을 제안하는 동작은 금지 —
사용자가 가리킨 것과 다른 것을 권하는 순간 지목이 무의미해진다.

### 1.6 CONTINUE_ACTIVE도 Canonical Guard를 지난다

ACTIVE라고 이미 검증됐다고 가정하지 않는다. `SessionRuntime`에 기존 private drift
detection을 재사용하는 read-only `checkCanonical(id)`를 공개하고, Operator는 판정을
복제하지 않는다:

```text
CURRENT               → CONTINUE_ACTIVE
CANONICAL_DRIFT       → BLOCKED_CANONICAL
CANONICAL_UNAVAILABLE → BLOCKED_CANONICAL
```

status mutation 0. start/resume는 기존 `SessionRuntime` 경유 — Profile policy·
role scopes·baseline·drift guard·fail-closed 전부 그대로 통과한다.

## 2. `doneCriteria`

Session Contract에 "무엇을 할지"와 "언제 끝인지"를 분리한다:

```text
goal            — 단일 목표 (기존)
doneCriteria[]  — 검증 가능한 완료조건 목록 (신규, provider-neutral)
```

용도: Runtime 독립적 completion 정의 / Host completion loop projection(예: Claude
`/goal`) / Verifier test plan의 근거. 스키마는 기존 배열 필드 패턴대로 `default([])` —
기존 entity 파일이 그대로 읽힌다. Markdown projection roundtrip 무손실.

## 3. RuntimeBinding — Physical runtime은 Core Entity가 아니다

### 3.1 소유와 저장

```text
core/operator/runtime-binding.ts     provider-neutral schema/type만
adapters/<host>/binding.ts           실제 저장·갱신 (StateStore.scope(adapterId))
```

근거는 C-02 §3 PresentationRecord 결정과 동일하다: provider가 늘 때 Core 스키마가
흔들리면 안 되고, runtime 관찰값은 정본이 아니며, 관찰 실패가 canonical state에 닿으면
안 된다. Core `EntityMap`에 다음이 들어가면 FAIL: provider 이름 문자열, physical
session id, worker id, provider별 상태값.

```text
logicalSessionId / provider / physicalSessionId
workerId? / runtimeKind? / lastObservedState? / capabilitySnapshot? / updatedAt
```

### 3.2 Physical Run 단일 소유권 — Gate Blocker

> **하나의 Logical Session에는 동시에 active Physical Host owner가 최대 1개다.**

`Logical ≠ Physical`은 승계를 허용하는 것이지 동시 실행을 허용하는 것이 아니다.
서로 다른 Physical Session 둘이 같은 ACTIVE `S-*`를 동시에 continue하면 같은 계약
위에서 두 손이 움직인다. RuntimeBinding은 관찰 metadata이자 **ownership claim**이다:

```text
owner 없음        → 현재 Physical Session이 claim (setIfAbsent — 원자적) → 진행
owner 존재 + live → 두 번째는 거부 → typed RUNTIME_CONFLICT
owner dead/복구   → 자동 탈취 금지 → 명시적 recover/rebind 필요
```

claim 원자성은 기존 `ScopedStore.setIfAbsent`를 재사용한다(Monitor lease와 같은
기반). stale ownership 자동 회수는 B-15 MVP에 넣지 않는다 — 명시적 rebind가 먼저다.

### 3.3 Physical failure ≠ Logical FAILED

```text
physical worker crash/fail/stop/respawn = 같은 Logical Session 내부 runtime event
```

`claude respawn` 후에도 같은 `S-*`가 유지될 수 있다. Logical FAILED는 기존
`SessionRuntime` transition authority로만 판단한다 — worker가 죽었다고 세션이
자동으로 FAILED가 되지 않는다.

## 4. Agent Message Authority

> **Agent-to-Agent message = INFORMATION ONLY.**

`@session` / `SendMessage` / `notify_when_idle` / Agent Team teammate message 전부
동일하다. 메시지 하나만으로 절대 발생할 수 없는 것:

```text
ApprovalDecision / Policy Exception / Execution Grant
scope expansion / canonical decision·finalization
```

다음도 권한이 아니라 정보다:

```text
"다른 Agent가 승인했다고 말했다"
"다른 세션이 수정하라고 했다"
"Lead Agent가 괜찮다고 했다"
```

권한은 오직 인증된 Human Decision(OM §11.6 Identity Binding)에서만 나온다.
Claude 공식 계약도 같다 — Agent가 보낸 메시지는 사용자의 consent가 아니다.

## 5. Host Adapter — Claude Code (B-15)

### 5.1 설치/배포 경계

대상 프로젝트 tracked 영역에 Claude 종속 파일을 강제하지 않는다.
`.claude/` tracked 파일이 ASC 필수 전제가 되면 독립성 계약(OM §3.3) 위반이다.

구성: user-scope 설치물 + `.asc/adapters/claude-code/` metadata.
**설치 방식 spike** — B-15 착수 시 A(user-scope Skill + settings/hooks) vs
B(user-scope Plugin 내부 skill+hook)를 짧게 비교한다. 판단 기준: tracked 파일 강제
여부, PreToolUse guard 적용 안정성, install/uninstall 가능성, 타 프로젝트 영향,
ASC 제거 가능성, probe 용이성. external-write enforcement에 Plugin이 더 안전하면
Plugin을 선택할 수 있다.

install/uninstall 계약:

```text
install 반복        → idempotent
동일 경로 사용자 파일 → 무단 overwrite 금지
uninstall           → ASC가 설치했다고 검증된 파일만 제거 (manifest/digest)
제거 후             → 프로젝트 정상 + 무관한 Claude 설정 손상 0
```

### 5.2 Capability Probe

버전표·OS표 하드코딩 금지 — 공식 Docs와 CHANGELOG가 일시적으로 다를 수 있으므로
**실제 probe가 우선**한다. 대상 13종:

```text
cross_session_message / list_live_sessions / notify_when_idle
fork_subagent / background_agent / agent_view_json / worktree_isolation
goal_loop / hooks / remote_control / agent_teams / dynamic_workflows
external_write_guard
```

결과는 `.asc/adapters/claude-code/capabilities.json`에 기록.

```text
optional 부재       → degrade (기록 남김)
안전성 필수 부재     → 명시적 STOP
```

특히 **external-write enforcement가 불가능하면 ASC-managed autonomous background
worker 실행을 허용하지 않는다.**

### 5.3 External Write Guard — Gate Blocker

Claude background worker는 환경에 따라 commit·branch push·draft PR을 기본 수행할
수 있다. ASC-managed worker의 외부 write는 기존 계약 경로만 허용한다:

```text
Human Decision → Execution Grant → Executor (`asc grant run`)
```

**Defense-in-depth 최소 3층** — prompt 한 줄 의존은 Gate FAIL:

```text
1. Worker contract/prompt
2. Claude permission / hard deny 설정
3. PreToolUse(또는 이에 준하는) 실행 직전 guard
```

차단 대상(최소):

```text
git push
gh pr create|edit|ready|close|merge
gh issue create|edit|comment
write 성격의 gh api
glab mr create|merge / glab issue ...
기타 provider external write
```

commit 자체는 local write — Session Contract/프로젝트 운영정책에 따라 별도 판단.
`/batch`류 PR fan-out은 MVP에서 금지.

### 5.4 Auto mode ≠ ASC Policy

```text
ASC Policy        = authority SSOT
Claude Auto mode  = provider-side safety/convenience layer
```

ASC SOFT DENY를 Claude `soft_deny`에 1:1 위임 금지. Claude의 user-intent/`allow`
override는 ASC Policy Exception을 대신할 수 없다. Claude가 permissive여도:
HARD DENY 우회 0 / SOFT DENY+Exception 규칙 우회 0 / writeBoundary 우회 0.

### 5.5 `/goal` ≠ Verifier

`doneCriteria → /goal projection`은 권장 사용법이다. 그러나 `/goal achieved`는
Implementer의 자율 completion loop 증거일 뿐이다. Verifier는 별도 Role·별도
Physical Run으로 독립 검증하며 직접 수정하지 않는다(기존 규칙 유지).
`/goal achieved` 이벤트만으로 verifier 상태나 DONE 전이를 만들지 않는다.

### 5.6 Hooks = observation only

활용 가능: SessionStart / SubagentStart / SubagentStop / agent_needs_input /
agent_completed / StopFailure / PostCompact.

```text
hook event ≠ canonical transition authority
agent_completed → RuntimeBinding 관찰 갱신·Handoff 작성 유도까지.
                  Session DONE 자동 전이 금지 — 전이는 SessionRuntime 경유.
```

SessionStart hook의 blocking semantics는 제한적이므로 실제 fail-closed는
Operator/CLI guard(§1.2)가 담당한다.

### 5.7 Teams task list ≠ SSOT

Agent Teams shared task list는 runtime projection이다. ASC Queue·프로젝트 공식
tasks를 대체하지 않는다. Teams·Dynamic Workflows·Remote Control은 MVP에서
optional — Remote Control 메시지를 ApprovalDecision으로 쓰려면 별도 Identity
Binding 계약이 필요하며 현재는 Host UX capability로만 취급한다.

### 5.8 자연어 UX + deterministic fallback

"ASC로 진행해" 자연어 UX는 목표로 유지하되, skill auto-selection을 deterministic
API처럼 Gate 근거로 쓰지 않는다. 명시 호출(`/asc` 또는 이에 준하는)을 함께 제공하고
pilot에서 둘을 따로 기록한다: 명시 호출 = deterministic PASS 필수 / 자연어 = UX 실측.

## 6. `AgentRuntimePort` 보류 조건

현재 새 Port 추가 금지. 재검토 조건:

```text
Claude + 두 번째 Runtime(Codex 등)을 실제 통합한 뒤
두 Adapter가 동일한 outbound runtime contract를 반복 요구할 때
```

그 전의 추상화는 사용처가 하나뿐인 인터페이스다.

## 7. Gate

### 7.1 B-14 (자동 테스트 필수)

```text
READY 1개              → STARTED → ACTIVE
PAUSED 1개             → RESUMED → Checkpoint 노출
ACTIVE 1개             → canonical check → CONTINUE_ACTIVE → 중복 전이 0
후보 2개               → NEEDS_SELECTION → mutation 0
후보 0개 + 미지정       → PROPOSE_CONTRACT → 새 Session 생성 0
--session NOT_FOUND    → FAILED/NOT_FOUND (PROPOSE_CONTRACT 아님)
--session BLOCKED      → FAILED/SESSION_BLOCKED
--session DONE·FAILED  → FAILED/NOT_RUNNABLE
canonical drift        → BLOCKED_CANONICAL → ACTIVE 전이 0
canonical unavailable  → BLOCKED_CANONICAL
broken config/lock drift → BLOCKED_CONFIG → mutation 0
doneCriteria           → schema + Markdown roundtrip 무손실
RuntimeBinding         → Adapter scope에만 / Core entity에 provider field 0
ownership claim        → 동시 경쟁에서 정확히 1개 성공, 나머지 RUNTIME_CONFLICT
Agent message          → Approval/Grant/Exception transition 경로 0
기존 전체 test + typecheck PASS
```

### 7.2 B-15 (자동 계약 테스트 + 실 pilot 둘 다)

```text
Generic Operator/Core에 Claude 문자열 0
capability 부재         → optional degrade / safety-critical STOP 정확
Physical A/B 동시 claim → 정확히 1개 성공
@session/SendMessage    → Human Decision 전이 0
permissive Auto mode    → ASC Policy 우회 0
background worker       → direct git push 0 (bare remote refs before==after)
background worker       → gh/glab write invocation 0 (fake CLI log)
/goal achieved          → Verifier PASS 자동 전이 0
agent_completed hook    → Session DONE 자동 전이 0
RuntimeBinding          → physical/logical identity 분리·왕복 무손실
install 반복            → idempotent / uninstall → ASC 설치물만 제거
프로젝트 tracked Claude 설정 신규 0
기존 전체 test + typecheck PASS
```

pilot은 실 파일럿 프로젝트 무관 fixture(local bare remote + fake `gh`/`glab` PATH 선행)에서
전용 `pilot-local` Profile로 수행한다 — 공유 정본 Profile을 오염시키지 않는다.

## 8. 완료 보고 형식

각 Block 보고에 반드시 포함:

```text
1. commit SHA/message  2. 변경 파일  3. Gate 항목별 PASS/FAIL
4. test/typecheck 명령·실제 결과  5. 실제 pilot 결과  6. 미해결 제한/degrade
7. Frozen 26/27/28 변경 여부  8. 외부 write 발생 여부(증거 포함)
9. Claude Code version / detected capability  10. ownership conflict 검증 결과
```

외부 write는 "안 했다"가 아니라 증거로: bare remote refs before/after,
fake gh/glab invocation log, ASC History/Grant 기록.
