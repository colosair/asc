# ASC 구현 계약 C-12 — Always-On Runtime · Ingress · Front Session Binding

> 작성: 2026-08-26. **지위: 동결된 설계 v5.1(OM)·C-01·C-02·C-03을 수정하지 않는
> 후속 구현 계약이다 — 설계 재개가 아니다.**
> 근거 지시: (비공개 evidence 저장소) (원문 보관, 비규범).
> 대상 로드맵: B-51(Background Orchestrator) · B-52(Webhook Hot Path) · B-54(Coverage Health
> Escalation) · B-55(Front Session Auto-binding).
> **C-07의 Coverage 3경로와 Delta 의미를 재정의하지 않는다** — 실행 계기를 누가 갖는가만 정한다.
> 본문 CLI·필드명은 계약 검증용이며 exact 형식은 구현 중 한 번만 결정한다.

---

## 0. 기준문

> **상시성은 대화를 켜 두는 것으로 얻지 않는다. 상태를 지속시키고 계산을 짧게 돌리는
> 것으로 얻는다.**
>
> ```text
> Persistent Agent Conversation   X
> Persistent ASC State            O
> Ephemeral Compute               O
> Lightweight Runtime             O
> ```
>
> **사람이 `status`를 쳐야만 아는 것은 상시 감시가 아니다.**

구현 중 판단이 갈리면 이 문장으로 정한다.

## 0.1 C-07이 이미 정한 것 — 다시 열지 않는다

```text
Delta (Hot Path)   webhook / incremental polling / provider notification / updated-since
                   → 이미 상위 개념이다. push 전용으로 좁히지 않는다 (C-07 §1.1)
Reconcile          놓친 변화 회수
Census             목록 무결성
complete=false     missing 추론 금지 · baseline 이동 금지 · watermark 이동 금지
```

C-07 §1.8은 **실행 계기를 외부 orchestration에 넘겼다.** C-12는 그 밖을 채우는 계약이며,
Coverage 의미론은 그대로 소비한다.

**불변식 ①** — capability 이름을 편의로 바꾸지 않는다. provider에 push가 없으면 push가
있다고 선언하지 않는다. 다만 `updated-since` 기반 빠른 회수는 C-07 §1.1이 Delta에 포함한
형태이므로, 그 근거를 코드와 계약 포인터로 남긴다.

---

## 1. Runtime의 책임 경계

```text
Background Runtime이 하는 일        실행 계기(trigger)를 갖는다
Background Runtime이 하지 않는 일   판정한다 / 상태를 만든다 / 승인한다
```

```text
delta trigger · reconcile schedule · census schedule · digest schedule
retry · lease 관리 · health 평가
```

**불변식 ②** — Runtime은 Monitor·Investigation·Approval의 판정에 개입하지 않는다.
같은 함수를 사람이 부르든 Runtime이 부르든 결과가 같아야 한다
(C-07 §1.6 "경로마다 다른 판정을 하지 않는다"의 시간축 버전).

**불변식 ③** — 주기·간격 상수를 Core에 두지 않는다. Profile/User runtime policy가 정한다.

**불변식 ④** — Core에 특정 scheduler 제품을 하드코딩하지 않는다. cron·systemd·Task
Scheduler는 Runtime을 부르는 바깥 수단이며, Runtime은 그것 없이도 단독으로 돈다.

### 1.1 Lifecycle

```text
startup    상태를 읽고 시작한다. 만들지 않는다
shutdown   진행 중 회차를 중간에 끊더라도 lease·cursor가 다음 회차를 살린다
restart    cursor · observation · coverage · digest pending 을 저장소에서 복원
recovery   죽은 lease는 stale 판정으로 회수된다 (기존 5분 규칙)
```

**불변식 ⑤** — Runtime은 재기동해도 같은 사건을 다시 패킷으로 만들지 않는다.
멱등의 근거는 새로 만들지 않고 기존 dedupe·revisionMarker·observation ledger를 그대로 쓴다.

**불변식 ⑥** — 이중 기동은 오류가 아니라 lease로 직렬화된다. 늦게 온 쪽은 조용히
다음 회차를 기다린다.

---

## 2. Ingress — Webhook

### 2.1 계약 분리 (배치는 나중 문제)

```text
Webhook Ingress Adapter
→ durable ingress state
→ Background Orchestrator
```

**불변식 ⑦** — Ingress와 Orchestrator의 **계약은 분리한다.** MVP에서 같은 lightweight
process에 배치할 수 있으나 **Core는 둘의 process topology를 모른다.** 나중에 receiver만
떼어낼 수 있어야 한다.

### 2.2 수신은 저장까지, 판정은 기존 경로

```text
webhook 수신 → 서명 검증 → durable buffer 적재 → (여기까지가 Ingress)
EventSource.drain() 이 buffer를 비운다 → 기존 Phase A/B → Packet
```

`ports/event-source.ts`가 이미 예고한 형태다("push형 Adapter는 수신분을 내부 버퍼에 쌓아
두고 drain에서 돌려준다"). **MonitorEngine은 변경되지 않는다.**

**불변식 ⑧** — 서명 검증은 생략 불가다. 신뢰 경계이며, 검증 실패는 조용한 무시가 아니라
거부로 기록한다.

**불변식 ⑨** — raw webhook payload를 Main ASC 세션에 직접 주입하지 않는다. 외부에서 온
문자열은 데이터이지 지시가 아니다.

**불변식 ⑩** — 같은 변경을 Reconcile이 다시 발견해도 **중복 Decision Packet 0**이어야 한다.
빠른 경로가 본 것을 회수 경로가 알아야 한다는 기존 규칙(C-07 §1.7)이 그대로 적용된다.

**불변식 ⑪** — Ingress 적재 실패는 "변경 없음"이 아니다. Coverage Health의 저하로 잡힌다.

---

## 3. Health Escalation

현재 `lastHotEventAt` 등은 존재하지만 사람이 `asc monitor status`를 쳐야만 보인다.

```text
hot path stale                  최근 Delta가 오래 없다
reconcile repeated failure      회수 경로가 반복 실패
census stale                    목록 무결성 확인이 오래됐다
pagination incomplete 지속      끝까지 못 본 상태가 계속된다
credential degraded             자격이 만료·상실됐다
source unavailable              외부 소스가 응답하지 않는다
```

**불변식 ⑫** — **"변경 없음"과 "못 봄"을 합치지 않는다.** 외부 source failure를 조용한
정상으로 읽는 것이 이 계약이 막는 가장 위험한 오류다.

**불변식 ⑬** — Health 저하는 Attention candidate이지 승인 요청이 아니다. 기존 Presentation·
Digest 경로로 나가며(C-08), 새 채널·새 상태를 만들지 않는다.

**불변식 ⑭** — 임계값은 Profile/User policy다. Core 상수 금지(§1 불변식 ③과 같은 이유).

---

## 4. Front Session Binding

```text
사용자가 프로젝트에서 Agent 세션을 연다
→ 그 Physical Front Session이 workspace를 발견 (C-11 Resolver)
→ Controller-facing ASC Front로 bind
→ 현재 상태 복원
```

복원 대상:

```text
active session · pending handoff · pending decisions
monitor digest · recent checkpoint · health
```

**불변식 ⑮** — Front 복원은 **읽기다.** 복원 과정이 상태를 전이시키거나 승인 대기를
소비하지 않는다.

**불변식 ⑯** — Front binding은 기존 RuntimeBinding 소유권 규칙을 우회하지 않는다.
자동으로 집더라도 `setIfAbsent` 충돌 규칙과 owner 검사는 그대로다(C-10 §2.3).

**불변식 ⑰** — 사람이 매번 `asc status`·`asc resume`를 쳐야 하는 상태는 최종형이 아니다.
다만 자동 복원이 실패하면 **조용히 빈 화면을 주지 않고** 왜 못 붙었는지 말한다.

---

## 5. 상시성의 정의 — 둘 다 있어야 한다

```text
Background Runtime만 있음   사용자가 열어도 상태가 복원되지 않는다
Front Binding만 있음        사용자가 닫으면 아무도 보지 않는다
```

**불변식 ⑱** — 둘 중 하나만 구현하고 "ASC 상시화 완료"라고 하지 않는다.

**불변식 ⑲** — Main ASC Front가 닫혀 있어도 P0/P1이 사람에게 도달할 수 있어야 한다
(C-08의 One Request, Many Presentations). 도달 채널이 없으면 없다고 말한다 —
"전달됐다"고 가정하지 않는다.

---

## 6. 이 계약이 하지 않는 것

```text
분산 스케줄러 / 멀티 노드 orchestration
  → 단일 사용자 로컬 프로세스로 충분하다는 것이 현재 근거다.
    두 번째 실행 노드가 실제로 필요해지기 전에 열지 않는다.

Interrupt / 실행 중 세션 강제 중단
  → OM §16 부재 유지 (C-04 §5.2·C-10 §9와 같은 선).

Runtime이 판정·승인·외부 쓰기를 대신하는 것
  → Runtime은 계기만 갖는다. Monitor read-only, Approval ≠ Execution Grant 유지.

Delta 의미의 재정의 / capability 이름 변경
  → C-07 §1.1 그대로 소비한다.

webhook 공개 endpoint 운영 (터널링·인증서·공인 URL)
  → 제품 범위 밖. 수신 계약과 검증까지가 여기다.
```
