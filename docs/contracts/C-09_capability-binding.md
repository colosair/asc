# ASC 구현 계약 C-09 — External-System Independence · Capability / Binding

> 작성: 2026-08-26. **지위: 동결된 설계 v5.1(OM)·C-01·C-02·C-03을 수정하지 않는
> 후속 구현 계약이다 — 설계 재개가 아니다.**
> 근거 지시: (비공개 evidence 저장소) (원문 보관, 비규범).
> 대상 로드맵: B-29(Ports·Adapter Contract·Binding·Composition) · B-34(Swap Pilot).
> C-02의 5 Port를 수정하지 않는다 — 좁은 Port를 **추가**하고 기존 것은 bridge로 잇는다.
> 본문 인터페이스·필드명은 계약 검증용이며 exact 형식은 구현 중 한 번만 결정한다.

---

## 0. 기준문

> **ASC는 특정 SCM·Work Tracker·Messenger·Agent Host·MCP Server를 직접 지원하는 Core가
> 아니다. 외부 기능을 좁은 Port로만 소비하고, 어떤 외부 시스템이 그 기능을 제공하는지는
> 교체 가능한 Adapter와 Runtime Binding이 정한다.**
>
> **Provider 교체는 Core migration이 아니라 Binding replacement여야 한다.**
>
> **외부 시스템이 하나도 없어도 Local Runtime은 동작하고, 일부만 있으면 있는 것만 쓰고
> 나머지는 명시적으로 degrade한다.**
>
> **범용성은 많은 provider 이름을 아는 것으로 얻지 않는다. Core가 provider를 몰라도 동작하는
> 것으로 얻는다.**

구현 중 판단이 갈리면 이 문장으로 정한다.

## 0.1 의존 방향

```text
ASC Core                     → Domain Types / Ports only
Adapters                     → implement Ports, 외부 시스템 사용
Bootstrap / Composition Root → Core + Adapters 조립
```

```text
Stable Core → Narrow Ports ← Replaceable Adapters → External Systems
```

---

## 1. Interface와 Capability는 다른 것이다

```text
Interface(Port)  행동 계약 — 무엇을 어떻게 부르는가
Capability       availability descriptor — 그 행동을 지금 이 Binding에서 쓸 수 있는가
```

**Capability가 Interface를 대체하지 않는다.** capability가 있다고 호출 방법이 정해지는 것도
아니고, 없다고 Port가 사라지는 것도 아니다.

### 1.1 Capability는 provider-neutral semantic operation이다

```text
observe.delta            증분 이벤트를 흘려준다
inventory.enumerate      현재 목록을 상태 무관하게 열거한다
context.resource         리소스 본문·현재 상태를 읽는다
context.thread           대화·논의를 읽는다
context.change           변경 경로·요약을 읽는다
context.history          경위·이력을 읽는다
canonical.read           정본 baseline을 읽는다
action.comment           승인된 코멘트를 게시한다
action.update            승인된 상태 변경을 반영한다
presentation.digest      묶음을 보여준다
presentation.priority    급한 것을 눈에 띄게 전달한다
approval.interactive     그 자리에서 사람의 결정을 받는다
identity.resolve         "나"에 해당하는 계정을 판별한다
```

### 1.2 provider 이름은 capability가 아니라 adapter id다

```text
잘못  capability: scm.gitlab
맞음  adapter.id = gitlab
      adapter.provides = observe.delta, inventory.enumerate, context.resource,
                         context.thread, context.change, canonical.read, action.comment
```

`gitlab / github / 특정 work tracker / 특정 messenger` 는 전부 adapter id다. Core는 그 문자열로
분기하지 않는다.

> 기존 Profile의 `requires.capabilities: [scm.github]` 표기(OM §4.10)는 하위호환으로 남는다.
> 신규 선언은 semantic capability를 쓰고, 둘의 대응은 Composition이 안다.

---

## 2. 좁은 Port 7종

```text
EventSource        증분 이벤트 공급 (기존 — C-02 §1)
Inventory          상태 무관 열거. closed/merged/resolved 포함           [신규]
ResourceContext    리소스 본문·스레드 내용                                [신규]
ChangeContext      changed paths · 변경 요약 · revision marker            [신규]
Canonical          baseline 조회 (기존 ScmPort.getBaselines)
Presentation       전달·표시 (C-08)                                      [신규]
ExternalAction     승인된 단일 행위 실행 (기존 ScmPort.execute)
```

### 2.1 UniversalProvider를 만들지 않는다 (Gate Blocker)

```text
UniversalProvider { getIssues() getPullRequests() getReviews() sendMessage() ... }
```

이런 것을 만들면 provider의 도메인 모델이 Core로 올라온다. Port는 **작고 의미가 안정적인
단위**로 유지한다 — 한 Port가 답하는 질문은 하나다.

**adapter가 모든 Port를 구현할 필요는 없다.** 코드 시스템이 작업 이력을 모를 수 있고, 작업
추적기가 변경 경로를 모를 수 있고, 전달 채널은 그 둘 다 모른다. 그게 정상이다.

### 2.2 기존 ScmPort는 지금 해체하지 않는다

C-02는 동결이고 기존 코드가 `getThread`/`getBaselines`/`execute`를 쓴다.

```text
기존 ScmPort 유지 + 신규 좁은 Port 추가 + Composition에서 bridge
```

반복 사용 증거가 쌓인 뒤에 분해한다. **한 번에 갈아엎는 것이 더 안전하다는 근거가 없다.**

### 2.3 ChangeContext가 별도인 이유

현재 `getThread`는 **변경 마커만** 돌려준다(내용이 아니다). 조사(C-07 §6)는 changed paths와
변경 요약을 실제로 읽어야 하므로 같은 Port에 얹을 수 없다.

```text
reference → changed paths / 변경 요약 / revisionMarker
```

`revisionMarker`는 provider-neutral 불투명 문자열이다 — **adapter가 만들고 Core는 비교만
한다**(C-07 §4.2).

---

## 3. Resource Binding — `project.scm` 단일 dispatch 폐기

### 3.1 프로젝트는 외부 시스템을 하나만 쓰지 않는다

코드는 한 곳, 작업 항목은 다른 곳, 전달은 또 다른 곳일 수 있다. `project.scm = X` 하나로
Runtime을 조립하면 그 구조를 표현할 방법이 없다.

```text
Project → Bindings[]
  ├─ code-primary        adapter + resource + provides[]
  ├─ work                adapter + resource + provides[]
  ├─ presentation        adapter + resource + provides[]
  └─ optional-secondary  …
```

Binding 하나는 `역할 이름 / adapter id / resource 식별자 / 제공 capability` 다.

> `project.scm`은 하위호환으로 남기되 **runtime 조립의 중심에서 제외**한다.

### 3.2 Binding 선언은 Profile에 둔다

C-04 §6.3과 같은 제약을 받는다 — **`.optional()`, default 금지.** 파싱 결과가 바뀌면 profile
digest가 달라져 붙어 있는 프로젝트가 전부 LOCK_DRIFT로 멈춘다.

---

## 4. Binding Resolution

### 4.1 "provider가 무엇인가"를 묻지 않는다

```text
묻는다      이 작업에 어떤 Port가 필요한가
안 묻는다   지금 provider가 무엇인가
```

```text
inspect 목표: "이 변경이 지금 내 작업에 영향을 주는가?"
필요:  ResourceContext · ChangeContext · Canonical
해결:  각 Port를 제공하는 Binding을 찾아 조합한다 — 서로 다른 adapter여도 된다
```

Core에 `if <provider>` / `switch(provider)` 가 없다는 뜻이다.

### 4.2 후보가 여럿이면 고르지 않는다

같은 Port를 두 Binding이 제공하고 어느 쪽인지 정할 수 없으면 **`AMBIGUOUS_BINDING`** 으로
표면화한다. 임의 선택은 그 선택을 사람이 영영 보지 못하게 만든다 — C-04 §1.3(복수 후보 STOP)와
같은 규칙이다.

### 4.3 없으면 명시적으로 degrade한다

Port를 제공하는 Binding이 없으면 그 기능만 꺼진다. **조용히 통과시키지 않는다** — 조사 단계는
"판정 불성립"으로 남고(C-07 §6.2), 전달은 Local로 내려간다(C-08 §1.3).

외부 시스템이 하나도 없어도 로컬 루프는 그대로 돈다.

---

## 5. Adapter Contract — describe / discover / probe

```text
describe()   정적 선언. 호출도, 네트워크도 없다
             adapter id · version · 제공 capability · 실행 전제 · 자격 요구 메타(값 아님)

discover()   이 프로젝트·환경에서 연결 가능한 resource 후보를 찾는다
             git remote · 로컬 설정 · host 설정 · 등록된 도구 · 프로젝트 메타

probe()      찾은 후보가 실제로 쓸 수 있는지 잰다
```

### 5.1 probe 결과는 Boolean이 아니다

```text
AVAILABLE      지금 쓸 수 있다
DEGRADED       일부만 된다 (이유를 함께)
UNCONFIGURED   설정·자격이 없다 — 결함이 아니라 미설정이다
UNAVAILABLE    닿지 않는다
```

`UNCONFIGURED`와 `UNAVAILABLE`을 합치면 사람이 "내가 뭘 안 한 것"과 "저쪽이 안 되는 것"을
구분할 수 없다. B-21이 setup 판정에서 BLOCKED와 DEGRADED를 나눈 것과 같은 이유다.

### 5.2 자격 증명은 adapter가 다룬다

describe는 **자격이 필요하다는 사실과 그 이름**까지만 말한다. 값은 Core에 오지 않고 Profile에도
적히지 않는다(OM §4.2·§4.5).

---

## 6. Composition Root는 Core 밖이다 (Gate Blocker)

실제 adapter 구현체를 import하고 조립하는 곳은 `core/` 안에 두지 않는다.

```text
composition/          adapter 실제 import · 정적 registry · describe→discover→probe 실행
core/                 provider-neutral 타입만
                      AdapterDescriptor · BindingCandidate · CapabilityRequirement
                      · CapabilityResolution · BindingPlan
```

### 6.1 강제 Gate

```text
core/**  → adapters/** import              0
         → provider SDK import              0
         → provider API URL·path            0
         → provider id 조건분기             0
```

adapter id 문자열 자체는 **adapter · fixture · composition · 설정 · 사람이 보는 표시**에서
허용한다. 금지되는 것은 Core가 그 문자열로 **행동을 바꾸는 것**이다.

### 6.2 정적 registry로 충분하다

```text
만든다      정적 Adapter Registry + 좁은 Port + Runtime Resource Binding
안 만든다   plugin marketplace · 동적 패키지 로더 · 서명 · 원격 자동 설치 · 복잡한 버전 협상
```

두세 개의 실제 adapter에서 같은 구조가 반복되는 것을 본 뒤에 동적 plugin을 검토한다. 지금
만들면 쓰이지 않는 확장점의 유지 비용만 남는다.

---

## 7. Bootstrap 합류 — 발견과 결정은 다르다

C-06의 원칙을 그대로 잇는다 — **감지하고 계획하되 대신 고르지 않는다.**

```text
Registry → describe() → discover() → candidate bindings → probe()
→ Binding Plan → Capability Resolution → BootstrapPlan
```

**provider 목록을 순회하는 코드를 만들지 않는다**(`probeA() / probeB() / probeC()` 금지).
등록된 adapter만 참여하고, adapter가 없으면 그 갈래는 애초에 없다.

### 7.1 자동 수집 vs UNRESOLVED

```text
자동 수집(관찰 가능한 사실)
  git remote · 기본 branch · 닿는 프로젝트 · 사용 가능한 전달 대상 · 등록된 도구

UNRESOLVED(추측 금지 — 사람이 정한다)
  어느 branch/ref가 canonical인가
  작업 항목의 정본이 어디인가
  ownership path는 무엇인가
  decision authority는 누구인가
  기본 전달 채널은 무엇인가
```

앞의 것은 **찾아 주는 것**이고 뒤의 것은 **정하는 것**이다. 후자를 대신 정하면 그건 wizard이며
B-21이 제외한 항목이다(C-06 §2).

---

## 8. 외부 의존은 Core로 전파되지 않는다

```text
core/** 에 provider SDK를 추가하지 않는다
```

adapter에서도 Node 내장 fetch·CLI·프로세스/MCP 경계로 충분하면 SDK를 들이지 않는다. 다만
"dependency 0"이 목적은 아니다 — **목적은 외부 의존이 Core 구조로 번지지 않는 것**이다.

### 8.1 외부 도구를 프로세스 경계 뒤에 둔다

특정 작업 추적기·문서 시스템의 세부(REST 계약·문서 포맷·pagination·프로젝트 의미)는 ASC가 알
필요가 없다.

```text
ASC → Port → Adapter → 프로세스 / MCP 경계 → 외부 도구 → 외부 시스템
```

ASC가 소비하는 것은 `context.*` / `inventory.enumerate` 같은 capability뿐이다.

---

## 9. External-System Independence Gate

```text
provider 교체 시 변경 가능
  Adapter module / Adapter registration / Resource Binding / project configuration

provider 교체 시 변경 금지
  Monitor Core / Investigation Core / Relevance Core / Digest Core
  Responsibility / Approval / Session Runtime
```

### 9.1 검증 방식 — Swap Suite

같은 Core contract suite를 서로 다른 adapter에 물려 돌린다. `tests/support/`의 공용 계약 suite
(state-store contract 선례)와 같은 형태다.

```text
Provider swap      최소 3종 (실제 2 + fixture 1)
Presentation swap  최소 2종 (Local + fixture)
Multi-binding      Code Binding + Work Binding 동시 소비
```

허용 변경: adapter 등록 · binding 설정 · fixture 데이터. 그 밖의 Core 파일이 바뀌면 Gate 실패다.

### 9.2 multi-binding 검증을 생략하지 않는다

코드 시스템 A ↔ B 교체만 증명하면 "여러 외부 시스템을 동시에 붙인다"는 것은 증명되지 않는다.
실제 외부 도구 계약을 확인하지 못한 영역은 **추측해서 구현하지 않되**, fixture adapter로
**조합 자체는 검증한다.** 나중에 그 자리에 실제 adapter를 물려 같은 suite를 돌린다.

---

## 10. Gate

### 10.1 B-29 (자동 테스트 필수)

```text
· 좁은 Port 신설 (ChangeContext 포함) · 기존 5 Port 파일 무수정
· Adapter describe/discover/probe · probe 4상태 구분
· Resource Binding 복수 선언·resolve · AMBIGUOUS_BINDING 표면화
· Port 없을 때 명시적 degrade (조용한 통과 0)
· Composition Root가 core/ 밖 · core/** → adapters/** import 0 (grep gate)
· core/** provider id 조건분기 0
· BootstrapPlan에 binding 후보·probe 상태·UNRESOLVED 정책 합류
· Profile binding 선언은 optional·default 없음 (기존 attach LOCK_DRIFT 0)
· 기존 provider 경로 회귀 0
```

### 10.2 B-34 (자동 테스트 필수)

```text
· 동일 Core contract suite를 provider 3종에 적용 — Core 파일 변경 0
· Presentation adapter 교체 (Local ↔ fixture)
· Code + Work multi-binding 동시 소비 시나리오
· 추측 구현 0 (계약을 보지 못한 외부 도구의 adapter를 만들지 않는다)
· Core provider 어휘 0
```

---

## 11. 다음 계약으로 넘긴 것

```text
· 기존 ScmPort 해체 (반복 사용 증거 이후)
· 동적 Plugin / 원격 adapter 배포
· adapter 버전 협상·호환 정책
· 실제 외부 도구 adapter 구현 (계약 확인 후 fixture 자리 교체)
· capability 이름의 정본 등록·확장 절차 (지금은 이 문서가 목록)
```
