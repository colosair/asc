// Session lifecycle 오케스트레이션 — 발급부터 인수인계까지.
// Logical Session은 여러 Physical Run에 걸친다 (OM §6.2): 한 Run이 Checkpoint를 남기고
// 멈추면 다른 Run이 같은 계약을 이어받는다. 그 승계가 가능한지가 이 파일의 존재 이유다.
//
// Attach Pilot(B-11)에서 세션 기능을 처음 만들지 않도록 여기서 미리 검증한다.

import { Session, type CanonicalSnapshot, type Checkpoint, type Handoff, type SessionRole } from '../model/entities.ts'
import { transitionSession } from '../model/transitions.ts'
import { lookupAuthority, type OwnershipMap } from '../policy/ownership.ts'
import type { ResolvedPolicy, RoleName } from '../policy/policy.ts'
import { isWithinScopes, parseScope } from '../policy/scope.ts'
import type { BaselineQuery, ScmPort } from '../../ports/scm.ts'
import type { StateStore } from '../../ports/state-store.ts'
import type { RuntimeBindings } from '../operator/runtime-binding.ts'
import { applyTransition, type ApplyOutcome } from './store-ops.ts'

/** 소유하지 않은 세션에 기록하려 했다 (C-10 §2.3). */
export type NotOwner = { ok: false; reason: 'NOT_OWNER'; detail: string }
/** 전이 결과에 소유권 거부가 더해진 형태. 전이 자체의 실패 갈래는 그대로다. */
export type WriteOutcome<T> = ApplyOutcome<T> | NotOwner

export type CanonicalDrift = { sourceId: string; recorded: string; current: string }

/**
 * 정본이 움직였거나, 정본을 읽을 수 없다. 둘 다 그냥 이어갈 수 없는 이유다 (OM §9).
 *
 * 읽지 못한 것을 "달라진 게 없다"로 넘기면 검증이 있는 척만 하게 된다 — 토큰이 없거나
 * 조회가 실패한 채로 도는 세션이 가장 위험하다. 무엇을 딛고 선지 모르면 멈춘다.
 */
export type StartOutcome =
  | ApplyOutcome<Session>
  | { ok: false; reason: 'CANONICAL_DRIFT'; drifts: CanonicalDrift[] }
  | { ok: false; reason: 'CANONICAL_UNAVAILABLE'; detail: string }

/** `unknown`은 값이 아니라 "못 읽었다"는 표시다 (ports/scm.ts). */
const UNREADABLE = 'unknown'

type BaselineRead =
  | { ok: true; snapshots: CanonicalSnapshot[] }
  | { ok: false; detail: string }

export type SessionDeps = {
  /** 정본을 실제로 다시 읽는 통로. 없으면 baseline 기록·대조를 건너뛴다. */
  scm?: ScmPort
  /** Profile이 정의한 정본 갈래들 (OM §8). */
  canonicalSources?: readonly BaselineQuery[]
  /** Profile이 선언한 책임 지도 (C-04 §6). 없으면 결정권 판정이 성립하지 않는다. */
  ownership?: OwnershipMap
  /**
   * 현재 소유권 통로 (C-10 §2.3). 주면 checkpoint·handoff 쓰기에 owner 검사가 붙는다 —
   * Progress가 이미 하던 검사를 나머지 둘에도 대칭으로 건다.
   *
   * 주지 않으면 검사하지 않는다. 소유권 개념이 없는 경로(단독 사용·기존 스크립트)를
   * 이 계약이 갑자기 잠그지 않기 위해서다. **binding이 있는데 owner가 아닌 경우만 막는다.**
   */
  bindings?: RuntimeBindings
  now?: () => string
}

export type SessionSpec = {
  id: string
  role: SessionRole
  goal: string
  doneCriteria?: string[]
  blockId?: string
  taskPointer?: string
  canonicalSources?: { sourceId: string; baseline: string }[]
  readScope?: string[]
  /** Profile이 준 Role 최대 범위보다 좁아야 한다 — 넓히려 하면 발급이 실패한다. */
  writeBoundary?: string[]
  outOfScope?: string[]
  /** Controller가 이 세션에 한해 허용한 SOFT DENY 항목 (OM §5.1). */
  policyExceptions?: string[]
  /** 이 일을 끝까지 끌고 갈 주체 (C-04 §1.1). */
  owner?: string
  /** 이 일에 걸린 결정 영역. 선언하면 결정권자가 있는지 발급 전에 확인한다. */
  decisionDomains?: string[]
  /** 이번 세션에 한해 정한 결정권자 (domain → role). */
  decisionAuthority?: Record<string, string>
  /** 외부에서 받아야 할 입력. owner를 바꾸지 않는다. */
  dependencies?: string[]
}

export type IssueFailure =
  | { kind: 'INVALID_CONTRACT'; detail: string }
  | { kind: 'CANONICAL_UNAVAILABLE'; detail: string }
  | { kind: 'SCOPE_ESCALATION'; detail: string }
  | { kind: 'INVALID_SCOPE'; detail: string }
  | { kind: 'HARD_DENY_ESCAPE'; detail: string }
  /** 이 일에 필요한 결정의 주인이 정해지지 않았다 (C-04 §1.3). */
  | { kind: 'RESPONSIBILITY_AMBIGUOUS'; detail: string }
  | { kind: 'ALREADY_EXISTS'; detail: string }

export type IssueResult = { ok: true; session: Session } | { ok: false; failures: IssueFailure[] }

/**
 * 필요한 결정마다 주인이 하나로 정해지는지 본다 (C-04 §1.3).
 *
 * **결정 영역을 선언하지 않은 세션은 여기서 아무것도 걸리지 않는다.** 모든 세션이
 * cross-part 결정을 요구하지는 않으므로, owner가 비었다는 이유만으로 발급을 막지 않는다.
 * 막는 것은 "정해야 할 것이 있는데 정할 사람이 없거나 둘인" 경우뿐이다.
 *
 * 오류 문구가 다음 명령까지 말하는 이유: 무엇이 잘못됐는지만 알려 주면 처음 쓰는 사람은
 * 여기서 멈춘다. 어떻게 푸는지가 같은 화면에 있어야 한다.
 */
function responsibilityFailures(spec: SessionSpec, ownership: OwnershipMap | undefined): IssueFailure[] {
  const failures: IssueFailure[] = []
  for (const domain of spec.decisionDomains ?? []) {
    if (spec.decisionAuthority?.[domain]) continue // 이번 세션에 한해 사람이 정했다

    const found = lookupAuthority(ownership, domain)
    if (found.kind === 'RESOLVED') continue

    const how = `--authority ${domain}=<role> 로 이번 세션의 결정권자를 정하거나, Profile ownership 에 적어라`
    failures.push({
      kind: 'RESPONSIBILITY_AMBIGUOUS',
      detail:
        found.kind === 'AMBIGUOUS'
          ? `'${domain}' 의 결정권자가 갈려 있다 (${found.candidates.join(', ')}) — ${how}`
          : `'${domain}' 의 결정권자가 선언되지 않았다 — ${how}`,
    })
  }
  return failures
}

export class SessionRuntime {
  #store: StateStore
  #policy: ResolvedPolicy | null
  #scm: ScmPort | undefined
  #canonicalSources: readonly BaselineQuery[]
  #ownership: OwnershipMap | undefined
  #bindings: RuntimeBindings | undefined

  constructor(store: StateStore, policy: ResolvedPolicy | null = null, deps: SessionDeps = {}) {
    this.#store = store
    this.#policy = policy
    this.#scm = deps.scm
    this.#canonicalSources = deps.canonicalSources ?? []
    this.#ownership = deps.ownership
    this.#bindings = deps.bindings
  }

  /**
   * 이 Physical Run이 그 세션의 기록을 쓸 자격이 있는가 (C-10 §2.3 불변식 ⑤).
   *
   * 승계 후 죽지 않은 옛 Host가 계속 쓰면 기록이 오염된다. Progress는 이미 이 검사를
   * 하고 있었고 checkpoint·handoff만 열려 있었다 — 그 비대칭을 여기서 닫는다.
   */
  async #guardOwner(id: string, physicalSessionId: string | undefined): Promise<NotOwner | null> {
    if (!this.#bindings) return null
    const binding = await this.#bindings.get(id)
    // binding이 없으면 소유권 개념이 없는 세션이다 — 막지 않는다
    if (!binding) return null
    if (!physicalSessionId) {
      return {
        ok: false,
        reason: 'NOT_OWNER',
        detail: `${id} 에는 Runtime이 붙어 있다 — owner(${binding.physicalSessionId})만 기록할 수 있다`,
      }
    }
    if (binding.physicalSessionId !== physicalSessionId) {
      return {
        ok: false,
        reason: 'NOT_OWNER',
        detail: `${id} 의 owner가 아니다 (현재 owner: ${binding.physicalSessionId})`,
      }
    }
    return null
  }

  /**
   * 지금 정본이 어디에 있는지. source별로 따로 읽는다 — 하나로 뭉개지 않는다.
   *
   * Profile이 정본을 선언했는데 읽을 통로가 없으면 실패로 돌려준다. 빈 배열로 넘기면
   * 이후 대조가 아무것도 비교하지 않고 통과해, 검증이 있는 척만 하는 상태가 된다.
   */
  async #readBaselines(): Promise<BaselineRead> {
    if (this.#canonicalSources.length === 0) return { ok: true, snapshots: [] }
    if (!this.#scm) {
      const ids = this.#canonicalSources.map((s) => s.sourceId).join(', ')
      return { ok: false, detail: `정본(${ids})을 읽을 통로가 없다 — 자격 증명을 확인하라` }
    }

    const snapshots = await this.#scm.getBaselines(this.#canonicalSources)
    const unreadable = snapshots.filter((s) => s.baseline === UNREADABLE).map((s) => s.sourceId)
    if (unreadable.length > 0) return { ok: false, detail: `정본을 읽지 못했다: ${unreadable.join(', ')}` }
    return { ok: true, snapshots }
  }

  /**
   * 계약에 적힌 baseline과 지금을 견준다.
   * 세션 파일의 요약이 아니라 정본을 실제로 다시 읽는다는 것이 이 함수의 존재 이유다 (OM §9).
   */
  async #detectDrift(session: Session): Promise<
    { ok: true; drifts: CanonicalDrift[] } | { ok: false; detail: string }
  > {
    const recorded = session.canonicalSources ?? []
    if (recorded.length === 0) return { ok: true, drifts: [] }

    const current = await this.#readBaselines()
    // 기록된 baseline이 있는데 지금 읽을 수 없다면, 같은지 다른지 말할 수 없다.
    if (!current.ok) return current

    const drifts: CanonicalDrift[] = []
    for (const before of recorded) {
      const now = current.snapshots.find((c) => c.sourceId === before.sourceId)
      if (now && now.baseline !== before.baseline) {
        drifts.push({ sourceId: before.sourceId, recorded: before.baseline, current: now.baseline })
      }
    }
    return { ok: true, drifts }
  }

  /**
   * Controller가 세션 계약을 발급한다. Session Contract는 Policy hierarchy의 최하위
   * 계층이므로 상위보다 넓은 권한을 요청할 수 없다 (OM §5.2).
   * 범위를 벗어난 요청은 조용히 좁히지 않고 거절한다 — 계약서와 실권한이 어긋난 채로
   * 굴러가는 것이 더 위험하다.
   */
  async issue(spec: SessionSpec): Promise<IssueResult> {
    const failures: IssueFailure[] = []

    if (this.#policy) {
      const maxScope = this.#policy.roleScopes[spec.role as RoleName]
      for (const requested of spec.writeBoundary ?? []) {
        if (parseScope(requested) === null) {
          failures.push({ kind: 'INVALID_SCOPE', detail: `'${requested}' is not valid ASC scope grammar` })
        } else if (maxScope && !isWithinScopes(requested, maxScope)) {
          failures.push({
            kind: 'SCOPE_ESCALATION',
            detail: `${spec.role} may not write '${requested}' — outside ${maxScope.join(', ')}`,
          })
        }
      }
      // Policy Exception은 SOFT DENY 전용이다. HARD DENY를 여기 적는 것은 해제 시도다.
      for (const exception of spec.policyExceptions ?? []) {
        if (this.#policy.hardDeny.includes(exception)) {
          failures.push({
            kind: 'HARD_DENY_ESCAPE',
            detail: `'${exception}' is HARD DENY — a session contract cannot grant an exception for it`,
          })
        }
      }
    }

    failures.push(...responsibilityFailures(spec, this.#ownership))

    if (failures.length > 0) return { ok: false, failures }

    // 계약이 형식을 어기는 것도 발급 실패다. 예외로 새어 나가면 부르는 쪽마다
    // 따로 감싸야 하고, CLI에서는 스택 트레이스가 사람에게 튄다.
    // 발급 시점의 정본을 계약에 박아 둔다. 나중에 무엇을 딛고 시작했는지가 여기 남는다.
    let canonicalSources = spec.canonicalSources
    if (!canonicalSources) {
      const read = await this.#readBaselines()
      if (!read.ok) return { ok: false, failures: [{ kind: 'CANONICAL_UNAVAILABLE', detail: read.detail }] }
      canonicalSources = read.snapshots
    }
    const parsed = Session.safeParse({
      ...spec,
      ...(canonicalSources.length > 0 ? { canonicalSources } : {}),
      version: 0,
      status: 'READY',
    })
    if (!parsed.success) {
      return {
        ok: false,
        failures: parsed.error.issues.map((issue) => ({
          kind: 'INVALID_CONTRACT' as const,
          detail: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        })),
      }
    }
    const session = parsed.data
    const created = await this.#store.create('session', session)
    if (!created.ok) {
      return { ok: false, failures: [{ kind: 'ALREADY_EXISTS', detail: `session '${spec.id}' already exists` }] }
    }
    return { ok: true, session: created.entity }
  }

  get(id: string): Promise<Session | null> {
    return this.#store.get('session', id)
  }

  /**
   * Physical Run이 계약을 집어 든다. 집기 전에 정본이 그대로인지 본다 —
   * 바닥이 달라진 채로 이어가면 낡은 전제 위에서 작업하게 된다.
   */
  async start(id: string): Promise<StartOutcome> {
    const drift = await this.#guardCanonical(id)
    if (drift) return drift
    return applyTransition(this.#store, 'session', id, (s) => transitionSession(s, 'ACTIVE', 'session'))
  }

  /** Run이 끊긴다. Checkpoint 없이는 멈출 수 없다 — 다음 Run이 이어받을 수 없기 때문이다. */
  async pause(id: string, checkpoint: Checkpoint, physicalSessionId?: string): Promise<WriteOutcome<Session>> {
    const denied = await this.#guardOwner(id, physicalSessionId)
    if (denied) return denied
    return applyTransition(this.#store, 'session', id, (s) => transitionSession(s, 'PAUSED', 'session', { checkpoint }))
  }

  /** 다른 Physical Run이 같은 Logical Session을 이어받는다. 여기서도 정본부터 확인한다. */
  async resume(id: string): Promise<StartOutcome> {
    const drift = await this.#guardCanonical(id)
    if (drift) return drift
    return applyTransition(this.#store, 'session', id, (s) => transitionSession(s, 'ACTIVE', 'session'))
  }

  /**
   * 지금 정본 상태를 읽기 전용으로 판정한다 (C-03 §1.6). ACTIVE 세션을 이어갈 때도
   * 검증이 필요하지만 상태 전이는 없어야 하므로, 판정 로직을 Operator에 복제하지 않고
   * 여기서 공개한다.
   */
  async checkCanonical(
    id: string,
  ): Promise<
    | { status: 'CURRENT' }
    | { status: 'DRIFT'; drifts: CanonicalDrift[] }
    | { status: 'UNAVAILABLE'; detail: string }
    | { status: 'NOT_FOUND' }
  > {
    const session = await this.#store.get('session', id)
    if (!session) return { status: 'NOT_FOUND' }
    const detected = await this.#detectDrift(session)
    if (!detected.ok) return { status: 'UNAVAILABLE', detail: detected.detail }
    return detected.drifts.length > 0 ? { status: 'DRIFT', drifts: detected.drifts } : { status: 'CURRENT' }
  }

  async #guardCanonical(id: string): Promise<Exclude<StartOutcome, ApplyOutcome<Session>> | null> {
    const session = await this.#store.get('session', id)
    if (!session) return null // 없는 세션은 전이 단계에서 NOT_FOUND로 걸린다

    const detected = await this.#detectDrift(session)
    if (!detected.ok) return { ok: false, reason: 'CANONICAL_UNAVAILABLE', detail: detected.detail }
    return detected.drifts.length > 0 ? { ok: false, reason: 'CANONICAL_DRIFT', drifts: detected.drifts } : null
  }

  /** HARD DENY가 Goal을 막았다 — Controller 판단이 필요하다 (OM §5.3). */
  block(id: string): Promise<ApplyOutcome<Session>> {
    return applyTransition(this.#store, 'session', id, (s) => transitionSession(s, 'BLOCKED', 'session'))
  }

  /** 막힌 사유를 Controller가 해소했다. */
  unblock(id: string): Promise<ApplyOutcome<Session>> {
    return applyTransition(this.#store, 'session', id, (s) => transitionSession(s, 'ACTIVE', 'controller'))
  }

  /**
   * 세션 종료. Handoff까지가 에이전트 몫이고, state·block·queue 갱신은 Controller가
   * 회수한 뒤에 한다 (OM §7.2·§9).
   */
  async complete(id: string, handoff: Handoff, physicalSessionId?: string): Promise<WriteOutcome<Session>> {
    const denied = await this.#guardOwner(id, physicalSessionId)
    if (denied) return denied
    // 끝낸 시점의 정본을 Handoff에 남긴다. 다음 세션이 무엇을 기준으로 이어받는지가 이 값이다.
    // 여기서는 읽지 못해도 막지 않는다 — 종료를 막으면 Handoff를 남길 길이 없어져 세션이
    // 갇힌다. 대신 다음 발급·시작이 같은 이유로 멈추므로 모르는 채 이어지지는 않는다.
    let snapshot = handoff.snapshot
    if (snapshot.length === 0) {
      const read = await this.#readBaselines()
      if (read.ok) snapshot = read.snapshots
    }
    const outcome = await applyTransition(this.#store, 'session', id, (s) =>
      transitionSession(s, 'DONE', 'session', { handoff: { ...handoff, snapshot } }),
    )
    if (outcome.ok) {
      await this.#store.appendHistory({
        at: handoff.recordedAt,
        actor: id,
        kind: 'session_handoff',
        ref: id,
        detail: handoff.next,
      })
    }
    return outcome
  }

  fail(id: string, actor: 'session' | 'controller' = 'session'): Promise<ApplyOutcome<Session>> {
    return applyTransition(this.#store, 'session', id, (s) => transitionSession(s, 'FAILED', actor))
  }
}
