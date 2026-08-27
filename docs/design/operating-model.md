# ASC (Agent Session Control) 운영모델 — 설계 v5.1 (동결)

> 작성: 2026-08-22 (v4: 2026-08-21 / v5: 2026-08-22). 이 문서는 **설계 확정본**이며 현재
> 정본(projection)만 담는다. **참조 표기: 코드·문서의 `OM §x`는 이 문서를 가리킨다**
> (구 example-team 이관 번호 `26 §x`에서 전환). 변경 이력은 부록 A(Change Summary)에만 요약한다.
> **상태: 설계 동결 (2026-08-22, §17 최종 검토 PASS).** 이후 변경은 구현 계약 단계(§18)에서
> Port/Profile/Adapter 경계로 해결 불가한 증거가 있을 때만 재개한다.
> Core 코드·CLI·Adapter·`.asc/` Runtime·Profile schema는 **아직 구현하지 않는다** — §18 로드맵 참조.
> 본문 YAML·파일명·상태값은 책임 경계 검증에 필요한 수준의 예시이며 구현 확정이 아니다.

---

## 0. 정체성과 한 줄 요약

**ASC = 프로젝트에 독립적인 Vanilla Human-in-the-loop Agent Control Plane.**

여러 AI 세션 사이에서 사람이 매번 이전 작업 내용을 기억하고 전달해야 하는 부담을,
프로젝트별 로컬 Runtime `.asc/`가 대신하게 한다. **자동화가 목적이 아니다** — 병렬
에이전트를 쓰면서도 사람이 프로젝트의 이해·결정권·통제권을 잃지 않는 최소 계약 체계가 목적이다.

v4까지의 "실 파일럿 프로젝트 내부 개인용 `.asc/`"는 이제 하나의 적용 사례다. v5부터 ASC는
프로젝트·메신저에 종속되지 않는 **Vanilla Core**를 별도 Repository/설치 단위로 관리하고,
**Project Profile**과 선택적 **Adapter**를 조합해 원하는 프로젝트에 **attach**한다.

Core 내부에는 프로젝트 고유값이 존재해서는 안 된다. 다음은 전부 Project Profile 또는
User Override로 이동한다:

```text
front / blocker / colosair / spec 005 / docs/26
FE / BE / Unity / AI / example-org/example-repo / origin/develop 고정
```

## 1. 불변 원칙 (v4 계승)

1. **대상 프로젝트의 공식 개발 프로세스 무변경.** ASC는 그 프로세스 *안에서* AI 세션을
   운영하는 방법일 뿐이다.
2. **ASC는 공식 프로젝트와 분리된 로컬 Control Plane.** `.asc/`는 Git 추적에서 제외되고,
   통째로 삭제해도 프로젝트에 아무 영향이 없어야 한다.
3. **정본 복제 금지.** spec·계약·팀 결정·작업 목록·Issue·PR 내용을 `.asc/`에 복사하지
   않는다. pointer + baseline(커밋 해시)으로만 참조하고, 에이전트는 실행 시 정본을 다시 읽는다.
4. **공식 영역 자동 전파 금지.** 에이전트 산출물이 docs/Issue/PR 등에 자동 반영되는 경로를
   만들지 않는다. 항상 `Inbox → Controller 검토 → 필요분만 사람 지시로 반영`.
5. **사람 = Controller.** 우선순위·범위·정책·계약 변경·미결 확정·외부 대응 승인은 사람에게
   남는다. AI에는 판단권이 아니라 조사·분해·구현·검증의 실행력을 위임한다.
6. **미결은 임의 확정 금지.** 불확실한 사항은 해결하지 말고 UNRESOLVED로 회수한다.
7. **Execution Plane / Monitoring Plane 분리.** 상호 불간섭, 자동 Interrupt 없음.
8. **Implementer / Verifier 분리.** Verifier는 발견·반환만 하고 직접 수정하지 않는다.
9. **Handoff 기반 세션 인수인계 + Canonical snapshot·drift guard.**
10. **Inbox(판단 대기)와 Queue(승인된 작업) 분리.** `Monitor → Inbox → Controller →
    Queue/Execution` 흐름.
11. **Monitor의 자동 외부 게시 금지.** 외부 Action은 Controller 승인 이후에만,
    Execution Grant를 통해서만 실행된다.
12. **경계 문장은 §19.** ASC 제거 시 프로젝트 영향 0.

## 2. 전체 구조

```text
                         HUMAN CONTROLLER
                    Policy / Decision / Approval
                              │
                              ▼
                     ┌────────────────┐
                     │ Vanilla ASC    │
                     │ Core / Engine  │
                     └───────┬────────┘
                             │
            ┌────────────────┼─────────────────┐
            │                │                 │
          Policy           Runtime            Ports
            │                │                 │
            └────────────────┼─────────────────┘
                             │
                       Profile Resolver
                             │
       ┌─────────────────────┼─────────────────────┐
       │                     │                     │
 Vanilla Defaults     Project Profile       User Override
                             │
                    Operational Preset
                             │
                             ▼
                      Resolved Profile
                             │
                             ▼
                    Project Attach Layer
                             │
                    project-local .asc/
                             │
            ┌────────────────┴────────────────┐
            │                                 │
     Execution Plane                   Monitoring Plane
            │                                 │
     Logical Session                      Event Gate
            │                                 │
    Ephemeral Agent Run                Ephemeral Monitor
            │                           Phase A → B
 Planner / Researcher                       │
 Implementer / Verifier               ApprovalRequest
            │                                 │
   Checkpoint / Handoff                      ▼
            │                         Approval Port
            │                    ┌────────────┼────────────┐
            │                  Local          MM        Slack/...
            │                    └────────────┼────────────┘
            │                                 ▼
            └──────────────────────────► Controller
                                              │
                                ┌─────────────┴─────────────┐
                                │                           │
                             Queue                   Execution Grant
                                │                           │
                         New Session                 Ephemeral Executor
                                                            │
                                                     Drift Guard
                                                            │
                                                     External Action
```

## 3. 배포 모델 — Source Repository, 설치, Attach

### 3.1 ASC Source Repository와 Project-local Runtime의 경계

ASC Core는 특정 프로젝트 Repository 내부에 복제하지 않는다.
**별도 Repository 및 별도 설치 단위**로 관리하며, 하나의 설치가 여러 프로젝트에
attach될 수 있다. 각 프로젝트에는 Profile 선택 정보와 프로젝트 고유 Runtime State를
담는 `.asc/`만 생성된다.

```text
ASC Source Repository        ← 제품/엔진의 정본
────────────────────────
core/          # 엔진: Policy·Runtime·Resolver — Vanilla Policy/Rules의 유일한 정본
ports/         # 추상 인터페이스 (SCM, Approval, Event, State Store, Renderer)
adapters/      # 기본 Adapter 구현 (GitHub, Mattermost, Local, Markdown, ...)
schemas/       # Profile/Override/Grant 등 스키마
presets/       # Operational Preset 정의
profiles/      # 공유 Project Profile 정본 (example-team, pinlog, ...)
docs/
tests/

          │ attach
          ▼

Project Repository
────────────────────────
실제 프로젝트 코드 / specs / docs / git ...
.asc/                        ← 이 프로젝트에서 ASC가 동작하기 위한 Runtime Workspace
```

**정본 소유권**: Vanilla Policy/Core 규칙의 정본은 ASC Source Repository(core/)뿐이다.
프로젝트·사용자별 설정의 정본은 Project Profile / Preset / User Override다.
`.asc/` 안의 어떤 파일도 정책의 별도 정본이 되지 않는다 (§7.1 ASC.md 참조).

**금지**: 프로젝트별 Core 소스 복사 (`project/tools/asc-core-copy/` 류) — 프로젝트별
Core drift의 근원이다. Git submodule/subtree는 팀이 ASC를 프로젝트 공식 도구로 채택하는
경우에만 선택적으로 검토한다 — Vanilla 기본 배포 방식은 아니다.

### 3.2 Multi-project 지원

```text
               ASC Vanilla Installation
                         │
            ┌────────────┼────────────┐
            ▼            ▼            ▼
        실 파일럿 프로젝트       PINLOG      Project C
     example-team profile pinlog profile   ...
            │            │            │
        .asc A         .asc B       .asc C
```

각 `.asc/`의 State/Session/Monitor/Queue는 완전히 분리한다. Project context 혼합 금지.

### 3.3 독립성 3계약

ASC 설치 여부·`.asc/` 존재 여부가 프로젝트 정상 실행의 전제조건이 되어서는 안 된다.

```text
ASC 제거          → 프로젝트 정상
.asc/ 삭제        → 프로젝트 정상
Messenger 미설치  → ASC Local Approval 정상
```

### 3.4 Attach / Bootstrap 최소 책임

Core가 프로젝트에 즉시 attach하기 위해 갖는 최소 책임:

```text
1. Project Root Discovery
2. Profile Resolution
3. Capability / Policy Validation
4. Project-local .asc Runtime Bootstrap
5. Runtime Entrypoint
```

개념적 Bootstrap (`asc init --profile example-team`):

```text
현재 project root 탐지
  → Vanilla Defaults 로드
  → Project Profile 로드
  → Operational Preset 로드
  → User Local Override 로드
  → Schema / Policy 검증 (merge semantics §4.7)
  → Adapter capability 확인
  → Resolved Profile 생성 + profile.lock 기록 (§4.9)
  → ASC.md (Generated Runtime Contract) 생성 (§7.1)
  → project/.asc/ Runtime 초기화
```

하나의 설치로 `cd example-team && asc init --profile example-team`,
`cd pinlog && asc init --profile pinlog` 처럼 프로젝트별 독립 관리가 가능해야 한다.

## 4. 구성 계층 — Profile 체계

### 4.1 계층과 우선순위

Profile은 **Vanilla Core에 프로젝트별 운영 특성을 주입하는 선언형 Overlay**다.

```text
1. Vanilla Defaults
        ↓
2. Project Profile
        ↓
3. Operational Preset
        ↓
4. User Local Override
        ↓
5. Runtime Session / Execution Grant
```

### 4.2 Project Profile 책임

| 들어갈 것 (Static Configuration) | 들어가면 안 되는 것 (Runtime/개인) |
|---|---|
| project identity | Active Session |
| SCM / issue provider, repository | Queue / Inbox / Handoff |
| canonical source 집합 (§8) | Cursor / Event ID |
| monitor labels / signals, priority mapping | API·Messenger Token |
| workflow references, role default boundaries | 개인 Secret |
| verification defaults, approval requirements | 개인 계정/개인 UX 설정 (→ Override) |
| project terminology mapping | |

**Profile = Static Configuration, State = Runtime Information.**

### 4.3 Operational Preset

Project Profile과 사용자 운영 성향을 분리한다. 예: `conservative / balanced /
autonomous / lightweight`.

Preset이 조정 가능한 항목: verification 강도, P1/P2 deep analysis 여부, SOFT DENY
(Policy Exception) 승인 전략, notification 강도, parallelism 기본값. **HARD DENY는 Preset이 해제할 수 없다.**

### 4.4 User Local Override

팀원이 같은 Project Profile을 쓰더라도 개인 환경만 바꾼다. Controller identity
mapping(§11.6)도 여기(또는 별도 identity mapping 파일)에 둔다.

```yaml
identity:
  github: <개인 계정>
approval:
  preferred_channel: mattermost
monitor:
  realtime: true
controller:
  identities:            # Identity ≠ Credential — Token은 Secret Store (§4.5)
    github: <계정>
    mattermost: <계정>
```

### 4.5 Secret 분리

Profile/Override에 Token 직접 저장 금지. 참조만 둔다:

```yaml
approval:
  messenger:
    provider: mattermost
    token_env: ASC_MATTERMOST_TOKEN
```

실제 Credential은 environment variable / OS credential store / `gh auth` /
secret manager에서 가져온다.

### 4.6 Role Preset

Profile은 Role의 **기본 최대 범위**를 제안할 수 있다
(예: `Implementer: frontend/**`, `Verifier: project write = none`).
실제 Session Contract는 이를 **더 좁혀야** 한다. Session이 Profile보다 넓은 권한을
얻을 수 없다 — 초과 요청은 validation failure 또는 Controller 반환 (§4.7).
`Profile = 최대 기본 범위, Session Contract = 이번 작업의 최소 실제 범위`.

### 4.7 Profile Resolver — Merge Semantics

Bootstrap 시 §3.4 순서로 병합·검증한다. 동일 필드가 여러 계층에 존재할 때의 병합
규칙은 필드 유형별로 정의한다:

| 필드 유형 | 병합 규칙 |
|---|---|
| scalar | 필드 정의가 override 허용 여부를 명시. 허용 시 하위 계층 값 우선, 잠금(locked) 필드는 하위 값 무시+경고 |
| replace-list | 하위 값으로 전체 교체 |
| union-list | 상위 + 하위 병합 (중복 제거) |
| permission scope | **intersection** — 아래 별도 규칙 |
| required capability | 병합 후 검증 — 미충족 시 bootstrap 실패 |
| optional capability | 가능한 Adapter만 활성화, 불가 시 해당 기능 비활성 (Messenger의 단계적 fallback 상세는 §11.4) |
| HARD DENY | **immutable** — 하위 계층에서 해제 불가. 하위가 항목 *추가*는 가능(강화 방향만) |

**권한 범위는 `lower wins`가 아니다**:

```text
상위 최대 권한 ∩ 하위 요청 권한 = 실제 권한

Profile Implementer Scope = frontend/**
Session Scope             = frontend/src/studio/**
Resolved Scope            = frontend/src/studio/**
```

Session이 Profile 최대 범위를 넘는 요청을 하면 validation failure 또는 Controller
반환으로 처리한다 — 조용한 clamp(교집합으로 축소만 하고 통과)는 하지 않는다.
계약과 실권한이 달라 보이는 상태를 만들지 않기 위해서다.

### 4.8 Resolved Profile

병합·검증 결과가 Resolved Profile이다. **Derived View**다 —
`.asc/cache/resolved-profile.yaml` 등에 둘 수 있으나 직접 수정 금지, 삭제 후 재생성
가능해야 한다.

### 4.9 Profile Lock — Attach 재현성

Resolved Profile(언제든 재생성되는 projection)과 별도로, **이 프로젝트가 실제로 어떤
조합으로 실행되는지**를 고정하는 재현성 metadata를 둔다:

```text
.asc/profile.lock
─────────────────
ASC Core version / commit
Project Profile source + version / commit
Preset source / version
User Local Override digest
Resolved adapter versions
Resolved capability set
Resolved configuration digest
Generated at
```

목적: 한 달 뒤 Session 재현 / Profile 업데이트 전후 비교 / Bug report 재현 / Drift 판정.

**Lifecycle**:
- 생성·갱신 주체는 Resolver뿐. 최초 attach와 명시적 re-resolve(`asc init` 재실행,
  Core/Profile upgrade) 시에만 갱신 — Run마다 자동 갱신하지 않는다.
- Run 시작 시 **현재 resolved input 전체 조합**(Core / Profile / Preset / Override /
  Adapter versions / capability set / configuration digest)을 lock과 대조:
  `Current Resolved Inputs ↓ compare profile.lock`. 불일치 = configuration drift →
  경고 후 Controller 판단. 자동 re-resolve·lock 덮어쓰기 금지.
- 갱신 시 이전 lock은 `.asc/archive/profile-locks/`로 무손실 이동한다 (전후 비교용 —
  §7.4). profile.lock은 실행 재현성을 위한 **전체 구성 snapshot metadata**다.

### 4.10 Profile Version / Capability

Profile은 Core 호환성과 요구 capability를 선언할 수 있어야 한다:

```yaml
schema_version: 1
requires:
  asc: ">=1.0 <2.0"
  capabilities:
    - scm.github
optional_capabilities:
  - messenger.mattermost
```

Messenger는 가능한 한 Optional Capability로 둔다.
정확한 schema는 Generic화 과정에서 확정한다 — 지금은 책임 경계만 고정 (§18).

## 5. Policy Layer

### 5.1 3등급

기존 Green/Yellow/Red를 정책 계층으로 승격한다.

| 등급 | 의미 | 정의 |
|---|---|---|
| **ALLOW** (Green) | 자율 | Session Contract 범위 내에서 Agent 자율 실행 |
| **SOFT DENY** (Yellow) | 기본 금지 | Controller의 **Policy Exception**으로만 제한 허용 |
| **HARD DENY** (Red) | 상위 금지 | 일반 Session Contract·Project Profile이 해제 불가. 별도 승인 메커니즘 필요 |

약식 판정 heuristic(프로젝트 용어는 Profile terminology mapping으로 구체화):
내 Write Boundary 밖 수정 안 생김 = ALLOW / 내 담당 영역 안 파급 = SOFT DENY /
담당 경계·계약을 넘음 = HARD DENY.

**Policy Exception — SOFT DENY의 제한적 허용.** Controller가 특정 SOFT DENY 항목을
**기존 Logical Session 안에서** 명시적으로 허용하는 것. `기존 Session 내부 / 특정
항목 / 명시적 범위 / 명시적 Session`에만 적용되며, 해당 Session Contract 또는
controller.md의 승인사항에 기록한다. **HARD DENY는 Policy Exception으로 해제할 수
없다.** 예: Session이 공통 dependency 추가 필요(기본 SOFT DENY) → Controller가
"이번 Session에서 해당 dependency 추가 허용" → Policy Exception.

**Policy Exception ≠ Execution Grant** (§11.5):

```text
Policy Exception = 기존 Session의 SOFT DENY 제한적 허용
Execution Grant  = 별도 Executor에게 승인된 단일 외부 Action 계약
```

### 5.2 권한 상속

```text
ASC Policy
  ↓ Vanilla Defaults
  ↓ Project Profile
  ↓ Operational Preset
  ↓ User Local Override
  ↓ Block Contract
  ↓ Session Contract
  ↓ Task
```

**하위 계층은 상위 계층보다 권한을 확장할 수 없다.** 특히 HARD DENY는 Profile이나
Session Prompt가 ALLOW로 덮어쓸 수 없다. 병합은 §4.7 merge semantics를 따른다.

**Execution Grant는 이 hierarchy의 구성원이 아니다.** Grant는 HARD DENY를 해제하는
override가 아니라, Controller가 hierarchy 바깥에서 생성하는 **별도 one-shot execution
contract**다 (§11.5):

```text
Normal Session Policy → External Write = HARD DENY → 일반 Session에서 절대 실행 불가
Controller           → 별도 Executor Contract 생성 → 정확히 승인된 단일 Action만 수행

Session 권한 확장 X / 별도 실행 계약 생성 O
```

### 5.3 DENY 접촉 시 동작

세션 전체 즉시 중단이 기본이 아니다. Goal 달성 가능 여부로 분기한다:

```text
Blocking HARD DENY      → 현재 Goal 달성 불가
                        → Checkpoint/Handoff 작성 → Controller 반환

Non-blocking HARD DENY  → 해당 사항 수정/결정 금지, UNRESOLVED 기록
                        → 나머지 Scope 계속

SOFT DENY (우회 가능)   → defer + 계속
SOFT DENY (Goal 차단)   → Controller 반환
```

### 5.4 Role별 책임 경계

| Role | 하는 것 | 금지 |
|---|---|---|
| Controller (사람) | 우선순위·범위·정책·승인·Queue 확정·세션 발급·Policy Exception·Execution Grant 발급 | — |
| Planner | Block/Task 분해 초안, 계획 작성 | 공식 작업 생성, 우선순위 확정 |
| Researcher | 조사, 결과 보고 | 조사 결과로 정본 수정 |
| Implementer | 계약 범위 내 구현 | 요구사항 재설계, 범위 확장 |
| Verifier | 검증·발견·반환 | **발견한 문제의 직접 수정** |
| Monitor | 감지·조사·분석·초안 (§10) | 모든 외부 write, Queue 확정, 세션 발급/중단 |
| Executor | Grant 명시 단일 Action 수행 | Grant 외 모든 write |

모든 Role은 Ephemeral Compute다 (§6).

## 6. 실행 모델

### 6.1 Persistent State, Ephemeral Compute

**Persistent Agent는 없다. Persistent State만 있다.**

| 장기 존속 (State) | 필요 시 생성·종료 (Ephemeral Compute) |
|---|---|
| Policy, Controller State | Planner, Researcher |
| Block State | Implementer, Verifier |
| Monitor Contract, Monitor Cursor | Monitor Scan, Draft Generator |
| Inbox, Queue, History | Publish Executor, Resume Run |
| Session Contract / Checkpoint | |

"Monitor 장기 세션"은 물리적으로 오래 살아 있는 AI 프로세스가 아니라
`Persistent Monitor State + Event-triggered Ephemeral Monitor Run`이다.
실시간 감지는 유지 가능하되 AI 세션을 상시 점유시키지 않는 것이 기본이다.
Approval 대기 중에도 AI 프로세스는 살아 있을 필요가 없다 — **Approval 대기는 State다.**

### 6.2 Logical Session ≠ Physical Run

```text
S-20260822-03  Status: ACTIVE
  Run A → 작업 → usage limit/장애/사용자 중단 → CHECKPOINT → PAUSED
  Run B → 동일 S-03 계약 + Checkpoint 로드 → RESUME → DONE
```

- Session 상태: `READY / ACTIVE / PAUSED / BLOCKED / DONE / FAILED`
- Session 파일에 필요 시 `CHECKPOINT` 절을 둔다. 다른 Physical Run이 동일 Logical
  Session을 이어받을 수 있어야 한다.
- 동일 Logical Session에 동시 Physical Run은 금지 — 세션 entity single-writer 보장.

## 7. Project-local Runtime `.asc/`

### 7.0 Logical State Model과 Markdown Projection의 분리

Core가 이해하는 것은 파일이 아니라 **Logical Entity Model**이다:

```text
State / Session / Checkpoint / Handoff
ApprovalRequest / ApprovalDecision / QueueItem
MonitorEvent / ExecutionGrant
```

Entity의 저장·동시성은 **State Store Port**가 담당하고, 기본 구현은 Markdown Adapter다:

```text
Logical State Model
        ↓
State Store Port        ← atomic transition 보장 책임 (compare-and-set, atomic rename 등)
        ↓
Markdown / SQLite / JSON Adapter
```

**Core Contract ≠ Markdown file layout. Markdown layout = Default State Store /
Renderer projection.** 이후 SQLite/Web UI 전환 시 Core protocol을 재설계하지 않기
위한 분리다. 초기 MVP는 Markdown Adapter를 기본값으로 사용한다.
아래 §7.1~7.5의 파일 구조는 이 **Markdown Adapter의 기본 표현**이다.

### 7.1 구조 (Markdown Adapter 기본 표현)

```text
.asc/
├─ profile            # 선택한 Profile 참조 (예: example-team)
├─ profile.lock       # 재현성 metadata — Resolver만 갱신 (§4.9)
├─ override/          # User Local Override
├─ cache/
│  └─ resolved-profile   # Derived View — 수정 금지, 재생성 가능
├─ archive/
│  └─ profile-locks/  # 이전 profile.lock 무손실 archive (§4.9·§7.4)
├─ ASC.md             # Generated Runtime Contract — 아래 참조
├─ state.md           # 단일 진실: 활성 Block·세션·승인 대기 — Controller 전용
├─ controller.md      # Runtime Controller Contract — 사람만 수정 (Resolver 입력 아님)
├─ blocks/            # B-NN.md — Block 계약 + 진행 상태
├─ sessions/
│  ├─ active/         # S-YYYYMMDD-NN.md — 계약(상단)+Checkpoint/Handoff(하단) 한 파일
│  └─ archive/        # 종료 세션 무손실 이동
└─ monitor/
   ├─ M-<SOURCE>.md   # Monitor 계약 + cursor (예: M-GITHUB.md — Adapter 인스턴스)
   ├─ inbox/          # I-NNNN.md — Decision Packet entity per file (§7.2)
   ├─ grants/         # G-NNNN.md — Execution Grant entity per file (§11.5)
   ├─ queue.md        # 승인된 작업 큐 (Controller 전용)
   ├─ log-current.md  # append-only 감지·처분 이력
   ├─ archive/        # log·inbox 처분분 무손실 rotation (2026-08, ...)
   └─ views/
      └─ inbox.md     # Derived View — 현재 대기 항목 목록 projection
```

**`ASC.md` = Generated Runtime Contract.** `Core Policy + Vanilla Defaults +
Project Profile + Operational Preset + User Local Override`를 Resolver가 해석해
Agent가 읽기 쉽게 표현한 **생성물**이다. Vanilla Policy의 별도 정본이 아니다 —
직접 수정 금지, 삭제 후 재생성 가능(Derived View 분류, §7.3). Controller가 정책을
바꾸려면 위 입력 계층을 수정하고 ASC.md를 재생성한다. 이 lifecycle로 Core Policy와의
drift를 구조적으로 차단한다.

**`controller.md` = Runtime Controller Contract.** 현재 사람이 지정한 목표·우선순위·
승인사항(Policy Exception 포함 — §5.1)을 담는다. **Resolver 입력이 아니다** —
controller.md를 수정해도 ASC.md는 재생성되지 않는다.
`ASC.md = 시스템 운영 규칙(resolved policy projection) / controller.md = 현재 사람의
운영 지시` — 둘을 합치거나 서로의 정본으로 취급하지 않는다.

설계 결정 근거 (v4 계승):
- `tasks/` 없음 — Task 정본은 프로젝트 공식 작업 목록(예: speckit `tasks.md`). 세션
  계약에 포인터만.
- Handoff는 세션 파일 하단 — 계약↔결과 짝 어긋남 원천 차단. Verifier도 세션이며
  산출물은 자기 세션 파일의 Handoff다.

### 7.2 Writer 규칙과 동시성

원칙: **동일 파일을 여러 Agent가 무보호 동시 수정하는 구조는 허용하지 않는다.**
이를 위해 두 장치를 겹쳐 쓴다:

1. **Entity per file** — 상태 전이가 여러 주체에 걸치는 entity(Inbox 패킷, Grant)는
   파일 하나가 entity 하나다. `1 entity = 1 writer transition`: 한 시점에 그 entity의
   상태 전이 권한은 한 주체에게만 있다 (Inbox 패킷: Monitor 생성 → Controller 처분 →
   Executor 결과 기록 — 순차 전이라 겹치지 않음).
2. **State Store Port의 atomic transition** — Adapter가 compare-and-set·atomic rename
   등으로 전이 원자성을 보장한다 (§7.0).

추가로 Event Gate는 **프로젝트당 Monitor Run을 직렬화**한다(동시 스캔 1개, 나머지는
대기) — `log-current` append와 cursor 갱신의 다중 writer를 원천 제거한다.

| Entity/파일 | Writer |
|---|---|
| (core/ policy) | ASC Source Repository — Runtime에서 수정 불가 |
| ASC.md, cache/resolved-profile | Resolver (생성물 — 직접 수정 금지) |
| profile.lock | Resolver |
| controller.md | Controller (사람) |
| state.md | **Controller ONLY** |
| blocks/B-* | Controller |
| sessions/S-* | 해당 Logical Session (동시 Run 금지로 single-writer 보장) |
| M-<SOURCE>.md (cursor 포함) | Monitor (Run 직렬화로 single-writer 보장) |
| log-current | Monitor(Run 직렬화) + 처분 주체 — 처분을 수행한 자가 기록: Controller 처분 시 Controller, Grant 실행 시 Executor. 모든 append는 State Store Port의 atomic append 경유 (append-only) |
| inbox/I-* | Monitor 생성 → Controller 처분 → Executor 결과 기록 (순차 전이) |
| grants/G-* | Controller 발급 → Executor CLAIM/EXECUTE (순차 전이, §11.5) |
| queue.md | **Controller ONLY** |
| views/* | Renderer (Derived — 재생성 가능) |

Work Session 종료 시 Agent 책임은 **자기 Session 파일에 Checkpoint/Handoff 작성까지**다.
state·block·queue 갱신은 Controller가 회수 후 수행한다.

### 7.3 문서 수명주기

문서를 세 종류로 분리해, append 비대화 → AI "다이어트" → 정보 손실의 악순환을 구조적으로
차단한다.

| 종류 | 대상 | 규칙 |
|---|---|---|
| **A. Source of Truth / History** | 완료된 Session Contract/Handoff, Monitor Log, Decision History, 공식 GitHub, 공식 Project Canonical | Append-only 또는 immutable |
| **B. Working Current State** | state, controller, blocks, queue, inbox entities | 현재 상태만. Append가 아니라 **Rewrite** |
| **C. Derived View** | ASC.md, resolved-profile, views/*, summary, dashboard | 원본에서 재생성 가능한 projection. 직접 수정 금지 |

최종 원칙:

```text
Current State = bounded rewrite
History       = append / immutable
Old History   = lossless rotation
Summary       = disposable projection
```

**AI에게 거대 파일을 임의로 "다이어트/압축"시켜 과거 정보를 삭제하는 운영은 금지한다.**

### 7.4 비대화 정책 — Lossless Rotation

Log는 AI 요약으로 줄이지 않는다: `Compression X / Lossy Diet X / Lossless Rotation O`.
`monitor/log-current` → `monitor/archive/2026-08` 식 무손실 이동. 처분 완료된 inbox
entity·소비된 Grant는 `monitor/archive/`로, 이전 profile.lock은
`.asc/archive/profile-locks/`로 이동한다. overwrite·AI 요약으로 이전 lock을 소실시키지
않는다.
Session도 `sessions/active/` → `sessions/archive/` 이동. 삭제/요약이 아닌 이동이다.

### 7.5 파일 양식 (핵심 3종)

`state.md` — Controller 전용:

```markdown
# Execution
활성 Block: B-05 (blocks/B-05.md)
활성 세션: S-20260822-01 (ACTIVE)
최근 회수 Handoff: sessions/archive/S-20260821-02.md
병렬 세션 Write Boundary 점유: <경로 목록>
승인 대기: S-20260821-02 UNRESOLVED 2건

# Monitoring            ← 포인터만. 숫자·시각 없음 (갱신자 없는 데이터 금지)
M-GITHUB: monitor/M-GITHUB.md (cursor 그쪽 참조)
Inbox 미처분: monitor/views/inbox.md 확인

# Controller Attention
- <사람 메모>
```

`sessions/S-YYYYMMDD-NN.md` — 계약 + Checkpoint/Handoff 한 파일:

```markdown
# S-20260822-01 — Role: Implementer
Status: ACTIVE            # READY|ACTIVE|PAUSED|BLOCKED|DONE|FAILED
Block: B-05 / Tasks: <공식 작업 목록 경로> T-004~T-006 (포인터)
Goal: <이 세션의 단일 목표>
Canonical Sources(착수 시 재독 필수 — §8):
- shared-spec @ <해시>
- fe-plan @ <해시>
Read Scope / Write Boundary / Out of Scope: <명시>
Authority: ALLOW 자율 / SOFT DENY 보고 / HARD DENY §5.3 분기
Done: <완료 조건> + Handoff 작성 (state 갱신은 Controller 몫)

---
## CHECKPOINT             ← 중단 시 작성 (Run 승계용)
진행 위치 / 완료 Task / 재개 시 첫 행동 / 미커밋 변경 목록

---
## HANDOFF                ← 세션 종료 시 작성
DONE / CHANGED / VERIFIED(self-check 명시) / UNRESOLVED / NEXT
정본 스냅샷:
- shared-spec @ abc123 / fe-plan @ def456 / issue#19 @ event-789
```

`monitor/inbox/I-NNNN.md` Decision Packet — §11.1 참조.

## 8. Canonical — Multi-source / Multi-ref

**Project는 canonical 하나를 갖는 것이 아니라, Session이 소비하는 Canonical Source
집합을 갖는다.** 하나의 Session이 서로 다른 정본을 동시에 소비할 수 있다
(공유 spec은 develop, FE plan은 front, 결정 사항은 Issue thread, 외부 계약은 다른
provider). Profile이 source 집합을 정의한다:

```yaml
canonical:
  sources:
    - id: shared-spec
      provider: git
      remote: origin
      ref: develop
      paths:
        - specs/**
    - id: fe-plan
      provider: git
      remote: origin
      ref: front
      paths:
        - specs/**/FE/**
    - id: decisions
      provider: github
      references:
        - issue: 19
```

Session/Handoff snapshot은 단일 commit이 아니라 **소비한 source별 baseline**을 기록한다:

```text
shared-spec @ abc123
fe-plan     @ def456
issue#19    @ event-789
```

drift 판정도 source별로 독립 수행한다:

```text
이전 baseline → 현재 baseline → 해당 source diff → 계약 영향 판정
```

구분 유지:

```text
open change touches canonical      = potential drift  (감지·경고 대상)
source baseline 실제 변경           = actual drift     (계약 영향 판정 필수)
```

구버전 정본으로 작업하는 사고를 기억이 아니라 절차로 방지한다 — Handoff의 source별
"정본 스냅샷"과 부트스트랩 재독 절차의 대조가 핵심 장치다.

## 9. Execution Plane 운영 프로토콜

**세션 시작** — 사람 프롬프트 한 줄:
`.asc/ASC.md와 state.md 읽고 S-20260822-01 계약대로 진행해라`
이전 세션 내용 복사·설명 불필요 — 그게 이 구조의 존재 이유.

**부트스트랩 (모든 Run 공통)**:
1. ASC.md → controller.md → state.md → 자기 Session Contract → (있으면) CHECKPOINT 로드
2. 세션 계약의 Canonical Sources 정본을 실제로 다시 읽는다. 세션 파일의 요약을 믿지 않는다
3. source별 baseline이 기록 해시와 다르면 diff 확인, 계약 영향 시 중단·보고 (§8)

**중단** — CHECKPOINT 작성 → Status: PAUSED. 다른 Run이 이어받는다 (§6.2).

**세션 종료** — Handoff 작성, Status 갱신. 여기까지가 에이전트 몫.
작업일지·이슈·PR 반영은 안 함 (공식 영역에 변경을 만든 세션은 프로젝트 규칙대로 기록 —
§13).

**Controller 검토 루프** — Handoff 읽음 → 승인/반려/미결 확정 → state·block·queue 갱신
→ 공식 반영 필요분만 별도 지시. 지시받은 시점부터 프로젝트 기존 흐름 그대로.

**병렬 세션** — Write Boundary 비겹침을 Controller가 계약 발급 시 보장. state.md 점유
표가 충돌 감지선. 잠금 시스템 안 만든다.

## 10. Monitoring Plane

### 10.1 실시간 구조

```text
External Event
  → Lightweight Event Gate    (프로젝트당 Monitor Run 직렬화 — §7.2)
  → 관련 Event만
  → Ephemeral Monitor Run
  → Persistent State 갱신 (log·inbox entity·cursor)
  → 종료
```

Event Source는 교체 가능해야 한다: `webhook / polling / manual scan / scheduled trigger`.
Monitor Engine이 특정 SCM polling 구현에 직접 종속되면 안 된다 — Event Source Port 뒤에
둔다.

### 10.2 Phase A — Lightweight (전 이벤트)

```text
detect → dedupe → event_key → type classification
→ priority suggestion → log → inbox candidate decision
```

### 10.3 Phase B — Selected Deep Analysis (Inbox행 확정분만)

```text
context retrieval → canonical comparison → current state impact
→ recommended response → draft if needed → approval packet
```

유형별 깊이 — 전 이벤트 균일 심층 조사 금지:

```text
대응형 / 작업형   → full packet
정보형 P0/P1     → compact packet
P2 정보형        → 3줄 수준
```

### 10.4 dedupe — event key exact lookup

log tail 대조가 아니라 정확한 event key로 판정한다:

```text
notification:<thread_id>:<updated_at>
comment:<comment_id>
review:<review_id>
review_comment:<comment_id>
```

### 10.5 부분 실패 처리

```text
Phase A → event별 key 생성
Phase B → 성공: PROCESSED / 실패: PENDING_RETRY
global cursor → 전진 가능
다음 Run → PENDING_RETRY만 재시도
```

특정 이벤트 실패로 모든 이벤트를 재처리하지 않는다. 누락보다 중복이 안전 — dedupe가 걸러준다.

### 10.6 Generic Signal

Core는 프로젝트 고유값(계정명·라벨명) 없이 일반 신호만 정의한다:

```text
assigned_to_me / mentioned_me / direct_reply / review_requested
my_pr_reviewed / participated_thread_changed
active_canonical_changed / open_change_touches_active_canonical
priority_labels / project_specific_signal
```

실제 조건(어느 라벨, 누가 "나"인가)은 Project Profile + User Override가 매핑한다.

### 10.7 Monitor 계약 (Adapter 인스턴스)

`monitor/M-<SOURCE>.md`는 Profile이 채운 감지 규칙·Read Scope·Forbidden 목록·cursor를
담는다. Monitor의 Write는 `자기 계약 파일 + inbox entity + log`뿐. Forbidden은 v4와 동일:
코드·정본 수정, 모든 외부 write, queue/state 수정, 공식 작업 생성, 우선순위 확정,
세션 발급/중단, 작성 초안의 자동 게시.

## 11. Approval — Inbox, Port, Grant

### 11.1 Approval Inbox = Decision Packet 저장소

Inbox는 Notification List가 아니다. **Controller가 원 Thread를 처음부터 다시 읽지
않고도 판단할 수 있도록 AI가 준비한 Decision Packet 저장소**다.
패킷 하나가 entity 파일 하나다 (`monitor/inbox/I-NNNN.md` — §7.2).

대응형/작업형 패킷 필드:

```text
request_id (전 채널 공통 — §11.7)
Detected / Source / 상황 / 관련 맥락 / Canonical
현재 Block·Session 영향 / 중단 필요 여부 / 판단 근거
권장 대응 / 답변 초안
Canonical Snapshot (source별) / Thread Last Event ID
Authorized Approver (Controller identity — §11.6)
Controller Decision / 처리 기록
```

자동화 범위는 `감지 → 조사 → 분석 → 상황 설명 → 대응 제안 → 답변 초안`까지.
**반드시 Controller 승인 상태에서 멈춘다.**

### 11.2 Inbox lifecycle

```text
[AWAITING_APPROVAL]                         Monitor 기입 (Monitor가 만드는 유일한 상태)
[APPROVED] [QUEUED] [DEFERRED] [DISMISSED]  Controller 전용
[DONE]                                      Grant 수행 Executor가 전환 (처리 기록 필수)
```

의미: `AWAITING_APPROVAL` Controller 판단 대기 / `APPROVED` 커뮤니케이션·외부 Action
승인 완료, Execution Grant 발급 또는 실행 대기 / `QUEUED` 개발 작업으로 승인되어 Work
Queue 승격 / `DEFERRED` 판단·처리 보류 / `DISMISSED` 대응 불필요 / `DONE` 승인된 후속
Action 완료.

두 lifecycle 분리:

```text
[커뮤니케이션] AWAITING_APPROVAL → APPROVED → Execution Grant → Executor → DONE
[개발 작업]   AWAITING_APPROVAL → QUEUED → Logical Session 발급
```

- **APPROVED ≠ External Write Permission.** 상태값은 게시 권한이 아니다 — 실제 외부
  Write 권한은 여전히 Execution Grant에만 존재한다 (§11.5)
- 완료/기각 entity는 inbox에서 제거(archive 이동)하기 **전에** History에 기록한다:
  `event_key / decision / decided_at / result / external URL`
- 최종 역할: `Inbox = 현재 판단 대기 / History Log = 감지+최종 처분 이력 /
  External System = 실제 결과`
- 기각한 스레드의 **새 이벤트**는 다시 inbox에 들어온다 (새 정보 — 의도된 동작)

### 11.3 Approval Port — Messenger는 Optional

메신저는 ASC Core 필수 구성요소가 아니다.

```text
ASC Core
   │
Approval Port
   │
 ┌─┼───────────────┐
 ▼ ▼               ▼
Local  Mattermost  Slack / Discord / Teams ...
```

Messenger가 없어도 `Monitor → ApprovalRequest → Local Inbox → Controller →
ApprovalDecision`이 그대로 동작해야 한다. Messenger 장애·토큰 만료·미설치가 Core를
BLOCK시키면 안 된다.

Generic Interface — Core는 플랫폼 메시지 구조를 몰라야 한다:

```text
ApprovalRequest:  id(request_id), type, priority, title, summary, context, draft,
                  source, snapshot, authorizedApprover, allowedDecisions, expiresAt
ApprovalDecision: requestId, actor(authenticated), decision, revision,
                  decidedAt, channel
```

Adapter가 플랫폼 입력(Mattermost Button / Slack Action / Discord Button /
CLI command / Web UI button)을 공통 DTO로 변환한다.

### 11.4 Messenger Capability Model

Adapter capability 예: `interactive_actions, rich_blocks, dialogs,
ephemeral_feedback, threads, priority, acknowledgement, silent_notification`.

Profile은 원하는 UX policy만 선언하고, Adapter는
`Native rich feature → interactive fallback → text/markdown fallback →
Local Inbox fallback` 순으로 degrade한다.

Mattermost Adapter 사용 시 전용 기능 적극 활용 (배포 버전 capability에 따라 fallback):

```text
P0   → priority 강조 + acknowledgement + 상황 요약 + 초안 + [승인][수정][보류][기각]
수정  → dialog
결과  → ephemeral feedback
논의  → thread 유지
P2   → silent / low-noise presentation
```

Mattermost는 Optional Adapter다.

### 11.5 Execution Grant — one-shot execution contract

Controller가 외부 Action을 승인해도 Monitor·Session의 기본 권한은 바뀌지 않는다.
**Monitor는 항상 read-only.** External Write는 승인받은 단일 Action을 수행하는
Ephemeral Executor에게만 허용되며, Grant는 Policy hierarchy의 override가 아니라
**Controller가 생성하는 별도 one-shot execution contract**다 (§5.2).

```text
Execution Grant
───────────────
grant_id / request_id / issued_by / issued_at / expires_at
action / target / approved payload / snapshot / allowed writes
single_use / status / consumed_at / result_ref
```

Grant lifecycle (replay guard):

```text
READY → CLAIMED → EXECUTED
READY → INVALIDATED
READY → EXPIRED
```

- **한 번 성공한 Grant는 다시 소비할 수 없다** (single_use, consumed_at 기록).
- Executor 재실행·네트워크 retry가 와도 CLAIMED/EXECUTED 상태의 Grant는 재수행 불가.
- CLAIM은 State Store의 atomic transition으로 수행 — 동시 Executor 2개가 같은 Grant를
  잡을 수 없다 (§7.2).
- 예: `Action: GitHub comment post / Target: Issue #19 / Payload: Approved Draft /
  Other Writes: FORBIDDEN`.

### 11.6 Controller Identity Binding

승인 actor가 실제 승인 권한자인지 검증하는 계약을 둔다:

```text
ApprovalRequest    → authorized approver (Controller identity) 포함
Messenger Adapter  → platform user identity 인증
ApprovalDecision   → authenticated actor 반환
ASC Core           → Controller Identity binding 검증
  일치   → 승인 유효
  불일치 → 거절 + audit 기록 (log)
```

Identity mapping은 User Local Override 또는 별도 identity mapping에 둔다 (§4.4).
**Identity ≠ Credential** — Token/Secret은 기존 원칙대로 Secret Store (§4.5).

### 11.7 Multi-channel = One Request, Many Presentations

멀티채널 알림은 여러 Request가 아니라 **하나의 Request에 대한 여러 Presentation**이다.
모든 Channel(Mattermost / Local UI / Web UI)이 동일 `request_id`를 사용한다.
최초 유효 Decision 이후 다른 채널의 입력은 `STALE / ALREADY_DECIDED`로 처리한다.
중복 클릭·네트워크 retry로 동일 Decision이 재도착해도 결과는 같다 (idempotent).

### 11.8 Messenger 승인 ≠ External Write Permission

메신저에서 승인 버튼을 눌렀다고 외부 Write가 즉시 발생해서는 안 된다:

```text
ApprovalDecision
  → Controller Identity / Policy 확인 (§11.6)
  → Inbox entity [APPROVED]
  → Execution Grant 발급 (§11.5)
  → Ephemeral Executor (CLAIM)
  → Drift Guard (§11.9)
  → External Action → EXECUTED + result_ref
```

### 11.9 게시 직전 Drift Guard

Approval Packet에 `Canonical Snapshot(source별) + Thread Last Event ID` 필수.
Executor는 Action 직전 대상 상태를 재확인한다:

```text
변화 없음      → 실행
새 이벤트 존재 → 실행 중단 → Grant INVALIDATED → Controller 반환
```

오래된 초안 자동 게시 금지.

### 11.10 두 경로 (v4 계승 + Grant 결합)

```text
커뮤니케이션: Monitor 패킷 → [APPROVED] → Execution Grant → Executor
             → Drift Guard → 게시 → [DONE] + History 기록
개발 작업:   Monitor 패킷 → [QUEUED] → queue READY → S-* 발급
```

## 12. 팀 공유 · Repository 전략

### 12.1 팀 공유

동일 Vanilla Core를 쓰면서 팀원별 조합만 달리한다. 차이는 Core Fork가 아니라
`Profile / Preset / Local Override / Adapter Selection`으로 해결한다.

```text
팀원 A: 실 파일럿 프로젝트 Profile + GitHub + Mattermost + Realtime Monitor
        + Independent Verifier + Conservative Preset
팀원 B: 실 파일럿 프로젝트 Profile + GitHub + Messenger 없음 + Manual Scan
        + Verifier 선택적 + Lightweight Preset
```

### 12.2 Git Repository 전략 — 정본은 각각 하나

```text
main = Vanilla ASC Core 정본 + main/profiles/* = Project Profile 정본
├── project/example-team     ← downstream / showcase / integration fixture
└── project/pinlog          (정본 Profile을 "소비"하는 예시 — 별도 Profile 정본 소유 금지)
```

- `main/profiles/example-team` = 실 파일럿 프로젝트 Project Profile의 **유일한 정본**.
- `project/example-team` = Vanilla Core + 정본 Profile을 실제 적용한 결과를 검증하는
  downstream일 뿐이다. **동일 Profile의 독립 사본을 두지 않는다** — Profile 이중 정본
  drift 금지.

동기화 방향: `main → project/*`. Project에서 Generic 개선 발견 시:

```text
project에서 문제 발견 → Generic 문제로 재설계 → main PR
→ Vanilla Core 반영 → project branch 다시 sync
```

Project 특화 구현을 그대로 main에 역병합하지 않는다.

### 12.3 Profile vs Project Fork

```text
Profile            = Core 변경 없음. 프로젝트 설정/정책/매핑만
Project Fork/Branch = Core Engine 자체 동작이 달라짐
```

목표: 프로젝트 차이의 90~95%는 Profile/Adapter로 해결.
Project branch에서 Core 수정이 반복되면 **Profile/Port 설계 부족 신호**로 본다.

### 12.4 Adapter / Port 구조

초기 Extension Point:

```text
SCM / Issue Provider     (GitHub / GitLab)
Messenger / Approval     (Mattermost / Slack / Discord / Teams / Local)
Event Source             (webhook / polling / manual / scheduled)
State Store              (Markdown[기본] / SQLite / JSON — §7.0)
Renderer / UI            (CLI / Messenger / Web UI)
Project Profile
```

처음부터 거대한 Plugin Framework를 만들지 않는다. **Port/Interface를 먼저 안정화하고
기본 Adapter부터 구현한다.**

## 13. 공식 프로젝트 흐름과의 관계 (v4 계승)

ASC 내부 State를 공식 프로젝트 영역에 자동 반영하지 않는다:
`ASC Result → Controller → 명시적 반영 지시 → Project official workflow`.

단, Session Contract에 Project Write Boundary가 명시된 실제 구현은 프로젝트 기존
규칙(커밋 규약·작업일지 등)에 따라 수행한다. `.asc/` 안에서만 끝난 세션(조사·계획·검증
리포트)은 공식 기록을 만들지 않는다 — Handoff가 전부이고, 공식 기록 여부는 Controller가
검토 후 결정한다. **ASC는 프로젝트 workflow를 대체하지 않는다.**

## 14. 자원 모델

비용 = `call frequency × input context × investigation depth × output size`.

최적화 수단 (전부 이 문서의 구조적 결정과 1:1 대응):

```text
Persistent Agent X → Persistent State O        (§6.1)
Ephemeral Worker                               (§6.1)
Bounded Current State                          (§7.3)
History Pointer + Lossless Archive             (§7.3~7.4)
Lightweight Phase A / Selective Phase B        (§10.2~10.3)
Event-triggered AI                             (§10.1)
```

## 15. 실 파일럿 프로젝트 Profile 방향 (예시 — 비규범)

v4에 박혀 있던 프로젝트 고유값을 전부 실 파일럿 프로젝트 Profile로 이동한다. 정확한 schema는
확정 전이며, 아래는 책임 배치 예시다:

```yaml
schema_version: 1

profile:
  id: example-team

project:
  scm: github
  repository: example-org/example-repo

canonical:
  sources:
    - id: shared-spec
      provider: git
      remote: origin
      ref: develop
      paths: [specs/**]
    - id: fe-plan
      provider: git
      remote: origin
      ref: front
      paths: ["specs/**/FE/**"]
    - id: decisions
      provider: github
      references:
        - issue: 19

monitor:
  labels:
    include: [front]
  escalation_labels:
    - blocker

workflow:
  block_source:
    path: docs/backlog.md
  task_source:
    prefer:
      - speckit_tasks
      - session_objective

verification:
  independent_verifier: true
  verifier_can_modify: false
```

User Override 예시(개인 몫 — Profile에 넣지 않는다): `identity.github: colosair`,
`controller.identities`, `approval.preferred_channel`, `monitor.realtime`.

v4 §8의 GitHub 실측값(라벨 `front` 단일, 타 파트 back/ai/game/infra, gh auth 확인
절차)은 이 Profile 작성 시 입력 자료로 유효하다.

## 16. 알려진 트레이드오프 (수용함)

- **Interrupt 부재**: 정본을 뒤집는 이벤트가 와도 진행 중 세션은 완주 → 낭비 가능.
  수용 — Run은 유한하고 다음 Run의 baseline 대조가 잡는다. 완화: 긴 세션 발급 전
  inbox 확인 습관.
- **state.md Controller-only의 회수 부담**: 세션 종료마다 Controller가 state·block·queue를
  직접 갱신해야 한다. 수용 — single-writer 충돌 제거와 Controller의 상태 인지 유지가
  갱신 비용보다 크다. 비대해지면 Derived View(dashboard)로 완화.
- **Monitor Run 직렬화의 처리 지연**: 이벤트 폭주 시 Run이 줄을 선다. 수용 — 감지
  누락이 아니라 처리 지연일 뿐이고, dedupe·PENDING_RETRY가 정합성을 지킨다.
- **Entity per file의 파일 수 증가**: inbox·grant가 파일 단위로 늘어난다. 수용 —
  처분 완료분 archive 이동으로 관리, views/가 목록 가독성 담당.
- **Polling 기반 Event Source의 지연**: SCM이 이벤트를 push해줄 수 없는 환경에서는
  감지 지연 = polling 간격. 수용 — webhook Adapter로 교체 가능하게 Port 설계.
- **Resolved Profile·ASC.md cache staleness**: 입력 계층 갱신 후 재생성 전까지 낡은 값
  사용 가능. 수용 — profile.lock 대조(§4.9)가 drift를 감지, 자동 재-resolve는 하지 않는다.

## 17. 정합성 검토 기록

**v4 → v5 (2026-08-22)**: 전환 과정에서 발견된 기존 충돌 4건(state.md writer /
Red 즉시 중단 / Monitor 논리 세션 표현 / Inbox 삭제 vs History 보존)은 모두 해소.
이후 Vanilla 배포·Realtime Monitoring·Multi-channel Approval 관점의 확장 검토에서
신규 보완 항목 10건이 확인되었고 v5.1에서 해소했다 (부록 A).

**v5.1 재검토 (2026-08-22)** — 9축 확인:

| 축 | 판정 근거 |
|---|---|
| Policy | 상속 확장 불가(§5.2) + permission intersection(§4.7) + Grant는 hierarchy 밖 one-shot contract(§5.2·§11.5) — override 해석 차단 |
| Profile inheritance | 필드 유형별 merge rule 표(§4.7), 초과 요청은 validation failure/반환 |
| Canonical | multi-source 정의·source별 snapshot·source별 drift 판정(§8), 세션 양식 반영(§7.5) |
| State concurrency | Logical Entity Model + State Store Port atomic transition + entity per file + Monitor Run 직렬화(§7.0·§7.2·§10.1) |
| Approval identity | ApprovalRequest.authorizedApprover + Adapter 인증 + Core binding 검증 + 불일치 audit(§11.6) |
| Grant lifecycle | grant_id·single_use·READY→CLAIMED→EXECUTED / INVALIDATED / EXPIRED·atomic CLAIM(§11.5), request_id 채널 공통·STALE 처리(§11.7) |
| Attach reproducibility | profile.lock 내용·lifecycle·drift 대조(§4.9) |
| State abstraction | Core Contract ≠ Markdown layout, Markdown = default adapter projection(§7.0) |
| Repository ownership | Core 정본 = main/core, Profile 정본 = main/profiles/* 단일, project/* = downstream fixture(§12.2), ASC.md = 생성물(§7.1) |

**v5.1 독립 검토 (2026-08-22)**: 별도 검토 세션이 체크리스트 A(Policy)~G(문서 품질)
전수 검증. 설계 동결 기준 10항목 전부 충족, blocker 0건 / minor 3건 —
① log-current 처분 기록 주체·직렬화 명세 공백, ② §4.7 optional capability 참조 범위
협소, ③ v4 문서 참조 잔존. ①·② 본문 반영 완료, ③ 수용(핵심 실측값 인라인 요약 존재).
**최종 판정: PASS — 설계 동결 후보.**

**v5.1 동결 보정 최종 확인 (2026-08-22)** — 5축 재검증 후 **PASS, 설계 동결**:

| 축 | 확인 |
|---|---|
| Runtime Contract | ASC.md(시스템 규칙, Resolver 생성) / controller.md(사람의 운영 지시, Resolver 입력 아님) 역할 비중첩. Run 부트스트랩 순서 ASC.md → controller.md → state.md → Session Contract → CHECKPOINT → Canonical 재독으로 고정 (§7.1·§9) |
| Policy 용어 | SOFT DENY 허용 = Policy Exception / 외부 Write = Execution Grant — 문서 전체에서 분리, 혼용 표현 제거 (§5.1·§5.4·§4.3) |
| Approval lifecycle | 커뮤니케이션(AWAITING→APPROVED→Grant→DONE)과 개발 작업(AWAITING→QUEUED→Session) 분리, APPROVED ≠ External Write Permission (§11.2·§11.8·§11.10) |
| Reproducibility | lock 대조 범위 = Core/Profile/Preset/Override/Adapter/capability/digest 전체 조합 (§4.9) |
| Archive | 현재 lock = attach configuration 정본 metadata / 이전 lock = `.asc/archive/profile-locks/` 무손실 archive (§4.9·§7.1·§7.4) |

**v4 검증 이력 승계**: GitHub 실측(2026-08-21)·spec 005 대입 검증·독립 Verifier
9 PASS/2 FAIL(정정 완료)은 실 파일럿 프로젝트 Profile 입력 자료로 유효 (§15).

## 18. 구현 로드맵 (설계 동결 이후)

**v5.1 설계는 동결되었다 (§17). 별도 v5.2 아키텍처 확장은 하지 않는다.**
이후 단계는 설계 추가가 아니라 구현 계약이다 (아직 착수하지 않는다):

```text
1. Port Interface 설계        (SCM / Approval / Event Source / State Store / Renderer)
2. Logical Entity Model 구체화
3. 최소 Vanilla Core          (Policy·Resolver)
4. Markdown State Adapter     (entity per file + atomic transition)
5. GitHub SCM / Event Adapter (polling Event Source)
6. Local Approval             (Messenger 없이 완결되는 승인 루프)
7. 실 파일럿 프로젝트 Profile           (§4.2 책임 경계 준수 서면 검증 포함 — PinLog 대조)
8. 실 파일럿 프로젝트 attach 파일럿     (asc init 왕복 1회: 세션 발급 → Checkpoint/Handoff → 회수)
9. Monitor 파일럿             (수동 scan → 잡음 보고 signal 조정 → scheduled/realtime 승격)
10. Mattermost Adapter        (Optional — §11.3, Local Approval 안정화 이후)
```

구현 중 새 문제 발견 시: 먼저 **기존 Port/Profile/Adapter 경계 안에서 해결 가능한가**를
확인하고, Core abstraction이 부족하다는 실제 증거가 있을 때만 설계 변경을 재개한다.

실패 시 `.asc/` 삭제로 원상복구 — 프로젝트 무영향 (§3.3).

## 19. 경계 문장 (운영 철학)

ASC Core는 프로젝트와 메신저를 알지 않는다. Core는 별도 Repository/설치 단위로 관리되고
원하는 프로젝트에 attach되며, 각 프로젝트에는 Project Profile 선택 정보와 독립된 `.asc/`
Runtime State만 존재한다. Project Profile이 프로젝트의 정본·이벤트·운영 특성을 정의하고,
Adapter가 GitHub·Mattermost 등 외부 시스템을 연결한다. Monitor는 이벤트를 발견하고
맥락을 조사해 상황 설명과 대응 초안까지 준비하지만 외부 행동은 하지 않는다. Controller인
사람이 우선순위·정책·외부 대응을 승인하고, 승인된 작업만 Ephemeral Session 또는
Execution Grant를 통해 수행한다. 장기적으로 유지되는 것은 Agent가 아니라 State이며,
Current State는 bounded rewrite, History는 append/immutable + lossless rotation으로
관리한다.

---

## 부록 A. Change Summary

### v4 → v5

**유지** (원칙 전부): 공식 프로세스 무변경 / 로컬 분리·삭제 무영향 / 정본 복제 금지
(pointer+baseline) / 사람=Controller / 실행력만 위임 / Execution·Monitoring 분리 /
자동 외부 게시 금지 / Implementer·Verifier 분리, Verifier 수정 금지 / Handoff 인수인계 /
Canonical snapshot·drift guard / Inbox·Queue 분리 / 상호 불간섭·자동 Interrupt 없음 /
Phase A 경량·Phase B 선별 / 승인 후에만 외부 Action / `tasks/` 없음·Handoff는 세션 파일
하단 / 두 경로(커뮤니케이션·개발 작업) / 기각 스레드 새 이벤트 재유입.

**수정**: 정체성(Vanilla Core+Profile+attach) / Green·Yellow·Red→ALLOW·SOFT·HARD 정책
계층+상속 / Red 즉시중단→Blocking·Non-blocking 분기 / Monitor 장기세션→Persistent
State+Ephemeral Run / Logical Session≠Physical Run(+CHECKPOINT·상태머신) / canonical
하드코딩→profile-defined / Generic Signal / Inbox 삭제→History 기록 후 제거 /
Execution Grant·게시 직전 Drift Guard 명문화 / 도입 절차→로드맵.

**폐기**: Work Session의 state.md 갱신 권한(Controller ONLY로) / log tail dedupe
(event key로) / 프로젝트 내부 Core 전제 / AI 문서 다이어트(lossless rotation으로).

**신규**: 배포 모델(§3) / 구성 계층(§4) / Persistent State vs Ephemeral Compute(§6.1) /
문서 수명주기+lossless rotation(§7.3~7.4) / Event Gate·PENDING_RETRY(§10) /
Approval Port·Capability Model·Mattermost UX(§11) / Execution Grant(§11.5) /
팀 공유·branch 전략(§12) / 자원 모델(§14).

### v5 → v5.1 (정합성·동시성·재현성 보정 — 구조 무변경)

1. `ASC.md` = Generated Runtime Contract(Resolver 생성물)로 확정 — 정책 정본 이중화
   차단 (§3.1·§7.1). Writer도 Controller→Resolver로 수정.
2. Canonical 단일 branch → multi-source/multi-ref 모델, source별 snapshot·drift (§8).
3. Profile Resolver merge semantics 명문화 — scalar/replace/union/intersection/
   capability/HARD DENY immutable (§4.7).
4. Execution Grant ≠ HARD DENY override — hierarchy 밖 one-shot execution contract로
   명문화 (§5.2·§11.5).
5. State 동시성: Logical Entity Model + State Store Port(atomic transition) 채택,
   Markdown Adapter는 entity per file(inbox/·grants/) + views/ Derived View,
   Monitor Run 프로젝트당 직렬화 (§7.0·§7.2·§10.1).
6. Controller Identity Binding — authorizedApprover·Adapter 인증·Core 검증·불일치
   audit (§11.6, Override에 identities 매핑 §4.4).
7. ApprovalRequest/Grant idempotency·replay guard — request_id 채널 공통,
   One Request Many Presentations, STALE/ALREADY_DECIDED, Grant lifecycle·single_use·
   atomic CLAIM (§11.5·§11.7).
8. Attach 재현성 — `.asc/profile.lock` + lifecycle (§4.9).
9. State Store Port와 Markdown 표현 분리 명시 — Core Contract ≠ file layout (§7.0).
10. Profile 정본 단일화 — `main/profiles/*`가 유일 정본, `project/*`는 downstream
    fixture로 사본 소유 금지 (§12.2). §17 정합성 검토 표현 범위 수정 + v5.1 9축 재검토 기록.

### v5.1 동결 보정 (모호성 제거 5건 — 구조 무변경, 이후 동결)

1. controller.md를 Resolver 입력에서 제외 — Runtime Controller Contract로 정의,
   수정해도 ASC.md 재생성 안 함. Run 부트스트랩 순서 명문화 (§7.1·§9).
2. SOFT DENY 허용 = **Policy Exception**으로 용어 분리 — Execution Grant와 별개,
   HARD DENY 해제 불가 (§5.1).
3. Inbox lifecycle에 [APPROVED] 추가 — 커뮤니케이션/개발 작업 두 lifecycle 분리,
   APPROVED ≠ External Write Permission (§11.2·§11.8·§11.10).
4. profile.lock drift 대조 범위를 resolved input 전체 조합으로 확정, Override digest
   포함 (§4.9).
5. 이전 lock archive 위치 확정 — `.asc/archive/profile-locks/` (§4.9·§7.1·§7.4).
   §18을 구현 로드맵 10단계로 갱신, 설계 동결 명시.
