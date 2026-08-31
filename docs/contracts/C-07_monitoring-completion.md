# ASC 구현 계약 C-07 — Monitoring Completion

> 작성: 2026-08-26. **지위: 동결된 설계 v5.1(OM)·C-01·C-02·C-03을 수정하지 않는
> 후속 구현 계약이다 — 설계 재개가 아니다.**
> 근거 지시: (비공개 evidence 저장소) (원문 보관, 비규범).
> 근거 실측: (비공개 evidence 저장소) (감지 60건·잡음 45%·`review:` 미수집·라벨 미검증).
> 대상 로드맵: B-30(Relevance·Shadow·Material Change) · B-31(Coverage) · B-32(Typed Investigation).
> 본문 API·필드명은 계약 검증용이며 exact 형식은 구현 중 한 번만 결정한다.

---

## 0. 무엇을 고치는가

Monitoring은 지금 **notification이 온 것만** 본다. 그래서 두 방향으로 동시에 틀린다.

```text
못 잡는다   assignee·reviewer·mention 누락 / 닫힌 Issue·MR의 새 변경 / 알림 유실
과잉 잡는다 나와 무관한 곳에 태그당함 / 같은 스레드에서 반복 mention
```

둘은 **다른 문제**이고 다른 장치로 고친다.

```text
못 잡는 것   → Coverage (Delta / Reconcile / Census)
과잉 잡는 것 → Relevance (Explicit ≠ Actual) + Shadow Watch + Material Change
```

그리고 둘 다 고쳐도 남는 문제가 하나 더 있다 — **잡은 것을 사람에게 어떻게 건네는가**.
그건 C-08 소관이다. 여기서는 `Real-time Detection ≠ Real-time Notification` 이 원칙이라는
사실만 못 박는다.

## 0.1 두 축은 섞지 않는다

```text
Coverage           무엇을 후보로 올릴 것인가 (Phase A 입력 범위)
Investigation Depth 한 건을 얼마나 팔 것인가 (C-05 §3 — 요청 단위 budget)
```

`Delta × scan`, `Reconcile × scan`, `candidate → inspect`, `충돌 사건 → trace` 처럼 조합한다.
**전역 depth mode는 만들지 않는다** — C-05 §3.1과 B-26 Gate가 이미 잠근 사실이며 여기서
되돌리지 않는다.

## 0.2 새 Core Entity를 만들지 않는다

Coverage 상태·Shadow Watch·material change 마커·health metadata는 전부 **adapter-scope
`ScopedStore` 레코드**다 (C-04 §0.1 Bounded Query, B-20 Closure Ledger와 같은 경로).

```text
Request 상태 열거(OM §11.2) 무변경 — SHADOW 같은 새 상태 없음
state.md 무접촉(OM §7.5 "갱신자 없는 데이터 금지" / §7.2 Controller ONLY)
Monitor write 경계(OM §10.7) 무확대 — 자기 계약 파일 + inbox entity + log
```

---

## 1. Coverage — 세 경로

### 1.1 Delta (Hot Path)

가장 싸고 빠른 감지. webhook / incremental polling / provider notification / updated-since.
지금 구현이 이것이다.

**Delta는 완전성의 보증 수단이 아니다.** 빠른 발견만 담당한다.

### 1.2 Reconcile

Hot Path가 놓친 것이 없는지 **실제 inventory를 다시 조회**한다. notification feed 재조회가
아니다.

```text
open만 조회 X
open / closed / merged / resolved — 모든 상태 O
```

닫힌 객체를 빼면 안 되는 이유는 실측 가능한 사실이다 — closed Issue에 새 comment, merged MR에
discussion, 닫힌 작업의 description 변경이 실제로 일어난다. 회수 기준은 상태가 아니라
**`updatedAt` / revisionMarker**(§4)다.

### 1.3 Census

가장 넓은 안전망. 질문은 하나다 — **ASC가 아는 세계와 provider의 실제 세계가 일치하는가.**

```text
모든 relevant object type / 모든 상태 / pagination completeness / 충분히 넓은 lookback
ASC-known reference와 provider inventory의 불일치
```

"전체"는 **전 기간 본문을 다시 읽는다는 뜻이 아니다** — 모든 상태·모든 타입·모든 페이지를
빠짐없이 훑는다는 뜻이다.

### 1.4 Census는 event 재생이 아니라 reference 상태 비교다

이것이 dedupe(OM §10.4 exact lookup)와 충돌하지 않는 유일한 형태다. 매 census마다 같은 객체를
새 event key로 올리면 매번 새 패킷이 된다.

```text
census:<reference> 에 지난 관측(state·assignees·labels·revisionMarker) 보관
→ 이번 관측과 비교
→ 달라진 것만 event로 승격
```

### 1.5 Missing Reference도 anomaly다

```text
이전 census에 있었다 − 이번 inventory에 없다 → 관찰 대상
```

**원인을 추측하지 않는다.** `DELETED`로 단정하지 않고 `RESOURCE_MISSING` 으로 표면화한다 —
실제 삭제일 수도, permission·visibility 변화일 수도, filter 변화나 provider 오류일 수도 있다.
그중 무엇인지는 사람이 본다.

### 1.6 Discovery Path ≠ Priority

Reconcile·Census에서 늦게 발견했다는 이유로 우선순위를 낮추지 않는다. FE contract를 깨는
변경이 reviewer·mention 없이 들어왔다면, 그것이 **늦게 발견됐다는 사실이 위험을 줄이지
않는다.** 발견 후 현재 영향도로 다시 판정한다.

### 1.7 세 경로가 같은 변화를 봐도 패킷은 하나다

Hot / Reconcile / Census가 겹쳐 관측하는 것은 정상이며(OM §10.5 "누락보다 중복이 안전"),
중복 제거는 event key exact lookup + §4 material change 억제가 함께 맡는다.
기존 `cursor / overlap / PENDING_RETRY / replay envelope / scan lease` 는 전부 유지한다.

### 1.8 주기는 계약이 아니라 설정이다

Delta 실시간 / Reconcile 30분 / Wide Reconcile 3~6시간 / Census 일 1회는 **운영 예시**다.
Core에 상수로 박지 않는다. 실행 계기는 외부 orchestration(scheduler·cron)이 갖는다 —
B-12가 정한 승격선(수동 → scheduled, realtime 보류)을 이 계약이 넘지 않는다.

---

## 2. Signal ≠ Relevance

### 2.1 두 층이다

```text
Generic Signal      사건에 대한 관찰 신호. explicit targeting evidence를 포함한다
Actual Relevance    사건과 지금 나·이 프로젝트의 관계 판정
```

```text
Generic Signals ──(explicit evidence)──┐
                                       ▼
                              Relevance Evaluator
                                       ▲
   ownership / work / contract / canonical / participation / semantic
```

**Actual Relevance를 10종 Signal 안에 억지로 표현하지 않는다.** `GENERIC_SIGNALS === 10`
(OM §10.6)은 그대로 두고, relevance는 별도 판정 결과로 낸다.

### 2.2 현재 Signal 구현현황 (착수 시점 사실)

| Signal | 상태 | 생성 경로 |
|---|---|---|
| `assigned_to_me` | A. 생성됨 | provider reason 매핑 |
| `mentioned_me` | A. 생성됨 | reason 매핑 + 본문 `@id` 문자열 검사(2경로) |
| `review_requested` | A. 생성됨 | provider reason 매핑 |
| `my_pr_reviewed` | A. 생성됨 | provider reason 매핑 |
| `participated_thread_changed` | A. 생성됨 | provider reason 매핑(comment/subscribed/state_change) |
| `priority_labels` | A. 생성됨 | labels 존재 검사 — Core 직접 |
| `direct_reply` | B. 매핑되면 생성 가능 | 대응하는 provider reason이 없어 **현재 생성 0** |
| `project_specific_signal` | B. 매핑되면 생성 가능 | Profile이 임의 reason을 매핑할 때만. **현재 0** |
| `active_canonical_changed` | C. 생성 경로 없음 | reason 매핑으로 만들 수 없다 — Core가 baseline을 비교해야 한다 |
| `open_change_touches_active_canonical` | C. 생성 경로 없음 | 같음 — changed paths × canonical paths 대조가 필요 |

B와 C를 구분하는 이유: B는 Profile 선언 문제이고 C는 **Core가 상태를 보지 않는 구조 문제**다.
고치는 방법이 다르다.

### 2.3 이번에 이행하는 것

```text
direct_reply                           내 코멘트·내 글에 달린 응답 (B → A)
active_canonical_changed               baseline이 실제로 움직였다 — actual drift (C → A)
open_change_touches_active_canonical   열린 변경이 canonical 영역을 건드린다 — potential drift (C → A)
```

`project_specific_signal`은 Profile이 채우는 자리이므로 Core 구현 대상이 아니다.

### 2.4 canonical과 ownership을 섞지 않는다 (Gate Blocker)

```text
changed paths × canonical paths  → open_change_touches_active_canonical   (Signal)
changed paths × ownership.paths  → Actual Relevance Evidence              (Evaluator)
```

`ownership.paths`(C-04 §6.1)는 **누구 영역인가**이고 canonical paths는 **정본이 어디인가**다.
같은 경로 대조라도 답하는 질문이 다르므로 결과를 같은 칸에 넣지 않는다.

또 다음 둘을 계속 분리한다 — 섞으면 "바뀌었다"와 "바뀔 수 있다"를 구분할 수 없게 된다.

```text
active_canonical_changed              actual drift    (baseline이 이미 움직였다)
open_change_touches_active_canonical  potential drift (아직 열린 변경이다)
```

---

## 3. Relevance 판정

### 3.1 두 축과 처분

| Explicit Targeting | Actual Relevance | 처분 |
|---|---|---|
| HIGH | HIGH | Inbox |
| LOW | HIGH | **태깅 누락 — Inbox** |
| HIGH | LOW | 오지정·태깅 난사 — Shadow 후보 |
| LOW | LOW | 일반 Shadow / 관찰 |

> 나를 불렀다는 이유만으로 내 일이 되지 않는다.
> 나를 부르지 않았다는 이유만으로 내 일이 아니게 되지도 않는다.

### 3.2 Evidence 우선순위

구조적 근거를 먼저 보고, 의미 판단은 **보조**로만 쓴다.

```text
1 Ownership      changed path가 내 ownership인가 / decision domain이 내 authority인가 (C-04)
2 Work Relation  active Block·Session / pending Query / Queue / 작업 항목 관계
3 Contract       내 canonical 변경 / 내가 소비하는 계약 변경 / shared schema 영향
4 Participation  이전 참여 / 내가 만든 변경 / 내가 검토 중
5 Semantic       제목·본문이 내 영역과 연관되는가 — 보조 evidence
```

### 3.3 결과는 근거와 함께 낸다

**숫자 하나로 내지 않는다.** `relevance = 0.82` 는 사람이 검증할 수 없고, 틀렸을 때 어디가
틀렸는지도 말해주지 않는다.

```text
Relevance: HIGH
+ frontend owned path 변경
+ 현재 Session과 직접 연관
+ FE가 소비하는 contract 영향
- reviewer 지정 없음
```

Low도 같다 — 왜 낮다고 봤는지 적는다. 그래야 그 판단이 틀렸을 때 사람이 뒤집을 수 있다.

### 3.4 판정에 필요한 것을 Config에 넣지 않는다

`MonitorConfig`는 **선언형 데이터**를 유지한다(함수 금지 — 설정 파일로 표현할 수 없는 물건이
되면 안 된다). 상태(활성 세션·점유 범위·canonical baseline·ownership)는 **별도 판정 입력**으로
전달한다.

---

## 4. Material Change — provider-neutral revision marker

### 4.1 문제

같은 스레드에서 "확인 부탁드립니다"가 반복될 때마다 새 Decision Packet이 생긴다. 지금
notification key에 `updated_at`이 들어 있어 dedupe로는 막히지 않는다.

### 4.2 `lastEventId` 하나를 만능 마커로 쓰지 않는다

material change는 댓글로만 오지 않는다 — new commit / changed paths / label / assignee /
reviewer / status / component / relation / description / discussion 전부 해당한다.

그래서 공통 DTO에 **`revisionMarker`**(provider-neutral 불투명 문자열)를 둔다. **무엇을 넣을지는
adapter가 정한다** — Core는 값을 비교만 하고 해석하지 않는다.

```text
adapter A → updated_at + head revision + discussion marker
adapter B → updated_at + review·comment marker
adapter C → updated / version marker
```

기존 `ThreadSnapshot.lastEventId`는 revisionMarker를 구성하는 재료 중 하나일 수 있다.

### 4.3 억제 기준

```text
same reference + same relevant evidence + same revisionMarker
→ 새 Decision Packet을 만들지 않는다 (log에는 남는다)
```

셋 중 하나라도 달라지면 다시 올린다. **evidence가 달라진 것도 material change다** — 같은
스레드라도 changed paths가 내 영역까지 넓어졌으면 그건 새 사건이다.

---

## 5. Shadow Watch

### 5.1 버리지 않고 낮춘다

Low relevance 판정은 **삭제가 아니다.** 지금 관련 없다는 판정은 지금까지만 유효하다.

```text
Relevant      → Inbox
Low Relevance → Shadow Watch (기본 숨김)
```

### 5.2 Request 상태를 늘리지 않는다 (Gate Blocker)

`SHADOW` 같은 새 request 상태를 만들지 않는다. OM §11.2의 열거를 건드리면 승인 lifecycle 전체가
영향을 받는다.

```text
Shadow Watch = adapter-scope reference 레코드 + log + derived view
```

### 5.3 재평가 트리거

```text
changed paths 확대 / 새 relation / 새 contract·canonical 영향
assignee·component 변경 / authority question / material comment / status 변화
Reconcile·Census에서 관측된 차이
```

승격 예 — 이것이 Shadow를 유지하는 이유다.

```text
어떤 변경  처음엔 다른 파트 경로만 → LOW → Shadow
          이후 내 영역 공유 타입 수정이 추가됨 → HIGH → Inbox 승격
```

### 5.4 Agent가 "볼 필요 없음"을 확정하지 않는다

Shadow는 **숨김이지 폐기가 아니다**(C-01 §5 — Agent read와 Human decision의 분리). 사람이
요청하면 shadow 목록은 그대로 보여야 한다.

---

## 6. Typed Investigation Pipeline

### 6.1 "AI가 알아서 확인"으로 두지 않는다

기본 `inspect`는 단계가 정해져 있다.

```text
1 사건 자체 재확인      요약을 믿지 않고 원본을 다시 읽는다
2 Delta 확인            직전 관측 대비 무엇이 달라졌나
3 Responsibility        owner / decision authority / dependency / pending query (C-04)
4 현재 Work 관계        active Block·Session / Queue / Closure / canonical baseline
5 Thread 조사           최근 material comment · unresolved · 나에게 온 질문
6 Change 조사           changed paths / 변경 요약 / 검토·승인 상태
7 Work Context          작업 항목 상태·연결 (있을 때)
8 Canonical 대조        계약 고정분과 이번 변경 비교
9 Relevance + Impact    §3의 근거와 함께
10 Recommendation       무엇을 하면 되는가
11 Draft                §7 조건을 만족할 때만
```

`trace`는 여기에 경위 복원(전체 chronology·연결·과거 결정·이력)을 더한다.

### 6.2 각 Step은 Port만 요청한다 (Gate Blocker)

```text
Thread 조사   → ResourceContext            (코드 쪽 Binding)
Change 조사   → ChangeContext
Work Context  → ResourceContext + History  (작업 쪽 Binding — 코드 쪽과 다른 adapter일 수 있다)
Canonical     → Canonical
```

`Work Context`가 별도 Port 조합인 이유: 코드가 한 곳, 작업 항목이 다른 곳인 것이 정상이다
(C-09 §3.1). 같은 통로를 쓰라고 강요하면 두 시스템을 동시에 붙일 수 없다. 연결된 작업 항목이
선언되지 않았으면 **해당 없음**이고, 선언됐는데 통로가 없으면 **판정 불성립**이다 — 둘은 다르다.

**provider 이름으로 분기하지 않는다.** 어떤 외부 시스템이 그 Port를 제공하는지는 Binding이
정한다(C-09 §4). Step이 필요한 Port를 못 얻으면 그 단계는 **판정 불성립**으로 남기고, 다른
단계 결과를 그것으로 대신하지 않는다.

### 6.3 부분 결과는 잃지 않는다

Phase B 실패는 지금 전체 롤백이다(PENDING_RETRY). 단계가 생기면 **끝난 단계의 결과는 replay
envelope에 보존**해 재시도가 이어받는다. 재시도로 만들어진 패킷이 조사 내용을 잃고 빈 문구를
갖는 현재 동작도 여기서 해소된다.

### 6.4 relevance evidence는 packet 필드를 늘리지 않는다

OM §11.1 Decision Packet 필드 목록은 동결이다. evidence는 **Decision View의 의미 구조**
(C-01 §3)와 packet 본문(situation/context/impact rationale)으로 표현한다.

---

## 7. Draft Gate

```text
만든다      근거 충분 + authority 명확 + canonical 충돌 없음
안 만든다   결정권 불명 / 근거 부족 / canonical 충돌 / 상대 의도 불분명
            → 추가 조사 · 질문 · ESCALATE · Controller decision
```

단정적인 초안은 그 자체로 판단을 실어 나른다. 근거가 없을 때 초안을 만들면 사람은 초안을
검토하는 대신 승인하게 된다.

**불변**: `Draft ≠ Approval ≠ External Write`. Monitor와 Investigation은 끝까지 read-only이며,
외부 반영 경로는 하나뿐이다.

```text
Decision Packet → AWAITING_APPROVAL → Controller Decision → APPROVED
→ Execution Grant → Drift Guard → Executor → External Write
```

---

## 8. Completeness — 측정 가능한 계약

### 8.1 100% 보장은 선언하지 않는다

provider API 장애 / credential·permission / delivery 실패 / 삭제된 객체 / pagination 결함 /
provider가 이력을 노출하지 않는 경우 — 어느 것도 ASC가 통제하지 못한다.

대신 이렇게 쓴다.

> 정상 credential과 provider API 상태에서, provider가 현재 노출하는 관련 변경을 최대
> Reconciliation Interval 이내에 회수하는 것을 목표로 한다.

### 8.2 Health metadata

```text
lastHotEventAt / lastReconcileAt / lastCensusAt
coverageWatermark / paginationComplete / sourceHealthy
```

adapter-scope에 저장하고 **derived surface로만 보여준다**(`asc monitor status`).
`state.md`에 넣지 않는다 — 갱신자 없는 데이터를 Controller 파일에 두면 그 파일이 거짓말을
시작한다(OM §7.5).

---

## 9. Event Key projection

OM §10.4의 원칙(**log tail 대조가 아니라 exact lookup**)은 그대로다. 다만 key 문법은
**adapter-owned identity의 projection**으로 일반화한다 — 지금 정규식은 provider 4종 kind만
허용해 새 adapter와 census 관측이 통과하지 못한다.

```text
<kind>:<opaque>     kind는 adapter가 정한다. 기존 notification/comment/review/review_comment 하위호환
```

요구는 둘뿐이다 — **같은 외부 변화는 같은 키**, **다른 변화는 다른 키**. 키 안에 provider 의미를
Core가 해석하는 코드는 없다.

---

## 10. Gate

### 10.1 B-30 Relevance · Shadow · Material Change (자동 테스트 필수)

```text
· Signal과 Relevance가 분리된 산출 (relevance가 10종 signal 안에 표현되지 않음)
· GENERIC_SIGNALS === 10 불변
· changed×canonical → signal / changed×ownership → evidence (섞이지 않음)
· active_canonical_changed(actual)와 open_change_touches_active_canonical(potential) 분리
· direct_reply 생성 경로 존재
· Explicit × Actual 4칸 전부 시나리오 (특히 LOW×HIGH → Inbox, HIGH×LOW → Shadow)
· relevance 결과에 evidence 문장 동반 (숫자 단독 0)
· Shadow는 request 상태를 만들지 않음 / 재평가 트리거로 승격
· same reference + same evidence + same revisionMarker → 패킷 억제, evidence 변하면 재표면화
· Core provider 어휘 0
```

### 10.2 B-31 Coverage (자동 테스트 필수)

```text
· closed·merged 포함 회수
· Hot 유실 → Reconcile 회수
· Census reference 상태 비교로 변화분만 승격 (재조회 멱등 — 중복 패킷 0)
· previous-known − current-inventory → RESOURCE_MISSING (DELETED 단정 0)
· pagination completeness 기록
· Discovery Path ≠ Priority (늦게 발견해도 우선순위 하향 0)
· health metadata 표면 정확 · state.md 무접촉
· cursor·overlap·PENDING_RETRY·replay·lease 무약화
```

### 10.3 B-32 Typed Investigation (자동 테스트 필수)

```text
· step별 Port 요청 — provider conditional 0
· Port 부재 시 판정 불성립으로 남김 (다른 단계로 대체 0)
· Responsibility(C-04) 실제 소비
· evidence-backed relevance가 Decision View에 표시 · packet 필드 목록 무변경
· draft gate 4조건 (불명확 시 draft 0)
· 재시도 후 조사 결과 보존
· Monitor external write 경로 0
```

---

## 11. 다음 계약으로 넘긴 것

```text
· 전달·알림 정책 — C-08 (Presentation·Digest)
· Port·Adapter·Binding 구조 — C-09
· webhook 실시간 경로 (B-12 승격선: 수동 → scheduled 까지)
· full historical integrity check 주기·범위
· semantic evidence의 판정 방법 (지금은 보조 evidence 자리만 확보)
· Shadow Watch 이력의 통계·재발 분석
```
