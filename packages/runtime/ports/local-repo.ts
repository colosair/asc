// Local Repository Port — 지금 이 저장소가 실제로 어떤 상태인가.
//
// 이 Port가 따로 있는 이유는 하나다. **원격 provider가 막혀 있다는 사실이 저장소를 보지
// 않을 사유가 되어서는 안 된다.** GitLab API가 401을 주든 토큰이 없든, ref·병합 여부·
// 파일 존재는 로컬 git 으로 전부 읽힌다. 그것을 안 읽고 "확인 불가"라고 말하면
// 조사 누락이 접근 불가로 위장된다.
//
// diff 도 로그도 다루지 않는다. "구현이 정본 가지에 있는가"를 판정할 최소한만 본다.

export type RepoObservation = {
  /** 현재 체크아웃된 가지. 알 수 없으면 null. */
  branch: string | null
  remotes: readonly { name: string; url: string }[]
  /** refHint 에 걸린 지역·원격 ref 들 (예: 이슈 키가 들어간 작업 가지). */
  refs: readonly string[]
  /** 무엇을 정본으로 삼아 비교했는가. Profile 이 정한다 — adapter 가 추측하지 않는다. */
  canonicalRef?: string
  /**
   * refs 중 하나라도 정본 가지에 들어가 있는가. 판정이 아니라 **증거**다 —
   * squash 병합이면 ref 는 조상이 아니지만 산출물은 정본에 있다. 그 경우
   * `pathsOnCanonical` 이 같은 사실을 다른 각도로 말한다.
   */
  mergedIntoCanonical?: boolean
  /**
   * 작업 트리에 그 경로가 있는가. **이 작업의 산출물 후보만** 담는다 — 저장소에 늘 있는
   * 자리를 여기 섞으면 "구현이 있다"는 증거가 아무 작업에서나 성립해 버린다.
   */
  pathsExist: Record<string, boolean>
  /**
   * 저장소의 자리 목록(최상위 디렉터리 등). 범위를 좁힐 재료일 뿐 **증거가 아니다** —
   * 판정은 이 값을 보지 않는다.
   */
  modulesPresent?: Record<string, boolean>
  /** 정본 가지에 그 경로가 있는가 (squash 병합 대비). */
  pathsOnCanonical?: Record<string, boolean>
  /**
   * 정본 가지의 이력에서 이 작업을 언급하는 커밋들. **가지가 지워진 뒤에도 남는 증거다** —
   * 병합 후 브랜치를 지우는 팀에서는 ref 대조만으로는 "구현이 정본에 있다"를 알 수 없다.
   */
  mentionedOnCanonical?: readonly string[]
  /**
   * 언급 커밋이 전부 되돌리기인가. 되돌린 이력은 "구현이 정본에 있다"의 증거가 아니다.
   */
  mentionedOnlyReverts?: boolean
  /**
   * 언급 커밋이 건드린 파일 중 하나라도 정본에 아직 살아 있는가.
   *
   * **이것은 생존 증거이지 인수 조건 충족의 증명이 아니다** — "그 변경이 지금 저장소와
   * 끊어지지 않았다"까지만 말한다. 파일 목록을 읽지 못하면 undefined 로 둔다: 확인하지
   * 않은 것을 확인했다고 하지 않는다.
   */
  mentionedArtifactsPresent?: boolean
  /**
   * refs 중 정본의 조상은 아니지만 **내용이 전부 정본에 반영된**(rebase·cherry-pick 등가)
   * 가지가 있는가. SHA·이슈 키가 사라져도 내용이 살아 있으면 "미구현"이 아니다.
   * 로컬에 가지가 남아 있을 때만 잴 수 있다 — 못 쟀으면 undefined.
   */
  contentEquivalent?: boolean
  /**
   * 정본 대조가 얼마나 신선한가. **관측했다 ≠ 신선하다** — 로컬만 읽은 관측은 원격이
   * 전진한 사실을 모르고, 그 위에서 "구현 증거가 없다"는 결론은 성립하지 않는다.
   *
   *   FRESH         원격을 당겨 온 뒤의 원격 추적 ref 를 봤다
   *   FETCH_FAILED  당기려 했으나 실패했다 — 관측은 낡았을 수 있다
   *   UNKNOWN       당길 대상을 몰랐다 (remote 미선언 등)
   */
  freshness?: { state: 'FRESH' | 'FETCH_FAILED' | 'UNKNOWN'; detail?: string }
  /** git 자체를 쓸 수 없었던 이유. 있으면 이 관측은 비어 있다. */
  unavailable?: string
}

export type RepoQuery = {
  /** ref 이름에서 찾을 조각. 보통 작업 항목 키. */
  refHint?: string
  canonicalRef?: string
  /**
   * canonicalRef 를 당겨 올 원격 이름 (Profile 의 canonical source 가 선언한 것).
   * 있으면 observe 가 fetch 를 시도하고 원격 추적 ref 를 대조 기준으로 삼는다.
   */
  remote?: string
  paths?: readonly string[]
  /** 범위 재료로만 확인할 자리들. 증거 칸에 섞이지 않는다. */
  modulePaths?: readonly string[]
}

export interface LocalRepoPort {
  readonly id: string
  observe(query: RepoQuery): Promise<RepoObservation>
}
