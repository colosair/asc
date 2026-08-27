# ASC 구현 계약 C-14 — Distribution · Runtime Entry

> 작성: 2026-08-26. **지위: 동결된 설계 v5.1(OM)·C-01·C-02·C-03을 수정하지 않는
> 후속 구현 계약이다 — 설계 재개가 아니다.**
> 근거: JAM(`github.com/colosair/jam` @ `6254906`)에서 실전 검증된 distribution 패턴과
> 이 저장소의 실측(§1.1). 원문 지시는 비규범 보관.
> 대상 로드맵: B-66(이 계약) · B-67(Buildable Artifact) · B-68(Package/Bootstrap Topology) ·
> B-69(Human·Agent Setup Convergence) · B-70(Install·Upgrade·Runtime Resolution) ·
> B-71(Pack·Isolated Smoke) · B-72(Public Surface English) · B-73(Distribution Dogfood).
> 본문 경로·CLI·필드명은 계약 검증용이며 exact 형식은 구현 중 한 번만 결정한다.

---

## 0. 기준문

> **ASC SHALL be installable and runnable without a source checkout, and once installed
> its local control-plane commands SHALL NOT depend on network availability.**
>
> **Entry may branch. Runtime resolution may branch. Nothing past that point may.**

배포는 실행물을 machine에 놓는 일이고, 그 뒤의 판단은 하나여야 한다. 진입이 둘이라고
로직이 둘이 되면 그 둘은 반드시 갈라진다.

## 0.1 이 계약이 다루는 것과 다루지 않는 것

```text
C-11    workspace/storage identity — 사용자 상태가 어디 있는가
C-12    always-on runtime semantics — 상태가 어떻게 지속되는가
C-14    ASC 실행물이 machine에 어떻게 존재하고 어느 build를 부르는가
```

**Package runtime과 ASC_HOME workspace는 다른 축이다** (불변식 ⑪). runtime을 올려도
workspace state를 다시 쓸 이유가 없다.

---

## 1. 실측 — 이 계약이 서 있는 사실

### 1.1 구조적 blocker와 그 해소 (2026-08-26 spike, RUNTIME_OBSERVED)

```text
문제   .ts 소스를 그대로 싣는 패키지는 node_modules 아래에서 실행되지 않는다
       ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING (node 22·26 동일)
       → npm i -g / npx 형태가 성립하지 않는다

관측   tsc `rewriteRelativeImportExtensions: true` 로 emit하면
       소스의 `.ts` specifier 543개를 한 줄도 고치지 않고 `.js` 로 나온다
       dist 단독 실행 OK · tarball 설치 후 node_modules/.bin/asc --help OK
```

그래서 이 계약은 **소스 import 형태를 바꾸라고 요구하지 않는다.** 개발 중 `.ts` 직접
실행도 그대로 남는다 — 배포가 개발 방식을 인질로 잡지 않는다.

### 1.2 ASC와 JAM이 다른 지점

```text
JAM      MCP server — editor가 spawn하는 자식. stdout이 프로토콜 채널이다.
         committed `.mcp.json` 이 machine-independent executable을 지목해야 해서
         launcher package가 필요하다. package mode는 매 기동 `npx --yes <server>@<exact>`.

ASC      사람이 터미널에서 치거나 세션이 직접 부르는 local control plane.
         committed 실행물 지목 파일이 없다 — Claude host 통합은 생성된 hook을
         `~/.claude/settings.json` 에 절대경로로 적고, 그 경로는 이미 machine-local이다.
         `asc proceed` 는 하루에 수십 번 불린다.
```

이 차이가 아래 §3·§4의 두 갈림길을 결정한다.

---

## 2. Package topology — 2 package

```text
저장소 뿌리          private workspace root. 배포 대상이 아니다.
                     실수로 publish되지 않는다는 것이 이 private의 목적이다.

packages/runtime     `@asc-agent/runtime` — ASC 본체 — Core · CLI · adapters · composition · schemas
                     · profiles · presets. bin: `asc`. 배포 산출물은 compiled JS.

packages/bootstrap   `@asc-agent/bootstrap` — zero-install 첫 진입. **자체 setup 정책이 없다.**
                     runtime의 setup entry로 넘긴다.
```

### 2.1 launcher package를 만들지 않는다

JAM의 launcher는 committed `.mcp.json` 이 지목할 안정 실행물이 필요해서 존재한다
(§1.2). ASC에는 그 요구가 없고, launcher를 두면 **모든 local 명령이 한 단계를 더 거친다.**

runtime 선택은 package 하나가 아니라 runtime bin 안의 한 단계로 둔다 (§4).
필요성이 실측으로 증명되면 그때 추가한다 — 지금은 근거가 없다.

### 2.2 의존 방향

```text
bootstrap → runtime        (exact version)
```

역방향 금지. runtime은 bootstrap의 존재를 몰라야 한다.

---

## 3. Stable executable — 사용자가 실제로 치는 `asc`

> 2026-08-26 갱신. §3.1의 "실측으로 정한다"가 끝났다 — 사용자 결정으로 **npm global
> exact-version** 이 정본이다. 그 판단의 근거와 함께 버린 대안을 아래에 남긴다.

**모호하게 두지 않는다.** bootstrap이 `npx` 인데 그 다음 줄부터 맨 `asc` 가 나오고 어디서
생겼는지 아무도 말하지 않는 문서는 만들지 않는다.

```text
ZERO STATE  아무것도 없는 machine
              ↓
            npx --yes @asc-agent/bootstrap@<exact> init
              ↓ detect → plan
            plan에 **runtime을 이 machine에 설치한다**는 변경이 들어 있다
              ↓ apply
            npm install -g @asc-agent/runtime@<exact>
              ↓ verify   설치된 버전 확인 + **새 프로세스에서** 실행 확인
            bootstrap 프로세스 종료
              ↓
NEW PROCESS asc ...        설치된 runtime을 직접 실행한다 — 매 호출 network 0
```

설치는 **plan에 적힌 변경**이다 (불변식 ⑩). bootstrap이 몰래 설치하지 않고, plan을 보지
않은 사람이 설치를 당하지 않는다.

### 3.1 설치 방식 — npm global exact-version

```text
canonical   npm install -g @asc-agent/runtime@<exact>
실행물      asc                    (Windows에서는 npm이 만든 asc.cmd)
플랫폼      macOS · Linux · Windows 동일
```

**exact version만 쓴다.** `@latest` · `@1` · floating semver 금지 — 테스트하지 않은
runtime을 installer가 몰래 부르면 안 된다 (불변식 ⑧).

**실행물 링크는 npm의 몫이다.** ASC는 shim을 만들지 않고, PATH를 고치지 않는다.

```text
ASC가 하지 않는 것
  .zshrc · .bashrc · .profile · PowerShell profile 수정
  Windows User/System PATH 수정
  asc.cmd 직접 생성
  $ASC_HOME 안의 자체 package manager / installer
  매 호출 npx runtime
  별도 launcher package
```

대신 **verify한다.** 설치는 됐는데 `asc` 가 안 보이면 성공으로 뭉개지 않고 그렇게 말한다
(§3.3).

### 3.2 버린 대안 — user-owned installer

```text
$ASC_HOME/runtime/<version>/   설치본
$ASC_HOME/bin/asc              PATH에 넣는다
```

ASC가 이미 `~/.asc` 를 소유하므로(C-11) 이쪽이 더 ASC답다는 판단이 있었다. **v0.1에서는
채택하지 않는다** — npm이 이미 prefix·링크·플랫폼 shim을 관리하고, 그것을 다시 만드는
것은 package manager를 하나 더 만드는 일이다.

**언제 다시 여는가**: 실 global-install 실패(권한·prefix·node manager)가 **반복적으로
관측될 때**다. 한 번의 실패는 진단하고 해법을 말할 일이지, 설치기를 새로 쓸 근거가 아니다.

### 3.3 설치됐는데 안 보이는 경우

node manager(nvm·fnm·Volta·asdf·Homebrew)에 따라 global prefix가 달라지고, 그 결과
설치는 성공했는데 지금 프로세스의 PATH에 `asc` 가 없을 수 있다.

```text
성공으로 뭉개지 않는다. 사실대로 말하고 다음 행동을 준다:
  "Runtime package was installed, but `asc` is not visible in this process.
   Open a new terminal and run `asc setup status`."
```

새 프로세스에서도 안 보이면 npm global prefix · PATH · node manager 문제로 진단한다.
**이것을 이유로 ASC가 PATH를 고치지 않는다.**

### 3.4 Invocation provenance — 설치 전과 후를 섞지 않는다

같은 일을 두 이름으로 부른다. 그 둘을 혼동하면 fresh machine에서 실행되지 않는 명령이
문서와 JSON에 실린다.

```text
Human shorthand          asc setup status
                         사람이 읽고 치는 짧은 형태. **설치 뒤에만** canonical이다.

Portable command         npx --yes @asc-agent/bootstrap@<exact> setup apply --profile <id>
                         **지금 이 machine 상태에서 그대로 실행 가능한** 형태.
```

**불변식**: agent에게 실행 가능한 action으로 주는 command는 그 machine의 현재 상태에서
그대로 실행돼야 한다 (불변식 ⑯). runtime이 아직 설치되지 않았는데 `asc …` 만 돌려주면
agent는 없는 실행물을 부른다.

runtime이 `CURRENT` 이면 `asc …` 자체가 portable이다 — 그때는 둘이 같다.

---

## 4. Runtime resolution — package / development

```text
mode: package        설치된 runtime이 스스로 돈다. 재실행도, 중간 프로세스도 없다.
mode: development    설치된 bin이 지정된 checkout의 build를 대신 실행한다.
```

**JAM의 package mode(매 기동 `npx --yes`)를 그대로 쓰지 않는다.** `asc proceed` 가 npm
가용성에 묶이면 §0 기준문과 C-12가 깨진다.

### 4.1 development source 검증은 resolver에서 끝낸다

```text
경로가 있는가
그 안이 ASC 저장소인가 (package identity)
build 산출물이 있는가
```

셋 중 하나라도 아니면 **거절하고 무엇을 하라고 말한다.** module-not-found를 나중에
맞게 두지 않는다.

### 4.2 자기 자신으로 되튀지 않는다

지금 도는 실행물이 곧 resolve된 대상이면 재실행하지 않는다. development checkout의
bin을 직접 불렀을 때 무한 재실행이 되면 안 된다.

---

## 5. Runtime config

```text
위치     $ASC_HOME 안 (machine-local)
소유     이 파일은 runtime 선택만 담는다
금지     credential · project key · workspace state
```

**project 파일에 machine 절대경로를 적지 않는다** (불변식 ④). development source 경로는
machine-local config에만 있다.

**runtime 선택 변경은 project 변경이 아니다** (불변식 ⑤). 반대도 같다 — workspace를
붙이거나 옮기는 것이 runtime 선택을 바꾸지 않는다.

읽지 못하는 config는 **없는 것으로 본다.** 반쯤 해석해서 엉뚱한 runtime을 부르지 않는다.

---

## 6. Setup — detect → plan → apply → verify

기존 표면을 재사용한다. **새 setup core를 병렬로 만들지 않는다.**

```text
detect    세상의 스냅샷. 읽기만 한다.
          이미 있는 것: planBootstrap의 입력 수집 · inspectSetup · verifyInstall · probe

plan      순수 판단. 변경 목록을 만들고 아무것도 쓰지 않는다.
          network·subprocess·clock에 손대지 않는다 — 사실은 caller가 관측해 넘긴다.
          이미 있는 것: planBootstrap → BootstrapPlan · assessSetup

apply     plan에 적힌 변경만 실행한다. **다시 판단하지 않는다.**
          plan에 없는 변경은 일어나지 않는다.

verify    같은 detect로 다시 보고 판정한다. apply 직후 plan은 비어 있어야 한다(멱등).
```

### 6.1 금지되는 형태

```text
HumanSetupService  vs  AgentSetupService
PackageAscCore     vs  DevelopmentAscCore
PackageOperator    vs  DevelopmentOperator
```

두 진입이 다르게 굴어야 한다면 그 차이는 **plan 안에 있어야 하고**, 구현이 둘이 되면 안 된다.

---

## 7. Agent surface

```text
stdout    하나의 parseable JSON document. ANSI 0, prompt 0.
stderr    진단.
```

Agent가 산문을 grep하거나 한국어 문장을 정규식으로 판정하면 그것은 계약 위반이다.

최소 안정 필드:

```text
status              기계가 분기하는 상태
code                막힌 이유의 식별자 — 산문이 아니다
requiresUserAction  사람이 정해야 하는가
changesPlanned      plan이 적은 변경
changesApplied      실제로 적용됐는가
nextActions         다음에 할 일
evidence            판정 근거
```

정확한 형태는 기존 typed outcome과 정렬한다. **테스트는 stdout 전체를 파싱한다** —
JSON처럼 보이는 부분만 뽑아내면 그 계약은 검증되지 않은 것이다.

### 7.1 Human boundary는 C-13을 그대로 쓴다

setup에서 사람이 필요한 경우는 이미 정의돼 있다:

```text
ownership/adoption 결정 · 모호한 profile 선택 · secret/permission
· canonical conflict · project/team scope 채택 · 파괴적 migration
```

**Agent도 같은 경계를 받는다.** 사람이 답해야 할 것을 agent라서 추측하지 않는다.

---

## 8. Version

```text
release package 간 관계는 exact version으로 고정한다.
@latest · @1 · floating semver 금지.
```

이유: 테스트하지 않은 runtime을 installer가 몰래 부르면 안 된다.

초기 release는 lockstep이 단순하다. **다만 셋은 원래 다른 축이다** —

```text
package version          실행물의 버전
workspace/state schema   사용자 상태의 형식
Host install payload     설치물의 digest (이미 L-5가 이 축으로 판정한다)
```

같은 숫자여야 할 이유는 없다. 불필요한 migration coupling을 처음부터 만들지 않는다.

현재 `package.json 0.0.0` 과 `ASC_VERSION 0.1.0` 이 어긋나 있다 — distribution 시작
시점에 한 번 정본화하고, 그 이상 설계하지 않는다.

---

## 9. Offline

설치가 끝난 뒤 network가 없어도 다음은 돈다:

```text
asc front · proceed · session · progress · audit · report
· escalate · preflight · closure · query · freeze/thaw
· host의 local 판정 (install/verify/uninstall)
```

remote provider 기능만 degraded/unavailable로 **표시**된다 — 숨기지 않는다(B-49·B-58).

network가 필요한 것은 **bootstrap · install · update** 뿐이다.

---

## 10. Install ownership — 기존 정책을 그대로 쓴다

L-5에서 정한 판정을 distribution이 우회하지 않는다:

```text
ASC-owned          update 가능
user-modified      --force 없이 덮지 않는다
무관한 사용자 파일   건드리지 않는다
타 도구 hook        건드리지 않는다
```

runtime을 올리면 Host 설치물이 뒤처진다(`INSTALLED_STALE`). **그 사실이 보여야 하고**,
자동 복구 여부는 plan에 적힌다 (불변식 ⑩).

### 10.1 Upgrade는 먼저 부수지 않는다

```text
새 버전 설치 → verify → active runtime 전환
```

순서를 지킨다. 실패하면 이전 runtime이 그대로 남아 있어야 한다. 패키지 매니저를 새로
만들라는 뜻이 아니다 — **부분 적용 상태를 방치하지 말라는 뜻이다.**

### 10.2 Uninstall

runtime 제거와 사용자 데이터 삭제를 **한 명령에 묶지 않는다.**

```text
runtime-owned 파일    제거
ASC_HOME state       기본 보존 — 지우려면 명시적으로
Host 통합             명시적 선택
사용자 파일·프로젝트   건드리지 않는다
```

---

## 11. Local-first는 distribution 때문에 흔들리지 않는다

C-11이 그대로 산다:

```text
개인 사용 기본        저장소 footprint 0
repo/.asc            legacy 또는 명시적 project 채택에서만
.gitignore           팀 파일 — 손대지 않는다
.git/info/exclude    project scope 전용 전환기 장치
```

**distribution 설치가 legacy migration을 자동으로 파괴적 정리하지 않는다** (불변식 ⑭).

---

## 12. 불변식

```text
①  Human/Agent setup 로직은 하나다.
②  Package/Development 차이는 runtime resolution뿐이다.
③  정상 설치 뒤 local control 명령은 network 가용성에 의존하지 않는다.
④  machine-specific 경로를 project-owned 파일에 적지 않는다.
⑤  runtime 선택 변경은 project 변경이 아니다.
⑥  개인 setup의 저장소 footprint는 0이다.
⑦  bootstrap에는 독립 setup 정책이 없다.
⑧  실행물 wiring은 exact version을 쓴다.
⑨  package artifact는 compiled JS이며 소비자에게 TS 실행을 요구하지 않는다.
⑩  apply는 plan에 없는 변경을 하지 않는다.
⑪  package update가 workspace/runtime state를 자동으로 다시 쓰지 않는다.
⑫  Agent non-interactive 표면은 산문 파싱을 요구하지 않는다.
⑬  install/update는 ASC-owned artefact만 바꾼다.
⑭  user-modified Host artefact는 --force 없이 덮지 않는다.
⑮  private workspace root는 배포 대상이 아니다.
⑯  agent에게 실행 가능한 action으로 주는 command는 그 machine의 현재 상태에서
    그대로 실행된다. 사람이 읽는 짧은 형태와 섞지 않는다.
⑰  실행물 링크(PATH·shim)는 npm의 몫이다. ASC는 shell·PATH를 고치지 않고 verify한다.
```

---

## 13. 확정된 것과 정하지 않는 것

**확정 (2026-08-26 사용자 결정 — 더 이상 후보가 아니다)**

```text
Product · CLI     ASC (Agent Session Control) · `asc`
npm scope         @asc-agent
runtime           @asc-agent/runtime
bootstrap         @asc-agent/bootstrap
stable install    npm global exact-version (§3.1)
플랫폼 정책        macOS · Linux · Windows 동일
offline           설치 후 local control plane은 network를 요구하지 않는다 (§9)
```

폐기된 후보: `@asc-control/*` · `@asc-ops/*` · `@asc-run/*` · `agent-session-control` ·
`ascp` · unscoped `asc`. **naming 탐색은 끝났다.**

`agent` 가 `Agent Session Control` 의 A와 겹치는 것은 의도한 것이다 — JAM이 `@jam-mcp/*`
로 제품이 속한 생태계를 짧게 드러내는 것과 같은 방식이다.

**정하지 않는 것**

> **2026-08-27 갱신** — 아래 둘은 그 뒤 사람이 결정했다: repository는 **공개**이고,
> v0.1.0은 **npm에 게시됐다**. 남은 문장(license·Node 하한·Windows)은 그대로 유효하다.
> 게시 여부의 정본은 [docs/status.md](../status.md)다.

```text
license                   사용자 결정이다. 현재 ISC.
npm publish               사용자의 명시적 지시 없이는 하지 않는다 (v0.1.0은 지시로 게시됨).
Node 하한 변경             compiled JS가 됐다고 낮은 Node 호환이 증명되지 않는다.
                          현재 `>=24` 를 유지하고, 낮추려면 그 Node에서 실측한다.
Windows 지원 선언          architecture는 확정(§3.1)이나, 실 장비 없이
                          RUNTIME_OBSERVED를 선언하지 않는다.
```

**남은 외부 사실 하나**: `@asc-agent` scope의 실제 소유·publish 권한. 이름 재논의가 아니라
registry 제약 확인이며, 실 publish 직전에만 필요하다. 확인 결과 쓸 수 없으면 그때 멈춘다.
