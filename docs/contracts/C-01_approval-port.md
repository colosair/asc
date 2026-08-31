# ASC 구현 계약 C-01 — Approval Port · Local Operator Interface

> 작성: 2026-08-22. **지위: 동결된 설계 v5.1(`operating-model.md`)의 구현 계약
> Addendum이다 — 설계 재개·v5.2 구조 문서가 아니다.** v5.1의 `Renderer/UI Port`,
> `Approval Port`, `State Store Port` 경계 안에서만 정의한다.
> 반영 위치: v5.1 §18 로드맵의 `1. Port Interface 설계`와 `6. Local Approval` 단계.
> 본문 API·CLI·enum·필드명은 계약 검증용 예시이며 exact 형식은 구현 단계에서 확정한다.

---

## 0. 목적 — 지원하는 사용자 흐름

사용자가 로컬 AI 작업환경(예: Claude Code — **소비자 예시일 뿐, Core Contract 구성요소
아님**)에서 작업 중 Mattermost로 ASC 승인 알림을 받았을 때, MM을 다시 열어 원문을
찾거나 복사하지 않고 현재 작업환경에서 **동일한 ApprovalRequest**를 조회·검토·결정한다.

```text
1. 로컬 작업환경에서 평소 작업 (예: S-023 구현 중)
2. MM에 REQ-0042 알림
3. 로컬에서 "REQ-0042 확인해"
4. 동일 보고서 + 현재 세션 영향(Overlay) 확인
5. 사용자가 승인/수정/보류/기각
6. 어느 채널에서 결정해도 동일 Request 상태 변경
7. 승인된 것만 기존 ASC 실행 흐름(Grant/Queue)으로 진입
```

```text
                    ASC ApprovalRequest
                         REQ-0042
                             │
                  Shared Decision View Model
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
     Mattermost        Local Operator         Web UI
   알림 + 빠른 결정      전체 검토 (+ Agent)
                             │
                 Current Context Overlay
                             │
                      사용자 명시 결정
                             │
                        Approval Port
                             │
                       ASC Core State
```

기존 원칙의 확장이지 신설이 아니다: `One Request / Many Presentations`(v5.1 §11.7)에
**Local Operator라는 Presentation 하나를 추가**하는 계약이다.

## 1. 정본·식별 규칙

- Approval 보고서의 정본은 MM 메시지도, Markdown 파일도 아니다. 정본은 Logical State
  Model의 **ApprovalRequest entity** 하나다 (v5.1 §7.0).
- Core identity는 **`request_id`**다. 파일명·MM 메시지·CLI 출력은 전부 projection이다:

```text
request_id: REQ-0042          ← Core identity (유일)
Markdown:   I-0042.md         ← State Store projection
Mattermost: ASC · P0 · REQ-0042  ← Presentation
CLI/Web/Agent: REQ-0042       ← Presentation
```

- `.asc/monitor/inbox/I-*` **파일 경로 자체를 Core API로 만들지 않는다.**
  `I-0042` 같은 파일명 규칙과 request_id의 exact 형식은 구현 시 확정하되,
  모든 표면이 동일 논리 entity를 가리킨다는 계약은 고정이다.

## 2. Correlation Reference 계약

모든 Approval Presentation은 **복사 가능한 stable request reference를 반드시 표시**한다.

```text
ASC · P0 · REQ-0042 · Issue #19
```

- MM 카드에서 request_id를 숨기지 않는다.
- 목표 UX: MM에서 `REQ-0042`를 본 사용자가 로컬에서 "REQ-0042 확인해"라고 말하는 것만으로
  정확히 같은 요청을 찾는다.
- MM 카드에는 Local Handoff 힌트를 함께 둔다 (문구는 CLI 확정 후):

```text
ASC · P0 · REQ-0042
Issue #19 답변 승인 필요
[승인] [수정] [보류] [기각]
로컬에서 자세히 보기: REQ-0042를 ASC Local Interface에서 조회
```

## 3. Shared Decision View Model

MM과 Local이 같은 ApprovalRequest를 각자 임의 재구성하면 보고서 구조가 갈라진다.
Renderer 앞에 **공통 Decision View Model**을 둔다:

```text
ApprovalRequest
      ↓
Decision View Model
      │
 ┌────┼──────────┐
 ▼    ▼          ▼
MM   Local      Web
```

공통 의미 구조 (최소):

```text
Request Reference / Priority / Status / Detected / Source
상황 / 관련 맥락 / Canonical
현재 작업 영향 / 중단 필요 여부 / 판단 근거
권장 대응 / 답변 초안
Snapshot / Freshness
Allowed Decisions
```

- Renderer별 접기/요약은 허용: MM = 핵심 요약+버튼, Local = 전체 보고서,
  Web = 전체+접이식.
- **강제하는 것은 화면 모양이 아니라 의미 구조와 request_id의 동일성이다.**

## 4. Local Operator Interface

Core가 특정 로컬 도구(Claude Code 등)를 알아서는 안 된다. 로컬 작업환경이 사용할
**Generic Local Operator Interface**를 정의한다. 새 Plane이 아니라
`Renderer/UI Port + Local Approval Adapter`의 로컬 구현 계약이다.

Use Case:

```text
ApprovalRequest List      listRequests(filter: pending/priority/detected_at ...)
ApprovalRequest Get       getRequest(request_id)
ApprovalRequest Status    (freshness 포함 — §7)
ApprovalDecision Submit   submitDecision(request_id, decision, revision?, expectedVersion)
```

초기 Surface는 CLI가 기본 후보다 (syntax 미확정 — 개념 예시):

```text
asc inbox list
asc inbox show REQ-0042
asc inbox decide REQ-0042 approve
```

소비자: `CLI / MCP / Web UI / IDE integration / shell 사용 가능한 Agent`.
**Claude Code integration = Core dependency가 아니라 이 인터페이스의 한 소비자다.**

## 5. Agent Read와 Human Decision의 분리

Agent의 ApprovalRequest 조회·분석은 read operation — 자유:

```text
"REQ-0042 보여줘" / "현재 세션 영향 분석해" / "이 초안 설명해"
"MM에서 온 최신 P0 요청 정리해"
```

그러나 **Agent가 자체 판단으로 approve/dismiss/queue 등 state transition을 수행하면
안 된다.** transition은 사람의 명시적 의사표현이 있을 때만:

```text
"REQ-0042 승인해" / "둘째 문장을 이렇게 수정한 뒤 승인" / "이건 보류"
```

이 명시적 입력이 Local Approval Adapter를 거쳐 `ApprovalDecision`으로 변환된다.
`AI 판단 ≠ Controller Decision` (v5.1 §1.5)을 Local UI에서도 그대로 유지한다.

**Local Approval도 Controller Identity Binding(v5.1 §11.6)을 통과한다:**

```text
사용자의 명시적 Local Decision
  → Local Approval Adapter
  → ApprovalDecision (동일 semantics)
  → Controller Identity Binding 검증
  → ASC Core
```

Local이라는 이유만으로 무조건 trusted 승인으로 처리하지 않는다.
local authentication 방법은 구현 시 확정, Core semantics는 채널 공통.

## 6. Stored Packet vs Current Context Overlay

MM 보고서는 **ApprovalRequest 생성 당시의 판단 snapshot**이다. 사용자가 로컬에서
확인하는 시점에는 상황이 바뀌어 있을 수 있다 (14:00 생성 당시 S-020·abc123 →
14:20 조회 시 S-023·def456). 둘을 섞어 쓰지 않는다:

| 구분 | 내용 | 성격 |
|---|---|---|
| **A. Stored Decision Packet** | MM에 표시된 요청의 원래 분석 ("생성 당시 S-020에 영향 없음") | ApprovalRequest 원본 — 불변 |
| **B. Current Context Overlay** | 현재 `.asc/` state·controller·Active Session·Canonical을 다시 읽어 만든 파생 정보 ("현재 S-023에는 영향 있음, Canonical abc123→def456 변경됨") | **Derived View** — 원본 덮어쓰기·History 수정 금지 |

표현 계약:

```text
REQ-0042
────────────────────────
[알림 당시 분석]
현재 작업 중단 필요: No / 기준 Session: S-020 / Snapshot: abc123

[현재 작업 기준]
현재 Active Session: S-023 / 영향: 있음 / Canonical 변경: abc123 → def456
```

Agent가 과거 보고서를 현재 사실처럼 설명하는 것을 이 구분으로 차단한다.

## 7. Freshness 표시 규칙

Local Operator Interface는 조회 시 요청의 freshness를 함께 확인·표시한다.
최소 구분 (enum 명칭은 구현 시 확정):

```text
CURRENT          변화 없음
STALE_CONTEXT    생성 당시 대비 로컬 작업 맥락 변화 (Active Session 등)
SOURCE_CHANGED   대상 스레드/Canonical source 변화
ALREADY_DECIDED  다른 채널에서 이미 결정됨
```

**역할 경계**: Local freshness = 사용성·사전 경고. Execution Grant → Drift Guard
(v5.1 §11.9) = 최종 실행 안전장치. **대체 관계가 아니다** — freshness가 CURRENT여도
Executor는 Action 직전 Drift Guard를 그대로 수행한다.

## 8. Atomic Decision — Cross-channel 동시 결정 방지

사용자가 MM과 로컬을 동시에 열어둘 수 있다. 결정은 entity version 기반
**atomic transition(CAS)**으로만 수행한다 (State Store Port의 atomic transition —
v5.1 §7.2 — 의 Approval 적용):

```text
read REQ-0042 (version=7)
  → submitDecision(expectedVersion=7)
  → CAS
성공  → 상태 전이 (예: APPROVED)
실패(이미 version 8) → STALE / ALREADY_DECIDED 반환
```

- 로컬에서 먼저 승인 → MM 버튼은 ALREADY_DECIDED. 반대도 동일.
- 이는 v5.1 §11.7(최초 유효 Decision 이후 STALE 처리)의 구현 계약이다.
  version/etag 스키마는 구현 시 확정.

## 9. PresentationRecord — 채널 표시물 동기화 metadata

로컬 결정 후 MM 카드에도 가능하면 결과를 반영한다 ("✅ 다른 채널에서 승인됨").
이를 위해 Adapter는 request↔외부 표시물 매핑 metadata를 가질 수 있다:

```text
PresentationRecord
request_id / channel / external_message_ref / rendered_at
```

- **PresentationRecord는 ApprovalRequest 정본이 아니다** (원칙 고정).
  Core Logical Entity로 둘지 Adapter-owned metadata로 둘지는 Port Interface 설계
  단계에서 결정한다.
- 흐름: `ApprovalRequest 상태 변경 → Presentation Update → MM 메시지 수정/thread 표시`.
- Presentation Update는 **best-effort**: MM이 메시지 수정을 미지원하거나 업데이트에
  실패해도 ASC canonical state에는 영향 없다. 낡은 MM 버튼 입력은 Core가
  ALREADY_DECIDED로 거절하면 된다 (§8).

## 10. 결정 이후 흐름 — 기존 v5.1 경로 그대로

**작업형** (예: REQ-0048 "#32 FE 계약 검토 작업 필요"):

```text
"REQ-0048 확인해"
  → Local Operator: 동일 ApprovalRequest 조회 → Stored Packet 표시
    → 현재 state/controller/active session 읽기 → Overlay 표시
사용자: "작업 진행 승인"
  → AWAITING_APPROVAL → QUEUED
  → 이후 Controller 흐름: Queue → Logical Session 발급
```

**Agent가 임의로 새 Session을 만들어 실행하지 않는다.**

**대응형** (예: REQ-0042 "Issue #19 답변 초안"):

```text
"REQ-0042 보여줘" → 동일 Decision Packet 표시
사용자: "마지막 문장 빼고 승인해"
  → ApprovalDecision(revision 포함)
  → APPROVED → Execution Grant → Executor → Drift Guard → External Action
```

**로컬 Agent가 직접 GitHub 댓글을 게시하지 않는다** — Execution Grant 경계
(v5.1 §11.5·§11.8) 유지. APPROVED ≠ External Write Permission.

## 11. request_id 없는 조회 ("방금 온 알림 보여줘")

Local Operator는 `pending requests, sort by detected_at desc` 류 조회를 지원할 수 있다.
단 **복수 후보가 있으면 Agent가 임의로 하나를 정본처럼 확정하지 않는다**:

```text
최근 승인 요청이 2건 있습니다.
REQ-0042 · P0 · Issue #19
REQ-0041 · P1 · PR #50
어느 요청인지 지정하거나 '최신 P0'처럼 조건을 주십시오.
```

명백하게 하나뿐인 경우에는 바로 표시 가능.

## 12. Markdown Direct-read는 Fallback

초기 Markdown Adapter 환경에서 `.asc/monitor/inbox/I-0042.md` 직접 읽기는 기술적으로
가능하지만 **정식 인터페이스로 고정하지 않는다** — State Store가 SQLite/JSON/Web으로
바뀌어도 로컬 사용자 흐름이 깨지면 안 되기 때문이다.

```text
정식:   Local Operator Interface → ASC Core / State Store Port → Current State Adapter
fallback: Markdown direct read   → MVP fallback / debugging path 로만
```

## 13. 검토 판정 기록 (2026-08-22)

v5.1 동결 구조 대입 결과 — **기존 확장점 안에서 해결 가능, 설계 재개 불필요**:

```text
Core 재설계 필요           NO
새 Plane 필요              NO
Claude 전용 Adapter 필요    NO

Renderer/UI Port 확장        YES  (Shared Decision View Model — §3)
Local Approval 계약 구체화    YES  (§4~5)
request correlation          YES  (§1~2)
Current Context Overlay      YES  (§6)
cross-channel CAS            YES  (§8)
presentation sync metadata   YES  (§9)
```

FAIL 기준 8항 검증:

| 기준 | 판정 | 근거 |
|---|---|---|
| Core 독립성 — 제품명이 Core Contract에 포함되면 FAIL | PASS | Claude Code는 §0·§4에서 소비자 예시로만 등장. Core Contract 구성요소는 Local Operator Interface (§4) |
| 정본 단일성 — 정본 모호하면 FAIL | PASS | 정본 = Logical ApprovalRequest 하나, MM·Local·Markdown 전부 projection (§1) |
| State abstraction — Markdown 직접 읽기가 유일 경로면 FAIL | PASS | 정식 경로 = Local Operator Interface → State Store Port, direct read는 fallback (§12) |
| Cross-channel consistency — 채널별 별도 request면 FAIL | PASS | 전 채널 동일 request_id, One Request Many Presentations (§1~2) |
| Human control — Agent 자체 Decision 가능하면 FAIL | PASS | read/transition 분리, 명시적 사람 입력 + Identity Binding (§5) |
| Race safety — 동시 승인 중복 실행 가능하면 FAIL | PASS | expectedVersion CAS + STALE/ALREADY_DECIDED (§8), Grant single_use는 v5.1 §11.5 |
| Temporal correctness — 과거 분석과 현재 상태 혼합하면 FAIL | PASS | Stored Packet / Current Context Overlay 분리 + freshness (§6~7) |
| External write safety — Grant 우회 직접 게시 가능하면 FAIL | PASS | 결정 후에도 Grant→Executor→Drift Guard 경로만 (§10) |

## 14. 구현 단계 확정 항목 (의도된 미확정)

계약은 고정, exact 형식만 다음 단계에서 확정한다:

```text
request_id / 파일명 규칙의 exact 형식        (§1)
freshness enum 명칭                          (§7)
CLI syntax                                   (§4)
local authentication 방법                    (§5)
version/etag 스키마                          (§8)
PresentationRecord 소유 위치 (Core entity vs Adapter metadata)  (§9)
MM Local Handoff 힌트 문구                   (§2)
```

## 15. 로드맵 반영

v5.1 §18 순서 유지. 이 계약은 다음 단계에 포함되어 구현된다:

```text
§18-1 Port Interface 설계   ← §3 View Model, §4 Interface, §8 CAS, §9 PresentationRecord 소유 결정
§18-6 Local Approval        ← §5 Decision contract, §7 freshness, §11 조회 UX, §12 fallback
```

별도 v5.2 구조 문서는 만들지 않는다 — 동결 v5.1 + 본 구현 계약(C-01)로 진행한다.
