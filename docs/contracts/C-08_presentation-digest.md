# ASC 구현 계약 C-08 — Presentation · Digest

> 작성: 2026-08-26. **지위: 동결된 설계 v5.1(OM)·C-01·C-02·C-03을 수정하지 않는
> 후속 구현 계약이다 — 설계 재개가 아니다.**
> 근거 지시: (비공개 evidence 저장소) (원문 보관, 비규범).
> 대상 로드맵: B-33(Presentation Port + Digest Coordinator).
> 본문 형식·필드명은 계약 검증용이며 exact 형식은 구현 중 한 번만 결정한다.

---

## 0. 원칙

```text
Real-time Detection ≠ Real-time Notification
```

빨리 감지하는 것과 사람을 지금 끊는 것은 다른 결정이다. 지금까지는 그 둘이 붙어 있었고,
그래서 실시간 감지를 켜면 새 사건마다 작업 흐름이 끊겼다(전달사항 §1.1).

문제는 감지 속도가 아니라 **전달 topology**다.

```text
Event → Main Session → Event → Main Session → ...
```

이 계약은 그 사이에 층을 하나 넣는다.

```text
Decision Packets → Digest Coordinator → PresentationPort → 사람
```

## 0.1 어휘 — "Digest"의 두 뜻을 구분한다

OM에서 `digest`는 configuration digest(해시, §4.9)를 뜻한다. 이 계약에서 쓰는 것은
**Presentation Digest** — 판단 요청을 묶어 한 번에 건네는 것이다. 코드·문서에서 혼동될
자리에서는 항상 `presentation digest` / `configuration digest` 로 적는다.

---

## 1. PresentationPort — 채널이 아니라 능력

### 1.1 MessengerPort로 좁히지 않는다

`MessengerPort`라고 이름 붙이는 순간 messenger가 아닌 전달 수단(로컬 터미널·파일·메일)이
2급이 된다. Port는 **무엇을 할 수 있는가**로 정의한다.

```text
presentation.digest      묶음을 보여줄 수 있다
presentation.priority    급한 것을 눈에 띄게 전달할 수 있다
approval.interactive     그 자리에서 결정을 받을 수 있다
```

### 1.2 Adapter는 일부만 제공해도 된다

```text
Local        presentation.digest O   presentation.priority O   approval.interactive O
메일류        presentation.digest O   presentation.priority △   approval.interactive X
메신저류      presentation.digest O   presentation.priority O   approval.interactive O
```

`approval.interactive` 가 없는 채널로 digest를 보내는 것은 정상이다 — **보는 곳과 정하는 곳이
달라도 된다.** 결정은 Local Inbox에서 받으면 된다.

### 1.3 Fallback은 capability로 구성한다

```text
필요한 capability를 제공하는 binding이 없다 → 그 기능만 degrade
Local Inbox는 언제나 마지막 안전망이다 — 채널이 전부 없어도 판단 요청은 사라지지 않는다
```

외부 채널 전송 실패가 **canonical state에 영향을 주지 않는다**. request는 이미 만들어져 있고,
전달은 best-effort다(C-01 §9와 같은 성질).

### 1.4 Core는 채널 제품을 모른다

`local / mattermost / slack / …` 은 adapter id다. Core에는 채널 이름으로 분기하는 코드가 없다
(C-09 §Gate).

---

## 2. Digest Coordinator

### 2.1 소속은 Presentation 층이다 (Gate Blocker)

Monitor의 write 경계는 **자기 계약 파일 + inbox entity + log** 뿐이다(OM §10.7). 전달은 그
경계 밖이므로 **Coordinator를 Monitor에 두지 않는다.**

```text
Monitor      감지 · 분류 · 조사 · packet 생성까지
Coordinator  이미 만들어진 packet을 언제·어디로 건넬지
```

### 2.2 패킷은 즉시 만들고 전달만 배치한다

미루는 것은 **전달**이지 생성이 아니다. 패킷 생성을 미루면 그 이벤트는 재시도 대기 상태로 남아
다음 scan이 같은 조사를 다시 하게 되고, 미완료와 보류가 구분되지 않는다.

```text
packet 생성  즉시 (기존 Phase B 그대로)
전달         P0 즉시 / P1·P2 배치 / Shadow 숨김
```

### 2.3 정책 값은 설정이다

```text
P0      즉시
P1      묶음 (예: 30~60분)
P2      묶음 (예: 일 1회) 또는 조용히
Shadow  기본 숨김
```

**간격을 Core 상수로 박지 않는다.** 프로젝트마다 다르고, 같은 프로젝트에서도 시기마다 다르다.
값은 Profile/Override가 준다.

### 2.4 attention-oriented projection

Main ASC에 raw event를 하나씩 보내지 않는다. 사람이 먼저 봐야 할 것은 **몇 건이 있고 그중
지금 정해야 할 것이 무엇인가**다.

```text
🔴 지금 확인 필요   n
🟡 판단 필요        n
🔵 참고             n
⚪ 자동 제외         n
↺  회수 경로에서 발견 n
```

항목 하나는 **왜 잡혔는지(evidence) → 무엇이 걸리는지(impact) → 무엇을 하면 되는지
(recommendation) → 초안(있으면)** 순으로 편다. 근거 없이 결론만 보여주지 않는다(C-07 §3.3).

`↺` 를 따로 표시하는 이유: Hot Path가 놓쳐서 Reconcile·Census가 주웠다는 사실은 **coverage에
대한 정보**다. 우선순위와는 무관하다(C-07 §1.6).

---

## 3. One Request, Many Presentations

### 3.1 Digest는 새 request를 만들지 않는다 (Gate Blocker)

```text
REQ-0214
├─ Local Presentation
├─ (다른 채널) Presentation
└─ Digest 안의 항목
```

전부 **같은 request**다. 한 곳에서 결정되면 나머지는 즉시 그 상태를 본다(OM §11.7, C-01 §8).
채널마다 request를 만들면 같은 사안이 두 번 승인될 수 있다.

### 3.2 발송 기록은 PresentationRecord

"이 request를 어느 채널에 언제 보냈는가"는 **Adapter-owned metadata**다(C-01 §9, C-02 §3) —
Core entity가 아니고, 정본도 아니다. 같은 packet을 두 번 묶어 보내지 않기 위한 best-effort
기록이다.

### 3.3 묶은 뒤 변한 것은 freshness로 말한다

```text
CURRENT / STALE_CONTEXT / SOURCE_CHANGED / ALREADY_DECIDED
```

**새 값을 만들지 않는다** — 4종은 C-02 §2에서 확정됐고 테스트가 잠근다. digest를 만든 뒤
원본이 바뀌었으면 `SOURCE_CHANGED`, 이미 결정됐으면 `ALREADY_DECIDED`로 보인다.

freshness는 사전 경고이고 최종 안전장치는 Drift Guard다(C-01 §7) — digest가 그 역할을
대신하지 않는다.

### 3.4 Digest는 log를 대체하지 않는다

History Log는 append·immutable이고 AI 요약으로 압축하지 않는다(OM §7.3~7.4). Digest는
**버려도 되는 projection**이다 — 다시 만들 수 있고, 없어도 사실은 log와 inbox에 남는다.

---

## 4. Agent read ↔ Human decision (Gate Blocker)

Digest를 만드는 경로에 **결정 제출 표면이 없다**(C-01 §5). 묶고 보여주는 것까지이며,
approve/dismiss/queue는 사람의 명시적 의사표현을 받은 뒤 기존 결정 경로로만 간다.

`approval.interactive` 를 제공하는 채널에서도 마찬가지다 — 버튼은 **사람의 입력을 받는 수단**
이지 Agent가 대신 누르는 수단이 아니다. Controller Identity Binding(OM §11.6)도 그대로 지난다.

---

## 5. B-13 (Messenger Adapter) 처리

### 5.1 우선순위 갱신은 Controller 결정이다

앞선 지시는 "Mattermost는 실측 근거 전 우선순위 상승 금지"를 불변식으로 두었고, 근거 조건은
`Local Approval 불편 / P0 놓침 / 메신저 승인 필요` 3종이었다. 2026-08-26 Controller가 그
우선순위를 **명시적으로 상향**했다(전달사항 §36, 범위 답변 2). 불변식을 우회한 것이 아니라
우선순위를 정하는 주체가 정했다 — 다만 근거 조건이 실측으로 충족된 것은 아니며, 그 사실을
여기 남긴다.

### 5.2 이번 라운드에서 하는 것과 하지 않는 것

```text
한다        PresentationPort · Digest Coordinator · Local Presentation Adapter
           · capability 기반 fallback · 교체 검증용 fixture Presentation Adapter
안 한다     특정 메신저 서버·토큰·interactive action의 실 E2E — 별도 Block
절대 안 한다 채널 제품을 Core가 아는 것
```

---

## 6. Gate — B-33 (자동 테스트 필수)

```text
· PresentationPort가 capability 단위로 정의됨 (채널 제품명 0)
· adapter가 일부 capability만 제공해도 동작 (digest 채널 ≠ 결정 채널 허용)
· 채널 부재·전송 실패 → Local Inbox로 degrade, canonical state 무영향
· Digest Coordinator가 Monitor 밖에 있다 (Monitor에 전달 코드 경로 0)
· 패킷은 즉시 생성되고 전달만 배치된다
· P0 즉시 / P1·P2 배치 / Shadow 숨김
· Digest가 새 Request를 만들지 않는다 (같은 request의 또 하나의 Presentation)
· 같은 packet 중복 발송 억제 (PresentationRecord)
· 묶은 뒤 변한 것은 freshness 4종으로 표현 (신규 값 0)
· digest 경로에 결정 제출 표면 0
· 간격·정책 상수가 Core에 없다 (설정에서 온다)
· Core provider·채널 어휘 0
```

---

## 7. 다음 계약으로 넘긴 것

```text
· 특정 메신저 Adapter 구현과 실 E2E (B-13 본체)
· interactive action의 채널별 표현 규약
· 사용자별 전달 선호(방해 금지 시간대 등)
· digest 이력의 통계·전달 성공률 분석
· 스케줄러 자체 (실행 계기는 외부 orchestration — C-07 §1.8)
```
