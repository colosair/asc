# ASC 구현 계약 C-13 — Autonomous Decision · Escalation Predicate · Approval Budget

> 작성: 2026-08-26. **지위: 동결된 설계 v5.1(OM)·C-01·C-02·C-03을 수정하지 않는
> 후속 구현 계약이다 — 설계 재개가 아니다.**
> 근거 지시: (비공개 evidence 저장소) (원문 보관, 비규범).
> 대상 로드맵: B-61(Escalation Predicate Gate) · B-62(Ownership-aware Proceed-by-default) ·
> B-63(Approval Budget · Decision Evidence) · B-64(Dependency-local Progress) ·
> B-65(Autonomous Multi-Agent Dogfood).
> 본문 필드명·CLI는 계약 검증용이며 exact 형식은 구현 중 한 번만 결정한다.

---

## 0. 기준문

> **권한 안이면 판단하고 실행한다. 권한 밖일 때만 구조화된 사유로 올린다.**
>
> **Human Approval은 정상 workflow가 아니라 authority boundary exception이다.**
>
> **Checkpoint는 허가 요청이 아니라 증거다.**
>
> **외부 대기는 막힌 node만 멈춘다.**

구현 중 판단이 갈리면 이 문장으로 정한다.

이 계약이 고치는 문제는 승인 통로 부족이 아니다. **무엇을 사람에게 올려도 되는지 제한하는
강제 Gate가 없다는 것**이다. 통로만 있고 자격 조건이 없으면 "확신이 안 서서" 올린 것과
"내 권한 밖이라" 올린 것이 같은 모양으로 도착하고, 그러면 사람은 둘 다 읽어야 한다.

## 0.1 역할 분리 — 무엇을 이 계약이 다루지 않는가

```text
C-01   Approval이 생성된 뒤 어떻게 처리하는가 (채널·결정·CAS·만료)
C-04   누가 끌고 가고 누가 결정하는가 (owner / authority / dependency)
C-10   누가 실제 실행·검증했는가 (delegation · execution · validation evidence)
C-13   어떤 사안이 Human Approval로 올라갈 자격이 있는가   ← 이 문서
```

**C-01의 결정 표면을 복제하지 않는다.** escalation이 통과하면 기존 ApprovalRequest가
만들어지고 사람은 기존 `asc inbox decide`로 결정한다. 두 번째 결정 창구를 만드는 순간
"어디서 승인했더라"가 생긴다.

**Monitor packet 경로는 escalation이 아니다.** 외부에서 사건이 와서 사람 판단이 필요한
것(C-07 Phase B)과, Agent가 자기 결정을 사람에게 올리는 것은 다른 사실이다. 전자는 이
계약의 Gate를 지나지 않는다 — 지나게 하면 "감지된 사건"이 "내 권한 밖"이라는 이상한
주장을 하게 된다.

---

## 1. Escalation Predicate — 올릴 자격

### 1.1 canonical set (7종)

이 목록 밖의 사유로는 Approval을 만들지 않는다.

```text
ownership_boundary
shared_contract_change
acceptance_change
secret_or_permission
irreversible_action
explicit_rule_requires_approval
canonical_conflict
```

**ownership_boundary** — 지금 Actor의 declared authority·owned scope 밖의 결정 또는 변경.
경로만이 아니라 의미도 본다(§3.2).

**shared_contract_change** — 자기 구현 세부가 아니라 **다른 owner·consumer가 의존하는
공유 계약**의 변경. API schema, cross-part interface, 공유 route 계약, 배포·오케스트레이션
계약 등.

**acceptance_change** — 구현 방법이 아니라 **Done Criteria·Acceptance 자체**를 바꿔야 하는
경우. "어떻게 만들까"가 아니라 "무엇이 끝인가"가 달라진다.

**secret_or_permission** — credential·secret·사람만 할 수 있는 인증·외부 권한이 필요하다.

**irreversible_action** — 파괴적이거나 복구가 어려운 외부 동작.

**explicit_rule_requires_approval** — 정본·정책이 명시적으로 human approval을 요구한다.

**canonical_conflict** — 동등하거나 상충하는 authority source가 있어 Agent가 임의로
우선권을 정할 수 없다.

### 1.2 predicate로 인정하지 않는 것

```text
uncertain
multiple_options
reviewer_might_disagree
not_fully_confident
want_confirmation
```

동의어도 같다:

```text
"두 방법 모두 괜찮아서 골라 달라"
"리뷰어 취향이 다를 수 있다"
"이쪽이 좋아 보이지만 확인받고 싶다"
"100% 확신이 없다"
```

**불확실성은 경계가 아니다.** 이것들이 올라오면 사람은 결정할 근거를 Agent보다 적게
가진 채로 결정하게 된다 — Agent는 코드를 봤고 사람은 그 요약만 본다.

기대 경로:

```text
implementation_detail
→ bounded evidence collection
→ option comparison
→ Actor가 하나 선택
→ 구현
→ 검증
→ Decision Evidence (§4)
```

Human approval 0.

**불변식 ①** — predicate가 0개면 ApprovalRequest를 만들지 않는다. 만들려는 시도는
거부하고, **거부한 사실 자체를 기록한다** — 무엇을 올리려 했는지가 사라지면 Gate가 제
일을 하는지 아무도 못 본다.

**불변식 ②** — 자유서술 사유 하나만으로 Approval을 만들지 않는다. §2의 구조가 있어야 한다.

---

## 2. Escalation Record — 올릴 때 필요한 것

```text
escalationId
sessionId
openedBy                        올린 주체 (principal)
predicates[]                    §1.1 중 최소 1개
question                        사람이 답할 한 문장
evidenceRefs[]                  최소 1개 — 근거 없는 상신은 상신이 아니다
affectedNodes[]                 영향받는 작업 노드
blockedNodes[]                  이것 때문에 지금 못 하는 노드
blockedScope[]                  경계의 실체 (경로·영역 범위)
stillRunnableNodes[]            계속 갈 수 있는 노드 — 자동 계산
boundaryFingerprint             §5의 중복 판정 키
previousEscalationId?           재상신일 때
whyPreviousDecisionDoesNotCoverThis?
requestId                       생성된 ApprovalRequest
openedAt
```

### 2.1 blockedNodes ≠ blockedScope

**두 축이며 섞지 않는다.**

```text
blockedNodes    작업 노드다. Done Criteria 항목 단위이고, "무엇을 지금 못 하는가"다
blockedScope    영역이다. 경로·범위 문법이고, "어디가 경계인가"다
```

같은 것으로 쓰면 두 질문이 한 값에 뭉개진다: `stillRunnableNodes` 계산은 node 축에서만
성립하고(§6), 중복 판정(§5)은 경계 축이 있어야 의미가 있다. 하나로 합치면 "경로를 하나
더 적었더니 다른 사안이 됐다"가 벌어진다.

**불변식 ③** — `stillRunnableNodes`는 **자동 계산**이다(`doneCriteria − blockedNodes`).
올리는 쪽이 자유 기입하면 "다 막혔다"고 적어 전체를 세우는 길이 열린다.

---

## 3. Proceed by default

### 3.1 Checkpoint ≠ Approval Request

```text
checkpoint 발행
↓
├─ 유효한 escalation predicate 있음   → 해당 node WAIT
└─ 없음                               → CONTINUE
```

**불변식 ④** — 사람이 checkpoint를 아직 읽지 않았다는 이유로 멈추지 않는다.
checkpoint는 "봐 달라"가 아니라 "이렇게 하고 있다"이다.

**불변식 ⑤ — blocker 서술은 판정 입력이 아니다.** `Checkpoint.blockers`는 사람이 읽는
문장이며, 그 문자열을 policy action key로 해석해 자동 판정에 쓰지 않는다. 서술을 판정에
쓰기 시작하면 문구를 바꾸는 것이 곧 권한 변경이 된다. blocker는 **표면화**되고(사람이
본다), 자동 HOLD/WAIT의 구조화 입력은 §2의 Escalation Record뿐이다.

### 3.2 Ownership은 경로만이 아니다

```text
API consumer          vs  API owner
Infra orchestration   vs  component image
FE routing 통합       vs  타 파트 내부 loader
프로젝트 정본·이력    vs  ASC/JAM 내부 runtime 기록
```

경로가 내 것이어도 의미가 남의 것일 수 있고, 반대도 있다.

### 3.3 기본 ALLOW 조건

다음이 모두 참이면 Agent가 스스로 정하고 진행한다.

```text
변경이 owned scope 안이고
공유 계약이 바뀌지 않고
acceptance가 바뀌지 않고
HARD DENY가 없고
명시적 approval 규칙이 없고
canonical conflict가 없다
```

---

## 4. Decision Evidence — 승인 없이 내린 결정의 기록

승인 없이 갔다는 것은 기록이 없어도 된다는 뜻이 아니다. **부여받은 authority 안에서의
자율 판단임을 감사 가능하게** 남긴다.

```text
decisionId
sessionId
actor
ownership              어느 권한 안에서 내렸는가
class                  §4.1
evidenceRefs[]         최소 1개
selectedOption
alternatives[]         무엇과 견줬는가 — 비교 없이 고른 것과 구분된다
whyNoApproval          왜 경계가 아니었는가
verification           무엇으로 확인했는가
decidedAt
```

### 4.1 Decision class

```text
implementation_detail
owned_contract_consumption
local_test_strategy
local_refactor
external_boundary
shared_contract
acceptance
permission
irreversible
```

앞 넷은 자율 판단의 자리이고, 뒤 다섯은 §1.1 predicate와 짝을 이룬다.

**불변식 ⑥** — Decision Evidence는 새 저장소를 만들지 않는다. C-10의 audit 레코드 계열에
붙고(`audit:dec:…`), 근거는 C-10 §6 Claim Provenance를 그대로 참조한다.

---

## 5. Approval Budget — 같은 경계를 두 번 올리지 않는다

목적은 횟수 제한이 아니다. **같은 경계 조건을 표현만 바꿔 여러 번 사람에게 돌려보내지
않는 것**이다.

```text
boundaryFingerprint = digest(sorted(predicates) + sorted(blockedNodes) + sorted(blockedScope))
```

**불변식 ⑦** — evidence는 fingerprint에 넣지 않는다. 넣으면 근거 한 줄만 더 붙여 같은
질문을 다시 올릴 수 있다.

미해소 상태의 같은 fingerprint가 있으면 새 Approval을 만들지 않는다(`DUPLICATE_EPISODE`).

### 5.1 재상신 조건 — 전부 필요하다

```text
previousEscalationId                       무엇을 잇는가
새 predicate 또는 실제로 다른 boundary     fingerprint가 달라져야 한다
이전에 없던 evidenceRef ≥ 1
whyPreviousDecisionDoesNotCoverThis        왜 앞선 결정이 이걸 못 덮는가
```

**불변식 ⑧** — **evidenceRef를 하나 더 붙이는 것만으로는 재상신할 수 없다.** predicate가
바뀌었거나 경계가 실제로 달라야 한다. 근거 추가는 같은 질문을 더 잘 설명한 것이지 새
질문이 아니다.

예:

```text
1차   secret_or_permission — OAuth credential 필요
같은 credential 문제 재질문                      → 억제
후속  shared_contract_change — Backend API 변경 필요  → 새 경계, 상신 가능
```

---

## 6. External Pending vs Local Progress

```text
node = Done Criteria 항목
```

새 그래프 구조도 새 Session 상태 enum도 만들지 않는다(OM §11.2 동결).

```text
blockedNodes            해당 node만 대기
stillRunnableNodes      계속 간다
```

**불변식 ⑨** — 외부 dependency의 존재가 전체 Session WAIT을 뜻하지 않는다.
실행 가능한 node가 하나도 없을 때만 파생 상태가 Waiting이 된다.

파생은 C-10 §7 Derived Execution State가 그대로 한다 — 일부 대기 + 실행 가능 node 존재는
`Conditional`이다. 저장하지 않는 뷰라는 성질도 그대로다.

---

## 7. Escalation Presentation

사람에게 올릴 때는 **왜 이것이 Human Boundary인지**를 먼저 보인다.

```text
외부 결정 필요
- ownership_boundary:
  root compose 수정은 Infra 소관이다.
- secret_or_permission:
  OAuth credential이 필요하다.
```

**불변식 ⑩** — `어떻게 할까요?` / `A와 B 중 골라주세요` 형태로 묻지 않는다. predicate를
제시하지 못하면 질문 자체가 성립하지 않는다.

정상 진행의 내부 서술(`이제 …를 확인한다` 류)은 사람에게 보고하지 않는다. 상세는
Checkpoint · Handoff · Audit · Decision Evidence · Worklog에 남는다.

자세히 올리는 경우는 이때뿐이다:

```text
유효한 escalation predicate
canonical conflict
validator reject
예상 밖 원격 divergence
새 blocker
scope 확대
파괴적 동작
state migration 위험
외부 권한
```

---

## 8. Gate — 이 계약이 실제로 무엇을 가르는가

계약만 읽고 다음을 판정할 수 있어야 한다.

```text
A  구현 방식 선택 (runtime-config vs index 치환)     → predicate 없음. 자율 결정
B  OAuth secret 필요                                  → secret_or_permission
C  FE Actor가 Infra/root compose 변경                 → ownership_boundary
D  괜찮아 보이는 대안 여럿                            → predicate 없음. 비교 후 선택
```

A·D에서 Approval이 만들어지면 이 계약은 실패한 것이다.

---

## 9. 이 계약이 하지 않는 것

```text
Approval Port·결정 표면 변경
  → C-01 무수정. escalation이 통과하면 기존 request·기존 inbox decide로 간다.

Monitor packet 경로에 predicate gate 삽입
  → 외부 사건 감지는 escalation이 아니다 (§0.1).

Checkpoint blocker 문자열의 자동 해석
  → 불변식 ⑤. 서술은 표면화까지다.

새 Session 상태 enum / 새 dependency 그래프
  → OM §11.2 동결, node는 Done Criteria 항목 (§6).

physical execution의 검증
  → C-10 §3 그대로. principal은 신고 수준까지만 기록한다.

승인 자동화 / Agent의 자기 승인
  → 경계 밖 결정을 Agent가 스스로 승인하는 경로는 만들지 않는다.
```
