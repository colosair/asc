# ASC 구현 계약 C-02 — Port / Boundary Contract

> 작성: 2026-08-22. **지위: 동결된 설계 v5.1 OM(`docs/design/operating-model.md`)과
> C-01(`C-01_approval-port.md`)의 구현 계약이다 — 설계 재개가 아니다.**
> B-02 산출물이며, 코드가 정본이다. 이 문서는 코드로 표현되지 않는 결정과 근거,
> 그리고 Gate 대조 기록을 담는다.
> 구현: `ports/*.ts`, `core/view/decision-view.ts`, `adapters/memory/*`.

---

## 1. Port 목록과 책임 경계

| Port | 파일 | 책임 | 하지 않는 것 |
|---|---|---|---|
| State Store | `ports/state-store.ts` | entity 저장·조회·CAS·History append·Adapter scope 제공 | 상태 전이 판단(Core), 표현(Renderer) |
| Approval | `ports/approval.ts` | 요청 표시(`ApprovalChannel`), 결정 수신(`DecisionSink`), 승인자 검증(`IdentityBinding`) | 외부 write, 전이 결정 |
| SCM | `ports/scm.ts` | 스레드·baseline 조회, 승인된 단일 Action 실행 | 권한 판단(Executor가 Grant로 통제) |
| Event Source | `ports/event-source.ts` | 원본 이벤트 공급(`drain`) | 분류·우선순위·dedupe(Monitor) |
| Renderer | `ports/renderer.ts` | View Model → 채널 표현 | 전달·결정 수신(Approval Channel) |

Core는 어떤 Port에서도 provider 이름(github/mattermost 등)을 알지 않는다. Adapter는
`id` 문자열로 자신을 밝히고 Core는 그 값을 해석 없이 통과시킨다.

## 2. 이번 단계에서 확정한 것 (C-01 §14 미확정 항목 중)

```text
request_id 형식   REQ-0042 (+ G-0001 / S-YYYYMMDD-NN / B-NN / Q-0001)   → core/model/ids.ts
version 스키마    entity.version(정수, 전이당 +1). 별도 etag 없음        → ports/state-store.ts
freshness enum    CURRENT / STALE_CONTEXT / SOURCE_CHANGED / ALREADY_DECIDED
                                                                        → core/view/decision-view.ts
PresentationRecord 소유  Adapter-owned metadata (§3)
```

C-01 §14에 남아 있던 나머지(CLI syntax, local authentication 방법, MM Local Handoff
힌트 문구)는 B-05·B-06·B-13에서 확정한다.

## 3. PresentationRecord 소유 — 결정과 근거

**결정: Adapter-owned metadata. Core Logical Entity가 아니다.**
저장 위치는 `StateStore.scope(adapterId)`가 주는 격리 공간이며, Core의 `EntityMap`에
등록하지 않는다.

근거:
1. Core가 채널별 매핑을 entity로 들면 채널이 늘 때마다 Core 스키마가 흔들린다 —
   "Core는 플랫폼 메시지 구조를 몰라야 한다"(OM §11.3)와 어긋난다.
2. 매핑은 정본이 아니다(C-01 §9). 정본 entity와 같은 전이·CAS 규율을 줄 이유가 없다.
3. 표시 갱신은 best-effort다. 실패가 canonical state에 영향을 주지 않으려면 매핑이
   Core 전이 경로 밖에 있어야 한다.

따라서 Core의 책임은 "상태가 바뀐 view를 채널들에 알린다"까지이고, 어떤 외부 메시지를
고칠지는 각 Adapter가 자기 매핑을 보고 정한다. 채널이 죽어 갱신에 실패해도 낡은 버튼
입력은 CAS가 거절하므로 안전하다.

## 4. CAS semantics

- 모든 entity는 `version`을 갖고 그 값이 유일한 동시성 토큰이다.
- 갱신 경로는 `compareAndSet(kind, id, expectedVersion, next)` 하나뿐이다.
- `next.version === expectedVersion + 1`이 아니면 **던진다** — 경쟁 실패가 아니라
  호출자 버그다.
- 저장된 version이 다르면 아무것도 쓰지 않고 `VERSION_CONFLICT`와 함께 **현재 entity**를
  돌려준다. 이 값이 사용자에게 `ALREADY_DECIDED`인지 단순 `STALE`인지 설명하는 근거다.
- 예외가 아니라 결과값으로 실패하는 이유: 두 채널이 같은 요청을 동시에 결정하는 것은
  오류 상황이 아니라 일상이다(C-01 §7).

## 5. Gate 대조 — C-01 §13 FAIL 기준 8항

| 기준 | 판정 | 이 단계의 근거 |
|---|---|---|
| Core 독립성 — 제품명이 Core Contract에 들어가면 FAIL | PASS | Port 5종 어디에도 Claude Code·GitHub·Mattermost 문자열 없음. Adapter는 `id`로만 자신을 밝힌다 |
| 정본 단일성 | PASS | 정본은 `ApprovalRequest` entity. View Model·PresentationRecord·Rendered는 전부 파생물이며 `EntityMap`에 없다 |
| State abstraction — Markdown 직접 읽기가 유일 경로면 FAIL | PASS | Core는 `StateStore` 인터페이스만 안다. in-memory 구현으로 전 계약이 동작함을 테스트가 보인다 |
| Cross-channel consistency | PASS | 채널은 `DecisionView.requestId`를 그대로 쓰고, 표시는 `present/update`로만 한다 — 채널이 요청을 새로 만들 경로가 없다 |
| Human control — Agent 자체 Decision 가능하면 FAIL | PASS | `DecisionSink.submit`은 사람의 입력을 받은 채널만 호출하는 단방향 입구이고, `IdentityBinding`이 actor를 검증한다 |
| Race safety | PASS | 동시 3채널 CAS에서 정확히 1건만 성공함을 테스트가 검증 (`tests/ports.test.ts`) |
| Temporal correctness | PASS | View Model이 `stored`(불변 분석)와 `current`(조회 시점 Overlay)를 구조적으로 분리하고, Renderer가 둘을 다른 블록으로 그린다 |
| External write safety | PASS | 외부 write는 `ScmPort.execute` 한 지점뿐이며, Grant를 쥔 Executor만 호출한다는 것이 Port 주석에 계약으로 명시됨 (강제는 B-07) |

## 6. 검증

```bash
npm test        # 49 tests pass (model 23 + ports 26)
npm run typecheck
```

`tests/ports.test.ts`가 확인하는 것: CAS 성공·충돌·NOT_FOUND·버전 계약 위반, 동시 결정
1건만 통과, 저장소 객체 격리, Adapter scope 격리, PresentationRecord가 Core entity 밖에
있음, 채널 갱신 실패가 canonical state에 무영향, Identity Binding의 채널별 구분,
Renderer의 reference 항상 노출·Stored/Overlay 분리, freshness 4종 고정.

## 7. Markdown Adapter 표현 (B-04에서 확정)

Core Contract가 아니라 기본 Adapter의 파일 배치다. 언제든 SQLite/JSON으로 바뀔 수 있다.

```text
.asc/
  state.md                    ControlState
  sessions/active/<id>.md     S-YYYYMMDD-NN.md
  monitor/inbox/<id>.md       REQ-NNNN.md
  monitor/grants/<id>.md      G-NNNN.md
  monitor/queue/<id>.md       Q-NNNN.md
  monitor/events/<key>.md     파일명 불가 문자는 치환
  monitor/log-current.md      append-only History
  monitor/views/inbox.md      Derived View
  adapters/<id>/<key>.json    Adapter scope (PresentationRecord 등)
```

**파일명은 entity id 그대로 쓴다** — C-01 §1의 `I-0042.md`는 예시였고, 실제로는
`REQ-0042.md`가 채널 간 correlation을 눈으로 확인하기 쉽다. 어느 쪽이든 파일명은 Core
identity가 아니라는 원칙(C-01 §1)은 그대로다. event key처럼 파일명에 못 쓰는 문자가 있는
id는 치환하되, 원본 id는 파일 안 JSON에 남으므로 목록은 파일을 읽어 만든다.

**한 파일, 두 독자**: HTML 주석 안의 JSON이 정본이고 그 아래 Markdown 본문은 매번 다시
그려지는 projection이다. 사람이 본문만 고쳐도 데이터는 잃지 않고, 다음 저장에서 본문은
덮인다 — 본문을 정본으로 삼으려는 유혹이 생기지 않는다.

**동시성 두 층**: 생성은 `O_EXCL`이 파일시스템 차원에서 중복을 막고(락 불필요), 갱신은
락 파일로 임계구역을 만든 뒤 임시 파일 + `rename`으로 원자 교체한다. 락 대기는 짧게
스핀하고, version 불일치는 기다리지 않고 그대로 보고한다 — 앞의 것은 순간적 경합이고
뒤의 것은 "그 사이 누가 결정했다"는 사실이기 때문이다.

## 8. 다음 블록으로 넘긴 것

```text
Session/Request 전이 오케스트레이션·Policy 병합    → B-03
Markdown State Store 구현(entity per file·atomic) → B-04
DecisionView 실제 조립(Overlay·freshness 산출)     → B-05
DecisionSink 구현·Identity Binding 실물            → B-06
Grant Executor·Drift Guard 강제                    → B-07
```
