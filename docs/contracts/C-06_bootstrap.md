# ASC 구현 계약 C-06 — Zero-base Entry · Bootstrap

> 작성: 2026-08-26. **지위: 동결된 설계 v5.1(OM)·C-01·C-02·C-03을 수정하지 않는
> 후속 구현 계약이다 — 설계 재개가 아니다.**
> 근거 지시: (비공개 evidence 저장소) (원문 보관, 비규범).
> 근거 실측: (비공개 evidence 저장소) 관찰 ①②⑦⑧ (진입점 부재·경로 기억·npm ci·Node 버전).
> 대상 로드맵: B-27(Zero-base Bootstrap).
> OM §3.4 Bootstrap 5책임을 **바꾸지 않는다** — 그 앞에 진입 경로를 하나 더 놓을 뿐이다.

---

## 0. 무엇이 문제인가

P1 파일럿이 fresh 환경에서 확인한 것:

```text
① clone 직후 무엇을 실행할지 알 방법이 파일 목록뿐
② 문서는 `asc init` 이라 적는데 실제 실행은 `node /path/to/asc/cli/asc.ts`
⑦ npm ci를 건너뛰면 431건 전부 실패 — "깨진 저장소"로 보인다
⑧ Node 최소 버전 미선언 — 낮은 버전에서 문법 오류처럼 실패
```

①⑦⑧은 README로 덮었다. **②는 문서로 덮을 수 없다** — 실행 방법 자체가 달라져야 한다.
그리고 그 위에 사용자 요구가 하나 더 있다: 사용자는 ASC 내부 구조를 몰라도 진입할 수 있어야
한다.

---

## 1. 두 진입, 하나의 계획

```text
Human Entry            Agent Entry
  npx asc init         "ASC로 진행해"
       │                     │
       └──────────┬──────────┘
                  ▼
          Bootstrap Resolver
        repo · host · profile detect
                  ▼
            BootstrapPlan
                  ▼
       기존 경로 재사용 (init / host install / setup status)
```

**두 진입은 같은 BootstrapPlan으로 합류한다.** 진입만 다르고 판정은 하나다 — 자연어 경로가
CLI 경로보다 더 할 수 있는 것도, 덜 할 수 있는 것도 없다.

## 1.1 BootstrapPlan은 계획이지 실행이 아니다

Resolver는 **감지하고, 무엇을 할지 적고, 사람에게 보여준다.** 실행은 기존 표면
(`init` / `host claude install` / `profile resolve --write`)이 그대로 한다. 새 orchestration
계층을 만들지 않는다.

```text
detect  →  BootstrapPlan  →  (사람의 선택)  →  기존 명령 실행
```

---

## 2. B-21 제외 항목은 그대로 제외다 (Gate Blocker)

B-21이 명시적으로 제외한 셋은 이번에도 제외다:

```text
· 대화형 wizard
· init이 값을 대신 채우기
· 토큰 저장·발급 대행
```

"Zero-base Entry"는 이것들을 뜻하지 않는다. 뜻하는 것은:

```text
감지한다        git root · 설치된 host · 사용 가능한 profile 후보
계획을 보여준다  무엇을 할 것인지, 무엇이 결정되지 않았는지
사람이 고른다    profile 선택은 사람의 결정이다 — 후보가 하나여도 자동 확정하지 않는다
```

**감지와 결정은 다르다.** ASC가 profile 후보를 찾아 주는 것과, 그중 하나를 대신 고르는 것은
같은 일이 아니다. 전자는 편의이고 후자는 §OM §1의 통제권 이전이다.

---

## 3. `ASC로 진행해`의 의미 계약

단순 Skill 호출 문구가 아니라 다음 의미로 고정한다:

> 현재 프로젝트와 ASC 상태를 확인하고 readiness를 확보한 뒤, 현재 사용자가 소유한 실행
> 가능한 작업을 찾아 책임·권한·경계를 검증하고 가장 안전한 다음 행동을 진행한다.

내부 단계:

```text
1. ASC 설치 여부      없음 → bootstrap
2. 프로젝트 attach     없음 → discover / init
3. setup·lock·canonical readiness   문제 → 자동 해결 가능 여부 판정
4. ACTIVE Session      있음 → continue
5. actionable work     1개 → contract 제안 / 여러 개 → 우선순위 / 없음 → inbox inspect
6. responsibility + boundary preflight        (C-04 §1.3·§2)
7. 필요한 내부 Agent만 발급                    (C-05 §2 배치)
8. progress → review → collect → closure
```

**사용자는 이 절차를 몰라도 된다.** Skill은 이 순서를 프로토콜로 갖되, 각 단계의 판정은
기존 표면(`setup status` / `proceed` / `preflight` / `collect`)을 호출해 얻는다 —
Skill이 판정을 재구현하지 않는다(C-05 §4).

### 3.1 자연어는 Gate 근거가 아니다

C-03 §5.8을 그대로 상속한다:

```text
명시 호출 (`/asc` 또는 이에 준하는)  = deterministic PASS 필수
자연어 ("ASC로 진행해")              = UX 실측 — pilot에서 따로 기록
```

자연어 트리거가 동작하지 않았다는 이유로 Gate가 실패하지 않고, 동작했다는 이유로 통과하지도
않는다.

### 3.2 각 단계는 기존 fail-closed를 지난다

`bootstrapGuard`(모든 Run의 필수 통과점), profile·lock drift, canonical unavailable —
전부 그대로다. "진행해"가 **막힌 것을 자동으로 여는 문구가 아니다.** 열 수 없는 것은
`setup status`가 이유와 해법을 말하고 멈춘다(B-21이 이미 하는 일).

---

## 4. 배포 — `npx asc`

### 4.1 지금 막는 것은 설계가 아니라 패키징

> **2026-08-26 갱신 — 이 절의 현재형 서술은 지났다.** 아래 상태는 C-06 작성 시점의
> 것이고, `bin`·`files`·`engines`는 B-27에서 실제로 추가됐다. 남은 것은 배포·설치
> 표면(레지스트리 게시·설치 명령·업그레이드 경로)이며 그것은 아직 확정되지 않았다.
> 이 절은 그때의 판단 기록으로 남긴다 — 아래 두 항목(`installRoot` 의존, `engines`
> 선언 이유)은 지금도 유효하다.

```text
package.json (C-06 작성 시점):  "private": true · bin 없음 · files 없음 · engines 없음
실행 경로:                        node <clone 경로>/cli/asc.ts
```

설계 충돌은 0이다. `bin` 항목과 패키징 메타를 더하면 열린다. 다만:

- `installRoot`는 `cli/asc.ts` 기준 상위 디렉터리로 계산된다 → **`profiles/`·`presets/`가
  패키지에 포함돼야 한다.** 빠지면 attach가 profile을 못 찾는다.
- `.ts` 직접 실행(Node type stripping)에 의존하므로 **`engines`로 Node 하한을 선언한다**
  (P1 관찰 ⑧). 선언은 진단을 위한 것이지 우회 수단이 아니다.

### 4.2 이번 범위에서 npm publish는 하지 않는다

검증은 `npm pack` 산출물을 새 디렉터리에서 실행하는 것까지다. 레지스트리 게시는 이름·소유권·
버전 정책이 걸린 별개 결정이며, 그것이 없어도 이 계약의 Gate는 전부 검증된다.

> **2026-08-27 — 이 절은 역사다.** v0.1.0은 npm에 게시됐고, registry에서 설치하는 경로가
> 실기계에서 관측됐다. 위 문장은 그 회차의 범위 판단이며, "게시하지 않는다"가 지금의 상태를
> 말하는 것으로 읽으면 안 된다. 게시 여부의 정본은 [docs/status.md](../status.md)다.

### 4.3 `--profile`은 더 이상 필수 인자가 아니다

미지정 시 실패하는 대신 detect 결과를 보여준다. **후보 제시이지 자동 선택이 아니다**(§2).

---

## 5. Gate — B-27 (자동 테스트 + 실 pilot 둘 다)

자동 테스트:

```text
· detect: git root 발견 / 미발견(비-git 디렉터리)에서 각각 정상 응답
· detect: profile 후보 0 / 1 / 다수 — 어느 경우도 자동 확정하지 않음
· BootstrapPlan이 실행을 수행하지 않음 (계획 조립만 — 파일 쓰기 0)
· --profile 미지정 init이 죽지 않고 계획을 반환
· --profile 지정 init은 기존과 동일 동작 (init 의미 무변경)
· bootstrapGuard 통과 지점 무변경
· B-21 제외 항목 침범 0 — wizard 프롬프트 0, 값 대신 채우기 0, 토큰 취급 0
· Core provider 어휘 0
```

실 pilot (P1 시나리오 확장):

```text
· npm pack → 새 디렉터리에서 npx <tarball> 실행 → CLI 진입
· 빈 fixture 프로젝트에서 단일 진입 → 감지 → attach → skill bundle 설치
  → setup status ready → actionable work 안내까지 연결
· profiles/·presets/ 가 패키지에 포함돼 attach가 성공
· 사용자가 내부 구조를 모르는 상태를 가정한 기록 (어디서 멈췄는지 그대로 남긴다)
```

---

## 6. 다음 계약으로 넘긴 것

```text
· npm registry publish · 패키지 이름·소유권·버전 정책
· 자동 업데이트 / 버전 호환 검사 (ascCompatibility)
· .asc runtime의 머신 간 이동 (P1 관찰 ⑪ — local state 계약 유지 중)
· host 자동 설치 (지금은 감지·안내까지. `host claude install`은 사용자가 부른다)
· probe의 guardInstalled 해석 (P1 관찰 ⑤ — 계약 해석 결정 선행)
```
