# ASC 구현 계약 C-05 — Skill Bundle · Inbox Depth

> 작성: 2026-08-26. **지위: 동결된 설계 v5.1(OM)·C-01·C-02·C-03을 수정하지 않는
> 후속 구현 계약이다 — 설계 재개가 아니다.**
> 근거 지시: (비공개 evidence 저장소) (원문 보관, 비규범).
> 대상 로드맵: B-26(3-Skill Bundle + Inbox Depth).
> Skill·hook 어휘는 OM에 등장하지 않는다 — C-03 §5(Host Adapter) 관할의 연장이다.
> 본문 파일명·필드명은 계약 검증용이며 exact 형식은 구현 중 한 번만 결정한다.

---

## 0. 왜 하나의 Skill로는 부족한가

현재 `asc` Skill 하나가 세션 운영·외부 조사·검증을 전부 설명한다. 그 결과:

```text
Main ASC가 GitHub thread 전체를 직접 읽는다   → context 오염
Implementer가 inbox를 뒤지다 다른 일을 시작한다 → 범위 확장
Verifier가 implementer 자기 보고를 그대로 믿는다 → 독립 검증 소실
```

세 가지는 **읽는 양·읽는 대상·판단 권한이 서로 다른 일**이다. 그래서 Skill을 셋으로 나눈다.
나누는 목적은 기능 추가가 아니라 **각 Agent가 볼 수 있는 것을 좁히는 것**이다.

---

## 1. 3-Skill 책임 경계

### 1.1 `asc` — 대표 표면

```text
Session lifecycle (issue/proceed/pause/resume/done)
progress 기록·조회
responsibility·boundary preflight
worker 위임
결과 회수 (collect)
user decision escalation
handoff / closure 연결
```

사용자와 직접 접하는 유일한 Skill이다. **사용자는 원칙적으로 이것만 알면 된다**
(Progressive Disclosure). 나머지 둘은 Main ASC가 필요할 때만 부른다.

Main ASC는 만능 Agent가 아니다:

```text
상태 확인 → 작업 선택 → 책임·경계 확인 → 필요한 Agent만 발급
→ 결과 회수 → 사용자 판단 필요 시 escalation
```

### 1.2 `asc-inbox` — 조사와 Decision Packet

```text
외부 이벤트 발견
상황 조사 · 관련 맥락 수집
행동 필요성 판단에 필요한 evidence 구성
Decision Packet 작성
Main ASC로 반환
```

주 사용자는 Monitor / Scout Agent다. 존재 이유는 **Main ASC의 context를 지키는 것** —
thread 원문은 여기서 소비되고, 돌아가는 것은 정리된 Packet이다.

**Monitor에게 외부 write 권한을 주지 않는다**(OM §10 Monitor 책임 그대로).

### 1.3 `asc-review` — 독립 검증

```text
변경 결과 독립 검증
contract / spec / doneCriteria 대조
diff 확인
테스트·evidence 직접 재확인
runtime 검증
PASS / FAIL / unresolved 반환
```

주 사용자는 Verifier / Reviewer Agent다. **Implementer의 자기 보고를 그대로 verification
evidence로 사용하지 않는다** — 이것이 이 Skill이 따로 존재하는 유일한 이유다.

Verifier에게 구현 판단 책임을 주지 않는다. 반환은 판정이지 수정이 아니다.

---

## 2. 역할별 배치

| 역할 | asc | asc-inbox | asc-review |
|---|---|---|---|
| Main ASC Session | 주 사용 | 필요 시 위임 | 필요 시 위임 |
| Controller | 주 사용 | 결과 소비 | 결과 소비 |
| Planner | 사용 | 필요 시 제한 사용 | 사용 안 함 |
| Implementer | lifecycle용 최소 사용 | **사용 안 함** | **사용 안 함** |
| Monitor / Scout | session 계약용 최소 사용 | 주 사용 | 사용 안 함 |
| Verifier | lifecycle용 사용 | 원칙적으로 사용 안 함 | 주 사용 |

배치는 **worker 계약이 노출하는 지시**로 표현한다 — Implementer 계약문에 asc-inbox 호출
지시를 넣지 않는다. Skill 파일 자체는 host 전역에 설치되므로 물리적 접근 차단은 아니며,
차단이 필요한 것은 external write이고 그것은 C-03 §5.3 guard가 이미 맡는다.
여기서 다루는 것은 **무엇을 하라고 지시받는가**다.

---

## 3. Inbox Depth — scan / inspect / trace

### 3.1 Mode가 아니라 요청 단위 budget

```text
scan      넓고 얕은 후보 탐색
inspect   행동 결정에 필요한 맥락까지 (기본값)
trace     원인·경위·연결 관계까지
```

**전역 Mode를 만들지 않는다.** `ASC ULTRA MODE` 같은 세션 전역 스위치는 없다. 동일 Run 안에서
항목마다 다를 수 있다:

```text
item A → scan
item B → inspect
item C → trace
```

### 3.2 각 단계가 보는 것

```text
scan     event · title · actor · signal · labels · assignment/review 여부 · 최소 freshness
         목적: 후보 발견 / 우선순위 분류

inspect  relevant thread · recent comments · current Issue/MR state · canonical pointer
         · 관련 작업 상태
         목적: Decision Packet 작성

trace    chronology · 연결 Issue/MR · 과거 결정 · commit/merge 관계 · approval history
         · canonical 변화 · 현재 상태가 된 원인
         목적: 경위 설명
```

### 3.3 기존 계약과의 명칭 정렬 (중복 신설 금지)

`inspect`는 새 개념이 아니다. **C-01 §4 `getRequest` + §6 Current Context Overlay**가 이미
"저장된 Packet에 현재 상태를 덧씌워 보여준다"를 계약하고 있고, inspect는 그 depth 이름이다.
`scan`은 C-01 §4 `listRequests` + §7 freshness의 최소 조합이다.
`trace`만 신규이며, 데이터 원천은 OM §11.2 History Log(감지 + 최종 처분 이력)다.

새 저장 구조를 만들지 않는다 — depth는 **얼마나 읽을 것인가의 계약**이지 새 데이터가 아니다.

### 3.4 자동 승격

```text
scan → (중요하지만 불명확) → inspect → (판단 근거 여전히 부족) → trace
```

승격은 허용한다. **처음부터 전 항목 trace는 기본으로 쓰지 않는다** — 자원 모델(OM §14)의
`investigation depth`를 항목별로 쓰겠다는 것이 depth 도입의 목적이다.

### 3.5 Agent read ↔ Human decision 분리 (Gate Blocker)

depth가 Agent에게 열려도 **C-01 §5는 그대로다.** 조회·분석은 자유, state transition은 사람의
명시적 의사표현에서만 나온다.

```text
asc-inbox가 할 수 있는 것    조회 · 정리 · Decision Packet 작성 · 반환
asc-inbox가 못 하는 것       approve / dismiss / queue 등 어떤 transition도 제출 불가
```

depth를 아무리 올려도 결정 제출 경로는 0이다.

---

## 4. Skill과 Core의 책임 분리 (Gate Blocker)

SKILL.md에 ASC 정책을 **중복 구현하지 않는다.** 다음 같은 것을 Skill 본문에 하드코딩하지
않는다:

```text
review_requested = P0
mention = P1
```

이런 것은 Profile/Core 책임이며, Skill에 복제되는 순간 두 곳이 서로 다른 정책을 말하기 시작한다.

Skill이 정의하는 것은 다섯 가지뿐이다:

```text
언제 어떤 ASC surface를 호출하는가
어떤 evidence를 모으는가
무엇을 직접 판단하면 안 되는가
depth를 언제 승격하는가
언제 Main ASC / Controller로 반환하는가
```

책임 경계:

```text
Skill   = 행동 프로토콜
Core    = 판단 / 상태 / invariant
Profile = 프로젝트별 정책 / ownership
Adapter = 외부 시스템 연결
```

Responsibility 판정과 Circular Delegation 탐지도 Skill prompt가 아니라 Core에 둔다(C-04 §0.1).
**Skill 본문에 정책 문자열이 있는지는 Gate에서 grep으로 확인한다.**

---

## 5. 설치 — Bundle 단위

C-03 §5.1 install/uninstall 계약이 **skill 개수와 무관하게 그대로 적용된다**:

```text
user-scope (~/.claude) 고정 · 경로 옵션 없음
idempotent — 재실행은 "변경 없음"
무단 overwrite 금지 — ASC 설치물이 아닌 파일은 건드리지 않는다
manifest + digest 기반 제거 — 설치 당시 digest와 다르면 남긴다
uninstall은 ASC 설치물만 제거 (settings.json 바이트 복원)
```

3개로 늘어나도 계약 변경이 아니다 — manifest가 파일 딕셔너리이므로 항목이 늘 뿐이다.
**hook은 하나로 유지한다.** guard는 안전 층이고 중복 등록은 그 자체가 위험이다.

Bundle 메타(`bundleVersion` / `ascCompatibility` / `defaultDepth` 등)의 구체 포맷은
**필요가 증명되기 전에 만들지 않는다** — 지금 3개 파일을 설치하는 데 매니페스트 위의 또 다른
매니페스트가 필요하지 않다.

---

## 6. Gate — B-26 (자동 테스트 필수)

```text
· install → skill 3종 배치 → uninstall → settings.json sha256 원상 (C-03 §5.1 재현)
· 재설치 idempotent ("변경 없음")
· uninstall이 빈 skill 디렉터리를 남기지 않음 (P1 관찰 ⑥)
· hook은 단일 등록 유지 (skill 증가가 hook 중복을 만들지 않음)
· Skill 본문에 정책값 하드코딩 0 (grep gate — 우선순위·라벨 매핑 문자열)
· Implementer worker 계약에 asc-inbox/asc-review 호출 지시 0
· Verifier 계약에 구현 수정 지시 0
· asc-inbox 경로에 transition 제출 표면 0 (C-01 §5)
· depth 기본값 inspect · 전역 mode 스위치 부재
· depth가 요청 단위로 적용됨 (동일 Run에서 항목별 상이)
· Core provider 어휘 0
```

---

## 7. 다음 계약으로 넘긴 것

```text
· bundle.json 메타 포맷 (필요 증명 전 미도입)
· JAM(Jira) capability 연결 — asc-inbox의 외부 context source. JAM 안정화 이후
· trace의 Jira ↔ Git 상관 추적
· Skill별 독립 버전·부분 설치 (지금은 전부 아니면 전무)
· 진입·배포 — C-06
```
