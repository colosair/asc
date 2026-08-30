# ASC — Agent Session Control

> **정본은 [README.md](README.md)(영어)다.** 이 문서는 같은 내용의 한국어 판이며, 두
> 문서가 어긋나면 영어 쪽이 맞다. 설계 정본과 계약 문서는 한국어 그대로다.

프로젝트에 독립적인 **human-in-the-loop agent control plane**. 여러 AI 세션 사이에서 사람이
매번 이전 작업 내용을 기억하고 전달해야 하는 부담을, 사용자 소유 공간에 있는 Runtime이
대신하게 한다. 자동화가 목적이 아니라, 병렬 에이전트를 쓰면서도 사람이 프로젝트의
이해·결정권·통제권을 잃지 않는 최소 계약 체계가 목적이다.

설계 정본은 [operating-model.md](docs/design/operating-model.md) §0이고, 저장 위치와
workspace 개념의 정본은 [C-11](docs/contracts/C-11_workspace-local-first.md)이다. 이 README는
**진입점일 뿐이며 설계를 정의하지 않는다** — 아래 문서 지도를 따라가라.

## 요구 사항

- **Node 24 이상** — `package.json`의 `engines`가 이 하한을 선언한다. 하위 버전은 지원
  대상이 아니다. 테스트와 CLI가 `.ts` 파일을 그대로 실행하므로, **type stripping이 플래그
  없이 되는 런타임**이어야 한다. 안 되는 버전에서는 문법 오류처럼 보이는 실패가 난다.
- 의존성은 `zod` 하나뿐이다.

## 설치

```bash
npx --yes @asc-agent/bootstrap@0.2.1 init
```

**이 저장소를 clone하는 것은 ASC를 쓰는 방법이 아니다** — 아래 [기여자 경로](#기여자-경로)이며,
ASC 자체를 고치는 사람을 위한 것이다.

여기 적힌 정확한 버전이 registry에 없다면 이 소스가 릴리스보다 앞선 것이다. **그 사실을
말하고 멈춰라 — 다른 버전으로 물러서지 않는다.** `@latest`도, 낮은 핀도 이 문서로 아무도
시험하지 않은 runtime이다.

> **agent가 읽는 중이라면** [AGENTS.md](AGENTS.md)가 정본 runbook이다 — URL 하나에서
> Control Plane이 READY가 될 때까지, 판단이 이미 내려진 순서로 적혀 있다. 실제 업무가
> 들어왔을 때 그것을 세션 계약으로 바꾸는 규약도 거기 있다.

## 실행 — `asc` 는 어디서 오는가

ASC는 패키지 둘로 나온다.

| 패키지 | 역할 |
|---|---|
| `@asc-agent/runtime` | 본체 — Core·CLI·adapters. `asc` 명령을 제공한다 |
| `@asc-agent/bootstrap` | zero-install 첫 진입. 자체 setup 정책이 없다 |

```text
npx --yes @asc-agent/bootstrap@0.2.1 init
        ↓  bootstrap이 ASC의 평소 setup을 돌린다 (detect → plan → apply → verify)
        ↓  plan에 "이 machine에 runtime을 설치한다"가 변경으로 적힌다
        ↓  apply: npm install -g @asc-agent/runtime@0.2.1
        ↓  실행물 링크는 npm의 몫이다 (Windows에서는 npm이 만든 asc.cmd)
        ↓  verify: 설치된 버전 + **새 프로세스에서** 실행되는지까지 본다
bootstrap 종료
        ↓
asc ...      이후로는 이것이 안정적인 명령이다
```

설치는 **plan에 적힌 변경**이다. bootstrap이 몰래 설치하지 않는다.

ASC는 shell 설정도 PATH도 고치지 않는다. 설치는 됐는데 지금 프로세스에서 `asc` 가 안
보이면 성공으로 뭉개지 않고 그렇게 말한다 — 새 터미널을 열라고 안내한다.

### ASC를 도는 세 가지 방식

명령은 세 방식 모두에서 같다 — 진입만 다르다.

| 방식 | 진입 | 언제 |
|---|---|---|
| Zero-install | `npx --yes @asc-agent/bootstrap@0.2.1 <command> --json` | 아직 아무것도 설치 전 |
| Persistent | `npm install -g @asc-agent/runtime@0.2.1` 후 `asc <command>` | 안정적인 로컬 명령 — 그리고 `npx` 자체가 서지 못하는 기계의 fallback |
| Development | `asc runtime use development <checkout>` | 패키지 대신 빌드된 checkout으로 |

ASC 프로세스가 뜨기도 전에 `npx`/`npm exec` 가 죽으면 — package runner나 PATH의 문제 —
그것은 ASC의 실패가 아니고, 분기할 ASC 오류 코드도 없다. persistent 방식을 설치하고 같은
subcommand를 `asc …` 로 다시 돌리면 된다.

## 프로젝트에 붙이기

```bash
cd /path/to/your-project
asc setup plan          # 무엇이 바뀔지만 보여준다. 아무것도 바꾸지 않는다
```

**무엇이 있고 무엇이 정해지지 않았는지**를 보여주고 멈춘다 — git 뿌리, Profile 후보,
Host 설치 여부, 다음 순서. 후보가 하나뿐이어도 대신 고르지 않는다.

### 이 프로젝트의 Profile

배포본에 담긴 Profile은 **예시**이고, 어느 것도 실 프로젝트를 설명하지 않는다. 지금 있는
저장소로 하나 만든다:

```bash
asc profile adopt                      # ~/.asc/profiles/<repo>/profile.json 을 쓴다
asc setup apply --profile <repo>
asc setup status
```

`adopt`는 **git remote가 증명하는 것만** 적는다 — 프로젝트 정체성뿐이다. 정본 branch와
role 경계는 비워 둔다. 저장소를 봐서 알 수 없는 팀의 결정이고, 잘못 지어내면 나중에 세션이
막힌다. 비운 것은 `warnings`가 말해 준다.

이미 받은 Profile 파일이 있으면 그것을 자리에 놓는다:

```bash
mkdir -p ~/.asc/profiles/my-team
cp path/to/profile.json ~/.asc/profiles/my-team/profile.json
asc setup apply --profile my-team
```

`setup apply`는 runtime을 만들고, 끝에 **지금 되는 것과 아직 열리지 않은 것**을 이유·해법과
함께 출력한다. 같은 요약은 언제든 `setup status`로 다시 본다.

붙인 직후에도 **로컬 개발 루프는 설정 편집 없이 돈다** — 세션 발급·진행·중단·재개·종료,
진행 기록, 산출 경로 사전 대조, 회수와 마무리 확인이 전부 그대로 동작한다. 채워야 열리는
것은 바깥 경로(승인 결정·GitHub 감시·외부 반영)뿐이고, 무엇을 어떻게 채우는지는
`setup status`가 말해 준다.

### Runtime은 어디에 생기나 — Local이 기본이다

`init`은 기본이 **local scope**다. 이때 **대상 저장소에는 아무것도 만들지 않는다.**

```text
--scope local (기본)   runtime = $ASC_HOME/workspaces/<W-id>/   저장소 footprint 0
--scope project        runtime = <저장소>/.asc/                 팀이 그렇게 정했을 때만
```

- `ASC_HOME`은 기본 `~/.asc` 이며 환경변수로 바꾼다. 그 안에 workspace 하나당 디렉터리
  하나와 역색인 `workspace-index.json` 이 있다.
- **local → project 자동 승격은 없다.** 저장소 안에 두는 것은 `--scope project`로만
  표현되는 명시적 결정이다 (C-11 불변식 ⑤).
- `.git/info/exclude` 등록은 **project scope에서만** 일어난다. local scope는 저장소 파일을
  한 바이트도 건드리지 않는다 (C-11 §5).

### Workspace — 경로가 아니라 프로젝트를 가리킨다

| 개념 | 뜻 |
|---|---|
| Workspace Identity | `W-…` — 정본. 안정적이고 논리적이다 |
| Alias | remote URL을 정규화한 이름. **식별 증거이지 동일성 증명이 아니다** |
| Locator | 이 기계에서의 checkout 경로. 바뀔 수 있다 |

절대 경로는 identity가 아니다. 그래서 checkout을 옮기거나 다시 clone해도 같은 workspace를
가리킬 수 있다.

```bash
asc workspace list
```

옮긴 뒤 그 위치를 같은 workspace에 다시 등록할 때는 사람이 선언한다 — alias가 맞아떨어져도
ASC가 대신 고르지 않고 후보만 알린다.

```bash
asc init --profile <id> --workspace <W-id>
```

### 저장소 안의 `.asc/` 가 이미 있다면 (legacy)

예전 방식으로 만들어진 `repo/.asc` 는 그대로 동작한다. 사용자 소유 공간으로 옮기려면:

```bash
asc workspace migrate
```

- 먼저 **팀이 채택한 것인지 개인 legacy인지 판정**하고, 모르면 옮기지 않는다.
- 복사하고 확인까지 한 뒤 **원본은 지우지 않는다.** 지우는 것은 사람이 확인하고 한다.
- 옮겨도 저장소의 내용이 최신으로 자동 갱신되지 않는다 — 과거 baseline은 과거 baseline이다.

### Runtime state의 성격

- 통째로 지워도 대상 프로젝트에는 아무 영향이 없다.
- 대상 프로젝트의 spec·Issue·작업 목록을 복사해 넣지 않는다. 포인터와 baseline만 둔다.
- 기계 사이 자동 동기화는 하지 않는다 (C-11 §9). 같은 기계 안에서의 경로 이동·재clone은
  workspace identity로 따라온다.

## Claude Host

Claude Code를 host로 쓸 때의 진입점이다.

```bash
asc host claude install   # 3층 guard hook + skill bundle (~/.claude)
asc host claude guard     # 2층 worker-settings (attach된 프로젝트에서)
asc host claude probe     # capability 실측 + 설치 상태 판정
```

Host 설치물은 **project-owned가 아니라 user-owned다.** `install`은 사용자 홈(`~/.claude`)에
설치하며 경로 옵션이 없다. `uninstall`은 ASC 설치물만 제거한다. 설치 단위는 **Skill Bundle
3종**이다 — `asc`(대표 표면) · `asc-inbox`(조사와 Decision Packet) · `asc-review`(독립 검증).
사용자는 원칙적으로 `asc` 하나만 알면 된다.

**`probe`에는 `claude` 실행파일이 PATH에 있어야 한다.** 없으면 안전 필수 capability
(`external_write_guard`)를 실측할 수 없어 `STOP`으로 떨어진다(exit 1). 이는 ASC 결함이 아니라
**prerequisite 부재**이며, 그 상태에서도 위 install/guard와 로컬 루프는 정상 동작한다.

## 기여자 경로

ASC 자체를 고칠 때만 쓴다. **이것으로 ASC를 쓰지 않는다.**

```bash
git clone https://github.com/colosair/asc.git
cd asc
npm ci
npm test
npm run typecheck
node packages/runtime/cli/asc.ts --help   # 소스를 그대로 실행한다
```

**`npm ci`를 먼저 해야 한다.** 건너뛰면 `Cannot find package 'zod'`로 전 테스트 파일이
실패해 저장소가 통째로 깨진 것처럼 보인다.

## 문서 지도

| 무엇 | 어디 | 성격 |
|---|---|---|
| 설계 정본 (v5.1, 동결) | [docs/design/operating-model.md](docs/design/operating-model.md) | `OM §x` 참조 대상 |
| 구현 계약 | [C-01](docs/contracts/C-01_approval-port.md) · [C-02](docs/contracts/C-02_port-interface.md) · [C-03](docs/contracts/C-03_operator-host-adapter.md) | Approval Port / Port 경계 / Operator·Host Adapter |
| 구현 계약 (책임·진입) | [C-04](docs/contracts/C-04_responsibility.md) · [C-05](docs/contracts/C-05_skill-bundle.md) · [C-06](docs/contracts/C-06_bootstrap.md) | Responsibility·Bounded Query / Skill Bundle·Inbox Depth / Zero-base Bootstrap |
| 구현 계약 (관찰·전달·독립성) | [C-07](docs/contracts/C-07_monitoring-completion.md) · [C-08](docs/contracts/C-08_presentation-digest.md) · [C-09](docs/contracts/C-09_capability-binding.md) | Monitoring Completion / Presentation·Digest / External-System Independence |
| 구현 계약 (감사·저장·상시성·자율) | [C-10](docs/contracts/C-10_orchestration-audit.md) · [C-11](docs/contracts/C-11_workspace-local-first.md) · [C-12](docs/contracts/C-12_always-on-runtime.md) · [C-13](docs/contracts/C-13_autonomous-escalation.md) | Orchestration Audit / Workspace·Local-first / Always-On Runtime / Autonomous Decision·Escalation |
| 구현 계약 (배포·실행 진입) | [C-14](docs/contracts/C-14_distribution-runtime-entry.md) | Distribution·Runtime Entry — 실행물이 machine에 어떻게 존재하는가 |
| 사용자 전달사항 원문 | (비공개 evidence 저장소) | 비규범 보관 — 규범은 계약 문서 |
| 자기 Profile 가져오기 | [docs/profiles.md](docs/profiles.md) | 실 프로젝트 Profile이 사는 자리 |
| 팀 온보딩·업그레이드 | [docs/team-setup.md](docs/team-setup.md) | 새 팀원이 처음부터 · 기존 사용자가 새 runtime으로 |
| **제품 상태 SSOT** | [docs/status.md](docs/status.md) | 무엇이 있고, 무엇이 증명됐고, 무엇을 주장하지 않는가 |
| Block 단위 이력 | (비공개 evidence 저장소) §2 | 개발 기록 — 비공개 evidence 저장소 |
| roadmap 후보·조사·관찰 | (비공개 evidence 저장소) · (비공개 evidence 저장소) | 후보이지 확정이 아니다 |
| 실측 기록 | (비공개 evidence 저장소) | 실제 runtime evidence |
| 영어 정본 진입 | [README.md](README.md) · [docs/architecture/distribution-and-runtime.md](docs/architecture/distribution-and-runtime.md) | 외부 진입은 영어다 |

설계 정본(OM v5.1)과 C-01~C-03은 **동결 문서**다. Port/Profile/Adapter 경계로 해결할 수
없다는 증거가 있을 때만 재개한다. C-04 이후 계약은 동결 정본을 고치지 않는 **후속 계약**이며,
정본과 어긋나는 부분은 해당 계약이 자기 머리말에서 명시적으로 supersede를 선언한다.

## 운영 규칙

**신규 Block은 실측 근거 없이 착수하지 않는다.** 후보는 실제로 발생한 사건과 연결돼 있어야
하고, 반복 가능성과 명확한 Gate가 있어야 한다. "할 게 없으니 다음 번호를 만든다"는 방식은
쓰지 않으며, 근거가 부족하면 다음 Block을 확정하지 않은 채로 둔다.

보고할 때는 **구현 사실과 검증 사실을 섞지 않는다** — 코드가 있다, 자동 테스트가 통과했다,
실 CLI에서 관찰했다, 실제 작업에서 관찰했다, 외부 시스템에 반영됐다는 서로 다른 주장이다.
