# ASC 구현 계약 C-11 — Workspace Identity · Local-first Storage · Zero-Footprint

> 작성: 2026-08-26. **지위: 동결된 설계 v5.1(OM)·C-01·C-02·C-03을 수정하지 않는
> 후속 구현 계약이다 — 설계 재개가 아니다.**
> 근거 지시: (비공개 evidence 저장소) (원문 보관, 비규범).
> 대상 로드맵: B-44(Workspace Identity) · B-45(Root Resolution 단일화) · B-46(User-owned
> Storage · Reverse Index · Guard) · B-47(Zero-Footprint init/attach) · B-48(Legacy Migration) ·
> B-49(SCM Resolver · Profile-driven Composition).
> 본문 경로·CLI·필드명은 계약 검증용이며 exact 형식은 구현 중 한 번만 결정한다.

---

## 0. 기준문

> **When ASC is used personally against a repository that has not explicitly adopted ASC,
> normal operation SHALL NOT create, modify, or require any file inside the repository
> working tree.**
>
> **Discovery may be automatic; adoption must never be inferred.**
>
> ASC를 개인적으로 쓰기 위해 남의 저장소에 흔적을 남기지 않는다. 팀이 ASC를 채택하는 것은
> 팀의 결정이며, 자동 발견의 결과로 승격되지 않는다.

구현 중 판단이 갈리면 이 문장으로 정한다.

## 0.1 C-06 §6을 supersede한다

```text
C-06 §6 (당시)     ".asc runtime의 머신 간 이동 — 다음 계약으로 넘김
                    (P1 관찰 ⑪ — local state 계약 유지 중)"

C-11 (이후)        Workspace Identity·User-owned Storage 범위에서
                    machine/path migration을 정식으로 다룬다
```

**C-06의 기록을 지우지 않는다.** 당시 판단은 그 시점에 옳았고, 그것을 없던 일로 만들면
왜 지금 열었는지도 사라진다. C-06 §6은 그대로 두고 이 절이 그 항목을 이어받는다.

---

## 1. 네 개념을 분리한다

```text
Workspace Identity   이것이 어떤 논리적 프로젝트인가        — 안정적, 사람이 안 바꿈
Alias                외부 시스템이 부르는 이름들            — 여러 개, 바뀔 수 있음
Locator              이 기계에서 지금 어디에 있는가          — 여러 개, 자주 바뀜
Execution Instance   그 Locator에서 실제로 도는 작업 단위    — worktree 단위
```

**불변식 ①** — 절대 경로를 identity로 쓰지 않는다. 현재 identity는 "walk-up이 멈춘 경로"인데,
그것은 directory move 한 번에 다른 프로젝트가 된다.

**불변식 ②** — `Workspace Identity ≠ Current SCM Binding`.
GitHub → GitLab 이전만으로 같은 프로젝트가 새 workspace가 되지 않는다.

### 1.1 Hybrid Identity

```text
workspaceId   W-<user-owned generated stable id>     내부 정본
aliases[]     normalized SCM/repository identities   외부 증거
locators[]    filesystem checkout paths              현재 위치
```

내부 id가 정본인 이유: remote가 없는 저장소도, remote가 바뀌는 저장소도 있어야 하기 때문이다.
alias가 필요한 이유: 새 clone을 같은 프로젝트로 알아보는 유일한 단서이기 때문이다.

**불변식 ③** — user-owned ASC state 자체가 그 기계에 없으면 같은 `workspaceId`를 복원한다고
주장하지 않는다. alias 일치는 **recover candidate**이지 동일성 증명이 아니다.

### 1.2 Alias 정규화

```text
git@host:group/project.git
https://host/group/project.git
ssh://git@host:2222/group/project
→ <scheme-neutral>:host/group/project
```

credential·userinfo·port·query·`.git` 접미는 identity에 넣지 않는다 — 비밀이 identity에
섞이면 로그·인덱스에 비밀이 남는다.

**불변식 ④** — 모든 remote를 evidence로 수집하고 `origin`을 primary로 단정하지 않는다.
mirror가 origin일 수 있고 primary가 upstream일 수 있다(실 파일럿 프로젝트 실측).

### 1.3 Worktree

```text
Logical Workspace
├─ Execution Instance / Locator A   (main worktree)
├─ Execution Instance / Locator B   (feature worktree)
└─ Execution Instance / Locator C
```

같은 논리 workspace, 다른 execution instance다. **workspace를 합치지도 쪼개지도 않는다** —
쪼개면 Monitor Run lease가 프로젝트 단위라는 전제가 깨지고, 합치면 실행 격리가 사라진다.

---

## 2. Scope — Local/User와 Project/Team

```text
Local / User Scope     기본값. user-owned runtime. repository footprint 0
Project / Team Scope   명시적 opt-in. 팀이 ASC artefact를 저장소에 두기로 결정한 경우만
```

**불변식 ⑤** — 자동 discovery 결과를 근거로 local → project scope를 승격하지 않는다.
adoption은 사람의 명시적 행위(예: `--scope project`)로만 생긴다.

**불변식 ⑥** — 신규 personal 사용은 repo-local runtime을 만들지 않는다. migration 이후
repo-local의 정상 용도는 explicit project adoption 하나뿐이며, 그 외는 legacy 호환이다.

---

## 3. User-owned Storage

```text
ASC_HOME (기본 ~/.asc)
├─ workspaces/<workspace-id>/     ← 이것이 ascRoot. 내부 구조는 기존과 동일
└─ workspace-index.json           ← Locator → Workspace 역색인
```

**불변식 ⑦** — workspace 하나당 디렉터리 하나다. 합치면 `nextId` 카운터가 깨지고
Monitor의 프로젝트 단위 Run lease가 무너진다.

**불변식 ⑧** — 저장 내용에 절대 경로를 넣지 않는다(현행 실측 0건 유지). locator는 index에만
산다 — state가 경로를 알면 이동이 곧 오염이 된다.

**불변식 ⑨** — 역색인 쓰기는 원자적이다(tmp+rename). 반쯤 쓰인 index를 guard가 읽으면
판정이 흔들린다.

### 3.1 Reverse Index의 소비자 제약

역색인의 가장 까다로운 독자는 **Claude guard hook**이다. hook은 어떤 프로젝트에서든 도는
무의존 단일 파일이며(외부 import 0), 매 Bash 호출마다 실행된다.

**불변식 ⑩** — 역색인 포맷은 `readFileSync` 한 번 + `JSON.parse` 한 번으로 해석 가능해야
한다. 이 제약이 포맷을 정한다 — 데이터베이스도, 다단 조회도 두지 않는다.

---

## 4. Guard — 조건부 fail-closed

현재 guard는 `.asc`를 못 찾으면 통과한다(`exit 0`). 그것은 "이 프로젝트는 ASC 소관이 아니다"의
신호였고, repo-local 전제에서는 옳았다. storage가 사용자 소유로 옮겨가면 그 신호가 무의미해진다.

```text
ASC binding evidence 없음
→ 일반 host 사용. ASC가 소유권을 주장하지 않는다. 통과

ASC-controlled Front/Execution으로 확인됨
+ workspace 역해석 실패
→ protected operation FAIL-CLOSED
```

protected operation:

```text
external write
canonical modify
policy change
remote mutation
grant-required action
```

**불변식 ⑪** — ASC와 무관한 일반 host 세션까지 전역으로 차단하지 않는다.
안전을 이유로 남의 도구를 망가뜨리지 않는다(`Host belongs to the user`).

**불변식 ⑫** — guard는 생성 시점에 문자열로 굳는다. 변경 시 재설치가 필요하다는 사실을
사용자에게 알린다 — manifest digest 비교로는 source↔installed drift를 볼 수 없다(L-5).

---

## 5. Zero-Footprint Acceptance

```text
given   clean repository, no explicit ASC project adoption
when    init · attach · inbox · proceed · review · monitor
then    repository working tree byte-for-byte unchanged
        repo-local ASC file 0
        .gitignore unchanged
        .git/info/exclude unchanged
        runtime only under ASC_HOME
```

**불변식 ⑬** — `git status clean` 하나로 통과시키지 않는다. tracked 내용·untracked 목록·
`.git/info/exclude`를 각각 대조한다. `.git` 내부의 비표시 변화도 별도로 본다.

`.git/info/exclude` self-registration은 **legacy/transitional safeguard**로 재분류한다.
project scope에서만 쓰고, local scope에서는 부르지 않는다.

---

## 6. Legacy Migration — provenance 먼저

기존 `repo/.asc/` 발견 시 **먼저 무엇인지 판정**한다.

```text
personal legacy       개인이 만든 것 → migrate candidate
project adopted       팀이 채택한 것 → 그대로 둔다
ambiguous             판단 불가     → 자동 이동 금지
```

**불변식 ⑭** — ambiguous는 `AMBIGUOUS_ADOPTION`으로 표면화하고 사람이 정한다.
**팀이 채택한 artefact를 개인 state로 오판해 옮기는 것은 이 계약이 막아야 할 최악이다.**

절차:

```text
copy → verify → provenance 기록 → switch → cleanup
```

**불변식 ⑮** — verify 전에 원본을 지우지 않는다. rollback 가능해야 한다.
lock·profile의 의미가 이전 후에도 보존돼야 하며, 이전 자체가 LOCK_DRIFT를 만들지 않아야 한다.

---

## 7. SCM Resolution — auto와 explicit

provider를 Profile 문자열로 못 박는 것을 기본값으로 두지 않는다.
Profile은 **필요한 capability/policy**를 선언하고, 어느 provider가 그것을 제공하는지는
runtime resolution이 정한다(C-09 §0 기준문과 같은 선).

```text
auto / 미선언
→ remote discovery → adapter 후보 → probe → binding resolution

explicit provider pin + repository reality mismatch
→ CONFLICT / DEGRADED / STOP
```

**불변식 ⑯** — silent fallback 0. GitHub mirror가 있다는 이유로 GitLab primary를 대신
고르거나 그 반대를 하지 않는다. 고르지 못하면 고르지 않고 그 사실을 말한다
(C-09의 AMBIGUOUS 처리와 같은 태도).

**불변식 ⑰** — provider id는 capability가 아니다. 한 프로젝트가 GitLab code binding과
GitHub mirror binding과 work binding을 동시에 가질 수 있다.

---

## 8. Identity fail-closed 유지

storage 위치가 바뀌어도 기존 안전 동작을 유지한다.

```text
external identity 미해결
→ approval · external monitoring · external mutation 잠금
```

**불변식 ⑱** — secret/token은 repository·profile·lock·docs·log·workspace-index 어디에도
남기지 않는다. index는 경로와 id만 안다.

---

## 9. 이 계약이 하지 않는 것

```text
머신 간 자동 state 동기화
  → 이전(migration)과 동기화(sync)는 다른 문제다. 여기서는 이전만 다룬다.

여러 호스트가 한 workspace를 동시에 쓰는 잠금
  → 현재 mtime 기반 stale 회수는 single-host 전제다(state-store의 ponytail 주석).
    user home으로 옮기면 확률이 오르지만, 실제 동시 사용 근거가 생기기 전에는
    lease 방식으로 올리지 않는다. 한계를 아는 채로 둔다.

repo-local 모드의 즉시 제거
  → legacy 호환으로 남긴다. 제거 시점은 별도 판단.

SDD·문서 계층·ASC 전용 구조 요구
  → 여전히 요구하지 않는다(OM 기존 invariant 유지).
```
