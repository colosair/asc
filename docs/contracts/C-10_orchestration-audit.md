# ASC 구현 계약 C-10 — Orchestration Audit · Execution Evidence · Provenance

> 작성: 2026-08-26. **지위: 동결된 설계 v5.1(OM)·C-01·C-02·C-03을 수정하지 않는
> 후속 구현 계약이다 — 설계 재개가 아니다.**
> 근거 지시: (비공개 evidence 저장소) (원문 보관, 비규범).
> 대상 로드맵: B-41(Delegation Evidence · Binding Tombstone) · B-42(Checkpoint·Handoff·Reclaim
> Audit + Writer Symmetry) · B-43(Validator Execution Evidence) · B-56(Claim Provenance) ·
> B-57(Derived Execution State).
> 본문 필드명·CLI는 계약 검증용이며 exact 형식은 구현 중 한 번만 결정한다.

---

## 0. 기준문

> **Logical Session이 발급됐다는 사실은 그 일을 누가 실제로 수행했다는 증거가 아니다.**
>
> **ASC의 audit trail만 보고 다음 셋을 구분할 수 있어야 한다 — Controller가 직접 끝까지
> 한 것 / 실제 Implementer에게 위임한 것 / 독립 Validator가 검증한 것.**
>
> **구분할 수 없으면 구분된 척하지 않는다.** 증거가 약하면 약한 등급으로 기록하고,
> 없으면 없다고 적는다. 조립된 서사가 아니라 남은 증거가 정본이다.

구현 중 판단이 갈리면 이 문장으로 정한다.

## 0.1 새 Core Entity를 만들지 않는다

C-04 §0.1과 같은 경로다. Audit 증거는 `ScopedStore` 위 adapter-scope 레코드다.

```text
OM §7.0 Logical Entity 목록      무변경
Session/Request 상태 enum        무변경 (OM §11.2 동결)
Checkpoint·Handoff               기존 Session 내부 구조 — 필드만 하위호환 확장
Delegation / Execution /
Validation / Reclaim 증거        ScopedStore adapter-scope 레코드 (Core Entity 아님)
```

선례: B-20 Closure Ledger, B-25 Bounded Query, B-30 Observation Ledger.

## 0.2 왜 Progress로 대신할 수 없는가

```text
Semantic Progress (B-17)   지금 어디쯤인가 — 최신 1건, last-write-wins, 회수 시 정리
Audit Evidence   (C-10)    무슨 일이 실제 있었는가 — append-only, 회수 후에도 남는다
```

Progress는 **살아 있는 표시**고 Audit은 **남는 기록**이다. 저장 수명이 다르므로 합치지 않는다.
`heartbeat 있음 ≠ Semantic Progress 있음`과 같은 계열의 구분이다.

---

## 1. Delegation ≠ Execution

### 1.1 두 사실을 따로 적는다

```text
DelegationRecord   누가 누구에게 무엇을 맡겼다고 선언했는가   (의도)
ExecutionEvidence  실제로 어떤 실행 주체가 그것을 집었는가     (사실)
```

Delegation만 있고 Execution이 없으면 **"발급됐으나 아무도 수행하지 않았다"**이며,
이것은 결함이 아니라 정확히 그 상태다. 그렇게 표시한다.

### 1.2 DelegationRecord

```text
delegationId        D-YYYYMMDD-NN
parentSessionId     위임한 세션 (Controller의 Logical Session). 없으면 최상위 발급
childSessionId      위임받은 세션
role                childSession의 역할 (SessionRole)
goal                무엇을
scope               읽기·쓰기 경계 (Session 계약의 사본이 아니라 참조)
doneCriteria        언제 끝인가
issuedBy            발급 주체 principal
issuedAt
expectedReturnTo    결과를 누구에게 돌려야 하는가 (보통 parentSessionId)
```

**불변식 ①** — Delegation은 authority를 옮기지 않는다. C-04 §4.2의 정의를 바꾸지 않는다.
오가는 것은 작업 계약과 결과이며, 결정권은 ownership map이 정한 자리에 남는다.

**불변식 ②** — Delegation 기록은 Session 상태 전이를 일으키지 않는다. 전이는 전이표
(`core/model/transitions.ts`)만 한다.

### 1.3 ExecutionEvidence

```text
executionId         E-YYYYMMDD-NN
logicalSessionId    어떤 Logical Session의 실행인가
hostAdapter         'claude-code' 등 — 어느 Host가 관찰했는가
principal           실행 주체 식별자
principalSource     declared | derived        ← §3에서 다룬다
physicalReference   physicalSessionId 등 Host가 아는 실행 참조
startedAt
finishedAt?         진행 중이면 없다
status              RUNNING | RELEASED | SUPERSEDED
evidenceSource      어디서 온 사실인가 (bind 선언 / host 관찰 / …)
```

**불변식 ③** — `logicalSessionId` 발급만으로 ExecutionEvidence를 만들지 않는다.
실행 주체가 실제로 소유권을 주장(claim)했을 때만 만든다.

**불변식 ④** — ExecutionEvidence는 **지워지지 않는다.** Runtime Binding은 현재 소유권을
가리키는 살아 있는 값이라 release 시 사라져도 되지만, "그때 그 실행이 있었다"는 사실은
남아야 한다. release/rebind는 현재 view를 비우되 증거를 append한다.

---

## 2. 세션이 남기는 네 가지 증거

### 2.1 Checkpoint — 진행 중 의미 있는 전환

기존 필드(`position`·`completedTasks`·`nextAction`·`uncommittedChanges`·`recordedAt`)에 더한다.

```text
currentJudgment     지금 무엇이 사실이라고 보고 있는가
blockers[]          막힌 것
risks[]             막히진 않았으나 위험한 것
evidenceRefs[]      그 판단의 근거 (commit·test·파일·외부 참조)
writtenBy           누가 적었는가 (execution principal)
```

기존 entity 파일을 그대로 읽을 수 있어야 하므로 전부 `.default([])`/`.optional()`이다
(doneCriteria 선례). **퍼센트는 계약에 없다** — projection이 필요하면 렌더가 만든다.

의미 있는 전환의 예: 현실 확인 / 계약 확인 / 구현 진입 / 구현 완료 / 검증 진입 /
새 blocker·risk 발견 / 판단 필요 / handoff 준비. 시간 경과는 전환이 아니다.

### 2.2 Handoff — 종료 시 넘기는 것

기존 구조(`done`·`changed`·`verified`·`unresolved`·`next`·`snapshot`)를 바꾸지 않는다.
**`verified`는 self-check이며 독립 검증이 아니다** — 이 구분은 §4가 강제한다.

### 2.3 Writer Authority — Progress와 대칭

```text
Progress 기록        binding owner만 (B-17, 이미 구현)
Checkpoint 기록      binding owner만 ← 이 계약이 추가
Handoff 기록         binding owner만 ← 이 계약이 추가
```

**불변식 ⑤** — 어떤 Physical Run도 자기가 소유하지 않은 Logical Session의 checkpoint·handoff를
쓰지 않는다. 승계 후 죽지 않은 옛 Host가 계속 쓰면 기록이 오염된다 — Progress가 이미
막던 것을 나머지 둘도 막는다.

**하위호환 단서**: RuntimeBinding 통로가 주입되지 않았거나 해당 세션에 binding이 없으면
현행대로 통과한다. 소유권 개념이 없는 경로(local 단독 사용·기존 스크립트)를 이 계약이
갑자기 잠그지 않는다. **binding이 있는데 owner가 아닌 경우만 거부한다.**

### 2.4 ReclaimEvidence — Controller가 실제로 회수했다

```text
sessionId
reclaimedBy         회수 주체 principal        ← 'controller' 문자열 하드코딩 금지
reclaimedAt
handoffRef          무엇을 받았는가
executionRef?       회수 시점에 살아 있던 실행 참조 (archive 전 마지막 순간)
```

**불변식 ⑥** — 회수 주체를 모르면 회수를 기록하지 않는다. 익명 회수는 감사 대상이 아니라
감사 공백이다.

---

## 3. Principal과 Physical Reference는 다르다

```text
physicalReference   Host가 아는 실행 참조 (세션 id 등). 같은 사람이 여러 개를 가질 수 있다
principal           그 실행을 돌린 주체. 독립성 판정의 기준
```

`--physical` 같은 값은 **자기 신고**다. 이 계약은 그것을 검증할 수단을 만들지 않는다 —
Host attestation이 없는 상태에서 검증했다고 쓰는 것이 더 나쁘다. 대신 **신고 수준을 기록**한다.

```text
principalSource = declared   실행 주체가 명시적으로 선언했다
principalSource = derived    선언이 없어 physicalReference에서 끌어왔다
```

**불변식 ⑦** — `derived` principal 위에서는 어떤 독립성 주장도 `UNVERIFIED`를 넘지 못한다.

---

## 4. Validation — 독립 검증의 조건

### 4.1 ValidationRecord

```text
validationId          V-YYYYMMDD-NN
validatorSessionId    검증한 Logical Session
validatorExecutionId  그 검증을 실제로 수행한 execution
principal             검증 주체
targetSessionId       무엇을 검증했는가
targetHandoffRef      어느 handoff를
targetRevision        어느 상태를 (commit·revision marker 등)
result                PASS | FAIL
findings[]            무엇을 봤는가 — 결과만 남기지 않는다
verifiedAt
independence          INDEPENDENT | SELF_REPORTED | UNVERIFIED
```

### 4.2 independence 판정

```text
INDEPENDENT     validator principal ≠ implementer principal, 양쪽 모두 declared
SELF_REPORTED   validator principal == implementer principal
UNVERIFIED      어느 한쪽이라도 derived — 다르다고 말할 근거가 없다
```

**불변식 ⑧** — `SELF_REPORTED`와 `UNVERIFIED`는 independent verification이 아니다.
Profile의 `independentVerifier` 설정이 켜져 있어도 이 판정을 뒤집지 않는다 —
설정은 요구사항이지 증거가 아니다.

**불변식 ⑨** — 기존 `ProgressReport.verifier`(PASS/FAIL)는 그대로 두되 **self-report로
표시**한다. 검증 대상 세션의 owner가 쓰는 값이므로 독립 검증과 같은 자리에 놓지 않는다.

---

## 5. Audit View — 조립이 아니라 복원

한 화면에서 다음을 복원할 수 있어야 한다.

```text
Controller
  ↓ delegated        DelegationRecord
Implementer
  ↓ checkpoints      CheckpointEvidence (0..n)
  ↓ handoff          Handoff
Validator
  ↓ result+findings  ValidationRecord (independence 등급 포함)
Controller
  ↓ reclaim          ReclaimEvidence
```

**불변식 ⑩** — 없는 단계를 비워 두지 않고 **없다고 적는다.**
`실행 증거 없음` / `검증 없음` / `회수 주체 미상`은 정상 출력이며 감춰야 할 결함이 아니다.

**불변식 ⑪** — View는 저장하지 않는다. 파생이며, 증거 레코드가 정본이다.

### 5.1 Gate — 이 계약이 실제로 무엇을 막는가

```text
같은 사람이 session id 3개를 만들고 각각 --physical 값을 대며
Controller·Implementer·Validator를 연기한 흐름
→ ExecutionEvidence의 principal이 전부 같거나 derived
→ independence = SELF_REPORTED 또는 UNVERIFIED
→ "독립 검증됨"으로 표시되지 않는다

실제로 세 주체가 각각 declared principal로 수행한 흐름
→ independence = INDEPENDENT
```

이 Gate가 잡는 것은 **거짓말**이 아니라 **근거 없는 승격**이다. ASC는 신고를 검증하지
못하지만, 검증하지 못했다는 사실은 정확히 기록한다.

---

## 6. Claim Provenance (B-56) — 사실과 추론

```text
CONFIRMED   실측했다
INFERRED    근거로부터 추론했다
PENDING     확인이 필요하다
STALE       나중 증거가 뒤집었다
```

```text
claimId · statement · status · evidenceRefs[] · observedAt · supersedes? · supersededBy?
```

**불변식 ⑫** — 뒤집힌 claim을 **삭제하지 않는다.** History는 당시 판단을 보존하고,
Current View는 STALE을 제외한 최신 claim의 projection이다. 작업일지를 통째로 다시 쓰는
방식(과거 판단이 사라지는 방식)을 쓰지 않는다.

**불변식 ⑬** — 추론을 정본으로 자동 승격하지 않는다.
`Evidence → Derived Proposal → Human/Owner Approval → Canonical Promotion` (지시 §13).

---

## 7. Derived Execution State (B-57)

```text
Ready         지금 즉시 착수 가능
Conditional   제한된 범위에서는 진행 가능
Waiting       외부 결정·이벤트·자격을 기다림
Blocked       필수 전제 실패
Done          doneCriteria + 요구된 검증 충족
```

**불변식 ⑭** — 외부 work tracker의 상태는 **입력 증거일 뿐 실행 상태의 정본이 아니다.**
Jira `진행 중`을 ASC `Ready`로 읽지 않는다.

**불변식 ⑮** — Session/Request 상태 enum을 확장하지 않는다(OM §11.2 동결). Derived View다.
저장하지 않으며, 같은 증거 집합에서 같은 값이 나와야 한다(결정성).

---

## 8. 저장·권한 요약

```text
저장       ScopedStore adapter-scope. Entity·state.md 무접촉
쓰기       잃으면 안 되는 사실이므로 setIfAbsent — 같은 증거를 두 번 쓰지 않는다
수명       Session archive 이후에도 남는다 (Closure Ledger 선례)
표면화     미확인 항목은 Controller View의 awaiting에 합류
권한       §2.3 writer authority. 기록 자체에 대한 인증 수단은 이 계약이 만들지 않는다
비밀       principal은 식별자이지 자격이 아니다 — 토큰·비밀을 증거에 남기지 않는다
```

---

## 9. 이 계약이 하지 않는 것

```text
physical execution의 암호학적 검증 (Host attestation)
  → 두 번째 Runtime과 실제 attestation 수단이 생기기 전에는 설계하지 않는다.
    지금은 신고 수준(declared/derived)을 기록하는 데까지다.

Generic AgentRuntimePort
  → 두 번째 Runtime 근거 없이 열지 않는다 (기존 보류 유지).

Interrupt / 강제 회수
  → 실행 중 세션을 끊는 수단을 만들지 않는다 (OM §16 부재 유지, C-04 §5.2와 같은 선).

Delegation을 통한 authority 이전
  → C-04 §4.2 무변경.

Progress·Checkpoint의 통합
  → §0.2. 수명이 다르다.
```
