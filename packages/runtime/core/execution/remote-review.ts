// Remote Review — 밖으로 나가기 전에 **사실을 검수한다** (0.8.0 보정 §D·§E).
//
// 승인과 검수는 다른 일이다:
//
//   Decision Authority   이 행동을 해도 되는가          — 사람의 자리
//   Remote Review        지금 그 행동이 말이 되는가     — 사실의 자리
//
// 사람이 "게시해" 라고 말한 것은 결정권을 해결한다. 그 말이 대상 프로젝트가 맞는지,
// 승인한 SHA 가 아직 그 SHA 인지, 같은 MR 이 이미 있는지까지 확인해 주지는 않는다.
// 그것을 확인하는 것이 이 파일이고, **그래서 이것은 두 번째 승인 벽이 아니다** — 사람에게
// 다시 허락을 구하지 않고, 사실이 어긋났을 때만 멈춘다.
//
// 판정은 하나다. MANUAL 에서는 같은 판정이 조언으로 보이고, AUTO 에서는 같은 판정이
// 실행 전 관문이 된다. 두 벌을 만들면 언젠가 사람이 보는 것과 Agent 가 따르는 것이 갈린다.
//
// 이 파일은 순수하다. 원격을 읽지 않는다 — 읽은 결과를 받아 판정만 한다.

/** 검수가 본 것. provider adapter 가 읽어서 넘긴다 (mutation 0). */
export type RemoteFacts = {
  provider: string
  /** 정규화된 원격 신원 — 이 결합이 가리키는 프로젝트/저장소와 견줄 값이다. */
  resource?: string
  target?: string
  /** 이 통로가 이 행위를 할 수 있는가. */
  capability?: boolean
  /** 이 통로가 이 행위를 되돌려 읽을 수 있는가 (0.8.0 보정 P1-2). */
  verifiable?: boolean
  /**
   * 관측된 사실들. 키는 provider 가 정하고 Core 는 해석하지 않는다 — 화면과 감사에
   * 그대로 남는다. 예: `local.head`, `remote.sha`, `mr.state`, `remote.url`.
   */
  observed?: Readonly<Record<string, string | undefined>>
  /** 고를 수 없는 상태. 같은 대상이 둘 이상 후보로 보일 때 그 이유를 적는다. */
  ambiguity?: readonly string[]
  /** 읽지 못한 것. 모르는 것을 안다고 적지 않는다. */
  unknown?: readonly string[]
}

/** 승인 시점에 못 박힌 것. 실행 직전 재검수는 이 값과 지금을 견준다. */
export type ApprovedBasis = {
  /** 올리기로 한 그 commit. 가지 이름만으로는 같은 승인이 다른 내용을 내보낸다. */
  sourceSha?: string
  /** 승인 당시의 원격 상태. 그 뒤 남이 움직였는지 보는 기준선이다. */
  remoteBaseline?: string
  /** 이 결합이 가리키는 신원. target 이 여기서 벗어나면 관리 범위 밖이다. */
  resource?: string
}

export type ReviewSeverity = 'BLOCK' | 'REVIEW' | 'NOTE'

export type ReviewFinding = {
  code:
    | 'NO_CAPABILITY'
    | 'NO_VERIFY_PATH'
    | 'BINDING_MISMATCH'
    | 'DRIFT'
    | 'AMBIGUOUS'
    | 'UNKNOWN_FACT'
    | 'MISSING_TARGET'
    | 'NOTE'
  severity: ReviewSeverity
  detail: string
}

/**
 * READY           사실이 맞는다. 결정권이 이미 풀렸다면 그대로 나갈 수 있다
 * REVIEW_REQUIRED 사람이 봐야 하는 것이 있다 — 범위 밖 대상, 모호함, 읽지 못한 사실
 * NOT_EXECUTABLE  지금 이 행동은 성립하지 않는다 — 할 수 없거나, 근거가 이미 움직였다
 */
export type ReviewVerdict = 'READY' | 'REVIEW_REQUIRED' | 'NOT_EXECUTABLE'

export type ReviewOutcome = {
  verdict: ReviewVerdict
  findings: ReviewFinding[]
  /** 실행이 성공했다면 밖에서 무엇이 보여야 하는가. verify 가 이 값과 견준다. */
  expected: Record<string, string>
}

export type ReviewInput = {
  action: string
  target: string
  facts: RemoteFacts
  basis?: ApprovedBasis
  /**
   * 되돌려 읽을 수 없으면 실행하지 않는가 (0.8.0 보정 P1-2).
   *
   * 자율 실행(AUTO)에서는 참이다: 확인할 수 없는 쓰기를 자율로 내보내면 "성공했다" 를
   * 아무도 세지 않는다. 사람이 실행하는 자리(MANUAL)에서는 그 판단이 사람의 것이다.
   */
  requireVerification?: boolean
}

/**
 * 사실을 판정한다. **모르는 것을 무조건 차단으로 번역하지 않는다** (§E) — 모르는 것은
 * 사람이 볼 일이고, 성립하지 않는 것만 실행 불가다.
 */
export function reviewExternalAction(input: ReviewInput): ReviewOutcome {
  const findings: ReviewFinding[] = []
  const facts = input.facts

  if (input.requireVerification === true && facts.verifiable === false) {
    findings.push({
      code: 'NO_VERIFY_PATH',
      severity: 'BLOCK',
      detail: `${facts.provider} cannot read back '${input.action}' — it will not run unattended`,
    })
  }
  if (facts.capability === false) {
    findings.push({
      code: 'NO_CAPABILITY',
      severity: 'BLOCK',
      detail: `${facts.provider} cannot carry out '${input.action}'`,
    })
  }
  if (input.target.trim() === '') {
    findings.push({ code: 'MISSING_TARGET', severity: 'BLOCK', detail: 'the action has no target' })
  }

  // 결합 밖의 대상 — Agent 가 스스로 범위를 넓히지 않는다 (§K). 사람이 정할 일이다.
  const bound = input.basis?.resource
  if (bound && facts.resource && normalize(bound) !== normalize(facts.resource)) {
    findings.push({
      code: 'BINDING_MISMATCH',
      severity: 'REVIEW',
      detail: `this run is bound to ${bound}, and the target is ${facts.resource}`,
    })
  }

  // 승인이 못 박은 것과 지금이 다르다 — 승인은 그 SHA 에 대한 것이었다 (§L).
  const head = facts.observed?.['local.head']
  if (input.basis?.sourceSha && head && head !== input.basis.sourceSha) {
    findings.push({
      code: 'DRIFT',
      severity: 'BLOCK',
      detail: `what was approved is ${short(input.basis.sourceSha)}, and here it is now ${short(head)}`,
    })
  }
  const remote = facts.observed?.['remote.sha']
  if (input.basis?.remoteBaseline && remote && remote !== input.basis.remoteBaseline) {
    findings.push({
      code: 'DRIFT',
      severity: 'BLOCK',
      detail: `the remote moved since this was approved (${short(input.basis.remoteBaseline)} → ${short(remote)})`,
    })
  }

  for (const reason of facts.ambiguity ?? []) {
    findings.push({ code: 'AMBIGUOUS', severity: 'REVIEW', detail: reason })
  }
  for (const reason of facts.unknown ?? []) {
    findings.push({ code: 'UNKNOWN_FACT', severity: 'REVIEW', detail: `could not read: ${reason}` })
  }

  const verdict: ReviewVerdict = findings.some((finding) => finding.severity === 'BLOCK')
    ? 'NOT_EXECUTABLE'
    : findings.some((finding) => finding.severity === 'REVIEW')
      ? 'REVIEW_REQUIRED'
      : 'READY'

  return { verdict, findings, expected: expectationOf(input) }
}

/**
 * 성공했다면 밖에서 무엇이 보여야 하는가.
 *
 * 실행 전에 적어 두는 이유는 하나다: 실행 뒤에 기대치를 정하면 관측한 것이 기대치가 된다.
 */
export function expectationOf(input: {
  action: string
  target: string
  facts: RemoteFacts
  basis?: ApprovedBasis
}): Record<string, string> {
  const expected: Record<string, string> = { action: input.action, target: input.target }
  const sha = input.basis?.sourceSha ?? input.facts.observed?.['local.head']
  if (sha) expected['sha'] = sha
  if (input.facts.resource) expected['resource'] = input.facts.resource
  // provider 가 "성공했다면 이것이 보여야 한다" 고 적어 둔 것들. Core 는 그 뜻을 풀지
  // 않고 이름만 옮긴다 — 무엇을 확인할지는 그 행위를 아는 쪽이 안다.
  for (const [key, value] of Object.entries(input.facts.observed ?? {})) {
    if (key.startsWith('expect.') && value !== undefined) expected[key.slice('expect.'.length)] = value
  }
  return expected
}

/**
 * 실행 직전의 재확인 — **바뀔 수 있는 것만 본다.**
 *
 * 검수(CHECK)는 계약을 만들 때 이미 끝났다. 그때 사람이 보고 넘어간 모호함·읽지 못한
 * 사실을 실행 직전에 다시 꺼내면 그것은 두 번째 승인 벽이 된다 — 같은 질문에 두 번
 * 답하게 만드는 구조이고, 이 릴리스가 없애려는 바로 그 형태다.
 *
 * 그래서 여기서 묻는 것은 **승인 이후 실제로 움직일 수 있는 것** 셋뿐이다:
 *
 * ```text
 * 이 통로가 아직 이 행위를 할 수 있는가
 * 대상이 아직 승인된 범위 안인가
 * 못 박은 commit·기준선이 아직 그대로인가
 * ```
 *
 * 답은 둘이다: 그대로면 `null`, 아니면 실행하지 않을 이유 하나.
 */
export function revalidate(input: {
  action: string
  facts: RemoteFacts
  basis?: ApprovedBasis
}): { code: 'NO_CAPABILITY' | 'BINDING_MISMATCH' | 'DRIFT'; detail: string } | null {
  const { facts, basis } = input
  if (facts.capability === false) {
    return { code: 'NO_CAPABILITY', detail: `${facts.provider} cannot carry out '${input.action}'` }
  }
  if (basis?.resource && facts.resource && normalize(basis.resource) !== normalize(facts.resource)) {
    return {
      code: 'BINDING_MISMATCH',
      detail: `this run is bound to ${basis.resource}, and the target is ${facts.resource}`,
    }
  }
  const head = facts.observed?.['local.head']
  if (basis?.sourceSha && head && head !== basis.sourceSha) {
    return {
      code: 'DRIFT',
      detail: `what was approved is ${short(basis.sourceSha)}, and here it is now ${short(head)}`,
    }
  }
  const remote = facts.observed?.['remote.sha']
  if (basis?.remoteBaseline && remote && remote !== basis.remoteBaseline) {
    return {
      code: 'DRIFT',
      detail: `the remote moved since this was approved (${short(basis.remoteBaseline)} → ${short(remote)})`,
    }
  }
  return null
}

/** 사람이 읽는 한 줄들. 화면 형태는 MANUAL·AUTO 가 각자 정하고 판정은 같은 것을 쓴다. */
export function reviewLines(outcome: ReviewOutcome): string[] {
  const lines = [`Remote review: ${outcome.verdict}`]
  for (const finding of outcome.findings) {
    lines.push(`  [${finding.severity}] ${finding.code} — ${finding.detail}`)
  }
  return lines
}

/** 원격 신원 비교용 정규화. 대소문자·`.git`·앞뒤 슬래시만 걷어낸다. */
export function normalize(resource: string): string {
  return resource
    .trim()
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '')
}

const short = (sha: string): string => (sha.length > 10 ? sha.slice(0, 10) : sha)

/**
 * 실행 뒤의 대조. **명령이 0 으로 끝났다는 것은 성공이 아니다** (§L·§M·§N).
 *
 * 되돌려 읽은 사실이 기대치와 다르면 성공이라고 적지 않는다.
 */
export type VerifyOutcome = {
  ok: boolean
  /** 무엇을 봤는가. 감사에 그대로 남는다. */
  observed: Record<string, string | undefined>
  mismatches: string[]
}

export function verifyAgainst(
  expected: Readonly<Record<string, string>>,
  observed: Readonly<Record<string, string | undefined>>,
  keys: readonly string[],
): VerifyOutcome {
  const mismatches: string[] = []
  for (const key of keys) {
    const want = expected[key]
    const got = observed[key]
    if (want === undefined) continue
    if (got === undefined) {
      mismatches.push(`${key}: expected ${short(want)}, and it could not be read back`)
      continue
    }
    if (normalize(want) !== normalize(got)) mismatches.push(`${key}: expected ${short(want)}, read back ${short(got)}`)
  }
  return { ok: mismatches.length === 0, observed: { ...observed }, mismatches }
}
