# ASC 구현 계약 C-04 — Responsibility · Bounded Query

> 작성: 2026-08-26. **지위: 동결된 설계 v5.1(OM)·C-01·C-02·C-03을 수정하지 않는
> 후속 구현 계약이다 — 설계 재개가 아니다.**
> 근거 지시: (비공개 evidence 저장소) (원문 보관, 비규범).
> 대상 로드맵: B-23(Ownership Map) · B-24(Session Responsibility + Preflight) ·
> B-25(Bounded Query · One-hop · Circular Detection).
> 본문 API·CLI·필드명은 계약 검증용이며 exact 형식은 구현 중 한 번만 결정한다.

---

## 0. 목적 — 무엇을 막는가

여러 팀원이 각자 Agent를 돌릴 때 발생하는 **결정 탁구**를 막는다.

```text
FE Agent   "이거 BE가 정해야 하지 않나요?"
BE Agent   "제품 정책이라 Product가 정해야죠"
Product    "구현 제약은 FE가 아는데요"
FE Agent   ...
```

사람은 이 순환을 몇 번 돈 뒤에야 알아채고, 그때는 이미 세 세션의 context가 소모돼 있다.
ASC는 이것을 **발급 전에 탐지하고, 발생하면 구조적 상태로 표면화**한다.

기존 B-19 boundary preflight는 **"어디에 쓸 것인가"**를 대조했다. C-04는 그 옆에
**"누가 끌고 가고, 누가 결정하는가"**를 둔다. 둘은 다른 축이며 합치지 않는다.

## 0.1 새 Core Entity를 만들지 않는다

`owner`/`authority`/`dependency`는 OM §7.0 Logical Entity 목록에 추가되지 않는다.

```text
Profile ownership map   = 선언 (프로젝트 정책)
Session optional 필드   = 계약 (그 세션의 책임)
Responsibility 판정     = 위 둘에서 파생 (저장하지 않는다)
Bounded Query           = ScopedStore 위의 adapter-scope 레코드 (Core Entity 아님)
```

B-20 Closure Ledger가 `ScopedStore` 위에 살면서 Entity를 늘리지 않은 것과 같은 경로다
(C-02 §1 Port 표 무변경).

---

## 1. Responsibility Contract

### 1.1 세 축의 의미

```text
owner        작업을 끝까지 끌고 갈 주체. 종료까지 하나.
authority    특정 decision domain의 최종 결정권자. domain별로 다를 수 있다.
dependency   외부에서 받아야 할 입력. 받는다는 사실이지 권한 이전이 아니다.
```

`authority`는 단일 문자열이 아니라 **decision domain → role 매핑**이다.

```text
authority:
  api-contract: backend
  client-ui:    frontend
  publish-policy: product
```

이는 OM §7.5 세션 파일 양식의 `Authority:` 라인(ALLOW/SOFT DENY/HARD DENY)을
**대체하지 않는다.** 기존 `Authority:`는 *그 세션이 무엇을 자율로 해도 되는가*(실행 자율도)이고,
C-04의 `authority`는 *어떤 결정의 결정권자가 누구인가*(결정 귀속)다. 두 이름이 겹치므로
구현 시 후자는 `decisionAuthority`로 적어 혼동을 없앤다.

### 1.2 세 불변식

**① dependency는 ownership을 옮기지 않는다.**
다른 파트에 질문을 보냈다는 사실만으로 Session owner가 바뀌는 경로는 **존재하지 않는다.**
"owner를 바꾸지 않는다"가 아니라 **바꿀 코드 경로가 없다**로 구현한다(테스트로 고정).

**② authority 없는 주체는 결정하지 않는다.**
가능한 것은 정보 반환(ANSWER) 또는 상신(ESCALATE)뿐이다.

**③ 필요한 결정의 책임자가 불명확하면 실행보다 먼저 막는다.**
Agent가 상대 Agent에게 물어보며 책임자를 탐색하게 두지 않는다. 단 차단 조건은 §1.3으로
엄격히 한정한다.

### 1.3 `RESPONSIBILITY_AMBIGUOUS` — 차단 조건 (한정)

모든 세션이 cross-part 결정을 요구하지는 않는다. **owner가 비었다는 이유만으로 발급을 막지
않는다.** 차단은 다음 두 조건이 **동시에** 성립할 때만이다.

```text
현재 Session 계약상 실제 decision domain이 필요하다
AND
그 domain의 authority를
  · 명시 Session 계약
  · Profile ownership map
어느 쪽에서도 단일하게 resolve할 수 없다
```

"단일하게 resolve할 수 없다"는 두 가지를 포함한다 — **미선언**(후보 0)과
**복수 후보**(후보 2 이상). 둘 다 STOP이며, 복수 후보에서 하나를 고르는 추론은 하지 않는다.

decision domain이 선언되지 않은 일반 구현 세션은 **기존과 완전히 동일하게** 발급된다.
이 계약은 기존 발급 경로에 새 필수 입력을 추가하지 않는다.

### 1.4 Resolver 원칙

```text
명확한 것만 자동 추론한다        — writeBoundary가 ownership map의 한 role paths에만 들면 owner 추론
불명확하면 임의 결정 금지        — undecidable 반환 (B-19의 "판정 불성립 ≠ 통과" 재사용)
map에 없는 domain 임의 매핑 금지 — 이름이 비슷하다는 이유로 가까운 role에 붙이지 않는다
Human 결정이 필요하면 Controller에 escalation
```

---

## 2. Responsibility Preflight

B-19 `preflight`의 **같은 표면에 축을 하나 더** 붙인다. 새 명령을 만들지 않는다.

검사 대상은 **두 축**이고, 섞지 않는다.

```text
경로 축   산출 경로 → write boundary → owner의 ownership paths
결정 축   선언된 decision domain → 각 domain의 authority 단일 resolve 여부
```

경로 축은 기존 `PathVerdict` union 확장으로 표현한다:

```text
OK
INVALID_SCOPE        (기존)
BOUNDARY_MISMATCH    (기존)
OWNERSHIP_MISMATCH   신규 — 쓰기 범위 안이지만 owner의 영역 밖
```

결정 축은 **경로별 판정에 섞지 않는다** — 결정은 파일에 붙지 않기 때문이다. 별도 목록
`authorityGaps: { domain, lookup }[]`으로 든다. 비어 있지 않으면 통과가 아니다.

`dependencies`는 선언이며 검사 대상이 아니다. 자유 문장이라 실재를 확인할 방법이 없고,
확인하는 척하면 없는 보증을 만든다. 여기서 지키는 것은 하나다 — **dependency를 적어도
owner는 그대로다**(§1.2 ①).

ownership map이 Profile에 없는데 책임을 물었으면 **`undecidable`**이지 통과가 아니다.
반대로 책임을 묻지 않은 세션(owner·decision domain 미선언)은 지도가 없어도 판정이 성립한다.

**자동 권한 확대 경로 0** — B-19와 동일. 판정과 제안까지이며 entity를 바꾸지 않는다.

---

## 3. Bounded Query

### 3.1 왜 자유형 질문을 허용하지 않는가

`"이거 어떻게 할까요?"` / `"정해주세요."`는 **결정 책임을 상대에게 통째로 넘기는 문장**이다.
받은 쪽은 무엇에 답해야 하는지, 답이 무엇을 풀어주는지 모르므로 다시 미룬다. 그래서
cross-part 요청은 **답할 수 있는 형태**로만 보낸다.

### 3.2 필드

```text
queryId            상관 식별자 (X-YYYYMMDD-NN)
ownerSessionId     원 owner — 답을 받은 뒤 돌아갈 자리
requestedAuthority 결정을 요청하는 decision domain
question           단일 질문. 선택지가 있으면 선택지까지
context            판단에 필요한 최소 맥락
proposedDefault    답이 없을 때 owner가 취할 기본값 (선택)
blockingScope      이 답이 없으면 막히는 범위. 없으면 "막히지 않는다"는 뜻
expectedResponse   DECIDE | ANSWER
```

`proposedDefault`는 "답이 늦으면 이렇게 간다"는 owner의 선언이다. 이것이 있으면 질문은
**차단이 아니라 확인**이 되고, 이것이 없으면 blockingScope가 실제로 막힌다.

### 3.3 세 가지 응답만 있다

```text
DECIDE    자신의 authority이면 결론을 반환
ANSWER    사실·계약 정보를 반환 (결정 아님)
ESCALATE  자신의 authority가 아니면 명시된 Human/Authority에 올림
```

`DECIDE`는 응답자가 Profile/Session 기준 해당 domain의 authority로 확인될 때만 유효하다.
아닌 주체의 DECIDE는 typed 실패이며 조용히 ANSWER로 강등되지 않는다.

### 3.4 `DECIDE`의 의미 — 강한 제한 (Gate Blocker)

```text
DECIDE
  ≠ Human Approval
  ≠ ApprovalDecision
  ≠ ExecutionGrant
  ≠ Policy Exception
  ≠ scope expansion
  ≠ Session ownership transfer
```

DECIDE의 의미는 오직 다음까지다:

> Profile/Session 기준 해당 decision domain의 authority로 확인된 주체가
> 그 bounded question에 대한 결론을 반환했다.

**이 응답 자체로 어떤 privileged Core transition도 발생하지 않는다.**
C-03 §4를 그대로 상속한다:

```text
Agent-to-Agent information
→ Approval 생성 경로 0
→ Grant 생성 경로 0
→ Exception 부여 경로 0
→ scope 확대 경로 0
```

Human Decision이 필요한 사안이면 DECIDE 결과를 **context/evidence로 포함해 Controller에
표면화할 뿐**, Human 결정을 대체하지 않는다. 권한은 여전히 인증된 Human Decision
(OM §11.6 Identity Binding)에서만 나온다.

### 3.5 흐름은 원 owner로 복귀한다

```text
FE Owner → BE bounded query → ANSWER/DECIDE → FE Owner 계속 진행
```

응답 수신은 owner 세션의 상태를 바꾸지 않는다. owner도, writeBoundary도, doneCriteria도
그대로다. 바뀌는 것은 owner가 가진 **정보**뿐이다.

---

## 4. One-hop Delegation

### 4.1 규칙

결정 요청 전달은 **최대 1 hop**이다. 질문을 받은 주체는 같은 결정을 제3자에게 다시 미루지
않는다 — 종결 수단은 DECIDE / ANSWER / ESCALATE 셋뿐이며, ESCALATE는 **Agent가 아니라
명시된 Human/Authority로** 올라간다.

```text
허용   FE → BE → (DECIDE|ANSWER|ESCALATE)
금지   FE → BE → Product → FE → ...
```

동일 queryId 계열을 owner가 아닌 세션이 제3자에게 재발행하면 `ONE_HOP_VIOLATION`이다.

### 4.2 "Delegation"은 권한 이전이 아니다

OM §1-5는 위임을 **사람 → AI 단방향**으로, 그것도 판단권이 아니라 실행력의 위임으로 정의한다.
C-04의 delegation은 그 정의를 바꾸지 않는다. 여기서 오가는 것은 **정보 요청과 정보 응답**이며,
authority는 이동하지 않는다. 이름이 "delegation"이라는 이유로 권한 이전으로 읽히면 안 된다.

---

## 5. Circular Delegation Detection

### 5.1 판정

동일 queryId 계열이 원 owner에게 **새로운 결정 요청 형태로** 되돌아오면 순환이다.

```text
FE → BE   X-20260826-04
BE → FE   X-20260826-04 (새 결정 요청)
→ CIRCULAR_DELEGATION
```

결과 메시지는 **책임 소재를 다시 말해 준다**: 원 요청의 owner는 FE이고 요청된 authority는
BE이므로, BE가 DECIDE / ANSWER / ESCALATE 중 하나로 종결해야 한다.

### 5.2 탐지는 표면화까지다

**실행 중인 세션을 중단시키지 않는다.** OM §16이 명시한 "Interrupt 부재(수용함)"를 유지한다.
차단이 필요한 시점은 **발급·위임 전**(§1.3, §2)이고, 실행 중에 발견된 순환은
`controller collect`의 "판단이 필요한 것"에 합류해 사람이 본다 — B-20 closure가 미확인 항목을
다루는 방식과 같다.

새 잠금 시스템을 만들지 않는다(OM §9). 원자성이 필요한 자리는 C-03 §3.2가 확립한
`setIfAbsent` claim 패턴을 재사용한다.

---

## 6. Profile Ownership Map

### 6.1 형태

```text
ownership:
  frontend:
    paths:       [ "festa-frontend/**" ]
    authorities: [ "client-ui", "browser-state", "client-routing" ]
  backend:
    paths:       [ "backend/**" ]
    authorities: [ "api-contract", "auth-server-policy", "persistence" ]
  product:
    authorities: [ "product-policy", "unresolved-cross-part" ]
```

`paths`는 선택이다 — 코드를 쓰지 않고 결정만 하는 역할(product)이 있다.

### 6.2 선언 계층은 Project Profile 하나다

Preset·Override에는 두지 않는다. 책임 지도는 **팀의 사실**이라, 개인 설정이 이것을 바꾸면
사람마다 다른 결정권자를 보게 되고 그때부터는 누구 말이 맞는지 정할 방법이 없다.
계층이 하나이므로 병합 규칙도 없다 — 없는 병합이 잘못될 일도 없다.

같은 domain을 두 role이 주장하면 **복수 후보**이며 §1.3에 의해 STOP이다(임의 선택 금지).
이것은 선언 오류가 아니라 **프로젝트가 아직 정하지 않았다는 사실**이므로 파싱은 통과시키고,
그 결정이 실제로 필요한 세션에서만 막는다.

### 6.3 schema default 금지 — 이유가 다른 두 결정

```text
Profile ownership   .optional(), default 금지
Session dependencies  .default([])
```

**같은 zod 파일의 정책이 달라 보이지만 다른 문제를 푼다.**

- **Profile default 금지 = configuration identity 보존 문제.** Profile parse 결과가 바뀌면
  digest가 바뀌고, 기존에 attach된 모든 프로젝트가 일괄 `LOCK_DRIFT`로 멈춘다. 기존 Profile에
  새 기본값을 암묵 삽입하지 않는다.
- **Session default = persisted entity 호환 문제.** 이미 디스크에 있는 Session 파일에 새 필드가
  없어도 읽혀야 한다. `doneCriteria`(`entities.ts`)가 같은 이유로 이미 default를 쓴다.

이 구분은 회귀 테스트 이름에도 드러낸다(구현이 아니라 이유가 기억되게).

---

## 7. Gate

### 7.1 B-23 Ownership Map (자동 테스트 필수)

```text
· 기존 Profile 파싱 결과 무변경 → digest 동일 → 기존 attach LOCK_DRIFT 0
· ownership 미선언 Profile은 기존과 동일하게 동작
· Preset·Override에는 선언 표면이 없다 (팀의 사실이 개인 설정으로 갈라지지 않는다)
· 같은 domain을 두 role이 주장 → 복수 후보로 노출 (임의 선택 0)
· paths·domain 이름 문법을 선언 입구에서 막는다 (잘못된 값이 profile.lock에 고정되지 않는다)
· ASC.md에 ownership 표 렌더
· Core provider 어휘 0
```

### 7.2 B-24 Session Responsibility + Preflight (자동 테스트 필수)

```text
· decision domain 없음 + authority 없음        → 기존 동작 유지 (발급됨)
· decision domain 있음 + 단일 authority resolve → PASS
· decision domain 있음 + authority 미선언       → STOP (RESPONSIBILITY_AMBIGUOUS)
· 복수 후보로 단일 판정 불가                     → STOP
· Profile에 없는 domain을 유사 역할로 임의 매핑하지 않음
· dependency 추가 → Session owner 불변 (변경 경로 부재를 테스트로 고정)
· ownership map 부재 → undecidable (통과 아님)
· 자동 권한 확대 경로 0 (entity 무변경)
· 기존 Session 파일(신규 필드 없음) 그대로 읽힘
```

### 7.3 B-25 Bounded Query · One-hop · Circular (자동 테스트 필수)

```text
· FE→BE(authority 有) → DECIDE → FE owner 유지
· BE authority 無 → ESCALATE, 제3 Agent forwarding 0회
· FE→BE→FE 결정 요청 회귀 → CIRCULAR_DELEGATION 탐지
· owner 아닌 세션의 동일 계열 재발행 → ONE_HOP_VIOLATION
· authority 아닌 주체의 DECIDE → typed 실패 (조용한 ANSWER 강등 0)
· DECIDE 수신 후:
    Session owner 불변 / writeBoundary 불변
    ApprovalRequest·ApprovalDecision 신규 생성 0
    ExecutionGrant 신규 생성 0
    Policy Exception·scope expansion 0
· 순환 탐지가 실행 중 세션을 중단시키지 않음 (collect 표면화만, exit 0)
· 동시 응답이 서로를 덮지 않음 (setIfAbsent 멱등)
· Core provider 어휘 0
```

---

## 8. 다음 계약으로 넘긴 것

```text
· Task 단위 responsibility (지금은 Session 단위만 — Task 파싱은 B-19 제외 항목 그대로)
· Bounded Query의 채널 전달 (지금은 로컬 레코드 + collect 표면화. 원격 전달은 B-13 이후)
· expectedOutputs를 Session 계약 필드로 승격 (지금은 preflight 입력으로만)
· 순환 이력의 통계·재발 분석 (실측 반복 근거 대기)
· depth(scan/inspect/trace)와 Skill 배치 — C-05
· 진입·배포 — C-06
```
