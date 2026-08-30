#!/usr/bin/env node
// ASC CLI — Local Operator Interface의 첫 Surface.
//
// 이것은 여러 소비자 중 하나일 뿐이다 (C-01 §4). MCP·IDE 확장·Web UI가 나중에 같은
// Operator를 부르게 되며, 그때 Core는 손대지 않는다. 그래서 여기에는 명령어 해석과
// 출력만 있고 판단은 한 줄도 없다.
//
// 읽기 전용이다. 결정 제출은 사람의 명시적 의사표현을 받는 별도 경로로 나간다 (B-06).

import { execFile, spawnSync } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  MINIMUM_NODE_MAJOR,
  checkNodeRuntime,
  type NodeRuntimeCheck,
  type NodeRuntimeDeps,
} from '../core/distribution/node-runtime.ts'

import { GitHubClient, discoverToken } from '../adapters/github/client.ts'
import { GitHubChangeContext, GitHubInventory, GitHubResourceContext } from '../adapters/github/context.ts'
import { GitHubEventSource } from '../adapters/github/event-source.ts'
import { GitHubScm } from '../adapters/github/scm.ts'
import { MarkdownStateStore } from '../adapters/markdown/state-store.ts'
import { LocalIdentityBinding } from '../adapters/local/identity.ts'
import { IDENTITY_FILE } from './identity-config.ts'
import { TextRenderer } from '../adapters/text/renderer.ts'
import { ApprovalService } from '../core/approval/service.ts'
import { Executor } from '../core/execution/executor.ts'
import { GrantService } from '../core/execution/grant.ts'
import { DecisionKind } from '../core/model/entities.ts'
import { discoverProjectRoot, excludeFromGit, identitiesTemplate, overrideTemplate, writeIfAbsent } from '../core/attach/init.ts'
import { AdoptError, buildAdoptedProfile, type AdoptedProfile, type RemoteEntry } from '../core/attach/adopt.ts'
import { locatorsOf, lookupLocator, readIndex, register, writeIndex } from '../core/workspace/index-store.ts'
import { adoptionLine, judgeAdoption, migrate } from '../core/workspace/migrate.ts'
import { newWorkspaceId, normalizeRemote, recoverCandidates, recoverLines } from '../core/workspace/identity.ts'
import { resolveWorkspace, resolutionLine, type Resolution } from '../core/workspace/resolve.ts'
import { assessSetup, renderSetup, type AttachmentState, type SetupStatus } from '../core/attach/setup.ts'
import { withIdentity } from '../core/attach/init.ts'
import {
  applySetupPlan,
  computeSetupPlan,
  renderSetupPlan,
  type ApplyResult,
  type SetupState,
} from '../core/attach/setup-plan.ts'
import { CLAUDE_PROVIDER, CLAUDE_SCOPE, claudeBindings } from '../adapters/claude-code/binding.ts'
import { readHeartbeat } from '../adapters/claude-code/observer.ts'
import { workerContract, workerSettings } from '../adapters/claude-code/guard.ts'
import { applyHostReport, assessReadiness, probe, type CapabilityName } from '../adapters/claude-code/probe.ts'
import {
  defaultPaths,
  install,
  installReportLines,
  uninstall,
  verifyInstall,
  verifyInstalled,
} from '../adapters/claude-code/install.ts'
import { MonitorEngine } from '../core/monitor/engine.ts'
import { CoverageLedger, renderHealth } from '../core/monitor/coverage.ts'
import { evaluateHealth, healthAlertLines } from '../core/monitor/health-alerts.ts'
import { Operator, type WorkIngress } from '../core/operator/proceed.ts'
import { deriveSessionContractDraft } from '../core/operator/derive-draft.ts'
import { LocalRepoAdapter } from '../adapters/local/repo.ts'
import { GitHubAdapter } from '../adapters/github/adapter.ts'
import { GitLabAdapter } from '../adapters/gitlab/adapter.ts'
import { JamAdapter } from '../adapters/jam/adapter.ts'
import type { ChangeSummary } from '../ports/change-context.ts'
import type { ContextComment, ResourceSnapshot } from '../ports/resource-context.ts'
import { statusIndicatesDone } from '../adapters/jam/ports.ts'
import { ProgressService } from '../core/operator/progress.ts'
import { composeBindings, defaultAdapters } from '../composition/registry.ts'
import { buildRuntimePorts, closeToolClients, rolesFor } from '../composition/runtime.ts'
import { proposeBindings } from '../composition/propose.ts'
import { buildEventObservation } from '../composition/observe.ts'
import { availableProfiles, planBootstrap, renderPlan, type PolicyId } from '../core/attach/bootstrap.ts'
import {
  detectStableInstall,
  installStableRuntime,
  verifyStableInstall,
  type ProcessRunner,
} from '../core/distribution/runtime-install.ts'
import {
  readRuntimeSelection,
  remediationAction,
  remediationLines,
  resolveRuntimeTarget,
  runtimeSelectionLine,
  selectionPath,
  writeRuntimeSelection,
} from '../core/distribution/runtime-select.ts'
import { portableCommand, shorthandCommand } from '../core/distribution/release.ts'
import { preflight, type PreflightTarget } from '../core/operator/preflight.ts'
import {
  DraftProvenance,
  issueArgs,
  planSessionContract,
  type DraftField,
  type SessionContractDraft,
} from '../core/operator/contract-draft.ts'
import { lookupAuthority, type OwnershipMap } from '../core/policy/ownership.ts'
import { renderProgress } from '../core/operator/render.ts'
import {
  AuditLedger,
  decisionLines,
  delegationLine,
  executionLines,
  reclaimLine,
  validationLines,
  type DecisionClass,
} from '../core/runtime/audit.ts'
import { ClosureLedger } from '../core/runtime/closure.ts'
import { Orchestrator, renderTick } from '../core/runtime/orchestrator.ts'
import { QueryLedger } from '../core/runtime/query.ts'
import { ObservationLedger } from '../core/monitor/observation.ts'
import { DeliveryLedger, deliver, planDigest } from '../core/presentation/digest.ts'
import { LocalPresentation } from '../adapters/local/presentation.ts'
import { collectSessions, renderCollect } from '../core/runtime/controller.ts'
import { renderFront, restoreFront } from '../core/runtime/front.ts'
import { EscalationLedger, escalationLines } from '../core/runtime/escalation.ts'
import { deriveExecutionState, executionLine } from '../core/runtime/execution-state.ts'
import { buildFinalReport, renderFinalReport } from '../core/runtime/report.ts'
import { FreezeLedger, freezeLines, judgeAction } from '../core/policy/remote-freeze.ts'
import type { ResolvedBinding } from '../core/binding/types.ts'
import type { Adapter } from '../ports/adapter.ts'
import type { ResolvedRuntime } from '../core/resolver/load.ts'
import { SessionRuntime } from '../core/runtime/session.ts'
import { Checkpoint, Handoff, SessionRole, type Session } from '../core/model/entities.ts'
import { archiveLock, bootstrapGuard, buildLock, compareLock, loadLayers, resolveRuntime } from '../core/resolver/load.ts'
import { ProfileSourceError } from '../core/resolver/profile-source.ts'
import { renderAscMd, renderControllerMd } from '../core/resolver/render.ts'
import { ProfileLock, ProjectProfile } from '../schemas/profile.ts'
import { LocalOperator } from '../core/operator/local-operator.ts'
import { loadIdentityMap } from './identity-config.ts'

const USAGE = `asc — Agent Session Control

  asc proceed [--session <id>] [--work <WORK-ID>] [--goal <text>] [--json]

  asc inbox list   [--all] [--priority P0|P1|P2] [--json]
  asc inbox show   <REQUEST_ID> [--json]
  asc inbox trace  <REQUEST_ID> [--json]   # how it got here — an exploratory trace
  asc inbox digest [--flush] [--json]      # batched view (P0 stays separate)
  asc inbox latest [--priority P0|P1|P2] [--json]
  asc inbox decide <REQUEST_ID> <approve|revise|defer|dismiss|queue> --as <actor>
                   [--revision <text>] [--expect <version>]

  asc grant issue <REQUEST_ID> --action <key> --target <ref> --as <actor>
                  [--grant-id <id>] [--expires <iso>]
  asc grant run   <GRANT_ID> [--run-id <id>]

  asc monitor scan      [--backfill] [--as <controller>]   # fast path
  asc monitor reconcile [--as <controller>]   # recover what was missed — re-list
  asc monitor census    [--as <controller>]   # full reconcile + detect disappearances
  asc monitor status    [--json]              # how far coverage has been confirmed

  asc profile adopt   [--id <name>] [--json]  # make a profile for this repository
  asc profile resolve --profile <id> [--preset <id>] [--install <path>] [--write]

  asc runtime start [--interval-min <n>] [--delta-min <n>] [--reconcile-min <n>]
                    [--census-min <n>] [--digest-min <n>]
  asc runtime tick
  asc runtime status [--json]              # which build is in use (C-14 §4)
  asc runtime use package
  asc runtime use development <checkout>   # run a built checkout instead
  asc front [status] [--json]
  asc escalate open <S-ID> --predicate <p>... --question <t> --blocked <node>...
                           --evidence <ref>... [--blocked-scope <path>...] [--previous <ESC-ID> --why <t>]
  asc escalate list
  asc escalate resolve <ESC-ID>
  asc freeze [status]
  asc freeze on --reason <text> [--offline]
  asc freeze defer --id <id> --intent <text> [--evidence <ref>]
  asc freeze release --id <id>
  asc thaw
  asc workspace list
  asc workspace migrate [--force]
  asc init [--profile <id>] [--preset <id>] [--install <path>]
           [--scope local|project] [--workspace <W-id>]
                        # without --profile: report what was detected, then stop

  asc setup status [--json]
  asc setup identity [--role controller|monitor|both] [--actor <channel:actor>]
                        # 지금 이 사람을 승인 권한자로 세우고 재고정까지 한다
  asc setup plan   [--profile <id>] [--scope local|project] [--json]
                        # says what it would change — changes nothing
  asc setup apply  [--profile <id>] [--scope local|project] [--json]
  asc setup apply --json   # non-interactive apply. stdout is a single JSON document

  asc session plan  [--id <S-ID>] [--role <role>] [--goal <text>] [--boundary <glob>...]
                    [--criteria <text>...] [--owner <role>] [--provenance <f>=<STATUS>[:<src>]...]
                    [--json]        # is this draft issuable? changes nothing
  asc session issue <ID> --role <role> --goal <text> [--block <id>]
                         [--parent <S-ID>] [--issued-by <principal>]
  asc session pause  <S-ID> --position <t> --next <t> [--physical <id>]
                            [--judgment <t>] [--blocker <t>] [--risk <t>] [--evidence <ref>]
  asc session validate <target S-ID> --validator <validator S-ID> --result PASS|FAIL [--finding <t>]
  asc session audit  <S-ID>
  asc session report <S-ID> [--json]
  asc session decision <S-ID> --class <c> --selected <t> --why <t>... --evidence <ref>...
                              [--alternative <t>...] [--ownership <scope>...] [--verification <t>...]
                        [--boundary <glob>...] [--exception <item>...]
                        [--criteria <text>...] [--owner <role>]
                        [--domain <decision-domain>...] [--authority <domain>=<role>...]
                        [--dependency <text>...]
  asc session start  <ID>
  asc session pause  <ID> --position <text> --next <text> [--done <task>...]
  asc session resume <ID>
  asc session done   <ID> --verified <text> --next <text> [--done <task>...]
                        [--changed <path>...] [--unresolved <text>...]
  asc session list

  asc controller collect

  asc closure list    [<S-ID>]
  asc closure confirm <S-ID> --item <id>...

  asc preflight --path <p>... (--role <r> | --session <S-ID>) [--json]

  asc query open   <X-ID> --session <S-ID> --domain <decision-domain>
                        --question <text> [--context <text>] [--default <text>]
                        [--blocking <text>] [--expect-response DECIDE|ANSWER]
                        [--in-reply-to <X-ID>]
  asc query answer <X-ID> --kind DECIDE|ANSWER|ESCALATE --by <role> --body <text>
                        [--to <authority>]
  asc query list   [--json]

  asc progress show   [<S-ID>]
  asc progress report <S-ID> --physical <id> --phase <text>
                      [--milestone <text>...] [--next <text>] [--unresolved <text>...]
                      [--decision none|later|now] [--decision-ref <text>]
                      [--verifier none|running|pass|fail] [--verifier-detail <text>] [--terminal]

  asc host claude install [--force]     # --force: overwrite ASC files a person has edited
  asc host claude uninstall|probe [--report <cap>=<bool>...]
  asc host claude guard
  asc host claude bind <S-ID> --physical <id> [--principal <p>] [--worker <id>] [--kind <k>] [--force]
  asc host claude release <S-ID> --physical <id>
  asc host claude contract <S-ID>

Options
  --root <path>   runtime directory (otherwise: registered workspace, then repo-local .asc)
  --json          machine-readable output
  --as <actor>    who is deciding. Must be mapped as an approver
  --revision      what was changed, when approving with revisions
  --expect        the version you read. Rejected if it changed since
  --action        action key to emit (e.g. github.issue_comment.create)
  --target        target reference (e.g. owner/repo#19)
  --backfill      sweep history on the first run (default: from now on)
  --profile       Project Profile id
  --preset        Operational Preset id
  --install       ASC installation path (default: where this CLI lives)
  --write         actually write the artefacts (default: preview)
  --role          planner|researcher|implementer|verifier
  --goal          the single goal of this session
  --work          work item to investigate before proposing a contract (asc proceed)
  --actor         who you are, as <channel>:<actor> (asc setup identity)
  --boundary      write scope (must be narrower than the Profile's)
  --exception     SOFT DENY item allowed for this session only
  --criteria      a verifiable done-criterion (repeatable)
  --path          output path to check (preflight, repeatable)
  --item          confirmed closure item id (closure confirm, repeatable)
  --phase         one line on what is happening right now (progress report)
  --milestone     a meaningfully finished chunk (repeatable)
  --decision      does a person need to decide: none|later|now
  --verifier      independent verification state: none|running|pass|fail
  --terminal      final report — stays as the closing screen after collect

decide assumes a person is operating it, and only checks that the name given with --as
is registered as an approver. Approval is not permission to publish: anything reaching an
external system goes out through a separate Execution Grant.`

/**
 * 지금 여기가 어느 ASC runtime인가. **모든 명령이 같은 문을 지난다** (C-11 §3, B-45).
 *
 * 예전에는 이 판단이 네 군데에 흩어져 있었고 `--root` 가 host 명령에만 안 먹었다.
 * 이제 한 곳이라 그런 비대칭이 생기지 않는다.
 */
async function discoverRoot(start: string, explicitRoot?: string): Promise<string | null> {
  const resolution = await resolveRoot(start, explicitRoot)
  return resolution.kind === 'UNRESOLVED' ? null : resolution.root
}

async function resolveRoot(start: string, explicitRoot?: string): Promise<Resolution> {
  return resolveWorkspace({
    cwd: start,
    ...(explicitRoot ? { explicitRoot } : {}),
    index: await readIndex(ascHome()),
    // 홈의 `~/.asc` 는 user runtime이지 프로젝트 상태가 아니다 — 그 위로 올라가지 않는다
    stopAt: homedir(),
  })
}

const execFileAsync = promisify(execFile)

/**
 * 이 binding이 가리키는 주소. 자체 호스팅은 발견 단계가 이미 알아냈으므로 같은 값을 쓴다 —
 * 여기서 다시 추측하면 두 곳이 다른 주소를 말하게 된다.
 */
function endpointOf(adapters: readonly Adapter[], binding: ResolvedBinding): string | undefined {
  for (const adapter of adapters) {
    const withEndpoint = adapter as Adapter & { endpointFor?: (resource: string) => string | undefined }
    if (adapter.describe().id !== binding.adapterId) continue
    return withEndpoint.endpointFor?.(binding.resource)
  }
  return undefined
}

/** 관측 기록이 사는 자리. source id가 정한다 — provider 이름을 여기 박지 않는다. */
const monitorScope = (sourceId: string): string => `monitor:${sourceId}`

/**
 * 묶음 전달. 사람이 `asc inbox digest` 로 부르든 상시 Runtime이 부르든 같은 함수다 —
 * 경로마다 다르게 묶으면 "언제 보낸 것이냐"에 따라 내용이 달라진다 (C-12 불변식 ②).
 */
/** 감시 상태 임계값. Core 상수가 아니다 (C-12 불변식 ⑭) — 여기서 정해 넣는다. */
const HEALTH_THRESHOLDS = { hotPathMs: 6 * 60 * 60_000, reconcileMs: 24 * 60 * 60_000, censusMs: 7 * 24 * 60 * 60_000 }

async function deliverDigest(store: MarkdownStateStore, flush: boolean): Promise<number> {
  const channel = new LocalPresentation()
  const ledger = new DeliveryLedger(store.scope('presentation'))
  const scope = await activeMonitorScope(store)
  const shadow = await new ObservationLedger(store.scope(scope)).shadowed()
  const operator = new LocalOperator({ store })
  const at = new Date().toISOString()

  // 목록이 조용한 이유가 조용해서인지 못 봐서인지 함께 판정한다 (C-12 §3)
  const health = evaluateHealth(await new CoverageLedger(store.scope(scope)).health(), at, HEALTH_THRESHOLDS)

  const plan = planDigest({
    at,
    pending: await operator.list({}),
    shadowCount: shadow.length,
    health,
    // --flush 면 이미 보낸 것도 다시 묶는다. 기본은 안 보낸 것만.
    ...(flush ? {} : { delivered: await ledger.delivered(channel.id) }),
  })

  // 채널 Port는 batch만 받는다 — 감시 경고는 계획을 만든 쪽이 안다. 여기서 함께 보인다.
  for (const line of healthAlertLines(plan.health)) console.error(line)
  const report = await deliver(plan, channel, ledger)
  for (const line of report.degraded) console.error(`  (${line})`)
  return 0
}

const ACTIVE_SOURCE_KEY = 'active-source'

/**
 * 지금 붙어 있는 감시 통로가 무엇인지 남긴다.
 *
 * digest처럼 조립을 하지 않는 명령도 같은 자리를 읽어야 하는데, 그걸 알아내려고 discovery와
 * probe를 다시 돌리면 화면 하나 그리자고 외부를 친다. 그래서 monitor가 돌 때 적어 둔다.
 */
async function rememberMonitorSource(store: MarkdownStateStore, sourceId: string): Promise<void> {
  await store.scope('monitor').set(ACTIVE_SOURCE_KEY, sourceId)
}

/**
 * 마지막으로 붙었던 통로의 scope. 기록이 없으면 예전 이름으로 본다 —
 * 이전 설치의 shadow 기록이 이름이 바뀌었다는 이유로 사라진 것처럼 보이면 안 된다.
 */
async function activeMonitorScope(store: MarkdownStateStore): Promise<string> {
  const sourceId = await store.scope('monitor').get(ACTIVE_SOURCE_KEY)
  return monitorScope(sourceId ?? 'github-poll')
}

/** user-owned ASC home. */
const ascHome = (): string => process.env.ASC_HOME ?? join(homedir(), '.asc')

const DECISION_ERROR: Record<string, string> = {
  NOT_FOUND: '요청을 찾지 못했다.',
  FORBIDDEN_ACTOR:
    '승인 권한자가 아니다. .asc/identities.json 에 `"이름": ["local:계정"]` 형태로 매핑을 추가하라 ' +
    '(현재 상태는 `asc setup status`).',
  NOT_ALLOWED_DECISION: '이 요청이 허용하지 않는 결정이다.',
  EXPIRED: '만료된 요청이다.',
  ALREADY_DECIDED: '이미 결정된 요청이다.',
  STALE: '읽은 뒤 요청이 바뀌었다. 다시 확인하고 결정하라.',
}

/**
 * 어느 문으로 들어왔는가 (C-14 §3.4).
 *
 * **`bootstrap` 만 stable runtime 설치를 계획한다.** 설치된 runtime이 스스로를 다시
 * 설치하는 것은 말이 안 되고, 그것을 계획에 넣으면 매 setup이 npm을 부른다.
 */
export type AscEntry = 'runtime' | 'bootstrap'

/**
 * bootstrap이 자기 USAGE에 적을 값. **거기서 손으로 적지 않게 하려고 내보낸다** —
 * 두 패키지가 각자 버전 문자열을 들면 릴리스마다 한쪽이 뒤처지고, 그 지연은 곧
 * 사용자가 실행하는 명령이 된다 (0.2.0 회차의 skill.ts가 그랬다).
 */
export { BOOTSTRAP_SPEC } from '../core/distribution/release.ts'

/**
 * CLI 한 번의 실행. **다른 진입도 이 함수를 부른다** (C-14 불변식 ①).
 *
 * bootstrap 패키지는 아직 아무것도 설치되지 않은 machine에서 이것을 그대로 부른다 —
 * 진입이 둘이어도 판단은 하나다. 그래서 export이고, 그래서 아래 자동 실행은 이 파일이
 * 진짜 진입점일 때만 돈다.
 */
/**
 * 설정을 읽다 실패한 것을 **사람이 읽을 문장**으로 바꾼다.
 *
 * 여기가 없으면 Profile 하나가 잘못됐을 때 사용자가 보는 것은 Node의 stack dump다 —
 * 내부 파일 이름과 프레임이 줄줄이 나오고, 정작 "무엇을 고쳐야 하는지"는 없다.
 * 독립 검증이 다섯 갈래(충돌·깨진 JSON·디렉터리가 아닌 것·EISDIR·긴 id)에서 같은 모양을
 * 관측했다. 예상 못 한 오류는 그대로 던진다 — 삼키면 그게 더 나쁘다.
 */
function explainConfigError(error: unknown): string | null {
  if (error instanceof ProfileSourceError) return error.message
  const failure = error as NodeJS.ErrnoException
  const path = failure?.path ? ` (${failure.path})` : ''
  switch (failure?.code) {
    case 'ENOENT':
      return `That profile is not there${path}. \`asc setup status\` lists what is.`
    case 'EISDIR':
      return `A profile has to be a file, and that is a directory${path}.`
    case 'EACCES':
    case 'EPERM':
      return `No permission to read that profile${path}.`
    default:
      break
  }
  if (error instanceof SyntaxError) return `That profile is not valid JSON — ${error.message}`
  return null
}

/** 실제 파일시스템·프로세스를 물린다. Core는 이 중 아무것도 직접 하지 않는다. */
function nodeRuntimeDeps(): NodeRuntimeDeps {
  return {
    version: process.version,
    exists: (path) => existsSync(path),
    list: (path) => {
      try {
        return readdirSync(path)
      } catch {
        // 없는 디렉터리는 "후보 없음"이다. 이 machine에 그 배치가 없을 뿐이다.
        return []
      }
    },
    run: nodeProcessRunner,
    home: homedir(),
    join,
  }
}

/**
 * 못 돌린다는 사실과, 이 machine에서 실제로 쓸 수 있는 것을 함께 준다.
 *
 * 후보가 있으면 **같은 canonical 명령을 그 Node로 돌리는 형태**를 낸다 — 이것은 per-invocation
 * 환경변수이지 PATH·profile 수정이 아니다 (불변식 ⑰). 이 형태마저 host가 실행을 거부하면
 * 그때는 ASC의 문제가 아니라 host 경계이며, AGENTS.md가 그 자리를 정의한다.
 */
function reportNodeRuntime(check: Extract<NodeRuntimeCheck, { ok: false }>, asJson: boolean): void {
  const actions = check.candidates.map((candidate) => ({
    type: 'use_node_runtime' as const,
    display: `PATH="${dirname(candidate.path)}:$PATH" ${shorthandCommand(['setup', 'apply', '--json'])}`,
    portable: `PATH="${dirname(candidate.path)}:$PATH" ${portableCommand(['setup', 'apply', '--json'])}`,
    node: candidate,
  }))
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          code: check.code,
          detail: check.detail,
          runtime: { node: process.execPath, version: check.version, required: `>=${MINIMUM_NODE_MAJOR}` },
          candidates: check.candidates,
          nextActions: actions.map((action) => action.portable),
          actions,
        },
        null,
        2,
      ),
    )
    return
  }
  console.error(check.detail)
  for (const action of actions) console.error(`  ${action.node.version} at ${action.node.path}\n    ${action.display}`)
}

export async function runAscCommand(argv: string[], entry: AscEntry = 'runtime'): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string' },
  parent: { type: 'string' },
  'issued-by': { type: 'string' },
  principal: { type: 'string' },
  judgment: { type: 'string' },
  scope: { type: 'string' },
  reason: { type: 'string' },
  predicate: { type: 'string', multiple: true },
  blocked: { type: 'string', multiple: true },
  'blocked-scope': { type: 'string', multiple: true },
  affected: { type: 'string', multiple: true },
  previous: { type: 'string' },
  selected: { type: 'string' },
  class: { type: 'string' },
  alternative: { type: 'string', multiple: true },
  ownership: { type: 'string', multiple: true },
  verification: { type: 'string', multiple: true },
  why: { type: 'string', multiple: true },
  /** 초안의 출처 — `<field>=<FACT|PROPOSAL|DECISION_REQUIRED>[:<source>]` (session plan). */
  provenance: { type: 'string', multiple: true },
  offline: { type: 'boolean', default: false },
  id: { type: 'string' },
  intent: { type: 'string' },
  grant: { type: 'string' },
  'interval-min': { type: 'string' },
  'delta-min': { type: 'string' },
  'reconcile-min': { type: 'string' },
  'census-min': { type: 'string' },
  'digest-min': { type: 'string' },
  workspace: { type: 'string' },
  validator: { type: 'string' },
  result: { type: 'string' },
  finding: { type: 'string', multiple: true },
  blocker: { type: 'string', multiple: true },
  risk: { type: 'string', multiple: true },
  evidence: { type: 'string', multiple: true },
      json: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      priority: { type: 'string' },
      as: { type: 'string' },
      action: { type: 'string' },
      target: { type: 'string' },
      'grant-id': { type: 'string' },
      profile: { type: 'string' },
      preset: { type: 'string' },
      install: { type: 'string' },
      write: { type: 'boolean', default: false },
      backfill: { type: 'boolean', default: false },
      role: { type: 'string' },
      goal: { type: 'string' },
      block: { type: 'string' },
      boundary: { type: 'string', multiple: true },
      exception: { type: 'string', multiple: true },
      criteria: { type: 'string', multiple: true },
      owner: { type: 'string' },
      domain: { type: 'string', multiple: true },
      authority: { type: 'string', multiple: true },
      dependency: { type: 'string', multiple: true },
      question: { type: 'string' },
      context: { type: 'string' },
      default: { type: 'string' },
      blocking: { type: 'string' },
      'expect-response': { type: 'string' },
      'in-reply-to': { type: 'string' },
      by: { type: 'string' },
      body: { type: 'string' },
      to: { type: 'string' },
      session: { type: 'string' },
      work: { type: 'string' },
      actor: { type: 'string' },
      position: { type: 'string' },
      next: { type: 'string' },
      done: { type: 'string', multiple: true },
      changed: { type: 'string', multiple: true },
      verified: { type: 'string' },
      unresolved: { type: 'string', multiple: true },
      'run-id': { type: 'string' },
      physical: { type: 'string' },
      worker: { type: 'string' },
      kind: { type: 'string' },
      force: { type: 'boolean', default: false },
      agent: { type: 'boolean', default: false },
      report: { type: 'string', multiple: true },
      flush: { type: 'boolean', default: false },
      path: { type: 'string', multiple: true },
      item: { type: 'string', multiple: true },
      phase: { type: 'string' },
      milestone: { type: 'string', multiple: true },
      decision: { type: 'string' },
      'decision-ref': { type: 'string' },
      verifier: { type: 'string' },
      'verifier-detail': { type: 'string' },
      terminal: { type: 'boolean', default: false },
      expires: { type: 'string' },
      revision: { type: 'string' },
      expect: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  const [group, command, target, extra] = positionals
  if (values.help || group === undefined) {
    console.log(USAGE)
    return 0
  }

  // **지원 하한을 먼저 답한다** (C-14 §3). `engines` 는 npm에게 하는 말이라 기본값에서
  // 경고로만 나가고, 그러면 "경고 뒤에 그래도 돌아감"이 된다 — 사용자는 자기가 지원
  // 범위 안인지 끝내 모른다. 여기서 한 번, 결정적으로 답한다.
  //
  // 이 자리인 이유: 설치된 `asc` 와 bootstrap이 **같은 문으로 들어온다**. bootstrap에
  // 두면 그쪽에 정책이 생기고(C-14 불변식 ⑦), 그러면 두 진입의 답이 갈릴 수 있다.
  const runnable = await checkNodeRuntime(nodeRuntimeDeps())
  if (!runnable.ok) {
    reportNodeRuntime(runnable, Boolean(values.json) || Boolean(values.agent))
    return 1
  }

  // 선택된 build로 넘길 것이 있으면 여기서 넘긴다. **선택 자체를 다루는 명령은 넘기지
  // 않는다** — 잘못 가리키는 선택을 고치거나 들여다보는 명령이 그 선택 때문에 못 돌면
  // 사람이 갇힌다.
  if (!(group === 'runtime' && (command === 'use' || command === 'status'))) {
    const redispatched = await redispatchIfNeeded(argv)
    if (redispatched !== null) return redispatched
  }
  if (group === 'init') return runInit(values)

  if (group === 'workspace') return runWorkspace(command, values)

  // 어느 build를 쓸지는 **프로젝트와 무관하다** — 붙기 전에도 답해야 한다 (C-14 §5).
  if (group === 'runtime' && (command === 'use' || command === 'status')) {
    return runRuntimeSelect(command, positionals[2], positionals[3], values)
  }

  if (group === 'host') return runHost(command, positionals[2], positionals[3], values)

  // setup은 **붙기 전에도** 답을 줘야 한다. 아래 discoverRoot 실패는 exit 2로 끊는데,
  // 그러면 "아직 안 붙었다"를 확인하려고 부른 명령이 안 붙었다는 이유로 죽는다.
  if (group === 'setup') return runSetup(command, values, entry)

  // adopt는 **붙기 전의 명령이다.** 붙을 Profile을 만드는 것이 일이므로 attach를 요구하면
  // 순서가 뒤집힌다. 나머지 profile 명령은 아래 attach 경로에 그대로 남는다.
  if (group === 'profile' && command === 'adopt') return runProfileAdopt(values, entry)

  if (!['inbox', 'grant', 'monitor', 'runtime', 'front', 'freeze', 'thaw', 'escalate', 'profile', 'session', 'controller', 'proceed', 'progress', 'preflight', 'closure', 'query'].includes(group)) {
    console.error(`Unknown command: ${group}\n\n${USAGE}`)
    return 2
  }

  const root = await discoverRoot(process.cwd(), values.root as string | undefined)
  if (!root) {
    console.error('No attached ASC runtime found. Attach with `asc init`, or point at one with --root.')
    return 2
  }

  const store = new MarkdownStateStore(root)
  const operator = new LocalOperator({ store })
  const renderer = new TextRenderer()
  const priority = values.priority as 'P0' | 'P1' | 'P2' | undefined

  if (group === 'profile') return runProfile(command, values, root)

  // attach된 프로젝트라면 Run을 시작하기 전에 지금 설정이 lock과 같은지 본다 (OM §4.9)
  const guard = await checkBootstrap(root)
  if (guard.code !== 0) return guard.code

  if (group === 'proceed') return runProceed(values, store, root, guard.runtime)
  if (group === 'session') return runSession(command, target, values, store, guard.runtime)
  if (group === 'controller') return runController(command, values, store, guard.runtime)
  if (group === 'closure') return runClosure(command, target, values, store)
  if (group === 'query') return runQuery(command, target, values, store, guard.runtime)
  if (group === 'progress') return runProgress(command, target, values, store)
  if (group === 'preflight') return runPreflight(values, store, guard.runtime)
  if (group === 'grant') return runGrant(command, target, values, store, root)
  if (group === 'monitor') return runMonitor(command, values, store, renderer, guard.runtime)

  if (group === 'runtime') return runRuntime(command, values, store, renderer, guard.runtime)

  // 새 대화가 붙었을 때 지금 상태를 되찾는다 (C-12 §4). 읽기만 한다.
  if (group === 'front') return runFront(command, values, store, root)

  // 사람에게 올릴 자격이 있는가 (C-13). 자격 없으면 request가 만들어지지 않는다.
  if (group === 'escalate') return runEscalate(command, target, values, store, guard.runtime)

  // 원격을 얼린다·녹인다. 로컬 작업은 얼리지 않는다 (지시 §27).
  if (group === 'freeze' || group === 'thaw') return runFreeze(group, command, values, store)

  switch (command) {
    case 'list': {
      const items = await operator.list({ all: values.all, ...(priority ? { priority } : {}) })
      console.log(values.json ? JSON.stringify(items, null, 2) : renderer.renderList(items).text)
      return 0
    }

    case 'show': {
      if (!target) {
        console.error('A request id is required: asc inbox show REQ-0042')
        return 2
      }
      const outcome = await operator.get(target)
      if (!outcome.ok) {
        console.error(`${target} was not found.`)
        return 1
      }
      console.log(
        values.json ? JSON.stringify(outcome.view, null, 2) : renderer.renderDecision(outcome.view, 'full').text,
      )
      return 0
    }

    // 감지와 방해를 나눈다 (C-08). 여기서 새 request가 생기지 않는다 — 같은 요청의
    // 또 하나의 표현일 뿐이다.
    case 'digest': {
      if (values.json) {
        const channel = new LocalPresentation()
        const ledger = new DeliveryLedger(store.scope('presentation'))
        const shadow = await new ObservationLedger(store.scope(await activeMonitorScope(store))).shadowed()
        console.log(
          JSON.stringify(
            planDigest({
              at: new Date().toISOString(),
              pending: await operator.list({}),
              shadowCount: shadow.length,
              ...(values.flush ? {} : { delivered: await ledger.delivered(channel.id) }),
            }),
            null,
            2,
          ),
        )
        return 0
      }
      return deliverDigest(store, Boolean(values.flush))
    }

    // 탐색 수준의 가장 깊은 단계 (C-05 §3.2). 전역 mode가 아니라 이 호출 하나의 예산이다.
    case 'trace': {
      if (!target) {
        console.error('A request id is required: asc inbox trace REQ-0042')
        return 2
      }
      const entries = await operator.trace(target)
      if (values.json) {
        console.log(JSON.stringify(entries, null, 2))
        return 0
      }
      if (entries.length === 0) {
        console.log(`${target} has no history.`)
        return 0
      }
      console.log(`How ${target} came to be in this state:`)
      for (const entry of entries) console.log(`  ${entry.at}  ${entry.actor}  ${entry.kind}  ${entry.detail}`)
      return 0
    }

    case 'latest': {
      const outcome = await operator.resolveLatest({ ...(priority ? { priority } : {}) })
      if (outcome.kind === 'none') {
        console.log('No pending requests')
        return 0
      }
      if (outcome.kind === 'ambiguous') {
        // 하나를 골라주지 않는다 — 잘못 고른 요청을 승인 화면까지 끌고 가는 것보다 한 번 더 묻는 게 싸다
        console.log(`There are ${outcome.candidates.length} pending requests. Name the one you mean.\n`)
        console.log(renderer.renderList(outcome.candidates).text)
        return values.json ? 0 : 1
      }
      console.log(
        values.json ? JSON.stringify(outcome.view, null, 2) : renderer.renderDecision(outcome.view, 'full').text,
      )
      return 0
    }

    case 'decide': {
      if (!target || !extra) {
        console.error('Usage: asc inbox decide REQ-0042 approve --as <actor>')
        return 2
      }
      const kind = DecisionKind.safeParse(extra)
      if (!kind.success) {
        console.error(`Unknown decision: ${extra} (approve|revise|defer|dismiss|queue)`)
        return 2
      }
      // 결정한 사람의 이름을 직접 받는다. 기본값을 두면 기록에 누가 정했는지가 흐려진다.
      if (!values.as) {
        console.error('--as <actor> is required. Who decided is part of the record.')
        return 2
      }

      const current = await operator.get(target)
      if (!current.ok) {
        console.error(`${target} was not found.`)
        return 1
      }
      // --expect 를 주지 않으면 방금 읽은 version을 쓴다. 그 사이 다른 채널이 결정했다면 거절된다.
      const expectedVersion = values.expect ? Number(values.expect) : current.view.version

      const approval = new ApprovalService({ store, identity: new LocalIdentityBinding(await loadIdentityMap(root)) })
      const outcome = await approval.submit({
        requestId: target,
        expectedVersion,
        kind: kind.data,
        actor: values.as,
        channel: 'local',
        ...(values.revision !== undefined ? { revision: values.revision } : {}),
        decidedAt: new Date().toISOString(),
      })

      if (outcome.ok) {
        console.log(renderer.renderDecision(outcome.view, 'summary').text)
        console.log('\nApproval is not permission to publish — anything external goes out through an Execution Grant.')
        return 0
      }
      console.error(DECISION_ERROR[outcome.reason])
      if ('view' in outcome) console.error('\n' + renderer.renderDecision(outcome.view, 'summary').text)
      return 1
    }

    default:
      console.error(`Unknown inbox command: ${command ?? '(none)'}\n\n${USAGE}`)
      return 2
  }
}

/**
 * 프로젝트에 Runtime을 붙인다.
 *
 * **기본은 local scope다** (C-11 §0·§2). 채택하지 않은 저장소에는 아무것도 만들지 않고
 * runtime을 사용자 소유 공간(`ASC_HOME`, 기본 `~/.asc`)에 둔다. 저장소 안에 두는 것은
 * 팀이 그렇게 하기로 정했을 때뿐이며, 그 결정은 `--scope project` 로만 표현된다 —
 * 자동 발견의 결과로 승격되지 않는다 (C-11 불변식 ⑤).
 */
/**
 * user-owned runtime을 만들고 이 checkout을 역색인에 등록한다.
 *
 * workspace id는 새로 만들되, 이미 알아볼 수 있는 후보가 있으면 **고르지 않고 알린다** —
 * alias 일치는 recover candidate이지 동일성 증명이 아니다 (C-11 불변식 ③).
 */
async function attachLocalWorkspace(
  projectRoot: string,
  git: boolean,
  declaredWorkspace?: string,
): Promise<string | null> {
  const home = ascHome()
  const index = await readIndex(home)

  const existing = lookupLocator(index, projectRoot)
  if (existing && !declaredWorkspace) {
    console.log(`Already registered workspace: ${existing.workspaceId}`)
    return existing.root
  }

  const remotes = git ? await gitRemotes(projectRoot) : []
  const aliases = remoteAliases(remotes)

  // 사람이 "이건 그 프로젝트다"라고 말한 경우 — 이어붙인다. 추론이 아니라 선언이다.
  if (declaredWorkspace) {
    const known = index.workspaces[declaredWorkspace]
    if (!known) {
      console.error(`${declaredWorkspace} is unknown — it is not a registered workspace.`)
      return null
    }
    const root = join(home, 'workspaces', known.workspaceId)
    await writeIndex(
      home,
      register(index, {
        workspaceId: known.workspaceId,
        root,
        locator: { path: projectRoot, platform: process.platform, observedAt: new Date().toISOString() },
        aliases,
        now: new Date().toISOString(),
      }),
    )
    console.log(`Registered this location under workspace ${known.workspaceId} — runtime lives at ${root}`)
    return root
  }

  const hits = recoverCandidates(Object.values(index.workspaces), aliases)
  if (hits.length > 0) {
    // 붙일지는 사람이 정한다. 여기서 이어붙이면 남의 workspace를 조용히 가져올 수 있다.
    for (const line of recoverLines(hits)) console.log(line)
    console.log(
      `같은 프로젝트라면: asc init --profile <id> --workspace ${hits[0]!.workspace.workspaceId}` +
        (hits.length > 1 ? ' (후보 중 하나를 골라라)' : ''),
    )
  }

  const workspaceId = newWorkspaceId()
  const root = join(home, 'workspaces', workspaceId)
  await writeIndex(
    home,
    register(index, {
      workspaceId,
      root,
      locator: { path: projectRoot, platform: process.platform, observedAt: new Date().toISOString() },
      aliases,
      adoptionScope: 'local',
      now: new Date().toISOString(),
    }),
  )
  console.log(`workspace ${workspaceId} — runtime lives at ${root} (nothing is created in the repository)`)
  if (aliases.length > 0) console.log(`Recognisable as: ${aliases.join(', ')}`)
  return root
}

/**
 * 모든 remote를 evidence로 모은다. origin을 primary로 단정하지 않는다 (C-11 불변식 ④).
 *
 * 이름을 함께 든다 — identity alias는 이름이 필요 없지만, `profile adopt` 는 어느 remote가
 * 이 프로젝트를 대표하는지 골라야 하고 `git remote -v` 의 출력 순서는 알파벳순이라
 * "첫 줄이 origin"이 아니다.
 */
async function gitRemotes(projectRoot: string): Promise<RemoteEntry[]> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectRoot, 'remote', '-v'])
    const seen = new Map<string, RemoteEntry>()
    for (const line of stdout.split(/\r?\n/)) {
      const [name, url] = line.split(/\s+/)
      if (!name || !url || seen.has(`${name} ${url}`)) continue
      seen.set(`${name} ${url}`, { name, url })
    }
    return [...seen.values()]
  } catch {
    return []
  }
}

/** identity alias는 이름을 쓰지 않는다 — URL만 정규화한다. */
const remoteAliases = (remotes: readonly RemoteEntry[]): string[] =>
  [...new Set(remotes.map((remote) => remote.url))]
    .map(normalizeRemote)
    .filter((alias): alias is string => alias !== null)

/**
 * 저장소 안에 있던 `.asc/` 를 사용자 소유 공간으로 옮긴다 (C-11 §6).
 *
 * 판정을 먼저 하고, 모르면 옮기지 않는다. 원본은 지우지 않는다 — 확인은 사람이 한다.
 */
async function runWorkspace(command: string | undefined, values: Record<string, unknown>): Promise<number> {
  if (command !== 'migrate' && command !== 'list') {
    console.error(`Unknown workspace command: ${command ?? '(none)'}

${USAGE}`)
    return 2
  }

  const home = ascHome()
  const index = await readIndex(home)

  if (command === 'list') {
    const workspaces = Object.values(index.workspaces)
    if (workspaces.length === 0) {
      console.log('No registered workspaces')
      return 0
    }
    for (const workspace of workspaces) {
      console.log(`${workspace.workspaceId} [${workspace.adoptionScope}] ${workspace.aliases.join(', ') || '(no alias)'}`)
      for (const locator of locatorsOf(index, workspace.workspaceId)) {
        console.log(`  ${locator.locator}${locator.kind ? ` (${locator.kind})` : ''}`)
      }
    }
    return 0
  }

  const { root: projectRoot, git } = await discoverProjectRoot(process.cwd())
  const legacy = join(projectRoot, '.asc')
  if (!(await pathExists(legacy))) {
    console.log(`No .asc inside ${projectRoot} — nothing to move.`)
    return 0
  }

  const adoption = judgeAdoption({
    projectRoot,
    trackedAscPaths: git ? await trackedUnder(projectRoot, '.asc') : [],
    excludeContent: await readFile(join(projectRoot, '.git', 'info', 'exclude'), 'utf8').catch(() => ''),
    gitignoreContent: await readFile(join(projectRoot, '.gitignore'), 'utf8').catch(() => ''),
  })
  console.log(adoptionLine(adoption))

  const existing = lookupLocator(index, projectRoot)
  const workspaceId = existing?.workspaceId ?? newWorkspaceId()
  const target = existing?.root ?? join(home, 'workspaces', workspaceId)

  const outcome = await migrate({ from: legacy, to: target, adoption, force: Boolean(values.force) })
  if (!outcome.ok) {
    console.error(outcome.detail)
    return outcome.reason === 'PROJECT_ADOPTED' ? 0 : 1
  }

  const remotes = git ? await gitRemotes(projectRoot) : []
  await writeIndex(
    home,
    register(index, {
      workspaceId,
      root: target,
      locator: { path: projectRoot, platform: process.platform, observedAt: new Date().toISOString() },
      aliases: remoteAliases(remotes),
      now: new Date().toISOString(),
    }),
  )
  console.log(`Copied and verified ${outcome.plan.entries} entries into ${target} (workspace ${workspaceId}).`)
  console.log('The original was left in place — check it, then remove it yourself:')
  console.log(`  rm -rf ${legacy}`)
  return 0
}

/** Git이 추적하는 경로 중 이 접두어 아래인 것. 하나라도 있으면 팀의 것이다. */
async function trackedUnder(projectRoot: string, prefix: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectRoot, 'ls-files', prefix])
    return stdout.split(/\r?\n/).filter(Boolean)
  } catch {
    return []
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path).catch(async () => {
      const { readdir } = await import('node:fs/promises')
      await readdir(path)
    })
    return true
  } catch {
    return false
  }
}

async function runInit(values: Record<string, unknown>): Promise<number> {
  // Profile을 지정하지 않았다고 죽지 않는다 (C-06 §4.3). 무엇이 있고 무엇이 정해지지
  // 않았는지 보여 주고 멈춘다 — 후보가 하나뿐이어도 대신 고르지 않는다.
  if (!values.profile) {
    // 등록된 adapter가 스스로 후보를 찾고 실측한다 — provider 목록을 여기서 순회하지
    // 않는다 (C-09 §7). adapter가 없으면 그 갈래는 애초에 없다.
    const { root: projectRoot } = await discoverProjectRoot(process.cwd())
    const bindings = await composeBindings({ context: { projectRoot, env: process.env } })
    // 붙었는지는 **모든 명령이 지나는 같은 문**으로 묻는다 (C-11 §3). 저장소 안의 `.asc`
    // 만 보면 local scope로 붙은 workspace를 못 본다 — 기본 경로인데 "아직 안 붙었다"고
    // 답하게 된다.
    const attachedRoot = await discoverRoot(process.cwd(), values.root as string | undefined)
    // 붙어 있다고 정책이 다 정해진 것이 아니다. Profile이 실제로 무엇을 선언했는지
    // 여기서 읽어 넘기고, 남은 것을 계획이 묻는다.
    const plan = await planBootstrap({
      cwd: process.cwd(),
      installRoot: installRoot(),
      externalProfileRoot: externalProfileRoot(),
      ...(attachedRoot ? { ascRoot: attachedRoot } : {}),
      hosts: [{ id: 'claude', installed: await verifyInstalled(defaultPaths()) }],
      bindings,
      declaredPolicies: declaredPolicies(attachedRoot ? await attachedRuntime(attachedRoot) : undefined),
    })
    console.log(renderPlan(plan))
    return 0
  }
  const scope = values.scope === 'project' ? 'project' : 'local'
  if (values.scope !== undefined && values.scope !== 'project' && values.scope !== 'local') {
    console.error(`--scope must be local or project (received: ${values.scope})`)
    return 2
  }
  const { root: projectRoot, git } = await discoverProjectRoot(process.cwd())
  console.log(`Project: ${projectRoot}${git ? '' : ' (not a git repository)'}`)

  // **읽을 수 있는 Profile인지 먼저 본다.** 아래부터는 `.git/info/exclude` 를 고치고
  // 템플릿을 만드는 등 세상을 바꾸는 일이고, 그 뒤에 Profile이 잘못된 것을 알면 반쯤 만든
  // `.asc/` 가 남는다 — 독립 검증이 실제로 그 상태를 만들었다. 여기서 멈추면 아무것도 남지 않는다.
  try {
    await loadLayers({
      installRoot: installRoot(),
      externalProfileRoot: externalProfileRoot(),
      profileId: values.profile as string,
    })
  } catch (error) {
    const explained = explainConfigError(error)
    if (explained === null) throw error
    console.error(explained)
    console.error('Nothing was changed.')
    return 2
  }

  const ascRoot =
    scope === 'project'
      ? join(projectRoot, '.asc')
      : await attachLocalWorkspace(projectRoot, git, values.workspace as string | undefined)
  if (!ascRoot) return 2
  await MarkdownStateStore.open(ascRoot)

  if (scope === 'project') {
    // 팀이 저장소에 두기로 한 경우에만 추적 제외를 손댄다.
    // local scope에서는 저장소 파일을 한 바이트도 건드리지 않는다 (C-11 §5).
    const excluded = await excludeFromGit(projectRoot)
    console.log(
      excluded === 'added'
        ? '.git/info/exclude 에 .asc/ 추가'
        : excluded === 'already'
          ? '.asc/ 는 이미 Git 추적에서 빠져 있다'
          : 'git 저장소가 아니라 추적 제외는 건너뛴다',
    )
  }

  if (await writeIfAbsent(join(ascRoot, 'override.json'), overrideTemplate())) console.log('created the override.json template')
  if (await writeIfAbsent(join(ascRoot, 'identities.json'), identitiesTemplate())) {
    console.log('created the identities.json template — while it is empty, no approval passes')
  }

  const resolved = await runProfile('resolve', { ...values, write: true }, ascRoot)
  if (resolved !== 0) return resolved

  // 무엇이 열려 있고 무엇이 아직 안 열렸는지를 여기서 한 번 보여준다.
  // 이 출력은 지나가면 끝이므로 다시 보는 법도 함께 알린다 (B-21).
  console.log(`\n${renderSetup(await inspectSetup(ascRoot))}`)
  console.log('\nAttached. Issue the first session with `asc session issue`.')
  console.log('You can see this summary again any time with `asc setup status`.')
  return 0
}

/** 붙어 있으면 무엇으로 붙었는지 읽는다. 안 붙었거나 어긋났으면 없는 것으로 본다. */
async function attachedRuntime(ascRoot: string): Promise<ResolvedRuntime | undefined> {
  const outcome = await bootstrapGuard({
    ascRoot,
    installRoot: installRoot(),
    externalProfileRoot: externalProfileRoot(),
    capabilities: CAPABILITIES,
    adapters: ADAPTER_VERSIONS,
    ascVersion: ASC_VERSION,
  }).catch(() => null)
  return outcome?.ok ? outcome.runtime : undefined
}

/**
 * Profile이 이미 선언한 정책. **추측하지 않는다** — 선언 자리가 있고 실제로 채워진 것만 센다.
 *
 * 자리 자체가 없는 정책(작업 항목 정본·기본 전달 채널)은 언제나 미정으로 남는다.
 * 그것이 지금 사실이고, 없는 자리를 있는 척하면 사람이 정할 기회를 잃는다.
 */
function declaredPolicies(resolved?: ResolvedRuntime): PolicyId[] {
  if (!resolved) return []
  const declared: PolicyId[] = []
  if (resolved.layers.profile.canonical.sources.length > 0) declared.push('canonical')
  if (resolved.ownership && Object.keys(resolved.ownership).length > 0) {
    declared.push('ownership')
    // 결정권은 ownership 안에 선언된다 — 하나라도 authority를 든 역할이 있어야 정해진 것이다.
    if (Object.values(resolved.ownership).some((role) => (role.authorities ?? []).length > 0)) {
      declared.push('authority')
    }
  }
  return declared
}

const ASC_VERSION = '0.2.1'
const CAPABILITIES = ['scm.github', 'state.markdown', 'approval.local']
const ADAPTER_VERSIONS = { 'scm.github': ASC_VERSION, 'state.markdown': ASC_VERSION }

/**
 * 어느 build를 쓸 것인가 (C-14 §4). **project를 건드리지 않는다** — 이 선택은
 * machine-local이고, 바꿔도 저장소에는 아무 일도 일어나지 않는다 (불변식 ⑤).
 */
async function runRuntimeSelect(
  command: 'use' | 'status',
  mode: string | undefined,
  source: string | undefined,
  values: Record<string, unknown>,
): Promise<number> {
  const home = ascHome()

  if (command === 'status') {
    const selection = await readRuntimeSelection(home)
    const target = await resolveRuntimeTarget(selection)
    if (values.json) {
      console.log(
        JSON.stringify(
          {
            selection: selection ?? null,
            target,
            file: selectionPath(home),
            // 해법은 데이터로 준다 — agent가 산문에서 경로를 추론하지 않는다
            ...('code' in target ? { action: remediationAction(target) } : {}),
          },
          null,
          2,
        ),
      )
      return 'code' in target ? 1 : 0
    }
    if ('code' in target) {
      for (const line of remediationLines(target)) console.error(line)
      return 1
    }
    console.log(runtimeSelectionLine(target))
    return 0
  }

  if (mode !== 'package' && mode !== 'development') {
    console.error('Usage: asc runtime use package | asc runtime use development <checkout>')
    return 2
  }

  const selection =
    mode === 'package'
      ? ({ version: 1, runtime: { mode: 'package' } } as const)
      : ({ version: 1, runtime: { mode: 'development', source: resolve(source ?? '') } } as const)

  if (mode === 'development' && !source) {
    console.error('development needs a checkout path: asc runtime use development <path>')
    return 2
  }

  // **쓰기 전에 검증한다** (C-14 §10.1). 나쁜 선택을 저장해 두고 다음 명령에서 죽게 하지 않는다.
  const target = await resolveRuntimeTarget(selection)
  if ('code' in target) {
    for (const line of remediationLines(target)) console.error(line)
    return 1
  }

  await writeRuntimeSelection(home, selection)
  console.log(runtimeSelectionLine(target))
  console.log(`Recorded in: ${selectionPath(home)}`)
  return 0
}

/**
 * 선택된 build가 지금 도는 실행물과 다르면 그쪽으로 넘긴다 (C-14 §4).
 *
 * **자기 자신으로 되튀지 않는다** (§4.2) — development checkout의 bin을 직접 부른 경우
 * resolve 결과가 곧 자기 자신이고, 그때 재실행하면 끝없이 돈다.
 */
async function redispatchIfNeeded(argv: string[]): Promise<number | null> {
  const selection = await readRuntimeSelection(ascHome())
  if (!selection || selection.runtime.mode !== 'development') return null

  const target = await resolveRuntimeTarget(selection)
  if ('code' in target) {
    for (const line of remediationLines(target)) console.error(line)
    return 1
  }

  if (target.kind !== 'development') return null

  const here = fileURLToPath(import.meta.url)
  if (target.entry === here) return null

  const child = spawnSync(process.execPath, [target.entry, ...argv], { stdio: 'inherit' })
  // 신호로 죽은 것을 성공으로 보고하지 않는다 — 감독자가 죽음을 봐야 한다
  if (child.signal) return 128 + (SIGNAL_NUMBERS[child.signal] ?? 15)
  return child.status ?? 0
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }

/**
 * 지금 무엇이 되고 무엇이 막혀 있는가 (B-21). 판정만 하고 아무것도 고치지 않는다.
 * 붙기 전에도 답을 줘야 하므로 root 탐색 실패를 오류로 다루지 않는다.
 */
async function runSetup(
  command: string | undefined,
  values: Record<string, unknown>,
  entry: AscEntry = 'runtime',
): Promise<number> {
  // plan/apply는 같은 판단을 나눠 쓴다 (C-14 §6). `--agent` 는 apply의 비대화 형태다.
  if (command === 'plan' || command === 'apply') return runSetupLifecycle(command, values, entry)
  if (command === 'identity') return runSetupIdentity(values)
  if (values.agent) return runSetupLifecycle('apply', values, entry)
  if (command !== undefined && command !== 'status') {
    console.error(`Unknown setup command: ${command}\n\n${USAGE}`)
    return 2
  }

  const resolution = await resolveRoot(process.cwd(), values.root as string | undefined)
  const root = resolution.kind === 'UNRESOLVED' ? null : resolution.root
  const status = root
    ? await inspectSetup(root)
    : assessSetup({
        attachment: 'UNATTACHED',
        hasApprovers: false,
        hasControllerIdentities: false,
        hasMonitorIdentities: false,
        hasScmToken: await hasToken(),
      })

  if (values.json) {
    console.log(JSON.stringify({ ...status, runtime: resolution }, null, 2))
  } else {
    // 어느 뿌리를 왜 골랐는지 먼저 말한다 — 틀린 결합은 여기서 알아채는 게 가장 싸다
    console.log(resolutionLine(resolution))
    console.log(renderSetup(status))
  }
  // 진단이지 실패가 아니다 — 막힌 게 있어도 0이다
  return 0
}

/**
 * 세상을 읽어 `SetupState` 를 만든다. **읽기만 한다** (C-14 §6).
 *
 * Core의 planner는 파일도 network도 모른다 — 사실은 여기서 관측해 넘긴다. 그래야
 * "이 명령이 무엇을 바꿀 것인가"를 아무것도 바꾸지 않고 물어볼 수 있다.
 */
async function detectSetupState(values: Record<string, unknown>, entry: AscEntry): Promise<SetupState> {
  const { root: projectRoot, git } = await discoverProjectRoot(process.cwd())
  const resolution = await resolveRoot(process.cwd(), values.root as string | undefined)
  const ascRoot = resolution.kind === 'UNRESOLVED' ? undefined : resolution.root
  const scope = values.scope === 'project' ? 'project' : 'local'
  const hostReport = await verifyInstall(defaultPaths())
  return {
    entry,
    projectRoot,
    git,
    ...(ascRoot ? { ascRoot } : {}),
    ...(values.profile ? { requestedProfile: values.profile as string } : {}),
    profileCandidates: await availableProfiles(installRoot(), externalProfileRoot()),
    scope,
    host: [{ id: 'claude', status: hostReport.status }],
    // **bootstrap으로 들어왔을 때만 본다.** 설치된 runtime이 자기를 다시 설치할 이유가
    // 없고, 그 축을 안 그리면 plan은 설치된 `asc` 를 전제하지도 않는다 (C-14 §3.4).
    ...(entry === 'bootstrap' ? { stableRuntime: await detectStableInstall(nodeProcessRunner) } : {}),
  }
}

/**
 * `npm` 을 shim으로 부르지 않는다.
 *
 * Windows에서 `npm` 은 `npm.cmd` 이고, Node는 보안 수정 이후 shell 없이 `.cmd` 를 실행하지
 * 않는다 — 그대로 두면 `asc setup status` 가 전역 설치를 조회하지 못하고 "설치 안 됨"으로
 * 잘못 답한다. shell을 켜는 것은 답이 아니다(인자가 escape 없이 이어붙는다). npm의 진입
 * JS를 찾아 지금 도는 node로 직접 돌리면 세 OS에서 같은 실행 경로가 된다.
 *
 * 못 찾으면 이름 그대로 부른다 — PATH에 진짜 `npm` 실행 파일이 있는 환경이 그 경우다.
 */
function resolveCommand(command: string, args: readonly string[]): [string, string[]] {
  if (command !== 'npm') return [command, [...args]]
  const base = dirname(process.execPath)
  for (const candidate of [
    join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows 설치 배치
    join(base, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // POSIX 설치 배치
  ]) {
    if (existsSync(candidate)) return [process.execPath, [candidate, ...args]]
  }
  return [command, [...args]]
}

/**
 * 바깥 명령 하나를 돌린다. **주입 가능한 seam이다** (C-14 §11) — 테스트는 가짜를 넣어
 * 사용자의 전역 npm·HOME·PATH를 건드리지 않는다.
 */
const nodeProcessRunner: ProcessRunner = async (command, args) => {
  const [runnable, runArgs] = resolveCommand(command, args)
  try {
    const { stdout, stderr } = await execFileAsync(runnable, runArgs)
    return { ok: true, stdout, stderr }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message ?? '' }
  }
}

/**
 * detect → plan → (apply) → verify 한 바퀴.
 *
 * 사람이 보는 줄과 agent가 파싱하는 JSON은 **같은 plan**에서 나온다 (C-14 불변식 ①).
 * agent 경로의 stdout은 JSON 문서 하나뿐이고, 그 밖의 말은 stderr로 간다 (§7).
 */
/**
 * `asc setup identity` — 지금 이 사람을 이 workspace 의 승인 권한자로 세운다 (P1-F).
 *
 * 결정은 사람이 하고(이 명령을 실행하는 것이 그 결정이다), **파일 편집은 ASC 가 한다.**
 * 그 전까지는 identities.json 과 override.json 을 손으로 고치는 것이 유일한 길이었고,
 * 그 둘은 서로 다른 형식이라 한쪽만 채워 놓고 왜 안 열리는지 모르는 상태가 흔했다.
 *
 * 비밀은 읽지도 쓰지도 않는다. 여기서 다루는 것은 이름과 채널뿐이다.
 */
async function runSetupIdentity(values: Record<string, unknown>): Promise<number> {
  const resolution = await resolveRoot(process.cwd(), values.root as string | undefined)
  if (resolution.kind === 'UNRESOLVED') {
    console.error('Not attached yet — run `asc init --profile <id>` first.')
    return 2
  }
  const root = resolution.root

  const explicit = values.actor as string | undefined
  const candidate = explicit ?? (await detectSelf())
  if (!candidate) {
    console.error('Could not tell who you are here. Pass one: --actor local:<name>')
    return 2
  }
  const actor = candidate.includes(':') ? candidate : `local:${candidate}`
  const name = actor.slice(actor.indexOf(':') + 1)
  const roles = (values.role as string | undefined) ?? 'both'
  if (!['controller', 'monitor', 'both'].includes(roles)) {
    console.error("--role is controller|monitor|both")
    return 2
  }
  const asController = roles !== 'monitor'
  const asMonitor = roles !== 'controller'

  // 어느 Profile 로 재고정할지는 lock 파일에서 읽는다. attachment 판정을 쓰면 안 되는 이유는
  // 이 명령 자신이 drift 를 만들기 때문이다 — 한 번 실패하면 그 다음부터는 자기가 닫아야 할
  // drift 때문에 profile 을 못 읽어 영영 못 닫는다.
  const attachedProfile = (values.profile as string | undefined) ?? (await lockedProfileId(root))
  if (!attachedProfile) {
    console.error('붙어 있는 Profile 을 알 수 없다 — `asc setup status` 를 보고, 필요하면 --profile 로 지목하라.')
    return 1
  }

  const identitiesPath = join(root, IDENTITY_FILE)
  const overridePath = join(root, 'override.json')
  const merged = withIdentity(await readJson(identitiesPath), await readJson(overridePath), {
    name,
    actor,
    controller: asController,
    monitor: asMonitor,
  })
  await writeJson(identitiesPath, merged.identities)
  await writeJson(overridePath, merged.override)

  console.log(`${name} — ${actor}`)
  console.log(`  identities.json  ${asController ? 'approver 등록' : '건드리지 않음'}`)
  console.log(`  override.json    ${asController ? 'controller.identities' : ''}${asController && asMonitor ? ' · ' : ''}${asMonitor ? 'monitorIdentities' : ''}`)

  // override 는 lock digest 에 들어간다 — 고친 뒤 재고정하지 않으면 다음 명령이 멈춘다.
  // 어느 Profile 로 재고정할지는 지금 붙어 있는 것이 답이다 — 사람에게 다시 묻지 않는다.
  const relocked = await runProfile('resolve', { ...values, profile: attachedProfile, write: true }, root)
  if (relocked !== 0) return relocked

  console.log('')
  console.log(renderSetup(await inspectSetup(root)))
  return 0
}

/** 지금 붙어 있는 Profile id. lock 이 어긋나 있어도 읽힌다 — 파일에 그대로 남아 있다. */
async function lockedProfileId(root: string): Promise<string | undefined> {
  try {
    const lock = JSON.parse(await readFile(join(root, 'profile.lock'), 'utf8')) as {
      profile?: { id?: string }
    }
    return lock.profile?.id
  } catch {
    return undefined
  }
}

/** git·계정에서 "지금 이 사람"의 이름만 읽는다. 자격 값은 읽지 않는다. */
async function detectSelf(): Promise<string | null> {
  const fromGit = await execText('git', ['config', 'user.name'])
  if (fromGit) return fromGit
  const user = userInfo().username
  return user || null
}

async function execText(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args)
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const writeJson = (path: string, value: unknown): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')

async function runSetupLifecycle(
  command: 'plan' | 'apply',
  values: Record<string, unknown>,
  entry: AscEntry,
): Promise<number> {
  const asJson = Boolean(values.json) || Boolean(values.agent)
  const plan = computeSetupPlan(await detectSetupState(values, entry))

  const emit = (payload: Record<string, unknown>): void => {
    if (asJson) console.log(JSON.stringify(payload, null, 2))
    else for (const line of renderSetupPlan(plan)) console.log(line)
  }

  if (command === 'plan' || plan.requiresUserAction) {
    // plan은 아무것도 바꾸지 않는다. 사람이 답해야 하면 apply도 여기서 멈춘다.
    emit({ ...plan, changesApplied: false })
    return plan.requiresUserAction ? 1 : 0
  }

  // apply가 부르는 기존 명령들은 사람에게 말하도록 만들어졌다. agent 경로에서 그 산문이
  // stdout에 섞이면 JSON 문서 하나라는 계약이 깨진다 (C-14 §7) — 진단이므로 stderr로 보낸다.
  const speak = console.log
  if (asJson) console.log = console.error
  let outcome: ApplyResult
  try {
    outcome = await applySetupPlan(plan, {
      installRuntime: async (change) => {
        // 설치는 npm의 몫이다 — ASC는 shell도 PATH도 고치지 않는다 (C-14 불변식 ⑰)
        const installed = await installStableRuntime(nodeProcessRunner, change.version)
        if (!installed.ok) throw new Error(`runtime install failed: ${installed.detail ?? '(no detail)'}`)
        // exit 0은 "npm이 화내지 않았다"까지다. 실제로 서는지까지 본다 (C-14 §3.3)
        const verified = await verifyStableInstall(nodeProcessRunner, change.version)
        if (!verified.ok) throw new Error(verified.remedy ?? 'runtime install could not be verified')
      },
      attachWorkspace: async (change) => {
        const code = await runInit({ ...values, profile: change.profile, scope: change.scope })
        if (code !== 0) throw new Error(`attach 실패 (exit ${code})`)
      },
      installHost: async (change) => {
        const code = await runHost('claude', 'install', undefined, { ...values, json: false })
        if (code !== 0) throw new Error(`${change.host} 설치 실패 (exit ${code})`)
      },
    })
  } finally {
    console.log = speak
  }

  // verify — 같은 detect로 다시 본다. 멱등이면 남은 변경이 없어야 한다.
  const after = computeSetupPlan(await detectSetupState(values, entry))
  const verified = after.changes.length === 0
  emit({
    ...plan,
    status: verified ? 'applied' : 'verification_failed',
    changesApplied: outcome.changesApplied,
    remaining: after.changes,
  })
  return verified ? 0 : 1
}

/** 파일·env를 읽어 판정 입력을 모은다. Core는 이것들을 직접 읽지 않는다. */
async function inspectSetup(root: string): Promise<SetupStatus> {
  const outcome = await bootstrapGuard({
    ascRoot: root,
    installRoot: installRoot(),
    externalProfileRoot: externalProfileRoot(),
    capabilities: CAPABILITIES,
    adapters: ADAPTER_VERSIONS,
    ascVersion: ASC_VERSION,
  })

  const attachment: AttachmentState = outcome.ok
    ? 'READY'
    : outcome.reason === 'NOT_ATTACHED'
      ? 'UNATTACHED'
      : outcome.reason === 'LOCK_DRIFT'
        ? 'LOCK_DRIFT'
        : 'BROKEN'

  const runtime = outcome.ok ? outcome.runtime : undefined
  return assessSetup({
    attachment,
    ...(runtime
      ? { profile: { id: runtime.layers.profile.id, origin: runtime.layers.profileOrigin } }
      : {}),
    hasApprovers: Object.keys(await loadIdentityMap(root)).length > 0,
    hasControllerIdentities: Object.keys(runtime?.controllerIdentities ?? {}).length > 0,
    hasMonitorIdentities: (runtime?.monitor.identities?.length ?? 0) > 0,
    hasScmToken: await hasToken(),
  })
}

const hasToken = async () => (await discoverToken()) !== null

/**
 * 모든 Run 앞에 서는 문. 지금 계층을 다시 합쳐 lock과 견주고, 어긋나면 멈춘다.
 * 저절로 다시 맞추지 않는다 — 설정이 바뀐 채 계속 돌면 그 Run이 무엇을 근거로 판단했는지
 * 나중에 알 수 없다.
 */
/** 이 저장소(또는 설치된 패키지)의 뿌리. profiles/ · presets/ 를 여기서 읽는다. */
const installRoot = () => join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 사용자 소유 Profile 디렉터리. 팀이 나눠 갖는 실 Profile이 여기 온다 —
 * 배포본에는 예시만 있고, 남의 프로젝트 설정은 패키지에 실리지 않는다.
 *
 * **경로를 아는 것은 Surface의 몫이다.** Core에 홈을 알려 주지 않는다 (C-11).
 */
const externalProfileRoot = () => join(ascHome(), 'profiles')

async function checkBootstrap(root: string): Promise<{ code: number; runtime?: ResolvedRuntime }> {
  const outcome = await bootstrapGuard({
    ascRoot: root,
    installRoot: installRoot(),
    externalProfileRoot: externalProfileRoot(),
    capabilities: CAPABILITIES,
    adapters: ADAPTER_VERSIONS,
    ascVersion: ASC_VERSION,
  })
  if (outcome.ok) return { code: 0, runtime: outcome.runtime }

  // 아직 붙이지 않았으면 설정 없이 도는 경로만 쓰는 것이므로 막지 않는다
  if (outcome.reason === 'NOT_ATTACHED') return { code: 0 }

  if (outcome.reason === 'BROKEN_ATTACHMENT') {
    // 붙이다 만 상태다. 무엇으로 도는지 모르는 채 굴러가는 것보다 멈추는 편이 낫다.
    console.error(`The runtime is not intact: ${outcome.detail}`)
    console.error('Re-attach with `asc init --profile <id>`, or lock it with `asc profile resolve --write`.')
    return { code: 2 }
  }

  if (outcome.reason === 'RESOLVE_FAILED') {
    console.error('Configuration could not be read:')
    for (const detail of outcome.details) console.error(`  - ${detail}`)
    return { code: 2 }
  }

  console.error('Configuration differs from profile.lock. Nothing proceeds until it is settled:')
  for (const drift of outcome.drifts) console.error(`  ${drift.field}: ${drift.locked} → ${drift.current}`)
  console.error('\nOnce you have checked it, re-lock with `asc profile resolve --write`.')
  return { code: 2 }
}

/**
 * 지금 이 저장소를 설명하는 Profile을 사용자 소유 공간에 만든다 (P0).
 *
 * **이것이 되물음을 없앤다.** 배포본에 담긴 Profile은 예시뿐이고, 그래서 URL만 받은 agent는
 * `ASC_PROFILE_SELECTION_REQUIRED` 앞에서 고를 것이 없어 사람에게 물었다. 여기서 만드는 것은
 * git remote가 증명하는 사실뿐이다 — 정본 branch·role 경계·정책은 짓지 않는다 (adopt.ts 주석).
 *
 * 쓰는 곳은 `$ASC_HOME/profiles/<id>/` 이고 저장소는 건드리지 않는다. 이미 있으면 덮지 않고
 * 멈춘다 — 남이 쓰던 Profile을 조용히 갈아 끼우는 것이 이 명령의 일이 아니다.
 */
async function runProfileAdopt(values: Record<string, unknown>, entry: AscEntry): Promise<number> {
  const asJson = Boolean(values.json) || Boolean(values.agent)
  const { root: projectRoot, git } = await discoverProjectRoot(process.cwd())
  const remotes = git ? await gitRemotes(projectRoot) : []

  let adopted: AdoptedProfile
  try {
    adopted = buildAdoptedProfile({
      dirName: basename(projectRoot),
      remotes,
      // provider를 아는 것은 Adapter를 아는 이 층이다 (C-09 §6.1). host 하나로 단정하는
      // 것은 여기까지고, 모르는 host는 `git` 이라고만 적는다 — 그것이 사실이다.
      scmForHost: (host) => (host === 'github.com' ? 'github' : 'git'),
      ...(values.id ? { requestedId: values.id as string } : {}),
    })
  } catch (error) {
    if (!(error instanceof AdoptError)) throw error
    console.error(error.message)
    return 2
  }

  // 스스로 만든 것이 스키마를 통과하는지 **쓰기 전에** 본다. 통과하지 못하는 파일을 놓고
  // 나가면 그 다음 명령이 남의 설정 오류처럼 죽는다 (95250da가 닫은 것과 같은 모양).
  const parsed = ProjectProfile.safeParse(adopted.profile)
  if (!parsed.success) {
    console.error(`Built a profile that ASC itself rejects — this is a bug in \`profile adopt\`:`)
    for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join('.')}: ${issue.message}`)
    return 1
  }

  const dir = join(externalProfileRoot(), adopted.id)
  const path = join(dir, 'profile.json')
  if (existsSync(path)) {
    console.error(
      `A profile called '${adopted.id}' is already there: ${path}\n` +
        `Attach with it (\`asc setup apply --profile ${adopted.id}\`), or adopt under another name with --id <name>.`,
    )
    return 1
  }

  await mkdir(dir, { recursive: true })
  await writeFile(path, `${JSON.stringify(adopted.profile, null, 2)}\n`, 'utf8')

  // 다음 한 걸음은 두 형태로 준다 — agent는 portable, 사람은 display (C-14 불변식 ⑯).
  // 여기서는 설치 상태를 다시 관측하지 않는다: 이 명령이 도는 방식이 곧 그 답이다.
  const args = ['setup', 'apply', '--profile', adopted.id]
  // portable은 agent가 그대로 실행한다 — 기계가 읽는 형태로 끝난다 (setup-plan.ts와 같은 규칙).
  const machine = [...args, '--json']
  const action = {
    type: 'apply_setup' as const,
    display: shorthandCommand(args),
    portable: entry === 'bootstrap' ? portableCommand(machine) : shorthandCommand(machine),
  }
  if (asJson) {
    console.log(
      JSON.stringify(
        { id: adopted.id, path, project: parsed.data.project, warnings: adopted.warnings, nextActions: [action.portable], actions: [action] },
        null,
        2,
      ),
    )
    return 0
  }
  console.log(`Adopted ${projectRoot} as profile '${adopted.id}' — ${path}`)
  console.log(`Project: ${parsed.data.project.scm} ${parsed.data.project.repository}`)
  for (const warning of adopted.warnings) console.log(`  note: ${warning}`)
  console.log(`\nAttach with it: ${action.display}`)
  return 0
}

/**
 * 계층을 합쳐 산출물 셋을 만든다. 기본은 미리보기다 — 무엇이 바뀌는지 보고 나서 쓴다.
 * lock이 어긋나면 알리기만 하고 저절로 맞추지 않는다 (OM §4.9).
 */
async function runProfile(command: string | undefined, values: Record<string, unknown>, root: string): Promise<number> {
  if (command !== 'resolve') {
    console.error(`Unknown profile command: ${command ?? '(none)'}\n\n${USAGE}`)
    return 2
  }
  if (!values.profile) {
    console.error('Usage: asc profile resolve --profile <id> [--preset <id>]')
    return 2
  }

  const installPath = (values.install as string) ?? installRoot()
  const layers = await loadLayers({
    installRoot: installPath,
    externalProfileRoot: externalProfileRoot(),
    profileId: values.profile as string,
    ...(values.preset ? { presetId: values.preset as string } : {}),
    overridePath: join(root, 'override.json'),
  })

  // 무엇이 실제로 제공되는지는 붙어 있는 Adapter가 정한다
  const capabilities = ['scm.github', 'state.markdown', 'approval.local']
  const result = resolveRuntime(layers, capabilities, ASC_VERSION)
  if (!result.ok) {
    console.error('resolve failed:')
    for (const failure of result.failures) {
      console.error(`  - ${failure.kind}: ${'detail' in failure ? failure.detail : failure.violation.detail}`)
    }
    return 1
  }

  const runtime = result.runtime
  const generatedAt = new Date().toISOString()
  const lock = buildLock({
    runtime,
    ascVersion: ASC_VERSION,
    adapters: { 'scm.github': ASC_VERSION, 'state.markdown': ASC_VERSION },
    generatedAt,
  })

  console.log(`Layers: ${runtime.resolved.policy.layers.join(' → ')}`)
  console.log(`Canonical: ${runtime.canonicalSources.join(', ')}`)
  console.log(`Enabled: ${runtime.resolved.capabilities.join(', ') || 'none'}`)
  if (runtime.degraded.length > 0) console.log(`Disabled: ${runtime.degraded.join(', ')}`)

  // 이미 lock이 있으면 견준다. 고쳐 주지 않고 무엇이 달라졌는지만 말한다.
  try {
    const existing = ProfileLock.parse(JSON.parse(await readFile(join(root, 'profile.lock'), 'utf8')))
    const drifts = compareLock(existing, lock)
    if (drifts.length > 0) {
      console.log('\nConfiguration differs from the lock:')
      for (const drift of drifts) console.log(`  ${drift.field}: ${drift.locked} → ${drift.current}`)
      console.log('Check what changed, and if this is the combination you want, re-lock it with --write.')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  if (!values.write) {
    console.log('\n(preview — pass --write to actually write)')
    return 0
  }

  // 이전 lock은 덮지 않고 옮긴다 — 어떤 조합으로 돌렸는지가 사라지면 재현할 수 없다
  try {
    const previous = ProfileLock.parse(JSON.parse(await readFile(join(root, 'profile.lock'), 'utf8')))
    console.log(`Previous lock archived at: ${await archiveLock(root, previous)}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  await mkdir(join(root, 'cache'), { recursive: true })
  await writeFile(join(root, 'ASC.md'), renderAscMd(runtime, generatedAt), 'utf8')
  await writeFile(join(root, 'cache', 'resolved-profile.json'), JSON.stringify(runtime.resolved, null, 2), 'utf8')
  await writeFile(join(root, 'profile.lock'), JSON.stringify(lock, null, 2), 'utf8')
  await writeFile(join(root, 'profile'), `${layers.profile.id}\n`, 'utf8')

  // controller.md는 사람이 쓰는 파일이라 한 번만 만들고 이후엔 손대지 않는다
  try {
    await writeFile(join(root, 'controller.md'), renderControllerMd(layers.profile.id), { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  console.log('\nWrote ASC.md, cache/resolved-profile.json and profile.lock')
  return 0
}

/**
 * Profile이 정의한 정본을 실제로 읽을 통로. 토큰이 없으면 만들지 않는다 —
 * 그 경우 baseline 기록·대조는 건너뛰고, 건너뛰었다는 사실이 계약에 빈 snapshot으로 남는다.
 */
async function scmFor(resolved?: ResolvedRuntime): Promise<GitHubScm | undefined> {
  if (!resolved) return undefined
  const token = await discoverToken()
  if (!token) return undefined

  const sourceRefs: Record<string, { ref: string }> = {}
  for (const source of resolved.layers.profile.canonical.sources) {
    if (source.ref) sourceRefs[source.id] = { ref: source.ref }
  }
  return new GitHubScm({
    client: new GitHubClient({ token }),
    defaultRepo: resolved.layers.profile.project.repository,
    sourceRefs,
  })
}

/**
 * Claude Host Adapter 표면 (C-03 §5). install/uninstall/probe는 프로젝트 밖(user-scope)
 * 이라 .asc 없이 돌고, bind/contract는 attach된 프로젝트에서 돈다.
 */
async function runHost(
  provider: string | undefined,
  command: string | undefined,
  target: string | undefined,
  values: Record<string, unknown>,
): Promise<number> {
  if (provider !== 'claude') {
    console.error(`Unknown host: ${provider ?? '(none)'} — only claude is supported today`)
    return 2
  }
  const paths = defaultPaths()

  switch (command) {
    case 'install': {
      const before = await verifyInstall(paths)
      if (before.status === 'INSTALLED_STALE') console.log('The installation is behind the current source — converging it.')
      const outcome = await install(paths, undefined, { force: Boolean(values.force) })
      for (const path of outcome.written) console.log(`installed: ${path}`)
      for (const skip of outcome.skipped) console.log(`skipped: ${skip.path} — ${skip.reason}`)
      if (outcome.written.length === 0 && outcome.skipped.length === 0) console.log('Already installed (no change)')
      // 무엇이 남았는지 install 직후에 말한다 — 사람이 따로 물어보게 하지 않는다
      for (const line of installReportLines(await verifyInstall(paths))) console.log(line)
      console.log('\nThe guard hook is registered. External writes from ASC-managed sessions are blocked at execution time.')
      return outcome.skipped.length > 0 ? 1 : 0
    }

    case 'uninstall': {
      const outcome = await uninstall(paths)
      for (const path of outcome.removed) console.log(`removed: ${path}`)
      for (const keep of outcome.kept) console.log(`kept: ${keep.path} — ${keep.reason}`)
      if (outcome.removed.length === 0) console.log('Nothing installed by ASC to remove')
      return 0
    }

    case 'guard': {
      // 2층 — worker 세션에만 적용되는 permission deny. user-scope에 넣으면 사람의
      // git push까지 전역으로 막히므로, worker 기동 시 --settings 로 주입하는 파일로 둔다.
      const root = await discoverRoot(process.cwd(), values.root as string | undefined)
      if (!root) {
        console.error('No attached ASC runtime found — run this inside an attached project, or pass --root.')
        return 2
      }
      const guardPath = join(root, 'adapters', 'claude-code', 'worker-settings.json')
      await mkdir(dirname(guardPath), { recursive: true })
      await writeFile(guardPath, workerSettings(), 'utf8')
      console.log(`created: ${guardPath}`)
      console.log('Inject this whenever an ASC-managed worker starts:')
      console.log(`  claude --settings "${guardPath}" ...`)
      return 0
    }

    case 'probe': {
      const report = await verifyInstall(paths)
      const installed = report.status === 'INSTALLED_CURRENT'
      // 2층 판정 — attach된 프로젝트에서만 확인 가능하다
      const probeRoot = await discoverRoot(process.cwd(), values.root as string | undefined)
      let workerSettingsReady: boolean | undefined
      if (probeRoot) {
        const guardPath = join(probeRoot, 'adapters', 'claude-code', 'worker-settings.json')
        workerSettingsReady = await readFile(guardPath, 'utf8')
          .then((text) => text === workerSettings())
          .catch(() => false)
      }
      let result = await probe({
        guardInstalled: installed,
        ...(workerSettingsReady !== undefined ? { workerSettingsReady } : {}),
      })
      // 호스트 세션이 자기 도구 목록을 보고 채우는 self-report (--report cap=true)
      const reports = (values.report as string[] | undefined) ?? []
      if (reports.length > 0) {
        const parsed: Partial<Record<CapabilityName, boolean>> = {}
        for (const entry of reports) {
          const [name, value] = entry.split('=')
          if (name && (value === 'true' || value === 'false')) {
            parsed[name as CapabilityName] = value === 'true'
          }
        }
        result = applyHostReport(result, parsed, new Date().toISOString())
      }

      // capability 표보다 먼저 설치 상태를 말한다 — 낡은 설치본이면 아래 판정도 낡은 것이다
      for (const line of installReportLines(report)) console.log(line)
      console.log(`Claude Code: ${result.claudeVersion ?? '(not found)'}`)
      for (const [name, verdict] of Object.entries(result.capabilities)) {
        const mark = verdict.available === true ? 'O' : verdict.available === false ? 'X' : '?'
        console.log(`  ${mark} ${name.padEnd(24)} [${verdict.source}] ${verdict.detail ?? ''}`)
      }

      const readiness = assessReadiness(result)
      if (!readiness.ok) {
        console.error(`\nSTOP: a safety-critical capability is missing — ${readiness.missing.join(', ')}`)
        console.error('Without the external-write guard, no ASC-managed autonomous worker runs.')
      } else if (readiness.degraded.length > 0) {
        console.log(`\ndegraded (optional capability missing or unverified): ${readiness.degraded.join(', ')}`)
      }

      // attach된 프로젝트면 결과를 Adapter metadata로 남긴다
      if (probeRoot) {
        const store = new MarkdownStateStore(probeRoot)
        await store.scope('claude-code').set('capabilities', JSON.stringify(result))
        // 뿌리는 workspace마다 다르다 — `.asc/` 로 적으면 local scope에서 없는 경로를 가리킨다
        console.log(`\nRecorded in: ${join(probeRoot, 'adapters', 'claude-code', 'capabilities.json')}`)
      }
      return readiness.ok ? 0 : 1
    }

    case 'bind':
    case 'release':
    case 'contract': {
      if (!target) {
        console.error(`Usage: asc host claude ${command} <S-ID> ...`)
        return 2
      }
      const root = await discoverRoot(process.cwd(), values.root as string | undefined)
      if (!root) {
        console.error('No attached ASC runtime found — run this inside an attached project.')
        return 2
      }
      const store = new MarkdownStateStore(root)
      const bindings = claudeBindings(store)
      const at = new Date().toISOString()

      if (command === 'contract') {
        const session = await store.get('session', target)
        if (!session) {
          console.error(`${target} was not found.`)
          return 1
        }
        // 계약문이 Profile의 책임 지도를 인용하므로, 지금 설정이 lock과 같은지 먼저 본다.
        // 어긋난 설정에서 뽑은 결정권을 worker에게 건네면 그 세션은 틀린 전제로 돈다.
        const guard = await checkBootstrap(root)
        if (guard.code !== 0) return guard.code
        console.log(
          workerContract({
            logicalSessionId: session.id,
            goal: session.goal,
            doneCriteria: session.doneCriteria,
            writeBoundary: session.writeBoundary,
            ...(session.owner ? { owner: session.owner } : {}),
            // 세션이 명시한 것과 Profile 지도에서 풀린 것을 합쳐 넘긴다. worker에게 필요한 것은
            // "어디에 적혀 있는가"가 아니라 "이 결정이 누구 것인가"다.
            ...(() => {
              const decided = effectiveAuthority(session, guard.runtime?.ownership)
              return Object.keys(decided).length > 0 ? { decisionAuthority: decided } : {}
            })(),
            ...(session.dependencies.length > 0 ? { dependencies: session.dependencies } : {}),
          }),
        )
        return 0
      }

      if (!values.physical) {
        console.error('--physical <Claude session id> is required.')
        return 2
      }
      const physical = values.physical as string

      const audit = auditLedger(store)

      if (command === 'release') {
        const running = (await audit.executionsOf(target)).filter(
          (e) => e.status === 'RUNNING' && e.physicalReference === physical,
        )
        const released = await bindings.release(target, physical)
        // 소유권은 사라져도 그 실행이 있었다는 사실은 남는다 (C-10 §1.3)
        if (released) for (const evidence of running) await audit.endExecution(evidence.executionId, 'RELEASED', at)
        console.log(released ? `${target} ownership released` : 'Release failed — you are not the owner')
        return released ? 0 : 1
      }

      const spec = {
        logicalSessionId: target,
        provider: CLAUDE_PROVIDER,
        physicalSessionId: physical,
        ...(values.worker ? { workerId: values.worker as string } : {}),
        ...(values.kind ? { runtimeKind: values.kind as string } : {}),
      }
      // principal은 physical 참조와 다르다 (C-10 §3). 선언이 없으면 유추한 것이고,
      // 유추한 principal 위에서는 어떤 독립성 주장도 UNVERIFIED를 넘지 못한다.
      const principal = (values.principal as string) ?? physical
      const principalSource = values.principal ? 'declared' : 'derived'
      const recordExecution = async (evidenceSource: string) => {
        const recorded = await audit.execute({
          logicalSessionId: target,
          hostAdapter: CLAUDE_PROVIDER,
          principal,
          principalSource,
          physicalReference: physical,
          startedAt: at,
          evidenceSource,
        })
        console.log(`execution evidence ${recorded.evidence.executionId} · principal ${principal} (${principalSource})`)
      }

      if (values.force) {
        // 죽은 owner를 사람이 확인하고 갈아끼우는 명시적 복구다 — 자동 탈취가 아니다
        const superseded = (await audit.executionsOf(target)).filter((e) => e.status === 'RUNNING')
        const rebound = await bindings.rebind(spec, at)
        for (const evidence of superseded) await audit.endExecution(evidence.executionId, 'SUPERSEDED', at)
        await recordExecution('host bind --force')
        console.log(`${target} ← ${rebound.physicalSessionId} (explicit rebind)`)
        return 0
      }
      const claimed = await bindings.claim(spec, at)
      if (!claimed.ok) {
        console.error(
          `RUNTIME_CONFLICT: ${target} 의 owner는 ${claimed.current.physicalSessionId} 다. ` +
            '죽은 세션이 확실하면 --force 로 rebind하라.',
        )
        return 1
      }
      await recordExecution('host bind')
      console.log(`${target} ← ${claimed.binding.physicalSessionId} (owner claim)`)
      console.log('This session is now ASC-managed — external writes are stopped by the guard.')
      return 0
    }

    default:
      console.error(`Unknown host claude command: ${command ?? '(none)'}\n\n${USAGE}`)
      return 2
  }
}

/**
 * "ASC로 진행해"의 CLI 표면 (C-03 §1). 판단은 Operator가, 전이는 SessionRuntime이 —
 * 여기는 조립과 출력뿐이다. guard는 main()에서 이미 지났지만 Operator에도 필수로
 * 물린다: 이 factory가 아닌 다른 Surface가 Operator를 직접 만들 때도 같은 문을 지나게.
 */
async function runProceed(
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  root: string,
  resolved?: ResolvedRuntime,
): Promise<number> {
  const scm = await scmFor(resolved)
  const sessions = new SessionRuntime(store, resolved?.resolved.policy ?? null, {
    ...(scm ? { scm } : {}),
    canonicalSources: (resolved?.canonicalSources ?? []).map((sourceId) => ({ sourceId })),
    ...(resolved?.ownership ? { ownership: resolved.ownership } : {}),
  })
  const workRef = (values.work as string | undefined) ?? undefined
  const ingress = workRef ? await buildWorkIngress(store, root, sessions, resolved) : undefined
  if (workRef && !ingress) {
    console.error(`작업 항목 '${workRef}' 을 읽을 통로가 없다 — Profile bindings 에 작업 항목 provider 를 선언하라.`)
    return 2
  }

  const operator = new Operator({
    store,
    sessions,
    // 막힌 node만 보고 판단한다 — checkpoint를 발행했다는 이유로 멈추지 않는다 (C-13 §3.1)
    escalations: escalationLedger(store),
    ...(ingress ? { ingress } : {}),
    // main()의 checkBootstrap과 같은 원천(bootstrapGuard)이다 — 중복 판단이 아니라 같은 문
    guard: async () => {
      const outcome = await checkBootstrap(root)
      return outcome.code === 0 ? { ok: true } : { ok: false, detail: 'bootstrap guard 실패 — 위 출력 참조' }
    },
  })

  const outcome = await operator.proceed({
    ...(values.session ? { sessionId: values.session as string } : {}),
    ...(values.goal ? { goal: values.goal as string } : {}),
    ...(workRef ? { workRef } : {}),
  })

  // 도구 자식(JAM MCP 서버 등)을 여기서 닫는다 — 안 닫으면 출력까지 끝내고도 종료하지 못한다.
  await closeToolClients()

  if (values.json) {
    console.log(JSON.stringify(outcome, null, 2))
    return outcome.kind.startsWith('BLOCKED') || outcome.kind === 'FAILED' ? 1 : 0
  }

  switch (outcome.kind) {
    case 'STARTED':
    case 'RESUMED':
    case 'CONTINUE_ACTIVE': {
      const verb = outcome.kind === 'STARTED' ? '시작' : outcome.kind === 'RESUMED' ? '재개' : '계속'
      console.log(`${outcome.contract.id} ${verb} — ${outcome.contract.goal}`)

      // 이어가는 경우에는 계약 복창보다 "지금 어떻게 되고 있는가"가 먼저다.
      // 재개(RESUMED)는 아래 checkpoint가 그 역할을 하므로 중복해서 말하지 않는다.
      if (outcome.kind === 'CONTINUE_ACTIVE') {
        const progress = await progressService(store).get(outcome.contract.id)
        const liveness = await livenessOf(store, outcome.contract.id)
        // 열린 상신은 신고와 무관하게 "지금 판단이 필요한 것"이다 — 화면이 그것을 먼저 말한다
        const rendered = renderProgress({
          session: outcome.contract,
          progress,
          ...(liveness ? { liveness } : {}),
          ...(outcome.awaiting && outcome.awaiting.length > 0 ? { awaiting: outcome.awaiting } : {}),
        })
        console.log(`\n${rendered.body.join('\n\n')}`)
        console.log(`\n> detail: ${rendered.detail}\n`)
      }

      // 막힌 것이 있으면 진행 화면보다 먼저 말한다 — 상신 2건이 열려 있는데
      // "판단 필요 항목 없음"이라고 하면 그 화면은 거짓말이다 (dogfood에서 잡힘).
      if (outcome.gate) {
        for (const line of executionLine(outcome.gate, 'Current state')) console.log(line)
      }

      // checkpoint는 중단 시점의 승계 정보다. 재개할 때만 지금 상황이며,
      // 이미 돌고 있는 세션(CONTINUE_ACTIVE)에 남아 있는 것은 지난 이야기다 (B-17).
      if (outcome.checkpoint && outcome.kind !== 'CONTINUE_ACTIVE') {
        console.log(`Resume at: ${outcome.checkpoint.position}`)
        console.log(`Next action: ${outcome.checkpoint.nextAction}`)
      }
      if (outcome.doneCriteria.length > 0) {
        console.log('Done criteria:')
        for (const criterion of outcome.doneCriteria) console.log(`  - ${criterion}`)
      }
      if (outcome.contract.writeBoundary.length > 0) {
        console.log(`Write boundary: ${outcome.contract.writeBoundary.join(', ')}`)
      }
      return 0
    }
    case 'NEEDS_SELECTION':
      console.log(`There are ${outcome.candidates.length} runnable sessions. Name the one you mean (--session):`)
      for (const c of outcome.candidates) {
        console.log(`  ${c.id}  ${c.status.padEnd(7)}  ${c.wouldDo.padEnd(8)}  ${c.goal}`)
      }
      return 1
    case 'WORK_STATE': {
      const shown = outcome.result.leaning
        ? `${outcome.result.state} (${outcome.result.leaning})`
        : outcome.result.state
      console.log(`${outcome.workRef}: ${shown}`)
      for (const line of outcome.result.evidence) console.log(`  근거      ${line}`)
      for (const line of outcome.result.limitations) console.log(`  한계      ${line}`)
      for (const line of outcome.result.missing) console.log(`  미확인    ${line}`)
      console.log(`\n다음 행동: ${outcome.nextAction}`)
      return outcome.result.state === 'UNDECIDABLE' ? 1 : 0
    }
    case 'PROPOSE_CONTRACT':
      if (outcome.plan) {
        console.log(`${outcome.plan.status}${outcome.full?.id ? ` — ${outcome.full.id}` : ''}`)
        for (const fact of outcome.plan.facts) console.log(`  fact      ${fact.field} (${fact.source})`)
        for (const proposal of outcome.plan.proposals) {
          console.log(`  proposal  ${proposal.field} — ${proposal.reason ?? proposal.source}`)
        }
        for (const item of outcome.plan.invalid) console.log(`  invalid   ${item.field}: ${item.detail}`)
        for (const item of outcome.plan.unresolved) {
          console.log(`  decide    ${item.field} [${item.reason}]: ${item.detail}`)
        }
        if (outcome.forController) {
          console.log(`\n계약은 성립한다. 발급은 Controller 의 것이다 — ${outcome.plan.issuance.detail}:`)
          console.log(`  ${shorthandCommand(outcome.forController.slice(1))}`)
        }
        return outcome.plan.status === 'READY_TO_ISSUE' ? 0 : 1
      }
      console.log('No runnable session. If a new contract is needed, the Controller issues it:')
      console.log(
        `  asc session issue S-<date>-<n> --role ${outcome.draft.role} --goal "${outcome.draft.goal || '<goal>'}"`,
      )
      return 1
    case 'HELD':
      // 실패가 아니다 — 사람이 결정할 때까지 기다리는 것이고 세션은 그대로 있다
      console.log(`Held: ${outcome.detail}`)
      for (const line of executionLine(outcome.verdict, 'Current state')) console.log(line)
      console.log(`Escalations: ${outcome.escalations.join(', ')} — see them with \`asc escalate list\``)
      return 0
    case 'BLOCKED_CONFIG':
      console.error(`Configuration check failed: ${outcome.detail}`)
      return 1
    case 'BLOCKED_CANONICAL':
      console.error(`Canonical check failed: ${outcome.detail}`)
      for (const drift of outcome.drifts ?? []) {
        console.error(`  ${drift.sourceId}: ${drift.recorded} → ${drift.current}`)
      }
      return 1
    case 'FAILED':
      console.error(`Cannot proceed (${outcome.reason}): ${outcome.detail}`)
      return 1
  }
}

/**
 * 이미 쓴 세션 id. **회수돼 보관된 것까지 센다** — 그 번호를 다시 쓰면 앞의 계약 기록
 * 위에 다른 계약이 앉는다. 실제로 그렇게 기록 하나를 잃었다.
 */
async function usedSessionIds(store: MarkdownStateStore, root: string): Promise<string[]> {
  const active = (await store.list('session')).map((session) => session.id)
  let archived: string[] = []
  try {
    archived = (await readdir(join(root, 'sessions', 'archive')))
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -3))
  } catch {
    archived = []
  }
  return [...new Set([...active, ...archived])]
}

/**
 * 저장소의 최상위 자리와 그 아래 `src`. 분류 이름이 어느 모듈에 맞는지 재는 재료다 —
 * 목록일 뿐이고, 이것이 쓰기 범위가 되지는 않는다 (derive 가 최상위는 범위로 쓰지 않는다).
 */
async function topLevelModules(projectRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(projectRoot, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .flatMap((entry) => [entry.name, `${entry.name}/src`])
  } catch {
    return []
  }
}

/** 선행·의존으로 볼 후보. 링크가 먼저고, 본문이 말한 키가 그다음이다. 상한은 5. */
const DEPENDENCY_CAP = 5

function dependencyCandidates(workItem: ResourceSnapshot | undefined): string[] {
  if (!workItem) return []
  // 본문이 "BLOCKED BY: KEY-1" 처럼 말한 것은 링크가 없어도 의존이다 — 링크가 없다는
  // 사실이 의존이 없다는 뜻은 아니다.
  const fromBody = new Set<string>()
  const project = workItem.reference.split('-')[0]
  if (project) {
    const pattern = new RegExp(`(?:blocked\\s*by|선행|의존)[^\\n]*?(${project}-\\d+)`, 'gi')
    for (const [, key] of `${workItem.body ?? ''}`.matchAll(pattern)) if (key) fromBody.add(key)
  }
  // 부모·하위 작업은 포함 관계이지 선행이 아니다 — 그것까지 세면 거의 모든 작업이 막힌다.
  const ordered = [...(workItem.blockedBy ?? []), ...fromBody].filter((key) => key !== workItem.reference)
  return [...new Set(ordered)].slice(0, DEPENDENCY_CAP)
}

/**
 * 작업 항목 하나를 조사해 계약까지 잇는 통로 (P0-D).
 *
 * 여기서 판정하지 않는다. 모으고(gather·observeRepo), 도출하고(derive), **기존 판정기에
 * 넘긴다**(plan = planSessionContract, issue = SessionRuntime). 범위·책임·발급 권한은
 * 그것들이 답하는 것을 그대로 쓴다.
 *
 * buildMonitorEngine 을 거치지 않는 이유: 그 함수는 GitHub 토큰이 없으면 멈춘다. 감시에는
 * 맞는 문이지만, GitLab·JAM 프로젝트에서 저장소 조사까지 막아 버린다 — 그것이 "원격이
 * 막혔으니 저장소도 못 본다"는 잘못된 결론을 만든 구조다.
 */
async function buildWorkIngress(
  store: MarkdownStateStore,
  root: string,
  runtime: SessionRuntime,
  resolved?: ResolvedRuntime,
): Promise<WorkIngress | undefined> {
  const { root: projectRoot } = await discoverProjectRoot(process.cwd())
  // JAM 은 아직 `jam` 바이너리를 깔지 않는 설치가 기본이다 — 그 경우 launcher 를 통해 부른다.
  const jamCommand = process.env.ASC_JAM_PATH ? undefined : { command: 'npx', args: ['--yes', '@jam-mcp/launcher'] }
  const adapters = [
    new GitHubAdapter(),
    new GitLabAdapter(),
    new JamAdapter(jamCommand ?? {}),
  ]
  const declared = resolved?.layers.profile.bindings ?? []
  const plan = await composeBindings({
    context: { projectRoot, env: process.env },
    adapters,
    roles: declared.map((b) => ({ adapterId: b.adapter, resource: b.resource, role: b.role })),
  })
  // 선언이 없으면 발견된 사실로 제안한다 (P1-G). 저장하지 않고, 갈리면 고르지 않는다.
  const proposed = declared.length === 0 ? proposeBindings(plan) : undefined
  if (proposed) {
    for (const reason of proposed.reasons) console.error(`  제안  ${reason}`)
    for (const conflict of proposed.conflicts) console.error(`  보류  ${conflict}`)
  }
  const ports = await buildRuntimePorts({
    plan,
    // 제안은 **말하는 것**이지 정하는 것이 아니다. 역할을 박아 넣으면 선언과 구분되지 않고,
    // capability 해석은 후보가 유일할 때 이미 스스로 풀린다.
    roles: rolesFor(plan, declared),
    perPage: 30,
    jam: { command: jamCommand?.command ?? 'jam', args: [...(jamCommand?.args ?? []), 'serve'], cwd: projectRoot },
    endpointFor: (binding) => endpointOf(adapters, binding),
  })

  const work = ports.resourceContext
  if (!work) return undefined

  // 저장소는 원격 provider 와 무관하게 본다. 이 한 줄이 P0-E 의 요점이다.
  const repo = new LocalRepoAdapter({ cwd: projectRoot })
  const canonicalRef = resolved?.layers.profile.canonical.sources[0]?.ref
  const canonicalPaths = resolved?.layers.profile.canonical.sources.flatMap((source) => source.paths) ?? []
  const changeContext = ports.changeContext

  return {
    gather: async (workRef) => {
      const workItem = await work.getResource(workRef).catch(() => undefined)
      const comments = await work
        .getComments(workRef, { limit: 20 })
        .then((list) => list as readonly ContextComment[] | 'UNAVAILABLE')
        .catch(() => 'UNAVAILABLE' as const)
      const change = changeContext
        ? await changeContext
            .getChange(workRef)
            .then((summary) => summary as ChangeSummary | 'UNAVAILABLE')
            .catch(() => 'UNAVAILABLE' as const)
        : ('UNAVAILABLE' as const)
      // 선행 작업이 열려 있는지는 **조회해야** 안다. 키만 넘기면 판정이 늘 "모른다"가 되고,
      // 그러면 막힌 작업이 착수 가능으로 보인다. adapter 가 막는 것을 앞에 실어 주므로
      // 상한에 걸려도 blocker 가 먼저 확인된다.
      const candidates = dependencyCandidates(workItem)
      const dependencies = await Promise.all(
        candidates.map(async (reference) => {
          const item = await work.getResource(reference).catch(() => undefined)
          const done = item && !item.missing ? statusIndicatesDone(item.state) : undefined
          return {
            reference,
            ...(item?.state ? { state: item.state } : {}),
            ...(done === undefined ? {} : { open: !done }),
          }
        }),
      )

      return {
        ...(workItem ? { workItem } : {}),
        ...(workItem ? { trackerDone: statusIndicatesDone(workItem.state) } : {}),
        comments,
        change,
        dependencies,
      }
    },
    observeRepo: async (query) => {
      // 조회할 경로는 **작업 항목이 지목한 것**이 먼저다. 그것을 확인해야 좁은 범위를
      // 만들 수 있고, 확인하지 않으면 넓은 범위밖에 남지 않는다. 저장소의 최상위 자리도
      // 함께 확인한다 — 분류 이름이 어느 모듈 하나에만 맞는지 재려면 그 목록이 있어야 한다.
      const modules = await topLevelModules(projectRoot)
      const paths = [...new Set([...(query.paths ?? []), ...canonicalPaths])]
      return repo.observe({
        refHint: query.refHint,
        ...(canonicalRef ? { canonicalRef } : {}),
        ...(paths.length > 0 ? { paths } : {}),
        ...(modules.length > 0 ? { modulePaths: modules } : {}),
      })
    },
    usedIds: () => usedSessionIds(store, root),
    derive: (input) =>
      deriveSessionContractDraft({
        existingIds: input.existingIds,
        intent: { workRef: input.workRef, ...(input.goal ? { goal: input.goal } : {}) },
        workItem: input.workItem,
        workState: input.workState,
        repo: input.repo,
        // 상한이지 출처가 아니다 — 도출한 후보가 이 밖으로 나가지 않는지 재는 데만 쓴다.
        maxScopes: resolved?.resolved.policy.roleScopes.implementer ?? [],
        ...(resolved?.ownership ? { ownership: resolved.ownership } : {}),
        today: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
      }),
    plan: async (draft) =>
      planSessionContract({
        draft,
        ...(resolved?.resolved.policy ? { policy: resolved.resolved.policy } : {}),
        ...(resolved?.ownership ? { ownership: resolved.ownership } : {}),
        existingIds: await usedSessionIds(store, root),
      }),
    issue: async (draft) => {
      // 발급 경로는 하나뿐이다 — `asc session issue` 와 같은 SessionRuntime.issue 를 부른다.
      const issued = await runtime.issue({
        id: draft.id!,
        role: SessionRole.parse(draft.role ?? 'implementer'),
        goal: draft.goal ?? '',
        ...(draft.criteria ? { doneCriteria: [...draft.criteria] } : {}),
        ...(draft.boundary ? { writeBoundary: [...draft.boundary] } : {}),
        ...(draft.owner ? { owner: draft.owner } : {}),
      })
      if (!issued.ok) {
        return { ok: false, detail: issued.failures.map((f) => `${f.kind}: ${f.detail}`).join('; ') }
      }
      await auditLedger(store).delegate({
        childSessionId: issued.session.id,
        role: issued.session.role,
        goal: issued.session.goal,
        scope: issued.session.writeBoundary,
        doneCriteria: issued.session.doneCriteria,
        issuedBy: issued.session.owner ?? '(위임 범위 내 자동 발급)',
        issuedAt: new Date().toISOString(),
      })
      return { ok: true, sessionId: issued.session.id }
    },
  }
}

/** 세션 lifecycle. 계약을 발급하고, 중단·재개하고, Handoff까지 남긴다 (OM §6.2). */
/**
 * 이 세션이 걸린 결정마다 실제 결정권자. 세션 계약이 먼저고, 없으면 Profile 지도에서 푼다.
 * 풀리지 않은 것은 넣지 않는다 — 발급에서 이미 막혔거나, 막지 않기로 한 경로다.
 */
function effectiveAuthority(
  session: { decisionDomains: string[]; decisionAuthority: Record<string, string> },
  ownership: OwnershipMap | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const domain of session.decisionDomains) {
    const explicit = session.decisionAuthority[domain]
    if (explicit) {
      out[domain] = explicit
      continue
    }
    const found = lookupAuthority(ownership, domain)
    if (found.kind === 'RESOLVED') out[domain] = found.role
  }
  return out
}

/**
 * `--authority api-contract=backend` 를 map으로. 형식이 틀리면 조용히 버리지 않는다 —
 * 결정권자를 정했다고 믿는 사이 아무것도 정해지지 않는 것이 가장 나쁜 결과다.
 */
function parseAuthority(
  pairs: string[] | undefined,
): { ok: true; map: Record<string, string> } | { ok: false; detail: string } {
  const map: Record<string, string> = {}
  for (const pair of pairs ?? []) {
    const at = pair.indexOf('=')
    if (at <= 0 || at === pair.length - 1) {
      return { ok: false, detail: `--authority 는 <domain>=<role> 형식이다: '${pair}'` }
    }
    map[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return { ok: true, map }
}

/**
 * 초안을 재 본다. **아무것도 발급하지 않는다** (C-14 §6의 plan/apply 분리와 같은 자세).
 *
 * agent가 사용자 요청·work item·Profile·저장소를 읽어 계약 초안을 만들고, 여기서 그것이
 * 구조·경계로 성립하는지 확인한다. 판정은 셋뿐이다 — 발급해도 된다 / 사람이 정할 것이
 * 남았다 / 이 초안으로는 계약이 안 된다.
 */
async function runSessionPlan(
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  resolved?: ResolvedRuntime,
): Promise<number> {
  const authority = parseAuthority(values.authority as string[] | undefined)
  if (!authority.ok) {
    console.error(authority.detail)
    return 2
  }

  // 출처는 `<field>=<status>[:<source>]` 로 받는다 — 초안을 만든 쪽이 무엇을 확인했고
  // 무엇을 제안했는지 스스로 적게 한다. 적지 않으면 제안으로 셈한다(사실로 올리지 않는다).
  const provenance: DraftField[] = []
  for (const raw of (values.provenance as string[] | undefined) ?? []) {
    const [field, rest] = raw.split('=', 2)
    const [status, source] = (rest ?? '').split(':', 2)
    const parsed = DraftProvenance.safeParse({
      field,
      status,
      source: source ?? 'agent_proposal',
      ...(values.why ? { reason: (values.why as string[])[0] } : {}),
    })
    if (!parsed.success) {
      console.error(`--provenance 는 <field>=<FACT|PROPOSAL|DECISION_REQUIRED>[:<source>] 형식이다: '${raw}'`)
      return 2
    }
    provenance.push(parsed.data)
  }

  const draft: SessionContractDraft = {
    ...(values.id ? { id: values.id as string } : {}),
    ...(values.role ? { role: values.role as string } : {}),
    ...(values.goal ? { goal: values.goal as string } : {}),
    ...(values.boundary ? { boundary: values.boundary as string[] } : {}),
    ...(values.criteria ? { criteria: values.criteria as string[] } : {}),
    ...(values.owner ? { owner: values.owner as string } : {}),
    ...(values.domain ? { decisionDomains: values.domain as string[] } : {}),
    ...(Object.keys(authority.map).length > 0 ? { decisionAuthority: authority.map } : {}),
    ...(provenance.length > 0 ? { provenance } : {}),
  }

  const plan = planSessionContract({
    draft,
    ...(resolved?.resolved.policy ? { policy: resolved.resolved.policy } : {}),
    ...(resolved?.ownership ? { ownership: resolved.ownership } : {}),
    existingIds: (await store.list('session')).map((session) => session.id),
  })

  // 통과했을 때만 실행 가능한 명령을 준다. 통과하지 않은 초안의 명령을 함께 주면
  // agent는 그것을 "고치고 나서 쓸 것"이 아니라 "지금 쓸 것"으로 읽는다.
  //
  // 그리고 **완성된 계약이라고 해서 발급해도 되는 것은 아니다** (OM §450). 위임이 없으면
  // 명령은 `forController` 로 간다 — actions에 넣으면 "portable을 실행하라"는 지시를 따르는
  // agent가 사람의 권한을 대신 쓰게 된다.
  const issuable = plan.status === 'READY_TO_ISSUE'
  const command = {
    display: shorthandCommand(issueArgs(draft)),
    portable: shorthandCommand([...issueArgs(draft), '--json']),
  }
  const actions = issuable && plan.issuance.authority === 'delegated' ? [{ type: 'issue_session' as const, ...command }] : []
  const forController = issuable && plan.issuance.authority === 'controller' ? command : undefined

  if (values.json || values.agent) {
    console.log(
      JSON.stringify(
        { ...plan, nextActions: actions.map((action) => action.portable), actions, ...(forController ? { forController } : {}) },
        null,
        2,
      ),
    )
  } else {
    console.log(`${plan.status}${plan.draft.id ? ` — ${plan.draft.id}` : ''}`)
    for (const fact of plan.facts) console.log(`  fact      ${fact.field} (${fact.source})`)
    for (const proposal of plan.proposals) console.log(`  proposal  ${proposal.field} — ${proposal.reason ?? proposal.source}`)
    for (const item of plan.invalid) console.log(`  invalid   ${item.field}: ${item.detail}`)
    for (const item of plan.unresolved) {
      console.log(`  decide    ${item.field} [${item.reason}]: ${item.detail}`)
      for (const [index, option] of (item.options ?? []).entries()) {
        console.log(`              ${index + 1}. ${option}${item.recommended === index ? '   ← recommended' : ''}`)
      }
    }
    for (const action of actions) console.log(`\nIssue it: ${action.display}`)
    if (forController) {
      console.log(`\nThe contract holds. Issuing it is the Controller's — ${plan.issuance.detail}:`)
      console.log(`  ${forController.display}`)
    }
  }
  // 사람이 정할 것이 남았거나 초안이 성립하지 않으면 1이다 — setup plan과 같은 규칙.
  return plan.status === 'READY_TO_ISSUE' ? 0 : 1
}

async function runSession(
  command: string | undefined,
  target: string | undefined,
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  resolved?: ResolvedRuntime,
): Promise<number> {
  // Profile이 정한 Role 범위와 금지가 여기까지 와야 실제로 강제된다.
  // 정책 없이 만들면 붙어 있는 프로젝트에서도 계약 검사가 통째로 비어버린다.
  const scm = await scmFor(resolved)
  const runtime = new SessionRuntime(store, resolved?.resolved.policy ?? null, {
    ...(scm ? { scm } : {}),
    canonicalSources: (resolved?.canonicalSources ?? []).map((sourceId) => ({ sourceId })),
    ...(resolved?.ownership ? { ownership: resolved.ownership } : {}),
    // checkpoint·handoff 쓰기에도 owner 검사를 건다 (C-10 §2.3). Progress만 검사하던
    // 비대칭을 닫는다 — binding이 없는 세션은 지금처럼 그냥 통과한다.
    bindings: claudeBindings(store),
  })

  if (command === 'list') {
    const sessions = await store.list('session')
    if (sessions.length === 0) {
      console.log('No sessions')
      return 0
    }
    for (const session of sessions) {
      console.log(`${session.id}  ${session.status.padEnd(7)}  ${session.role.padEnd(12)}  ${session.goal}`)
    }
    return 0
  }

  // `plan` 은 **아직 세션이 없을 때** 부르는 것이므로 id를 요구하지 않는다. 초안에 id가
  // 없다는 사실 자체가 판정 대상이다 (없으면 그것이 unresolved로 나온다).
  if (command === 'plan') return runSessionPlan(values, store, resolved)

  if (!target) {
    console.error(`Usage: asc session ${command ?? '<command>'} <SESSION_ID>`)
    return 2
  }
  const at = new Date().toISOString()

  switch (command) {
    case 'issue': {
      const role = SessionRole.safeParse(values.role)
      if (!role.success || !values.goal) {
        console.error('--role and --goal are required (role: planner|researcher|implementer|verifier)')
        return 2
      }
      const authority = parseAuthority(values.authority as string[] | undefined)
      if (!authority.ok) {
        console.error(authority.detail)
        return 2
      }
      const issued = await runtime.issue({
        id: target,
        role: role.data,
        goal: values.goal as string,
        ...(values.criteria ? { doneCriteria: values.criteria as string[] } : {}),
        ...(values.block ? { blockId: values.block as string } : {}),
        ...(values.boundary ? { writeBoundary: values.boundary as string[] } : {}),
        ...(values.exception ? { policyExceptions: values.exception as string[] } : {}),
        ...(values.owner ? { owner: values.owner as string } : {}),
        ...(values.domain ? { decisionDomains: values.domain as string[] } : {}),
        ...(Object.keys(authority.map).length > 0 ? { decisionAuthority: authority.map } : {}),
        ...(values.dependency ? { dependencies: values.dependency as string[] } : {}),
      })
      if (!issued.ok) {
        console.error('Could not issue the session:')
        for (const failure of issued.failures) console.error(`  - ${failure.kind}: ${failure.detail}`)
        return 1
      }
      // 위임을 **선언**으로 남긴다 (C-10 §1.1). 상태 전이는 일으키지 않는다 —
      // 누가 맡겼는지는 세션 상태가 아니라 별도 증거다.
      const audit = auditLedger(store)
      const delegated = await audit.delegate({
        ...(values.parent ? { parentSessionId: values.parent as string } : {}),
        childSessionId: issued.session.id,
        role: issued.session.role,
        goal: issued.session.goal,
        scope: issued.session.writeBoundary,
        doneCriteria: issued.session.doneCriteria,
        issuedBy: (values['issued-by'] as string) ?? (values.as as string) ?? issued.session.owner ?? '(미상)',
        issuedAt: at,
        ...(values.parent ? { expectedReturnTo: values.parent as string } : {}),
      })
      console.log(`${issued.session.id} READY — ${issued.session.goal}`)
      if (delegated.ok) console.log(delegationLine(delegated.record, issued.session.id))
      return 0
    }

    case 'decision': {
      const selected = values.selected as string | undefined
      const decisionClass = values.class as string | undefined
      if (!selected || !decisionClass) {
        console.error(
          '사용법: asc session decision <S-ID> --class <c> --selected <t> --why <t>... --evidence <ref>...',
        )
        return 2
      }
      const evidence = (values.evidence as string[]) ?? []
      const why = (values.why as string[]) ?? []
      if (evidence.length === 0 || why.length === 0) {
        // 근거와 "왜 경계가 아니었는가"가 없으면 자율 판단이 아니라 그냥 안 물어본 것이다
        console.error('At least one --evidence and one --why are required (C-13 §4).')
        return 2
      }
      const audit = auditLedger(store)
      const recorded = await audit.decide({
        sessionId: target,
        actor: (values.as as string) ?? (values.principal as string) ?? '(미상)',
        ownership: (values.ownership as string[]) ?? [],
        class: decisionClass as DecisionClass,
        evidenceRefs: [evidence[0]!, ...evidence.slice(1)],
        selectedOption: selected,
        alternatives: (values.alternative as string[]) ?? [],
        whyNoApproval: [why[0]!, ...why.slice(1)],
        verification: (values.verification as string[]) ?? [],
        decidedAt: at,
      })
      for (const line of decisionLines([recorded.decision])) console.log(line)
      return 0
    }

    case 'validate': {
      const result = values.result === 'PASS' || values.result === 'FAIL' ? values.result : null
      if (!values.validator || !result) {
        console.error('Usage: asc session validate <target S-ID> --validator <validator S-ID> --result PASS|FAIL')
        return 2
      }
      const audit = auditLedger(store)
      const targetSession = await store.get('session', target)
      const recorded = await audit.validate({
        validatorSessionId: values.validator as string,
        targetSessionId: target,
        result,
        ...(values.finding ? { findings: values.finding as string[] } : {}),
        ...(targetSession?.handoff ? { targetHandoffRef: targetSession.handoff.recordedAt } : {}),
        ...(values.revision ? { targetRevision: values.revision as string } : {}),
        verifiedAt: at,
      })
      if (!recorded.ok) {
        console.error(recorded.detail)
        return 1
      }
      for (const line of validationLines([recorded.record])) console.log(line)
      if (recorded.record.independence !== 'INDEPENDENT') {
        console.log('This record does not count as independent verification — see the reason above.')
      }
      return 0
    }

    case 'report': {
      const audit = auditLedger(store)
      const found = (await store.get('session', target)) ?? null
      if (!found) {
        // 회수된 세션은 archive로 갔다. 증거는 남아 있으므로 audit으로 보라고 말한다.
        console.error(`${target} is not in the current list — if it was collected, try asc session audit ${target}`)
        return 1
      }
      const executions = await audit.executionsOf(target)
      const validations = await audit.validationsOf(target)
      const report = buildFinalReport({
        session: found,
        executions,
        validations,
        decisions: await audit.decisionsOf(target),
        escalations: (await escalationLedger(store).pending()).filter((e) => e.sessionId === target),
        reclaim: await audit.reclaimOf(target),
        derived: deriveExecutionState({
          ...(found.handoff ? { metCriteria: found.handoff.done } : {}),
          doneCriteria: found.doneCriteria,
          ...(validations.length > 0
            ? { verificationPassed: validations.every((v) => v.result === 'PASS') }
            : {}),
          ...(found.handoff?.unresolved.length ? { waitingOn: found.handoff.unresolved } : {}),
        }),
      })
      if (values.json) {
        console.log(JSON.stringify(report, null, 2))
        return 0
      }
      for (const line of renderFinalReport(report)) console.log(line)
      return 0
    }

    case 'audit': {
      const audit = auditLedger(store)
      const session = (await store.get('session', target)) ?? null
      const bindings = claudeBindings(store)
      console.log(delegationLine(await audit.delegationOf(target), target))
      if (session) {
        console.log(`Status: ${session.status} · role: ${session.role}`)
        // 검증자가 대조할 acceptance가 여기 없으면 세션 파일을 직접 열어야 한다 (dogfood에서 잡힘)
        if (session.doneCriteria.length > 0) {
          console.log('Done criteria:')
          const done = new Set(session.handoff?.done ?? [])
          for (const item of session.doneCriteria) console.log(`  ${done.has(item) ? '[x]' : '[ ]'} ${item}`)
        }
        if (session.writeBoundary.length > 0) console.log(`Write boundary: ${session.writeBoundary.join(', ')}`)
      }
      if (session?.checkpoint) {
        const c = session.checkpoint
        console.log(`Latest checkpoint: ${c.position}${c.currentJudgment ? ` — ${c.currentJudgment}` : ''}`)
        if (c.blockers.length > 0) console.log(`  blocked: ${c.blockers.join(' · ')}`)
      }
      if (session?.handoff) {
        console.log(`Handoff: ${session.handoff.next}`)
        // 무엇을 고쳤는지가 비어 있으면 검증자가 저장소를 뒤져 알아내야 한다
        console.log(
          session.handoff.changed.length > 0
            ? `  changed: ${session.handoff.changed.join(', ')}`
            : '  changed: (nothing recorded — the ASC record cannot say what changed)',
        )
        console.log(`  self-check (not independent verification): ${session.handoff.verified}`)
      }
      console.log('Execution:')
      for (const line of executionLines(await audit.executionsOf(target))) console.log(line)
      console.log('Decided without approval:')
      for (const line of decisionLines(await audit.decisionsOf(target))) console.log(line)
      const openEscalations = (await escalationLedger(store).all()).filter((e) => e.sessionId === target)
      console.log('Escalated:')
      if (openEscalations.length === 0) console.log('  no escalations')
      for (const record of openEscalations) {
        console.log(`  ${record.escalationId} [${record.predicates.join(', ')}] ${record.question} → ${record.requestId}`)
        console.log(`    blocked: ${record.blockedNodes.join(', ')}`)
        // 검증자는 "어느 경계라서 못 했는가"를 여기서 봐야 한다 — 세션 파일을 직접 열게 하지 않는다
        if (record.blockedScope.length > 0) console.log(`    boundary: ${record.blockedScope.join(', ')}`)
        if (record.stillRunnableNodes.length > 0) console.log(`    still ran: ${record.stillRunnableNodes.join(', ')}`)
      }
      console.log('Verification:')
      for (const line of validationLines(await audit.validationsOf(target))) console.log(line)
      console.log(reclaimLine(await audit.reclaimOf(target), target))
      const owner = await bindings.get(target)
      console.log(`Currently held by: ${owner ? owner.physicalSessionId : 'nobody (released, or never picked up)'}`)
      const children = await audit.delegationsFrom(target)
      if (children.length > 0) {
        console.log('Delegated by this session:')
        for (const child of children) console.log(`  ${delegationLine(child, child.childSessionId)}`)
      }
      return 0
    }

    case 'start':
      return reportStart(await runtime.start(target), `${target} ACTIVE`)

    case 'pause': {
      if (!values.position || !values.next) {
        console.error('--position and --next are required. Whoever picks this up reads them.')
        return 2
      }
      const checkpoint = Checkpoint.parse({
        position: values.position,
        completedTasks: (values.done as string[]) ?? [],
        nextAction: values.next,
        uncommittedChanges: (values.changed as string[]) ?? [],
        // 의미 있는 전환을 남긴다 (C-10 §2.1) — 지금 무엇이 사실이라고 보는가, 무엇이
        // 막고 있는가, 그 판단의 근거는 무엇인가.
        ...(values.judgment ? { currentJudgment: values.judgment as string } : {}),
        ...(values.blocker ? { blockers: values.blocker as string[] } : {}),
        ...(values.risk ? { risks: values.risk as string[] } : {}),
        ...(values.evidence ? { evidenceRefs: values.evidence as string[] } : {}),
        ...(values.physical ? { writtenBy: values.physical as string } : {}),
        recordedAt: at,
      })
      return report(
        await runtime.pause(target, checkpoint, values.physical as string | undefined),
        `${target} PAUSED — 다음: ${checkpoint.nextAction}`,
      )
    }

    case 'resume': {
      const session = await runtime.get(target)
      if (session?.checkpoint) {
        console.log(`Resume at: ${session.checkpoint.position}`)
        console.log(`Next action: ${session.checkpoint.nextAction}`)
        if (session.checkpoint.uncommittedChanges.length > 0) {
          console.log(`Uncommitted: ${session.checkpoint.uncommittedChanges.join(', ')}`)
        }
      }
      return reportStart(await runtime.resume(target), `${target} ACTIVE`)
    }

    case 'done': {
      if (!values.verified || !values.next) {
        console.error('--verified and --next are required. They record what was checked, and how.')
        return 2
      }
      const handoff = Handoff.parse({
        done: (values.done as string[]) ?? [],
        changed: (values.changed as string[]) ?? [],
        verified: values.verified,
        unresolved: (values.unresolved as string[]) ?? [],
        next: values.next,
        recordedAt: at,
      })
      const outcome = await runtime.complete(target, handoff, values.physical as string | undefined)
      if (!outcome.ok) return report(outcome, '')
      console.log(`${target} DONE — handoff written`)
      console.log('Updating state and blocks is the Controller\'s: `asc controller collect`')
      return 0
    }

    default:
      console.error(`Unknown session command: ${command ?? '(none)'}\n\n${USAGE}`)
      return 2
  }
}

/** 정본이 움직였으면 무엇이 어떻게 달라졌는지 보이고 멈춘다. */
function reportStart(
  outcome: {
    ok: boolean
    reason?: string
    detail?: string
    drifts?: { sourceId: string; recorded: string; current: string }[]
    failure?: { message: string }
  },
  success: string,
): number {
  if (!outcome.ok && outcome.reason === 'CANONICAL_UNAVAILABLE') {
    console.error(`The canonical source cannot be read: ${outcome.detail}`)
    console.error('Nothing starts while it is unknown what it stands on.')
    return 1
  }
  if (!outcome.ok && outcome.reason === 'CANONICAL_DRIFT') {
    console.error('The canonical source differs from when this was issued — the ground under the contract moved:')
    for (const drift of outcome.drifts ?? []) {
      console.error(`  ${drift.sourceId}: ${drift.recorded} → ${drift.current}`)
    }
    console.error('\nReview the changes, and hand the contract back to the Controller if they affect it.')
    return 1
  }
  return report(outcome, success)
}

function report(
  outcome: { ok: boolean; reason?: string; detail?: string; failure?: { message: string } },
  success: string,
): number {
  if (outcome.ok) {
    console.log(success)
    return 0
  }
  if (outcome.reason === 'REJECTED') console.error(outcome.failure!.message)
  // 소유권 거부는 이유를 그대로 보여준다 — "실패: NOT_OWNER" 만으로는 누가 owner인지 모른다
  else console.error(outcome.detail ?? `failed: ${outcome.reason}`)
  return 1
}

/** 끝난 세션을 거둬 Controller 상태를 다시 쓴다. 세션은 이 문서를 직접 고치지 않는다. */
async function runController(
  command: string | undefined,
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  resolved?: ResolvedRuntime,
): Promise<number> {
  if (command !== 'collect') {
    console.error(`Unknown controller command: ${command ?? '(none)'}\n\n${USAGE}`)
    return 2
  }
  // Core는 Profile을 모른다 — 선언을 꺼내 넘기는 것은 Surface의 몫이다
  const checklist = resolved?.resolved.policy.lists[CLOSURE_CHECKLIST] ?? []
  const reclaimedBy = (values.as as string) ?? Object.keys(resolved?.controllerIdentities ?? {})[0]
  if (!reclaimedBy) {
    console.error(
      '누가 거두는지 알 수 없다 — --as <주체> 로 지정하거나 override.json 의 controller.identities 를 채워라.',
    )
    return 2
  }
  const outcome = await collectSessions(store, new Date().toISOString(), {
    closureChecklist: checklist,
    closureLedger: closureLedger(store),
    queryLedger: queryLedger(store, resolved),
    escalationLedger: escalationLedger(store),
    auditLedger: auditLedger(store),
    // 누가 거뒀는지 모르면 History에 'controller' 라는 익명이 남는다 (C-10 §2.4)
    ...(reclaimedBy ? { reclaimedBy } : {}),
  })
  console.log(renderCollect(outcome, await store.list('session')))

  // 거둔 세션의 live 진행 표시는 여기서 정리한다 — 종결 보고(terminal)는 남는다
  const cleared = await progressService(store).collect(outcome.collected)
  if (cleared.length > 0) console.log(`\nCleared progress markers: ${cleared.join(', ')}`)
  return 0
}

/**
 * Bounded Query (B-25) — 다른 파트에 묻되 답할 수 있는 형태로만 묻는다.
 * 답 하나로 권한이 생기지 않는다. 여기서 나가는 것은 정보뿐이다 (C-04 §3.4).
 */
async function runQuery(
  command: string | undefined,
  target: string | undefined,
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  resolved?: ResolvedRuntime,
): Promise<number> {
  const ledger = queryLedger(store, resolved)

  if (command === 'list') {
    const entries = await ledger.list()
    const violations = await ledger.violations()
    if (values.json) {
      console.log(JSON.stringify({ entries, violations }, null, 2))
      return 0
    }
    if (entries.length === 0 && violations.length === 0) {
      console.log('No queries')
      return 0
    }
    for (const { query, answer } of entries) {
      const state = answer ? `${answer.kind} — ${answer.byRole}` : '답 대기'
      console.log(`${query.id}  ${query.requestedAuthority.padEnd(20)}  ${state}`)
      console.log(`    ${query.question}`)
      if (answer) console.log(`    → ${answer.body}`)
      else if (query.proposedDefault) console.log(`    (with no answer: ${query.proposedDefault})`)
    }
    for (const v of violations) console.log(`${v.attemptedId}  ${v.kind} — ${v.detail}`)
    return 0
  }

  if (!target) {
    console.error(`Usage: asc query ${command ?? '<command>'} <X-ID>`)
    return 2
  }

  if (command === 'open') {
    const domain = (values.domain as string[] | undefined)?.[0]
    if (!values.session || !domain || !values.question) {
      console.error('--session, --domain and --question are required.')
      return 2
    }
    const session = await store.get('session', values.session as string)
    if (!session) {
      console.error(`Session '${values.session}' was not found.`)
      return 1
    }
    const expected = values['expect-response'] as 'DECIDE' | 'ANSWER' | undefined
    if (expected && expected !== 'DECIDE' && expected !== 'ANSWER') {
      console.error('--expect-response must be DECIDE or ANSWER.')
      return 2
    }
    const outcome = await ledger.open({
      id: target,
      ownerSessionId: session.id,
      ...(session.owner ? { ownerRole: session.owner } : {}),
      requestedAuthority: domain,
      question: values.question as string,
      ...(values.context ? { context: values.context as string } : {}),
      ...(values.default ? { proposedDefault: values.default as string } : {}),
      ...(values.blocking ? { blockingScope: values.blocking as string } : {}),
      ...(expected ? { expectedResponse: expected } : {}),
      ...(values['in-reply-to'] ? { inReplyTo: values['in-reply-to'] as string } : {}),
    })
    if (!outcome.ok) {
      console.error(`Could not open the query — ${outcome.reason}`)
      console.error(`  ${outcome.detail}`)
      return 1
    }
    console.log(`${outcome.query.id} opened — waiting for an answer on '${outcome.query.requestedAuthority}'.`)
    console.log(`${outcome.query.ownerSessionId} asked, and an answer does not transfer ownership of the work.`)
    return 0
  }

  if (command === 'answer') {
    const kind = values.kind as string | undefined
    if (kind !== 'DECIDE' && kind !== 'ANSWER' && kind !== 'ESCALATE') {
      console.error('--kind must be one of DECIDE|ANSWER|ESCALATE.')
      return 2
    }
    if (!values.by || !values.body) {
      console.error('--by <role> and --body <text> are required.')
      return 2
    }
    if (kind === 'ESCALATE' && !values.to) {
      console.error('ESCALATE requires --to <authority> — it goes to a person with authority, not to another agent.')
      return 2
    }
    const outcome = await ledger.answer(target, {
      kind,
      byRole: values.by as string,
      body: values.body as string,
      ...(values.to ? { escalateTo: values.to as string } : {}),
    })
    if (!outcome.ok) {
      console.error(`Could not answer — ${outcome.reason}`)
      console.error(`  ${outcome.detail}`)
      return 1
    }
    console.log(`${target} ${outcome.answer.kind} — ${outcome.answer.byRole}`)
    console.log(`Control returns to ${outcome.query.ownerSessionId}. This answer creates no approval, authority or scope.`)
    return 0
  }

  console.error(`Unknown query command: ${command ?? '(none)'}\n\n${USAGE}`)
  return 2
}

/** Profile이 마무리 항목을 선언하는 관례 키 (B-20). */
const CLOSURE_CHECKLIST = 'closureChecklist'

/** Orchestration Audit (C-10). 회수 후에도 남는 기록이라 Progress와 다른 자리에 산다. */
const auditLedger = (store: MarkdownStateStore) => new AuditLedger(store.scope('audit'))

const closureLedger = (store: MarkdownStateStore) => new ClosureLedger(store.scope('closure'))

/** Bounded Query (B-25). 결정권 판정에 Profile 책임 지도가 필요하다. */
const queryLedger = (store: MarkdownStateStore, resolved?: ResolvedRuntime) =>
  new QueryLedger(store.scope('query'), resolved?.ownership)

/**
 * 프로젝트 마무리 의무 (B-20). 확인은 Controller가 항목 id로 명시한다 —
 * Handoff 텍스트를 읽어 추론하지 않는다.
 */
async function runClosure(
  command: string | undefined,
  target: string | undefined,
  values: Record<string, unknown>,
  store: MarkdownStateStore,
): Promise<number> {
  const ledger = closureLedger(store)

  if (command === 'list') {
    const records = target ? [await ledger.get(target)].filter((r) => r !== null) : await ledger.list()
    if (records.length === 0) {
      console.log(target ? `${target} has no closure record.` : 'No closure records.')
      return target ? 1 : 0
    }
    if (values.json) {
      console.log(JSON.stringify(records, null, 2))
      return 0
    }
    for (const record of records) {
      const pending = record.declared.filter((item) => !record.confirmed.includes(item))
      const state = record.closedAt ? `닫힘 (${record.closedAt})` : `미확인 ${pending.length}건`
      console.log(`${record.logicalSessionId} — ${state}`)
      for (const item of record.declared) {
        console.log(`  ${record.confirmed.includes(item) ? '[x]' : '[ ]'} ${item}`)
      }
    }
    return 0
  }

  if (command === 'confirm') {
    const items = (values.item as string[] | undefined) ?? []
    if (!target || items.length === 0) {
      console.error('Usage: asc closure confirm <S-ID> --item <item id>...')
      return 2
    }
    const outcome = await ledger.confirm(target, items)
    if (!outcome.ok) {
      console.error(`Could not confirm (${outcome.reason}): ${outcome.detail}`)
      if (outcome.reason === 'UNKNOWN_ITEM') {
        console.error(`Declared items: ${outcome.declared.join(', ')}`)
      }
      return 1
    }
    const pending = outcome.record.declared.filter((i) => !outcome.record.confirmed.includes(i))
    console.log(
      outcome.newlyClosed
        ? `${target} 마무리 완료 — 선언된 ${outcome.record.declared.length}건 전부 확인됐다.`
        : `${target} 확인 ${items.length}건 기록. 남은 항목: ${pending.join(', ')}`,
    )
    return 0
  }

  console.error(`Unknown closure command: ${command ?? '(none)'}\n\n${USAGE}`)
  return 2
}

/**
 * hook이 남긴 활동 신호. 진척이 아니라 "도구가 돌았다"까지이므로 Renderer에
 * 보조 정보로만 넘긴다 — 없으면 없는 대로 둔다 (B-18).
 */
async function livenessOf(
  store: MarkdownStateStore,
  logicalSessionId: string,
): Promise<{ lastActivityAt: string; lastTool?: string } | null> {
  const beat = await readHeartbeat(store.scope(CLAUDE_SCOPE), logicalSessionId)
  if (!beat) return null
  return { lastActivityAt: beat.lastActivityAt, ...(beat.lastTool ? { lastTool: beat.lastTool } : {}) }
}

/** Core는 provider를 모른다 — 소유권 판정에 쓸 binding은 Surface가 조립해 넘긴다. */
function progressService(store: MarkdownStateStore): ProgressService {
  return new ProgressService({
    scope: store.scope('progress'),
    bindings: claudeBindings(store),
    appendHistory: (entry) => store.appendHistory(entry),
  })
}

/**
 * 산출 경로를 넘기기 전에 맞춰 본다 (B-19). 판정과 제안까지만 — 범위를 넓히거나
 * 역할을 바꾸거나 세션을 발급하지 않는다. 그건 Controller의 결정이다.
 */
async function runPreflight(
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  resolved?: ResolvedRuntime,
): Promise<number> {
  const paths = (values.path as string[] | undefined) ?? []
  if (paths.length === 0 || (!values.role && !values.session)) {
    console.error("Usage: asc preflight --path <path>... (--role <role> | --session <S-ID>)")
    return 2
  }
  if (values.role && values.session) {
    // 둘을 겹쳐 받으면 어느 쪽으로 판정했는지 출력만 봐서는 알 수 없다
    console.error('Pass either --role or --session, not both — the maximum scope and a session contract are different standards.')
    return 2
  }

  let target: PreflightTarget
  if (values.session) {
    const session = await store.get('session', values.session as string)
    if (!session) {
      console.error(`Session '${values.session}' was not found.`)
      return 1
    }
    target = {
      kind: 'session',
      sessionId: session.id,
      role: session.role,
      writeBoundary: session.writeBoundary,
      ...(session.owner ? { owner: session.owner } : {}),
      ...(session.decisionDomains.length > 0 ? { decisionDomains: session.decisionDomains } : {}),
      ...(Object.keys(session.decisionAuthority).length > 0
        ? { decisionAuthority: session.decisionAuthority }
        : {}),
    }
  } else {
    const role = SessionRole.safeParse(values.role)
    if (!role.success) {
      console.error('--role must be one of planner|researcher|implementer|verifier')
      return 2
    }
    const scopes = resolved?.resolved.policy.roleScopes
    target = { kind: 'role', role: role.data, maxScope: scopes ? scopes[role.data] : undefined }
  }

  const result = preflight({
    paths,
    target,
    ...(resolved ? { policy: resolved.resolved.policy } : {}),
    ...(resolved?.ownership ? { ownership: resolved.ownership } : {}),
  })

  if (values.json) {
    console.log(JSON.stringify(result, null, 2))
    return result.undecidable || result.mismatches.length > 0 || result.authorityGaps.length > 0 ? 1 : 0
  }

  const against =
    result.target.kind === 'role'
      ? `역할 '${result.target.role}' 의 최대 쓰기 범위`
      : `${result.target.sessionId} 의 쓰기 범위`

  if (result.undecidable) {
    console.error(`Cannot compare: ${result.undecidable}`)
    return 1
  }
  if (result.mismatches.length === 0 && result.authorityGaps.length === 0) {
    console.log(`All ${paths.length} output paths fall inside ${against}.`)
    if (result.target.kind === 'session' && result.target.decisionDomains?.length) {
      console.log(`All ${result.target.decisionDomains.length} decision domains have an owner.`)
    }
    return 0
  }

  if (result.mismatches.length > 0) {
    console.error(`Some output paths fall outside ${against}:`)
    for (const v of result.verdicts) {
      if (v.verdict === 'OK') continue
      console.error(`  - ${v.verdict}: ${v.path}`)
    }
  }
  if (result.authorityGaps.length > 0) {
    console.error('Some decisions have no owner:')
    for (const gap of result.authorityGaps) console.error(`  - ${gap.lookup.kind}: ${gap.domain}`)
  }
  console.error('\nAlternatives (not executed — the Controller decides):')
  for (const suggestion of result.suggestions) console.error(`  · ${suggestion}`)
  return 1
}

/** 작업 "중" 가시성 (B-17). 기록은 owner만, 표시는 사람 말로. */
async function runProgress(
  command: string | undefined,
  target: string | undefined,
  values: Record<string, unknown>,
  store: MarkdownStateStore,
): Promise<number> {
  const service = progressService(store)

  if (command === 'show') {
    // 지목이 없으면 지금 돌고 있는 것을 보여준다 — 사람이 id를 외우게 하지 않는다
    const active = (await store.list('session')).filter((s) =>
      target ? s.id === target : s.status === 'ACTIVE' || s.status === 'PAUSED',
    )
    // 거둔 세션은 활성 목록에 없다. 종결 보고가 남아 있으면 그것만으로 보여준다.
    const targets: { id: string; session: Session | null }[] =
      active.length > 0
        ? active.map((s) => ({ id: s.id, session: s }))
        : target && (await service.get(target))
          ? [{ id: target, session: null }]
          : []

    if (targets.length === 0) {
      console.log(target ? `${target} was not found.` : 'No work in progress.')
      return target ? 1 : 0
    }
    const openEscalations = await escalationLedger(store).pending()
    for (const { id, session } of targets) {
      const liveness = await livenessOf(store, id)
      const awaiting = openEscalations.filter((record) => record.sessionId === id).map((r) => r.escalationId)
      const rendered = renderProgress({
        session,
        progress: await service.get(id),
        ...(liveness ? { liveness } : {}),
        ...(awaiting.length > 0 ? { awaiting } : {}),
      })
      if (values.json) {
        console.log(JSON.stringify({ session: id, ...rendered }, null, 2))
      } else {
        console.log(rendered.body.join('\n\n'))
        console.log(`\n> detail: ${rendered.detail}`)
      }
    }
    return 0
  }

  if (command === 'report') {
    if (!target || !values.physical || !values.phase) {
      console.error('Usage: asc progress report <S-ID> --physical <id> --phase "what is happening now"')
      return 2
    }
    const decision = parseEnumArg(values.decision, ['none', 'later', 'now'] as const, 'decision')
    const verifier = parseEnumArg(values.verifier, ['none', 'running', 'pass', 'fail'] as const, 'verifier')
    if (decision === null || verifier === null) return 2

    const outcome = await service.report(target, values.physical as string, {
      phase: values.phase as string,
      ...(values.milestone ? { milestones: values.milestone as string[] } : {}),
      ...(values.next ? { nextStep: values.next as string } : {}),
      ...(values.unresolved ? { unresolved: values.unresolved as string[] } : {}),
      ...(decision ? { needsUserDecision: decision.toUpperCase() as 'NONE' | 'LATER' | 'NOW' } : {}),
      ...(values['decision-ref'] ? { decisionRef: values['decision-ref'] as string } : {}),
      ...(verifier ? { verifier: verifier.toUpperCase() as 'NONE' | 'RUNNING' | 'PASS' | 'FAIL' } : {}),
      ...(values['verifier-detail'] ? { verifierDetail: values['verifier-detail'] as string } : {}),
      ...(values.terminal ? { terminal: true } : {}),
    })
    if (!outcome.ok) {
      console.error(`Could not record the progress report (${outcome.reason}): ${outcome.detail}`)
      return 1
    }
    console.log(`${target} progress recorded — ${outcome.report.phase}`)
    return 0
  }

  console.error(`Unknown progress command: ${command ?? '(none)'}\n\n${USAGE}`)
  return 2
}

/** 잘못된 값을 조용히 기본값으로 흘리지 않는다 — 오타가 상태를 왜곡하면 표시를 못 믿는다. */
function parseEnumArg<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  flag: string,
): T | undefined | null {
  if (raw === undefined) return undefined
  if (allowed.includes(raw as T)) return raw as T
  console.error(`Invalid value for --${flag}: ${String(raw)} (allowed: ${allowed.join('|')})`)
  return null
}

/** 한 회차 감지. 읽기만 하고, 무엇을 할지는 사람이 정한다. */
/**
 * 감시 엔진을 세운다. **조립과 출력을 나눈다** — 상시 Runtime(C-12)이 같은 엔진을
 * 주기적으로 부르려면 조립이 명령 출력 안에 갇혀 있으면 안 된다.
 */
async function buildMonitorEngine(
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  resolved: ResolvedRuntime,
): Promise<{ ok: true; engine: MonitorEngine; sourceId: string; repo: string } | { ok: false; code: number }> {
  const token = await discoverToken()
  if (!token) {
    console.error('No GitHub token found. Set ASC_GITHUB_TOKEN, or run `gh auth login`.')
    return { ok: false, code: 2 }
  }

  // 감시 대상도, 누가 나인지도, 누가 승인자인지도 전부 설정에서 온다.
  // 명령줄로 받던 값들은 각자 제자리(Profile·Override)를 찾았다.
  const repo = resolved.layers.profile.project.repository
  const approver = (values.as as string) ?? Object.keys(resolved.controllerIdentities)[0]
  if (!approver) {
    console.error('No approver is known. Fill in controller.identities in override.json, or pass --as.')
    return { ok: false, code: 2 }
  }
  if ((resolved.monitor.identities?.length ?? 0) === 0) {
    // 누가 나인지 모르면 mention·assign 신호가 서지 않아 감지가 사실상 비어버린다
    console.error('Warning: monitorIdentities in override.json is empty — things addressed to you cannot be recognised.')
  }

  // provider를 CLI가 고르지 않는다. 선언된 요구와 실제 remote에서 Binding이 풀리고,
  // 갈리면 고르지 않고 말한다 — silent substitution 0 (C-11 §7).
  const { root: projectRoot } = await discoverProjectRoot(process.cwd())
  const adapters = defaultAdapters()
  const declared = resolved.layers.profile.bindings ?? []
  const plan = await composeBindings({
    context: { projectRoot, env: process.env },
    adapters,
    roles: declared.map((b) => ({ adapterId: b.adapter, resource: b.resource, role: b.role })),
  })
  const ports = await buildRuntimePorts({
    plan,
    roles: rolesFor(plan, declared),
    perPage: 30,
    endpointFor: (binding) => endpointOf(adapters, binding),
  })
  if (!ports.eventSource) {
    console.error('No monitoring channel could be built:')
    for (const reason of ports.unavailable) console.error(`  - ${reason}`)
    console.error('\nDeclare which provider takes which role in the Profile bindings.')
    return { ok: false, code: 2 }
  }

  const canonicalPaths = resolved.layers.profile.canonical.sources.flatMap((source) => source.paths)
  const myRoles = resolved.layers.override?.monitor.roles ?? []
  const changeContext = ports.changeContext
  const engine = new MonitorEngine({
    store,
    source: ports.eventSource,
    ...(ports.scm ? { scm: ports.scm } : {}),
    ...(ports.inventory ? { inventory: ports.inventory } : {}),
    // 밖에서 알아 온 사실을 실제로 공급한다 (C-07 §2~§4). 이것이 없으면 Relevance·
    // Shadow·Material Change가 코드에만 있고 실행 경로에는 없다.
    ...(changeContext
      ? {
          observe: buildEventObservation({
            change: changeContext,
            ...(resolved.ownership ? { ownership: resolved.ownership } : {}),
            ...(myRoles.length ? { myRoles } : {}),
            ...(canonicalPaths.length ? { canonicalPaths } : {}),
          }),
        }
      : {}),
    // scope는 실제로 붙은 source가 정한다 — provider 이름을 CLI가 박지 않는다.
    observations: new ObservationLedger(store.scope(monitorScope(ports.eventSource.id))),
    // 조사 단계가 요청하는 통로들. 없는 것은 그 단계가 판정 불성립으로 남는다 (C-07 §6.2).
    // 없는 것을 있는 척하지 않는다.
    investigation: {
      ...(ports.resourceContext ? { resource: ports.resourceContext } : {}),
      ...(changeContext ? { change: changeContext } : {}),
    },
    // Core는 Profile을 모른다 — 조사에 필요한 프로젝트 사실을 Surface가 꺼내 준다.
    investigationContext: () => ({
      ...(resolved.ownership ? { ownership: resolved.ownership } : {}),
      canonicalPaths,
    }),
    config: resolved.monitor,
    authorizedApprover: approver,
    canonicalSources: resolved.canonicalSources,
    // 처음 돌 때 과거를 통째로 긁으면 사람이 읽을 수 없다 (OM §18)
    ...(values.backfill ? {} : { startFrom: new Date().toISOString() }),
  })

  await rememberMonitorSource(store, ports.eventSource.id)

  // **밀려난 후보를 말한다.** 실 프로젝트 관측에서 나온 것이다: primary가 자격 없음으로
  // 빠지고 mirror에 조용히 붙으면 "감시가 도는데 아무것도 안 잡히는" 상태가 된다.
  // 고르는 것 자체는 막지 않되, 무엇이 밀렸는지 모르게 두지 않는다 (C-11 §7).
  const skipped = plan.bindings.filter((b) => b.state !== 'AVAILABLE' && b.state !== 'DEGRADED')
  if (skipped.length > 0) {
    console.error(`Monitoring runs on ${ports.eventSource.id}. Some candidates could not be used:`)
    for (const binding of skipped) {
      console.error(`  - ${binding.adapterId}:${binding.resource} — ${binding.state}${binding.detail ? ` (${binding.detail})` : ''}`)
    }
  }
  for (const reason of ports.unavailable) console.error(`  - ${reason}`)

  return { ok: true, engine, sourceId: ports.eventSource.id, repo }
}

/**
 * 상시 Runtime (C-12). 대화를 켜 두지 않고 **상태를 지속시키고 계산을 짧게 돌린다.**
 *
 * 여기는 계기만 갖는다 — 판정도 승인도 하지 않고, 사람이 부르던 것과 같은 함수를 부른다.
 * 재기동해도 cursor·lease·observation이 저장소에 있으므로 같은 사건을 다시 만들지 않는다.
 */
async function runRuntime(
  command: string | undefined,
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  renderer: TextRenderer,
  resolved?: ResolvedRuntime,
): Promise<number> {
  if (command !== 'start' && command !== 'tick') {
    console.error(`Unknown runtime command: ${command ?? '(none)'}\n\n${USAGE}`)
    return 2
  }
  if (!resolved) {
    console.error('This only runs inside an attached project. Run `asc init --profile <id>` first.')
    return 2
  }

  const built = await buildMonitorEngine(values, store, resolved)
  if (!built.ok) return built.code
  const { engine } = built

  const minutes = (value: unknown, fallback: number): number =>
    value === undefined ? fallback * 60_000 : Number(value) * 60_000
  // 주기는 Core 상수가 아니다 (C-12 불변식 ③). 명령줄이 정하고, 기본값은 여기 산다.
  const schedule = {
    deltaMs: minutes(values['delta-min'], 5),
    reconcileMs: minutes(values['reconcile-min'], 60),
    censusMs: minutes(values['census-min'], 24 * 60),
    digestMs: minutes(values['digest-min'], 60),
  }

  const scope = store.scope('runtime')
  const orchestrator = new Orchestrator({
    schedule,
    log: (line) => console.log(line),
    lastRunAt: {
      read: async () => {
        const raw = await scope.get('last-run')
        return raw ? (JSON.parse(raw) as Record<string, string>) : {}
      },
      write: async (kind, at) => {
        const raw = await scope.get('last-run')
        const current = raw ? (JSON.parse(raw) as Record<string, string>) : {}
        await scope.set('last-run', JSON.stringify({ ...current, [kind]: at }))
      },
    },
    actions: {
      delta: async () => {
        const outcome = await engine.scan()
        if (outcome.skipped) return
        console.log(`  detected ${outcome.detected} · logged ${outcome.logged} · packets ${outcome.packets.length}`)
      },
      reconcile: async () => {
        const sweep = await engine.reconcile()
        if (!sweep.skipped && !sweep.complete) {
          // 못 본 것을 "변경 없음"으로 읽지 않는다 (C-12 불변식 ⑫)
          console.error(`  Reconcile did not complete${sweep.detail ? ` — ${sweep.detail}` : ''}`)
        }
      },
      census: async () => {
        const sweep = await engine.census()
        if (!sweep.skipped && sweep.missing.length > 0) {
          console.log(`  ${sweep.missing.length} known items absent from this listing`)
        }
      },
      digest: async () => {
        const outcome = await deliverDigest(store, false)
        if (outcome > 0) console.error('  delivery failed')
      },
    },
  })

  if (command === 'tick') {
    const outcome = await orchestrator.tick()
    console.log(renderTick(outcome))
    return outcome.failures.length > 0 ? 1 : 0
  }

  const intervalMs = minutes(values['interval-min'], 1)
  console.log(`Always-on runtime started — one pass every ${intervalMs / 60_000} min. Ctrl+C to stop.`)
  const stop = () => {
    console.log('Stopping — a pass still running is carried to the next start by its lease.')
    orchestrator.stop()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  await orchestrator.run(intervalMs, (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()))
  return 0
}

/**
 * 새 Front Session이 붙었다. 지금 무엇이 걸려 있는지 한 화면으로 되찾는다.
 *
 * **읽기만 한다** — 전이도, 승인 대기 소비도, 소유권 주장도 없다 (C-12 불변식 ⑮).
 */
/** 상신 원장 (C-13). 회수 뒤에도 남는 기록이라 adapter-scope에 산다. */
const escalationLedger = (store: MarkdownStateStore) => new EscalationLedger(store.scope('escalation'))

/**
 * 사람에게 올린다 — **자격이 있을 때만**.
 *
 * predicate가 없으면 ApprovalRequest는 만들어지지 않고, 막힌 사실만 남는다 (C-13 §1.2).
 * 결정 표면은 기존 inbox다 — 두 번째 승인 창구를 만들지 않는다.
 */
async function runEscalate(
  command: string | undefined,
  target: string | undefined,
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  resolved?: ResolvedRuntime,
): Promise<number> {
  const ledger = escalationLedger(store)

  if (command === 'list' || command === undefined) {
    const pending = await ledger.pending()
    for (const line of escalationLines(pending)) console.log(line)
    if (pending.length === 0) console.log('No open escalations')
    const rejected = await ledger.rejected()
    if (rejected.length > 0) {
      // Gate가 무엇을 막았는지 보이지 않으면 Gate가 도는지 알 수 없다
      console.log(`\n${rejected.length} attempts that were refused:`)
      for (const item of rejected) console.log(`  [${item.reason}] ${item.question} — ${item.detail}`)
    }
    return 0
  }

  if (command === 'open') {
    if (!target) {
      console.error('Usage: asc escalate open <S-ID> --predicate <p>... --question <t> --blocked <node>...')
      return 2
    }
    const question = values.question as string | undefined
    if (!question) {
      console.error('--question is required. It is the one sentence a person answers.')
      return 2
    }
    const session = await store.get('session', target)
    if (!session) {
      console.error(`${target} was not found.`)
      return 1
    }

    // 결정할 사람을 여기서 먼저 정한다. Gate를 통과시켜 record를 남긴 뒤에 "누구에게
    // 올릴지 모르겠다"고 끊으면, 아무도 못 본 상신이 남아 같은 경계를 다시 막는다.
    const approver = (values.as as string) ?? Object.keys(resolved?.controllerIdentities ?? {})[0]
    if (!approver) {
      console.error('No approver is known — fill in controller.identities in override.json, or pass --as.')
      return 2
    }

    const opened = await ledger.open({
      escalationId: (values.id as string) ?? nextEscalationId(await ledger.all()),
      sessionId: target,
      openedBy: (values.as as string) ?? (values.principal as string) ?? session.owner ?? '(미상)',
      predicates: (values.predicate as string[]) ?? [],
      question,
      evidenceRefs: (values.evidence as string[]) ?? [],
      blockedNodes: (values.blocked as string[]) ?? [],
      ...(values['blocked-scope'] ? { blockedScope: values['blocked-scope'] as string[] } : {}),
      ...(values.affected ? { affectedNodes: values.affected as string[] } : {}),
      doneCriteria: session.doneCriteria,
      ...(values.previous ? { previousEscalationId: values.previous as string } : {}),
      ...(values.why ? { whyPreviousDecisionDoesNotCoverThis: (values.why as string[]).join(' · ') } : {}),
    })

    if (!opened.ok) {
      console.error(opened.detail)
      if (opened.reason === 'APPROVAL_NOT_JUSTIFIED') {
        console.error('\nThese are the only grounds that qualify for escalation (C-13 §1.1):')
        console.error('  ownership_boundary · shared_contract_change · acceptance_change')
        console.error('  secret_or_permission · irreversible_action · explicit_rule_requires_approval')
        console.error('  canonical_conflict')
        console.error('Being uncertain, or having several options, is not a boundary — gather the evidence, decide, and proceed.')
      }
      return 1
    }

    const record = opened.record

    // 결정 표면은 기존 Approval이다 (C-01 무수정). 여기서 새 창구를 만들지 않는다.
    const requestId = await nextRequestId(store)
    const created = await store.create('request', {
      id: requestId,
      version: 0,
      status: 'AWAITING_APPROVAL',
      // EventType은 3종뿐이다(OM). 상신은 사람의 행동을 요구하므로 actionable이다.
      type: 'actionable',
      priority: 'P1',
      title: record.question,
      detectedAt: record.openedAt,
      source: { eventKey: `escalation:${record.escalationId}`, reference: record.sessionId },
      situation: record.question,
      context: escalationLines([record]).join('\n'),
      impact: {
        interruptRequired: false,
        affectedSessions: [record.sessionId],
        // 무엇이 계속 가는지 함께 적는다 — 전체가 선 것처럼 읽히지 않게
        rationale: `막힌 것 ${record.blockedNodes.join(', ')} · 계속 가는 것 ${record.stillRunnableNodes.join(', ') || '없음'}`,
      },
      recommendation: '',
      snapshot: [],
      authorizedApprover: approver,
      allowedDecisions: ['approve', 'revise', 'defer', 'dismiss'],
      escalation: {
        escalationId: record.escalationId,
        predicates: record.predicates,
        evidenceRefs: record.evidenceRefs,
        affectedNodes: record.affectedNodes,
        blockedNodes: record.blockedNodes,
        blockedScope: record.blockedScope,
        stillRunnableNodes: record.stillRunnableNodes,
        ...(record.previousEscalationId ? { previousEscalationId: record.previousEscalationId } : {}),
      },
    })
    if (!created.ok) {
      // Gate는 이미 통과해 record가 남았다. 그 사실을 숨기면 사람은 같은 경계를 다시
      // 올리려다 "이미 열려 있다"는 말만 듣고 이유를 알 수 없다.
      console.error(`Could not create the request: ${created.reason}`)
      console.error(
        `${record.escalationId} 은 열린 채 아무에게도 가지 못했다 — 결정 표면이 없다.` +
          ' 저장 문제를 고친 뒤 다시 시도하라.',
      )
      return 1
    }
    await ledger.attachRequest(record.escalationId, requestId)

    for (const line of escalationLines([record])) console.log(line)
    console.log(`\nRaised as ${requestId} — decide it with \`asc inbox decide ${requestId}\`.`)
    if (record.stillRunnableNodes.length > 0) {
      console.log(`Only ${record.blockedNodes.join(', ')} is blocked. The rest keeps running.`)
    }
    return 0
  }

  if (command === 'resolve') {
    if (!target) {
      console.error('Usage: asc escalate resolve <ESC-ID> --as <actor>')
      return 2
    }
    const record = await ledger.get(target)
    if (!record) {
      console.error(`${target} was not found.`)
      return 1
    }
    const request = await store.get('request', record.requestId)
    if (!request?.decision) {
      // 사람이 결정하지 않았는데 닫으면 외부 대기를 가짜로 해소하는 것이다
      console.error(`${record.requestId} has no decision yet — an escalation closes only on a decision.`)
      return 1
    }
    const outcome = await ledger.resolve(target, request.decision.actor, `${record.requestId}:${request.decision.kind}`)
    if (!outcome.ok) {
      console.error(outcome.detail)
      return 1
    }
    console.log(`${target} closed — ${request.decision.kind} by ${request.decision.actor}`)
    return 0
  }

  console.error(`Unknown escalate command: ${command}\n\n${USAGE}`)
  return 2
}

/** `ESC-YYYYMMDD-NN`. 세션 id와 같은 모양으로 읽힌다. */
function nextEscalationId(existing: readonly { escalationId: string }[]): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const prefix = `ESC-${day}-`
  const used = existing
    .filter((record) => record.escalationId.startsWith(prefix))
    .map((record) => Number(record.escalationId.slice(prefix.length)))
    .filter((n) => Number.isFinite(n))
  return `${prefix}${String((used.length > 0 ? Math.max(...used) : 0) + 1).padStart(2, '0')}`
}

async function nextRequestId(store: MarkdownStateStore): Promise<string> {
  const existing = await store.list('request')
  const numbers = existing.map((r) => Number(r.id.slice(4))).filter((n) => Number.isFinite(n))
  return `REQ-${String((numbers.length > 0 ? Math.max(...numbers) : 0) + 1).padStart(4, '0')}`
}

/** 원격 동결 상태를 보고 바꾼다. **실행은 여기서 하지 않는다** — 미룬 것은 사람이 다시 본다. */
async function runFreeze(
  group: string,
  command: string | undefined,
  values: Record<string, unknown>,
  store: MarkdownStateStore,
): Promise<number> {
  const ledger = new FreezeLedger(store.scope('policy'))

  if (group === 'thaw') {
    const { policy, deferred } = await ledger.thaw()
    for (const line of freezeLines(policy, deferred)) console.log(line)
    if (deferred.length > 0) {
      // 자동 재생 금지 (지시 §27). 녹였다고 쌓인 것이 나가면 그 사이 바뀐 대상에 나간다.
      console.log('\nDeferred items do not go out on their own. Re-check each and send it through the approval path.')
    }
    return 0
  }

  if (command === 'status' || command === undefined) {
    for (const line of freezeLines(await ledger.policy(), await ledger.deferred())) console.log(line)
    return 0
  }

  if (command === 'on') {
    const reason = values.reason as string | undefined
    if (!reason) {
      // 이유 없는 freeze는 다음 사람이 언제 녹여도 되는지 모른다
      console.error('--reason is required. Without knowing why it was frozen, nobody knows when to thaw it.')
      return 2
    }
    const policy = await ledger.freeze(reason, { denyRemoteRead: Boolean(values.offline) })
    for (const line of freezeLines(policy, await ledger.deferred())) console.log(line)
    return 0
  }

  if (command === 'defer') {
    const id = values.id as string | undefined
    const intent = values.intent as string | undefined
    if (!id || !intent) {
      console.error('Usage: asc freeze defer --id <id> --intent "what was being attempted"')
      return 2
    }
    const added = await ledger.defer({
      id,
      action: 'remote.write',
      intent,
      basis: (values.evidence as string[]) ?? [],
      ...(values.grant ? { grantRef: values.grant as string } : {}),
    })
    console.log(added ? `${id} deferred` : `${id} is already on the deferred list`)
    return added ? 0 : 1
  }

  if (command === 'release') {
    const id = values.id as string | undefined
    if (!id) {
      console.error('Usage: asc freeze release --id <id>')
      return 2
    }
    const removed = await ledger.release(id)
    console.log(removed ? `${id} removed from the list — execution goes through the approval path` : `${id} was not found`)
    return removed ? 0 : 1
  }

  console.error(`Unknown freeze command: ${command}

${USAGE}`)
  return 2
}

async function runFront(
  command: string | undefined,
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  root: string,
): Promise<number> {
  if (command !== undefined && command !== 'status') {
    console.error(`Unknown front command: ${command}

${USAGE}`)
    return 2
  }

  const scope = await activeMonitorScope(store)
  const index = await readIndex(ascHome())
  const located = lookupLocator(index, process.cwd())

  const state = await restoreFront({
    store,
    pending: await new LocalOperator({ store }).list({}),
    escalations: await escalationLedger(store).pending(),
    health: evaluateHealth(
      await new CoverageLedger(store.scope(scope)).health(),
      new Date().toISOString(),
      HEALTH_THRESHOLDS,
    ),
    ...(located ? { workspace: { workspaceId: located.workspaceId, locator: located.locator } } : {}),
    // 도는 세션을 누가 집고 있는지. --physical 을 다시 물어보게 하지 않는다 (L-4).
    bindings: claudeBindings(store),
  })

  if (values.json) {
    console.log(JSON.stringify({ ...state, root }, null, 2))
    return 0
  }
  for (const line of renderFront(state)) console.log(line)
  return 0
}

async function runMonitor(
  command: string | undefined,
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  renderer: TextRenderer,
  resolved?: ResolvedRuntime,
): Promise<number> {
  if (command !== 'scan' && command !== 'reconcile' && command !== 'census' && command !== 'status') {
    console.error(`Unknown monitor command: ${command ?? '(none)'}\n\n${USAGE}`)
    return 2
  }
  if (!resolved) {
    console.error('This only runs inside an attached project. Run `asc init --profile <id>` first.')
    return 2
  }
  // 완전 오프라인이면 외부를 치지 않는다. 조용히 도는 것보다 왜 못 도는지 말하는 게 낫다.
  const frozen = await new FreezeLedger(store.scope('policy')).policy()
  const readJudgment = judgeAction(frozen, 'remote.read')
  if (readJudgment.decision === 'DENY') {
    console.error(`Monitoring is not running — ${readJudgment.detail}`)
    return 2
  }

  const built = await buildMonitorEngine(values, store, resolved)
  if (!built.ok) return built.code
  const { engine, repo } = built

  // 어디까지 확인했는지 보여주기만 한다. 판정하지도, 무엇을 고치지도 않는다.
  if (command === 'status') {
    const health = await engine.health()
    console.log(values.json ? JSON.stringify(health, null, 2) : renderHealth(repo, health).join('\n'))
    return 0
  }

  if (command === 'reconcile' || command === 'census') {
    const sweep = command === 'reconcile' ? await engine.reconcile() : await engine.census()
    if (sweep.skipped) {
      console.log('Another run is in progress. The next pass will pick it up.')
      return 0
    }
    if (values.json) {
      console.log(JSON.stringify(sweep, null, 2))
      return sweep.complete ? 0 : 1
    }
    console.log(`${sweep.kind}: ${sweep.seen} listed · ${sweep.changed} changed · ${sweep.packets.length} packets`)
    if (sweep.missing.length > 0) {
      console.log(`${sweep.missing.length} known items absent from this listing: ${sweep.missing.join(', ')}`)
      console.log('  (whether that is deletion, permissions, visibility or a query error is not judged here — a person looks)')
    }
    if (!sweep.complete) {
      // 완주하지 못한 회차를 성공으로 보이면 "확인했다"는 거짓말이 된다
      console.error(`The listing did not complete${sweep.detail ? ` — ${sweep.detail}` : ''}. This pass makes no judgement about disappearances.`)
      return 1
    }
    return 0
  }

  const outcome = await engine.scan()

  if (outcome.skipped) {
    console.log('Another scan is in progress. The next pass will pick it up.')
    return 0
  }
  console.log(
    `감지 ${outcome.detected} · 중복 ${outcome.duplicates} · 기록 ${outcome.logged} · ` +
      `보고서 ${outcome.packets.length} · 재시도 ${outcome.retries.length}`,
  )
  if (outcome.packets.length > 0) {
    const operator = new LocalOperator({ store })
    console.log()
    console.log(renderer.renderList(await operator.list()).text)
  }
  return 0
}

/**
 * 외부로 내보내는 경로. 승인과 분리돼 있는 이유는 OM §11.8 — 승인은 내용에 동의한
 * 것이고, 무엇을 어디에 쓸지는 Controller가 따로 지정한다.
 */
async function runGrant(
  command: string | undefined,
  target: string | undefined,
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  root: string,
): Promise<number> {
  switch (command) {
    case 'issue': {
      if (!target || !values.action || !values.target || !values.as) {
        console.error('Usage: asc grant issue REQ-0042 --action <key> --target <ref> --as <actor>')
        return 2
      }
      // 발급도 승인 권한자만 할 수 있다 — 외부로 나가는 권한이 여기서 만들어지기 때문이다
      const grants = new GrantService(store, new LocalIdentityBinding(await loadIdentityMap(root)))
      const issued = await grants.issue({
        grantId: (values['grant-id'] as string) ?? `G-${String(Date.now()).slice(-4)}`,
        requestId: target,
        issuedBy: values.as as string,
        channel: 'local',
        action: values.action as string,
        target: values.target as string,
        ...(values.expires ? { expiresAt: values.expires as string } : {}),
        issuedAt: new Date().toISOString(),
      })
      if (!issued.ok) {
        console.error(GRANT_ERROR[issued.failure.kind] ?? issued.failure.kind)
        return 1
      }
      console.log(`${issued.grant.id} READY — ${issued.grant.action} → ${issued.grant.target}`)
      console.log('The target state is checked again before execution. If it changed in the meantime, nothing runs.')
      return 0
    }

    case 'run': {
      if (!target) {
        console.error('Usage: asc grant run G-0001')
        return 2
      }
      const token = await discoverToken()
      if (!token) {
        console.error('No GitHub token found. Set ASC_GITHUB_TOKEN, or run `gh auth login`.')
        return 2
      }
      const grant = await store.get('grant', target)
      if (!grant) {
        console.error(`${target} was not found.`)
        return 1
      }
      // 이 한 번이 실제로 밖에 나간다. 계약이 지정한 대상·내용 그대로이며,
      // 직전에 대상 상태를 다시 확인한다.
      const scm = new GitHubScm({ client: new GitHubClient({ token }), defaultRepo: repoOf(grant.target) })
      const outcome = await new Executor({
        store,
        scm,
        runId: (values['run-id'] as string) ?? `cli-${process.pid}`,
      }).run(target)

      if (outcome.ok) {
        console.log(`EXECUTED — ${outcome.resultRef}`)
        return 0
      }
      console.error(`${outcome.reason}${'detail' in outcome ? `: ${outcome.detail}` : ''}`)
      return 1
    }

    default:
      console.error(`Unknown grant command: ${command ?? '(none)'}\n\n${USAGE}`)
      return 2
  }
}

/** `owner/repo#19` 에서 저장소만. 짧은 참조를 풀 때 쓴다. */
function repoOf(target: string): string | undefined {
  const match = /^([^/\s]+\/[^#\s]+)#\d+$/.exec(target)
  return match?.[1]
}

const GRANT_ERROR: Record<string, string> = {
  REQUEST_NOT_FOUND: '요청을 찾지 못했다.',
  NOT_APPROVED: '아직 승인되지 않은 요청이다. 승인 먼저 받아야 한다.',
  FORBIDDEN_ISSUER:
    '계약을 발급할 권한이 없다. .asc/identities.json 에 `"이름": ["local:계정"]` 형태로 매핑을 추가하라 ' +
    '(현재 상태는 `asc setup status`).',
  NO_PAYLOAD: '내보낼 내용이 없다.',
  GRANT_EXISTS: '같은 id의 계약이 이미 있다.',
}

// import 만으로 명령이 돌면 안 된다 — bootstrap이 이 모듈을 불러오는 순간 세상이 바뀐다.
// bin은 symlink로 놓이므로 realpath로 견준다.
const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  try {
    process.exitCode = await runAscCommand(process.argv.slice(2))
  } catch (error) {
    const explained = explainConfigError(error)
    if (explained === null) throw error // 모르는 고장은 감추지 않는다
    console.error(explained)
    process.exitCode = 1
  }
}
