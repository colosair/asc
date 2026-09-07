#!/usr/bin/env node
// ASC CLI — Local Operator Interface의 첫 Surface.
//
// 이것은 여러 소비자 중 하나일 뿐이다 (C-01 §4). MCP·IDE 확장·Web UI가 나중에 같은
// Operator를 부르게 되며, 그때 Core는 손대지 않는다. 그래서 여기에는 명령어 해석과
// 출력만 있고 판단은 한 줄도 없다.
//
// 읽기 전용이다. 결정 제출은 사람의 명시적 의사표현을 받는 별도 경로로 나간다 (B-06).

import { execFile, spawn, spawnSync } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { homedir, hostname, userInfo } from 'node:os'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, resolve } from 'node:path'
import {
  MINIMUM_NODE_MAJOR,
  checkNodeRuntime,
  type NodeRuntimeCheck,
  type NodeRuntimeDeps,
  reexecWithCandidate,
} from '../core/distribution/node-runtime.ts'
import { RELEASE_VERSION, RUNTIME_PACKAGE } from '../core/distribution/release.ts'
import { planUpdate, requiredMajorFrom, updateLine, type UpdatePlan } from '../core/distribution/update.ts'

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
import { transitionGrant } from '../core/model/transitions.ts'
import { applyTransition } from '../core/runtime/store-ops.ts'
import { GrantService } from '../core/execution/grant.ts'
import { DecisionKind } from '../core/model/entities.ts'
import { discoverProjectRoot, excludeFromGit, identitiesTemplate, overrideTemplate, writeIfAbsent } from '../core/attach/init.ts'
import { AdoptError, buildAdoptedProfile, type AdoptedProfile, type RemoteEntry } from '../core/attach/adopt.ts'
import { locatorsOf, lookupLocator, readIndex, register, writeIndex } from '../core/workspace/index-store.ts'
import { adoptionLine, judgeAdoption, migrate } from '../core/workspace/migrate.ts'
import { newWorkspaceId, normalizeRemote, recoverCandidates, recoverLines } from '../core/workspace/identity.ts'
import { gitWorktrees, resolveWorkspace, resolutionLine, type Resolution } from '../core/workspace/resolve.ts'
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
  controlPlaneAccess,
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
import type { ScmPort } from '../ports/scm.ts'
import { servicePath } from '../core/distribution/external-command.ts'
import {
  isTransientPath,
  resolveServiceRuntime,
  serviceRuntimeLine,
  type ServiceRuntimeResolution,
} from '../core/distribution/service-runtime.ts'
import { LocalCanonicalReader } from '../adapters/local/canonical.ts'
import { LocalRepoAdapter } from '../adapters/local/repo.ts'
import { GitHubAdapter } from '../adapters/github/adapter.ts'
import { GitLabAdapter } from '../adapters/gitlab/adapter.ts'
import { JamAdapter, resolveJamCommand } from '../adapters/jam/adapter.ts'
import { healJam, healLine } from '../adapters/jam/setup.ts'
import type { ChangeSummary } from '../ports/change-context.ts'
import type { ContextComment, ResourceSnapshot } from '../ports/resource-context.ts'
import { statusIndicatesDone } from '../adapters/jam/ports.ts'
import { ProgressService } from '../core/operator/progress.ts'
import { composeBindings, defaultAdapters } from '../composition/registry.ts'
import {
  buildObservationChannels,
  buildRuntimePorts,
  closeToolClients,
  rolesFor,
  workItemRoles,
} from '../composition/runtime.ts'
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
  DecisionClass,
} from '../core/runtime/audit.ts'
import { ClosureLedger } from '../core/runtime/closure.ts'
import { Orchestrator, renderTick } from '../core/runtime/orchestrator.ts'
import {
  LAST_RUN_KEY,
  RuntimeLease,
  fileScope,
  readBackground,
  recordPass,
  renderBackground,
  staleAfter,
} from '../core/runtime/background.ts'
import { dueWorkspaces, renderWorkspaces, summarizePass, viewWorkspaces, type PassResult, type WorkspaceView } from '../core/runtime/workspaces.ts'
import {
  persistentRuntimeLine,
  planPersistentRuntime,
  type PersistentRuntimeAdapter,
  type ServiceCommand,
} from '../core/distribution/persistent-runtime.ts'
import { launchdAdapter } from '../adapters/service/launchd.ts'
import { schtasksAdapter } from '../adapters/service/schtasks.ts'
import { serviceAdapterFor, systemdUserAdapter } from '../adapters/service/systemd-user.ts'
import { QueryLedger } from '../core/runtime/query.ts'
import {
  CoordinationLedger,
  coordinationLines,
  responsesFrom,
  viewCoordination,
  type CoordinationView,
} from '../core/runtime/coordination.ts'
import { publishLine, publishOnce, recordPublication } from '../core/runtime/publish.ts'
import { ObservationLedger } from '../core/monitor/observation.ts'
import { DeliveryLedger, deliver, planDigest } from '../core/presentation/digest.ts'
import { LocalPresentation } from '../adapters/local/presentation.ts'
import { collectSessions, renderCollect } from '../core/runtime/controller.ts'
import { frontOpeningLines, openFront, renderFront, restoreFront } from '../core/runtime/front.ts'
import { sessionStartPayload } from '../adapters/claude-code/session-start.ts'
import { EscalationLedger, escalationLines } from '../core/runtime/escalation.ts'
import { deriveExecutionState, executionLine } from '../core/runtime/execution-state.ts'
import { buildFinalReport, renderFinalReport } from '../core/runtime/report.ts'
import { FreezeLedger, freezeLines, judgeAction } from '../core/policy/remote-freeze.ts'
import {
  ExecutionMode,
  enforcementOf,
  judgeAutoReadiness,
  modeLine,
  readExecutionMode,
  writeExecutionMode,
  type AutoReadiness,
  type ExecutionModeState,
  type ReadinessAxis,
} from '../core/policy/execution-mode.ts'
import { reviewExternalAction, reviewLines, type ReviewOutcome } from '../core/execution/remote-review.ts'
import type { ResolvedBinding } from '../core/binding/types.ts'
import type { Adapter } from '../ports/adapter.ts'
import type { ResolvedRuntime } from '../core/resolver/load.ts'
import { SessionRuntime } from '../core/runtime/session.ts'
import { Checkpoint, Handoff, SessionRole, type ExecutionGrant, type Session } from '../core/model/entities.ts'
import { archiveLock, bootstrapGuard, buildLock, compareLock, loadLayers, resolveRuntime } from '../core/resolver/load.ts'
import { ProfileSourceError } from '../core/resolver/profile-source.ts'
import { renderAscMd, renderControllerMd } from '../core/resolver/render.ts'
import { ProfileLock, ProjectProfile } from '../schemas/profile.ts'
import { LocalOperator } from '../core/operator/local-operator.ts'
import { loadIdentityMap } from './identity-config.ts'

const USAGE = `asc — Agent Session Control

Lifecycle
  asc setup                 make this machine and this project ready to use
  asc status                what is set up, what is running, what is blocked
  asc update                install the newest release and verify it
  asc refresh               re-converge this runtime's own integration
  asc uninstall             remove the product; your state stays

Execution
  asc mode                  who executes: MANUAL (you) or AUTO (ASC)
  asc mode auto             turn on managed execution — refuses unless the path is usable
  asc mode manual           step back to advisory. Recorded, with who said so

Work
  asc work start [WORK]     start or resume the work, inside a contract
  asc work status [S-ID]    where it is right now
  asc work publish          send the approved result outside
  asc work publish --review read the target, the SHA and the binding — change nothing
  asc work finish [S-ID]    hand off, close, collect — one command
  asc work pause|resume|inspect [S-ID]

Human decisions
  asc inbox                 what is waiting for a person
  asc inbox show <REQUEST_ID>
  asc inbox decide <REQUEST_ID> <approve|revise|defer|dismiss|queue> --as <actor>

Runtime
  asc runtime status        which build is in use, and whether it observes
  asc runtime use package | development <checkout>

Options
  --json          machine-readable output. stdout is a single JSON document
  --as <actor>    who is deciding. Must be mapped as an approver
  --root <path>   runtime directory (otherwise: registered workspace, then repo-local .asc)

  asc help --advanced    the internal primitives these commands are built on
`

const ADVANCED_USAGE = `asc — advanced surface

These are the primitives the public commands are built on. A healthy path does not
require them: \`setup\` · \`status\` · \`work\` · \`inbox\` · \`mode\` cover normal use.
They stay because recovery, diagnosis and scripting need them.

  asc proceed [--session <id>] [--work <WORK-ID>] [--goal <text>] [--json]

  asc inbox trace  <REQUEST_ID> [--json]   # how it got here — an exploratory trace
  asc inbox digest [--flush] [--json]      # batched view (P0 stays separate)
  asc inbox latest [--priority P0|P1|P2] [--json]

  asc grant issue <REQUEST_ID> --action <key> --target <ref> --as <actor>
                  [--grant-id <id>] [--expires <iso>]
  asc grant issue --session <S-ID> --action <key> --target <ref> --body-file <path> --as <actor>
  asc grant run   <GRANT_ID> [--run-id <id>]

  asc monitor scan      [--backfill] [--as <controller>]   # fast path
  asc monitor reconcile [--as <controller>]   # recover what was missed — re-list
  asc monitor census    [--as <controller>]   # full reconcile + detect disappearances
  asc monitor status    [--json]              # how far coverage has been confirmed

  asc profile adopt   [--id <name>] [--json]  # make a profile for this repository
  asc profile resolve --profile <id> [--preset <id>] [--install <path>] [--write]

  asc runtime start [--detach] [--interval-min <n>] [--delta-min <n>]
                    [--reconcile-min <n>] [--census-min <n>] [--digest-min <n>]
                        # development and recovery only — the machine's registration is
                        # what observes on the normal path (asc runtime service)
  asc runtime tick [--all]                 # --all: every workspace this machine knows
  asc runtime list [--json]                # every workspace, without visiting each one
  asc runtime service [status] [--json]    # the machine's persistent registration
  asc runtime service install|uninstall [--interval-min <n>]
  asc runtime stop                         # ask the background runtime to finish its pass

  asc update check|plan [--json]           # what is installed, what is published
  asc refresh check|plan [--json]          # what integration is behind, changing nothing
  asc uninstall plan [--json]              # what would be removed, and what stays

  asc front [status] [--json]
  asc front open [--json]                  # a host session opened here — what is waiting
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

  asc setup status [--json]
  asc setup identity [--role controller|monitor|both] [--actor <channel:actor>]
  asc setup plan   [--profile <id>] [--scope local|project] [--json]
  asc setup apply  [--profile <id>] [--scope local|project] [--json]

  asc session plan  [--id <S-ID>] [--role <role>] [--goal <text>] [--boundary <glob>...]
                    [--criteria <text>...] [--owner <role>] [--provenance <f>=<STATUS>[:<src>]...]
                    [--json]        # is this draft issuable? changes nothing
  asc session issue <ID> --role <role> --goal <text> [--block <id>]
                         [--parent <S-ID>] [--issued-by <principal>]
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
                          [--changed <path>...] [--unresolved <text>...] [--physical <id>]
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

  asc coordination [status] [--json]   # what was asked outside, and whether it reached anyone
  asc coordination publish --grant <G-ID> --query <ID> --title <text> --body-file <path>
                   [--audience <who>] [--known <objectId>] [--work <ref>] [--json]
  asc coordination observe [--json]    # did anything come back on what we published

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
  --work          work item to investigate before proposing a contract
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
`

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
  const home = ascHome()
  const index = await readIndex(home)
  const resolution = await resolveWorkspace({
    cwd: start,
    ...(explicitRoot ? { explicitRoot } : {}),
    index,
    // 홈의 `~/.asc` 는 user runtime이지 프로젝트 상태가 아니다 — 그 위로 올라가지 않는다
    stopAt: homedir(),
    // 등록이 빗나갔을 때만 Git에게 구조를 묻는다 (C-11 §1.3).
    worktrees: gitWorktrees,
  })
  // 같은 저장소의 다른 checkout으로 풀렸으면 **이 경로를 등록해 둔다.** 그래야 다음부터는
  // 예전과 같은 index 조회 하나로 끝나고, guard hook도 이 checkout을 관리 대상으로 본다.
  if (resolution.kind === 'LINKED_WORKTREE') await rememberWorktree(home, index, resolution)
  return resolution
}

/**
 * 이번에 구조로 풀린 checkout을 index에 적는다. **workspace를 새로 만들지 않는다** —
 * 같은 논리 workspace의 execution instance가 하나 늘었을 뿐이다 (C-11 §1.3).
 *
 * 실패해도 이번 판정을 무르지 않는다. 다음 호출이 Git을 한 번 더 부르는 것으로 끝난다 —
 * 쓰기 하나가 안 됐다고 붙어 있는 workspace를 못 쓰게 만드는 쪽이 나쁘다.
 */
async function rememberWorktree(
  home: string,
  index: Awaited<ReturnType<typeof readIndex>>,
  resolution: Extract<Resolution, { kind: 'LINKED_WORKTREE' }>,
): Promise<void> {
  const now = new Date().toISOString()
  try {
    await writeIndex(
      home,
      register(index, {
        workspaceId: resolution.workspaceId,
        root: resolution.root,
        locator: {
          path: resolution.locator,
          kind: resolution.kindOfLocator,
          platform: process.platform,
          observedAt: now,
        },
        now,
      }),
    )
  } catch {
    // 등록만 못 했을 뿐이다. 판정은 그대로 선다.
  }
}

const execFileAsync = promisify(execFile)

/**
 * Claude Host 설치 경로 + **이 CLI의 위치**.
 *
 * SessionStart hook은 상태를 물어볼 곳이 필요하고, 그곳은 지금 도는 이 실행파일이다.
 * 그 CLI가 다시 선택된 build로 넘기므로(`runtime use development` 포함) hook이 build를
 * 고르는 일은 없다.
 */
const hostPaths = () => ({ ...defaultPaths(), entry: fileURLToPath(import.meta.url) })

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
async function rememberMonitorSources(store: MarkdownStateStore, sourceIds: readonly string[]): Promise<void> {
  await store.scope('monitor').set(ACTIVE_SOURCE_KEY, JSON.stringify([...sourceIds]))
}

/**
 * 마지막으로 붙었던 통로들.
 *
 * 예전에는 문자열 하나였다 — 통로가 하나뿐이라는 전제였고, 코드와 작업 항목이 다른 곳에
 * 있는 프로젝트에서 그 전제가 깨졌다. 옛 기록(문자열 하나)도 그대로 읽는다: 형식이
 * 바뀌었다는 이유로 이전 설치의 shadow 기록이 사라진 것처럼 보이면 안 된다.
 */
async function activeMonitorSources(store: MarkdownStateStore): Promise<string[]> {
  const raw = await store.scope('monitor').get(ACTIVE_SOURCE_KEY)
  if (!raw) return ['github-poll']
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')) {
      return parsed.length > 0 ? (parsed as string[]) : ['github-poll']
    }
  } catch {
    // 옛 형식이다 — 문자열 하나
  }
  return [raw]
}

/** 통로별 scope. 기록이 하나뿐이던 시절의 호출부는 첫 통로를 본다. */
async function activeMonitorScopes(store: MarkdownStateStore): Promise<string[]> {
  return (await activeMonitorSources(store)).map(monitorScope)
}

async function activeMonitorScope(store: MarkdownStateStore): Promise<string> {
  return (await activeMonitorScopes(store))[0]!
}

/**
 * JAM 을 부르는 방법. **한 곳에서만 정한다** — 감시와 작업 조사가 서로 다른 방법으로
 * JAM 을 부르면 한쪽만 되는 상태가 생긴다(실제로 그랬다: 감시 경로는 이 값을 아예 넘기지
 * 않아 선언된 JAM binding 이 통로를 만들지 못했다).
 */
const jamLauncher = (): { command: string; args: string[] } =>
  process.env.ASC_JAM_PATH
    ? { command: process.env.ASC_JAM_PATH, args: [] }
    : { command: 'npx', args: ['--yes', '@jam-mcp/launcher'] }

/** 조립 입력에 실을 JAM 갈래. */
const jamComposition = (projectRoot: string) => {
  const launcher = jamLauncher()
  return { jam: { command: launcher.command, args: [...launcher.args, 'serve'], cwd: projectRoot } }
}

/** 이 빌드가 아는 adapter 들. 감시와 작업 조사가 같은 목록을 본다. */
const monitorAdapters = (): Adapter[] => {
  const launcher = jamLauncher()
  return [
    new GitHubAdapter(),
    new GitLabAdapter(),
    new JamAdapter(process.env.ASC_JAM_PATH ? {} : { command: launcher.command, args: launcher.args }),
  ]
}

/** user-owned ASC home. */
const ascHome = (): string => process.env.ASC_HOME ?? join(homedir(), '.asc')

const DECISION_ERROR: Record<string, string> = {
  NOT_FOUND: '요청을 찾지 못했다.',
  FORBIDDEN_ACTOR:
    '승인 권한자가 아니다. .asc/identities.json 에 `"이름": ["local:계정"]` 형태로 매핑을 추가하라 ' +
    '(현재 상태는 `asc status`).',
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
      return `That profile is not there${path}. \`asc status\` lists what is.`
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

/** 재실행을 가로질러 진입점을 나르는 자리. 값은 `bootstrap` 하나뿐이다. */
export const ENTRY_ENV = 'ASC_ENTRY'

export async function runAscCommand(argv: string[], entry: AscEntry = 'runtime'): Promise<number> {
  // 호환 Node 로 다시 실행된 프로세스는 자기가 어느 문으로 들어왔는지 argv 로는 알 수 없다.
  const inherited = process.env[ENTRY_ENV] === 'bootstrap' ? ('bootstrap' as const) : undefined
  entry = inherited ?? entry
  let parsed: ReturnType<typeof parseArgsOrThrow>
  try {
    parsed = parseArgsOrThrow(argv)
  } catch (error) {
    // 모르는 옵션은 사용자 입력 오류다 — Node 스택을 던지면 그때부터 도구를 의심하게 된다.
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Could not read the arguments: ${message.split('\n')[0]}`)
    console.error('Run `asc --help` for the commands and flags this build understands.')
    return 2
  }
  const { values, positionals } = parsed

  // 실행 중인 버전을 묻는 유일한 공식 통로. 설치 안내가 버전을 핀으로 고정하는데
  // 정작 지금 도는 것이 무엇인지 물을 방법이 없었다 (Windows 실전 실측 ASC-1).
  if (values.version || positionals[0] === 'version') {
    console.log(RELEASE_VERSION)
    return 0
  }
  try {
    return await runParsedCommand(values, positionals, entry, argv)
  } finally {
    // **어느 명령이든** 자기가 띄운 도구 자식을 닫는다 (JAM MCP 서버 등).
    //
    // 예전에는 `proceed` 한 곳에서만 닫았다. 감시 경로가 JAM 통로를 열게 되자
    // `monitor scan` 과 `runtime tick` 이 할 일을 다 하고도 종료하지 못했고, 등록된
    // 서비스가 회차마다 그 프로세스를 하나씩 남겼다 — 실측에서 10분 넘게 살아 있었다.
    // 닫는 자리를 명령마다 두면 언젠가 또 빠진다. 나가는 문은 하나다.
    await closeToolClients()
  }
}

function parseArgsOrThrow(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      version: { type: 'boolean', default: false },
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
  detach: { type: 'boolean' },
  'delta-min': { type: 'string' },
  'reconcile-min': { type: 'string' },
  'census-min': { type: 'string' },
  'digest-min': { type: 'string' },
  workspace: { type: 'string' },
  validator: { type: 'string' },
  result: { type: 'string' },
  finding: { type: 'string', multiple: true },
  query: { type: 'string' },
  title: { type: 'string' },
  'body-file': { type: 'string' },
  audience: { type: 'string', multiple: true },
  known: { type: 'string', multiple: true },
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
      advanced: { type: 'boolean', default: false },
      review: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
}

async function runParsedCommand(
  values: Record<string, unknown>,
  positionals: string[],
  entry: AscEntry,
  argv: string[],
): Promise<number> {
  const [group, command, target, extra] = positionals
  // 기본 화면은 정상 표면만 보여준다. 내부 primitive 는 물어본 사람에게만 (§54).
  if (values.help || group === undefined || group === 'help') {
    console.log(values.advanced || command === 'advanced' ? ADVANCED_USAGE : USAGE)
    return 0
  }

  // 옛 이름은 그대로 돌되 새 이름을 말한다 (§58·§59). **명령이 실제로 돌기 전에** 말한다 —
  // 뒤에서 말하면 그 명령이 다른 이유로 멈췄을 때 사람은 이름이 바뀐 것을 끝내 모른다.
  const renamed = RENAMED[group === 'progress' && command === 'show' ? 'progress show' : group]
  if (renamed) console.error(`Deprecated. Use \`${renamed}\`.`)

  // **지원 하한을 먼저 답한다** (C-14 §3). `engines` 는 npm에게 하는 말이라 기본값에서
  // 경고로만 나가고, 그러면 "경고 뒤에 그래도 돌아감"이 된다 — 사용자는 자기가 지원
  // 범위 안인지 끝내 모른다. 여기서 한 번, 결정적으로 답한다.
  //
  // 이 자리인 이유: 설치된 `asc` 와 bootstrap이 **같은 문으로 들어온다**. bootstrap에
  // 두면 그쪽에 정책이 생기고(C-14 불변식 ⑦), 그러면 두 진입의 답이 갈릴 수 있다.
  const runnable = await checkNodeRuntime(nodeRuntimeDeps())
  if (!runnable.ok) {
    // 후보를 이미 찾았으면 처방 대신 실행한다 — 같은 명령, 같은 argv, 호환 Node (A6).
    const reexec = reexecWithCandidate(runnable, argv, {
      // **어느 문으로 들어왔는지가 재실행을 넘어가야 한다.** 이것이 없으면 bootstrap 으로
      // 시작한 첫 설치가 재실행 뒤 자기를 설치된 runtime 이라고 말하고, 그러면 stable
      // runtime 설치도 기계 등록도 계획에 들지 않는다 — 기본 Node 가 하한보다 낮은 기계에서
      // 첫 설치가 조용히 절반만 끝나던 자리다.
      env: { ...process.env, [ENTRY_ENV]: entry },
      entry: fileURLToPath(import.meta.url),
      spawn: (path, args, env) => {
        const child = spawnSync(path, args, { stdio: 'inherit', env: env as NodeJS.ProcessEnv })
        return { status: child.status, signal: child.signal, ...(child.error ? { error: child.error } : {}) }
      },
    })
    if (reexec !== null) return reexec
    reportNodeRuntime(runnable, Boolean(values.json) || Boolean(values.agent))
    return 1
  }

  // 선택된 build로 넘길 것이 있으면 여기서 넘긴다. **선택 자체를 다루는 명령은 넘기지
  // 않는다** — 잘못 가리키는 선택을 고치거나 들여다보는 명령이 그 선택 때문에 못 돌면
  // 사람이 갇힌다.
  // 기계 수준 명령은 **프로젝트와 무관하다.** 붙지 않은 자리에서도 답해야 하고,
  // 등록된 서비스는 어느 프로젝트 안에서 도는 것이 아니다 (설계 §4.1).
  // 업데이트는 **갈아 끼우려는 그 build 로 넘어가면 안 된다** — 넘어가면 구본이 자기를
  // 교체하는 셈이고, 교체 도중 그 파일들이 사라진다. 붙지 않은 자리에서도 답해야 하므로
  // 기계 수준 명령과 같은 자리에 둔다.
  const machineLevelRuntime =
    group === 'update' ||
    // 제품을 걷어내는 일도 갈아 끼우는 일과 같다 — 없애려는 그 build 로 넘기지 않는다.
    group === 'uninstall' ||
    (group === 'runtime' &&
    (command === 'use' ||
      command === 'status' ||
      command === 'list' ||
      command === 'service' ||
      (command === 'tick' && Boolean(values.all))))

  if (!machineLevelRuntime) {
    const redispatched = await redispatchIfNeeded(argv)
    if (redispatched !== null) return redispatched
  }

  if (group === 'workspace') return runWorkspace(command, values)

  // 어느 build를 쓸지는 **프로젝트와 무관하다** — 붙기 전에도 답해야 한다 (C-14 §5).
  if (group === 'runtime' && (command === 'use' || command === 'status')) {
    return runRuntimeSelect(command, positionals[2], positionals[3], values)
  }
  if (group === 'runtime' && command === 'list') return runRuntimeList(values)
  if (group === 'runtime' && command === 'service') return runRuntimeService(positionals[2], values)
  // 기계 전체 회차 — 등록된 서비스가 부르는 갈래다.
  if (group === 'runtime' && command === 'tick' && values.all) return runRuntimeTickAll(values)

  if (group === 'host') return runHost(command, positionals[2], positionals[3], values)

  // 갈아 끼우는 일은 붙은 프로젝트와 무관하다 — 어느 자리에서 쳐도 같은 답이어야 한다.
  if (group === 'update') return runUpdate(command, values)

  // 이 runtime 이 소유한 integration 만 지금 상태로 되맞춘다. 버전은 그대로다.
  if (group === 'refresh') return runRefresh(command, values)

  // 제품과 제품이 심은 것을 걷어낸다. 사용자 상태는 남는다.
  if (group === 'uninstall') return runUninstall(command, values)

  // 첫 진단 표면. 붙지 않은 자리에서도 답해야 한다.
  if (group === 'status') return runStatus(values)

  // `asc init` 의 자리는 `asc setup` 이 이어받았다. 옛 이름은 두 minor 동안 그대로 답한다 —
  // **하던 일을 그대로 하면서** 새 이름을 말한다 (§58). 같은 이름에 다른 동작을 넣으면
  // 그것은 alias 가 아니라 조용한 계약 변경이다: `asc init --profile <id>` 는 이 저장소를
  // 붙이는 명령이고, `asc setup` 은 기계까지 준비시키는 더 넓은 명령이다.
  if (group === 'init') return runInit(values)

  // setup은 **붙기 전에도** 답을 줘야 한다. 아래 discoverRoot 실패는 exit 2로 끊는데,
  // 그러면 "아직 안 붙었다"를 확인하려고 부른 명령이 안 붙었다는 이유로 죽는다.
  if (group === 'setup') return runSetup(command, values, entry)

  // `front open` 도 같은 이유로 여기서 답한다. Host lifecycle이 부르는 갈래라
  // **붙지 않은 자리에서 실패하면 안 된다** — 그 자리는 대부분 ASC와 무관한 프로젝트이고,
  // 거기서 exit 2를 내는 것은 남의 세션에 오류를 얹는 일이다 (C-11 불변식 ⑪).
  if (group === 'front' && command === 'open') return runFrontOpen(values)

  // adopt는 **붙기 전의 명령이다.** 붙을 Profile을 만드는 것이 일이므로 attach를 요구하면
  // 순서가 뒤집힌다. 나머지 profile 명령은 아래 attach 경로에 그대로 남는다.
  if (group === 'profile' && command === 'adopt') return runProfileAdopt(values, entry)

  if (!['inbox', 'grant', 'monitor', 'runtime', 'front', 'coordination', 'freeze', 'thaw', 'escalate', 'profile', 'session', 'controller', 'proceed', 'progress', 'preflight', 'closure', 'query', 'mode', 'work'].includes(group)) {
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

  // 실행을 누가 하는가 (Axis C). Agent Management 도 Decision Authority 도 바꾸지 않는다.
  //
  // **lock drift 앞에서도 답해야 한다** (E-02·§16). enforcement 를 낮추는 공식 출구가
  // 설정이 어긋났다는 이유로 막히면 그것이 곧 출구 없는 AUTO 다. 그래서 아래 bootstrap
  // 문보다 앞에 선다 — 권한 판정은 이 명령 안에서 Core 가 그대로 한다.
  if (group === 'mode') return runMode(command, values, store, root, await attachedRuntime(root))

  // attach된 프로젝트라면 Run을 시작하기 전에 지금 설정이 lock과 같은지 본다 (OM §4.9)
  const guard = await checkBootstrap(root)
  if (guard.code !== 0) return guard.code

  // 정상 작업 표면. 안쪽 단계는 그대로 남고, 사람이 그 순서를 외우지 않는다.
  if (group === 'work') return runWork(command, target, values, store, root, guard.runtime)

  if (group === 'proceed') {
    return withDeprecation('asc work start', values, () => runProceed(values, store, root, guard.runtime))
  }
  if (group === 'session') return runSession(command, target, values, store, guard.runtime)
  if (group === 'controller') return runController(command, values, store, guard.runtime)
  if (group === 'closure') return runClosure(command, target, values, store)
  if (group === 'query') return runQuery(command, target, values, store, guard.runtime)
  if (group === 'progress') {
    return command === 'show'
      ? withDeprecation('asc work status', values, () => runProgress(command, target, values, store))
      : runProgress(command, target, values, store)
  }
  if (group === 'preflight') return runPreflight(values, store, guard.runtime)
  if (group === 'grant') return runGrant(command, target, values, store, root, guard.runtime)
  if (group === 'monitor') return runMonitor(command, values, store, renderer, guard.runtime)

  if (group === 'runtime') return runRuntime(command, values, store, renderer, guard.runtime)

  // 새 대화가 붙었을 때 지금 상태를 되찾는다 (C-12 §4). 읽기만 한다.
  if (group === 'front') return runFront(command, values, store, root)

  // 밖에 물은 것이 실제로 전달됐는가. 읽기만 한다.
  if (group === 'coordination') return runCoordination(command, values, store, root, guard.runtime)

  // 사람에게 올릴 자격이 있는가 (C-13). 자격 없으면 request가 만들어지지 않는다.
  if (group === 'escalate') return runEscalate(command, target, values, store, guard.runtime)

  // 원격을 얼린다·녹인다. 로컬 작업은 얼리지 않는다 (지시 §27).
  if (group === 'freeze' || group === 'thaw') return runFreeze(group, command, values, store)

  // 남은 것은 inbox 다. 이름만 치면 목록이다 — 사람이 물은 것은 "무엇이 기다리는가" 이고,
  // 그 답을 얻으려고 하위 명령을 하나 더 외우게 하지 않는다 (§49).
  switch (command ?? 'list') {
    case 'list': {
      const items = await operator.list({ all: Boolean(values.all), ...(priority ? { priority } : {}) })
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
        actor: values.as as string,
        channel: 'local',
        ...(values.revision !== undefined ? { revision: values.revision as string } : {}),
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
  // **자리만 있고 workspace 가 없으면 등록된 것이 아니다.** 이 상태에서 "이미 등록됨" 이라고
  // 답하면 붙기는 성공하는데 기계 전체 화면에는 끝내 나타나지 않는다 — 등록된 서비스가
  // 그 workspace 를 영영 돌지 않는다. 색인이 부분적으로 지워진 자리에서 실제로 그랬다.
  const orphaned = existing !== null && index.workspaces[existing.workspaceId] === undefined
  if (existing && !orphaned && !declaredWorkspace) {
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

  // 상태가 남아 있으면 그 id 로 되돌린다 — 새 id 를 주면 세션·증거가 있는 자리가 고아로 남는다.
  const workspaceId = orphaned && existing ? existing.workspaceId : newWorkspaceId()
  const root = join(home, 'workspaces', workspaceId)
  if (orphaned) console.log(`This location pointed at ${workspaceId}, which the index no longer lists — registering it again.`)
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
      hosts: [{ id: 'claude', installed: await verifyInstalled(hostPaths()) }],
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
  console.log('You can see this summary again any time with `asc status`.')
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

// RELEASE_VERSION 이 정본이다 — 여기 문자열을 따로 두면 릴리스마다 낡는다 (0.3.0 에서
// 0.2.1 로 남아 lock 의 ascVersion 표기가 실제와 어긋났다).
const ASC_VERSION = RELEASE_VERSION
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
    // 어느 build를 쓰는지(C-14)와 지금 관측하고 있는지(C-12)는 다른 사실이다. 한 화면에
    // 같이 두되 섞지 않는다 — 붙지 않은 곳에서는 아래 절이 통째로 없다.
    const background = await backgroundHere(values)
    // 서비스 등록은 workspace 와 무관한 기계의 사실이다. 같은 화면에 두되 섞지 않는다.
    const service = await serviceHealth(values)
    if (values.json) {
      console.log(
        JSON.stringify(
          {
            selection: selection ?? null,
            target,
            file: selectionPath(home),
            ...(service ? { service } : {}),
            ...(background ? { background } : {}),
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
    if (service) console.log(service.line)
    if (background) for (const line of renderBackground(background)) console.log(line)
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
  // `asc setup` 은 **준비시키는** 명령이다 (§19). 진단은 `asc status` 가 맡는다 —
  // 같은 이름이 어제는 보고 오늘은 바꾸는 것이면 사람이 둘 중 무엇인지 매번 확인해야 한다.
  if (command === undefined) return runSetupLifecycle('apply', values, entry)
  if (command !== 'status') {
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
/**
 * 이 저장소가 스스로 증명하는 Profile 이름 (P0 F2).
 *
 * **파일을 만들지 않는다** — 이름과 "이미 있는가"만 관측한다. 다른 논리 workspace 를
 * 찾아 합치는 것이 아니라, 이 checkout 의 remote 하나에서 읽히는 신원이다 (C-11 유지).
 */
async function adoptableState(projectRoot: string, git: boolean): Promise<Pick<SetupState, 'adoptable'>> {
  if (!git) return {}
  const remotes = await gitRemotes(projectRoot)
  if (remotes.length === 0) return {}
  try {
    const adopted = buildAdoptedProfile({
      dirName: basename(projectRoot),
      remotes,
      scmForHost: (host) => (host === 'github.com' ? 'github' : 'git'),
    })
    // **공유 주소가 없으면 후보가 아니다.** remote 가 프로젝트 신원을 증명하지 못하면
    // 그것은 이 기계 안의 폴더일 뿐이고, 무엇으로 붙을지는 사람이 정한다.
    const project = adopted.profile.project as { repository?: string } | undefined
    if (!project?.repository || project.repository.startsWith('local/')) return {}
    const exists = existsSync(join(externalProfileRoot(), adopted.id, 'profile.json'))
    return { adoptable: { id: adopted.id, exists } }
  } catch {
    // 이름을 만들 수 없는 저장소가 있다. 그때는 이 축이 없는 것이고, 사람이 고른다.
    return {}
  }
}

/**
 * 승인 권한자가 서 있는가, 그리고 지금 이 사람을 무엇으로 부를 수 있는가 (P0 F2).
 *
 * **인증된 provider 가 말한 이름을 쓴다.** ASC 가 지어내지 않고, 자격 값은 읽지 않는다.
 */
async function identityState(
  ascRoot: string | undefined,
  workspaceComing: boolean,
): Promise<Pick<SetupState, 'identity'>> {
  const wired = ascRoot ? Object.keys(await loadIdentityMap(ascRoot)).length > 0 : false
  if (wired) return { identity: { wired: true } }
  // **세울 workspace 가 없으면 누구인지 묻지 않는다.** 물으려면 provider CLI 를 불러야
  // 하고, 그 도구는 자기 설정 파일을 만든다 — 멈출 계획이 남기는 자국이 되면 안 된다.
  if (!workspaceComing) return { identity: { wired: false } }
  const actor = await detectActor()
  return { identity: { wired: false, ...(actor ? { actor } : {}) } }
}

/**
 * 지금 이 사람을 `<channel>:<actor>` 로. 인증된 통로가 먼저다 — 그것이 실제로 밖에서
 * 나를 부르는 이름이고, git 의 표시 이름은 아무 계정과도 이어지지 않는다.
 */
async function detectActor(): Promise<string | null> {
  const gitlab = await execText('glab', ['api', 'user'])
  const gitlabName = readJsonField(gitlab, 'username')
  if (gitlabName) return `gitlab:${gitlabName}`
  const github = await execText('gh', ['api', 'user'])
  const githubName = readJsonField(github, 'login')
  if (githubName) return `github:${githubName}`
  const local = await detectSelf()
  return local ? `local:${local}` : null
}

function readJsonField(text: string | null, field: string): string | null {
  if (!text) return null
  try {
    const value = (JSON.parse(text) as Record<string, unknown>)[field]
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/**
 * 발견이 증명하는 결합 (P0 F2).
 *
 * **역할은 capability 로 정한다** — provider 이름으로 정하면 이 자리가 provider 목록이
 * 된다. 변경을 아는 통로가 code, 작업 항목을 세는 통로가 work 다. 같은 역할에 후보가
 * 둘이면 origin remote 가 가리키는 쪽을 쓰고, 그것으로도 갈리면 아무것도 제안하지 않는다.
 */
async function bindingProposalState(
  projectRoot: string,
  profileId: string | undefined,
  willCreate: boolean,
): Promise<Pick<SetupState, 'bindingProposal'>> {
  if (!profileId) return {}
  // 이미 선언이 있으면 손대지 않는다 — 사람이 적은 것이 먼저다.
  // 파일이 아직 없어도 **이번에 만들 것이면** 비어 있는 것과 같다: adopt 는 결합을
  // 적지 않으므로, 그 사실을 여기서 미리 알아야 한 번의 apply 로 끝난다.
  const declared = await readProfileBindings(profileId)
  if (declared === null && !willCreate) return {}
  if (declared !== null && declared.length > 0) return {}

  const adapters = monitorAdapters()
  const plan = await composeBindings({ context: { projectRoot, env: process.env }, adapters, roles: [] })
  const usable = plan.bindings.filter((binding) => binding.state === 'AVAILABLE' || binding.state === 'DEGRADED')
  const origin = (await gitRemotes(projectRoot)).find((remote) => remote.name === 'origin')
  const originAlias = origin ? normalizeRemote(origin.url) : null

  const byRole = new Map<string, { role: string; adapter: string; resource: string }[]>()
  for (const binding of usable) {
    const role = binding.provides.includes('context.change')
      ? 'code-primary'
      : binding.provides.includes('inventory.enumerate')
        ? 'work'
        : null
    if (!role) continue
    byRole.set(role, [...(byRole.get(role) ?? []), { role, adapter: binding.adapterId, resource: binding.resource }])
  }

  const proposal: { role: string; adapter: string; resource: string }[] = []
  for (const [role, candidates] of byRole) {
    if (candidates.length === 1) {
      proposal.push(candidates[0]!)
      continue
    }
    // origin 이 가리키는 것 하나면 그것이다 — 이 저장소의 주소가 그 판정의 근거다.
    const matching = originAlias
      ? candidates.filter((candidate) => originAlias.endsWith(`/${candidate.resource}`))
      : []
    if (matching.length === 1) proposal.push(matching[0]!)
    else return {}
  }
  return proposal.length > 0 ? { bindingProposal: proposal } : {}
}

/**
 * 발견이 증명한 결합을 Profile 파일에 적는다.
 *
 * **이미 있는 선언은 건드리지 않는다** — 사람이 적은 것이 먼저다. 그 밖의 필드도 그대로
 * 둔다: 이 함수가 아는 것은 `bindings` 한 칸뿐이다.
 */
async function writeProfileBindings(
  profileId: string,
  bindings: readonly { role: string; adapter: string; resource: string }[],
): Promise<boolean> {
  const path = join(externalProfileRoot(), profileId, 'profile.json')
  const profile = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  if (Array.isArray(profile.bindings) && profile.bindings.length > 0) return false
  profile.bindings = bindings.map((binding) => ({ ...binding }))
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  console.log(`bindings declared in ${profileId}: ${bindings.map((b) => `${b.role}=${b.adapter}`).join(', ')}`)
  return true
}

/**
 * 이 checkout 이 증명하는 정본 갈래 (P0 F5).
 *
 * **remote 에게 물어본다.** 로컬 `origin/HEAD` 는 clone 시점에 고정돼 낡는다 — 이 저장소에서
 * 그 값은 `main` 인데 remote 의 기본 branch 는 `develop` 이었다. 낡은 값을 정본으로 적으면
 * 세션이 엉뚱한 baseline 을 딛는다. 물어보지 못하면 적지 않는다.
 */
async function canonicalProposalState(
  projectRoot: string,
  git: boolean,
  profileId: string | undefined,
  willCreate: boolean,
): Promise<Pick<SetupState, 'canonicalProposal'>> {
  if (!git || !profileId) return {}
  const declared = await readProfileCanonical(profileId)
  if (declared === null && !willCreate) return {}
  if (declared !== null && declared > 0) return {}

  const symref = await execText('git', ['-C', projectRoot, 'ls-remote', '--symref', 'origin', 'HEAD'])
  const match = symref ? /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(symref) : null
  const branch = match?.[1]
  if (!branch) return {}
  // provider 는 `git` 이다 — 이 값은 checkout 이 이미 들고 있는 사실이고, 그것을 읽는 통로가
  // 선언된 provider 를 따른다 (canonical baseline 읽기).
  return { canonicalProposal: { id: branch, provider: 'git', remote: 'origin', ref: branch } }
}

/** Profile 이 선언한 정본 갈래 수. 파일이 없으면 `null`. */
async function readProfileCanonical(profileId: string): Promise<number | null> {
  const path = join(externalProfileRoot(), profileId, 'profile.json')
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { canonical?: { sources?: unknown } }
    return Array.isArray(parsed.canonical?.sources) ? parsed.canonical.sources.length : 0
  } catch {
    return null
  }
}

/**
 * remote 가 말한 정본 갈래를 Profile 에 적는다. 이미 선언이 있으면 손대지 않는다.
 */
async function writeProfileCanonical(
  profileId: string,
  source: { id: string; provider: string; remote: string; ref: string },
): Promise<boolean> {
  const path = join(externalProfileRoot(), profileId, 'profile.json')
  const profile = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  const canonical = (profile.canonical ?? {}) as { sources?: unknown[] }
  if (Array.isArray(canonical.sources) && canonical.sources.length > 0) return false
  profile.canonical = { ...canonical, sources: [source] }
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  console.log(`canonical source declared in ${profileId}: ${source.remote}/${source.ref}`)
  return true
}

/** Profile 이 이미 선언한 결합. 파일이 없으면 `null` — 없는 것과 비어 있는 것은 다르다. */
async function readProfileBindings(
  profileId: string,
): Promise<{ role?: string; adapter: string; resource: string }[] | null> {
  const path = join(externalProfileRoot(), profileId, 'profile.json')
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { bindings?: unknown }
    return Array.isArray(parsed.bindings) ? (parsed.bindings as { adapter: string; resource: string }[]) : []
  } catch {
    return null
  }
}

async function detectSetupState(values: Record<string, unknown>, entry: AscEntry): Promise<SetupState> {
  const { root: projectRoot, git } = await discoverProjectRoot(process.cwd())
  const resolution = await resolveRoot(process.cwd(), values.root as string | undefined)
  const ascRoot = resolution.kind === 'UNRESOLVED' ? undefined : resolution.root
  // 디렉터리가 있다고 붙은 것이 아니다 — profile.lock까지 서야 붙은 것이다. 빈 skeleton을
  // "붙어 있음"으로 넘기면 plan이 applied를 답하며 실패할 proceed를 준다 (실측 ASC-2).
  const attachmentBroken = ascRoot ? (await inspectSetup(ascRoot)).attachment === 'BROKEN' : false
  const scope = values.scope === 'project' ? 'project' : 'local'
  const hostReport = await verifyInstall(hostPaths())
  const adoptable = await adoptableState(projectRoot, git)
  const attachedProfile = ascRoot ? await lockedProfileId(ascRoot) : undefined
  // 이번 계획이 쓸 Profile 하나 — 그것의 결합 선언이 비어 있을 때만 제안을 관측한다.
  const targetProfile = (values.profile as string | undefined) ?? attachedProfile ?? adoptable.adoptable?.id
  const stable = entry === 'bootstrap' ? await detectStableInstall(nodeProcessRunner) : undefined
  return {
    entry,
    projectRoot,
    git,
    ...(ascRoot ? { ascRoot } : {}),
    ...(attachmentBroken ? { attachmentBroken } : {}),
    ...(values.profile ? { requestedProfile: values.profile as string } : {}),
    profileCandidates: await availableProfiles(installRoot(), externalProfileRoot()),
    scope,
    ...(attachedProfile ? { attachedProfile } : {}),
    // fresh onboarding 이 사람에게 되묻지 않으려면 이 셋이 관측돼 있어야 한다 (P0 F2).
    ...adoptable,
    ...(await identityState(ascRoot, Boolean(ascRoot) || Boolean(targetProfile))),
    ...(await bindingProposalState(projectRoot, targetProfile, Boolean(adoptable.adoptable && !adoptable.adoptable.exists))),
    ...(await canonicalProposalState(
      projectRoot,
      git,
      targetProfile,
      Boolean(adoptable.adoptable && !adoptable.adoptable.exists),
    )),
    host: [{ id: 'claude', status: hostReport.status }],
    // Profile 이 작업 도구를 선언했으면 그 준비 상태까지 본다 (설계 §9.3).
    ...(await workBindingState(ascRoot, projectRoot)),
    // **bootstrap으로 들어왔을 때만 본다.** 설치된 runtime이 자기를 다시 설치할 이유가
    // 없고, 그 축을 안 그리면 plan은 설치된 `asc` 를 전제하지도 않는다 (C-14 §3.4).
    ...(stable ? { stableRuntime: stable } : {}),
    // 이 기계의 지속 등록. **별도 onboarding 을 만들지 않는다** — 같은 계획에 함께 든다.
    ...(await persistentRuntimeState(values, Boolean(stable && stable.status !== 'CURRENT'))),
  }
}

/**
 * 지금 도는 것이 **설치된 패키지인가.**
 *
 * 등록물은 지금 도는 진입점의 절대 경로를 박는다. checkout 이나 일회용 prefix 에서
 * 등록하면 사라질 경로를 기계에 남기는 일이 된다 — 등록은 이 기계에 오래 남을 설치본이
 * 스스로 할 때만 의미가 있다.
 */
function runningFromInstalledPackage(): boolean {
  const here = fileURLToPath(import.meta.url).replace(/\\/g, '/')
  // **npx 캐시도 node_modules 다.** 경로 모양만 보면 임시 자리가 설치본으로 통과하고,
  // 실제로 그렇게 통과해 등록물이 npx 캐시를 가리켰다 — 캐시를 지우면 깨진다.
  return here.includes('/node_modules/@asc-agent/runtime/') && !isTransientPath(here)
}

/**
 * 지금 이 실행에서 기계 등록을 다뤄도 되는가.
 *
 * **기계 서비스는 HOME 으로 격리되지 않는다.** ASC_HOME 을 옮겨도 launchd·Task
 * Scheduler·systemd 는 같은 기계 하나를 본다 — 그래서 격리된 환경에서 setup 을 통째로
 * 돌려 보는 검증에는 이 축을 끄는 길이 필요하다. 그 길이 없으면 검증이 실행한 기계에
 * 진짜 서비스를 남긴다.
 */
function serviceRegistrationAllowed(): boolean {
  if (process.env.ASC_SERVICE === 'off') return false
  return true
}

/**
 * 이 기계에 ASC runtime 이 등록돼 있는가 (설계 §6, Gate 7).
 *
 * 물어볼 수 없으면 이 축을 그리지 않는다 — 모르는 것을 "해야 한다"로 적으면 설치되지
 * 않은 기계에서 setup 이 영영 끝나지 않는다.
 */
async function persistentRuntimeState(
  values: Record<string, unknown>,
  installing: boolean,
): Promise<Pick<SetupState, 'persistentRuntime'>> {
  if (!serviceRegistrationAllowed()) return {}
  const adapter = serviceAdapter()
  if (!adapter) return {}
  // 등록물이 가리킬 자리가 없으면 이 축을 그리지 않는다 — 깨진 등록을 남기느니 등록하지
  // 않고 그 사실을 말한다 (P0 F1).
  //
  // **이번 계획이 그 자리를 만든다면 지금 없는 것은 근거가 아니다.** 첫 설치는 npx 로
  // 들어와 전역 runtime 을 놓는데, 그 전에 판정하면 "가리킬 것이 없다" 가 되어 등록이
  // 영영 계획에 들지 않는다 — 사람이 뒤에 명령 하나를 더 쳐야 했던 자리다. 등록 자체는
  // apply 순서상 맨 마지막이고, 그때 다시 해석한다.
  const runtime = await serviceRuntime()
  if (runtime.kind !== 'STABLE' && !installing) {
    return { persistentRuntime: { action: 'unsupported', adapter: adapter.id, detail: runtime.detail } }
  }
  if (runtime.kind !== 'STABLE') {
    // 아직 없다 — 이번에 놓는다. 그러면 등록할 것이 생긴다.
    return { persistentRuntime: { action: 'install', adapter: adapter.id } }
  }
  const plan = await planPersistentRuntime(adapter, serviceCommand(serviceInterval(values), runtime)).catch(() => null)
  if (!plan) return {}
  return {
    persistentRuntime: {
      action: plan.action,
      adapter: adapter.id,
      ...(plan.state.kind !== 'CURRENT' && 'detail' in plan.state && plan.state.detail
        ? { detail: plan.state.detail }
        : {}),
    },
  }
}

/**
 * Profile 이 선언한 작업 도구가 지금 쓸 수 있는가 (설계 §9.3).
 *
 * **선언이 없으면 아무것도 보지 않는다** — 선언되지 않은 도구를 준비시키는 것은
 * 사람이 하지 않은 결정을 대신 내리는 일이다.
 *
 * 판정은 그 도구가 한다. 여기서 하는 것은 그 판정을 setup 이 읽을 수 있는 모양으로
 * 옮기는 것뿐이고, 도구를 실행하지 못하면 이 축을 그리지 않는다(모르는 것을
 * "준비 안 됨"으로 적지 않는다).
 */
async function workBindingState(
  ascRoot: string | undefined,
  projectRoot: string,
): Promise<Pick<SetupState, 'workBinding'>> {
  if (!ascRoot) return {}
  const runtime = await attachedRuntime(ascRoot)
  const declared = (runtime?.layers.profile.bindings ?? []).find((binding) => binding.role === 'work')
  // 지금 준비 상태를 물어볼 수 있는 도구는 JAM 뿐이다. 다른 adapter 가 생기면 여기가 는다.
  if (!declared || declared.adapter !== 'jam') return {}

  const launcher = jamLauncher()
  const adapter = new JamAdapter(
    process.env.ASC_JAM_PATH ? {} : { command: launcher.command, args: launcher.args },
  )
  const status = await adapter
    .runtime({ projectRoot, env: process.env })
    .catch(() => ({ state: 'UNAVAILABLE' as const, detail: 'could not ask' }))
  if (status.state === 'AVAILABLE') {
    return { workBinding: { adapter: 'jam', resource: declared.resource, ready: true } }
  }

  const remedy = adapter.lastRemedy()
  // 도구를 아예 못 불렀으면 이 축을 그리지 않는다 — 그 상태에서 "고쳐야 한다"고 적으면
  // 설치되지 않은 기계에서 setup 이 영영 끝나지 않는다.
  if (!remedy) return {}
  const version = await jamVersion(projectRoot)
  return {
    workBinding: {
      adapter: 'jam',
      resource: declared.resource,
      ready: false,
      remedy: remedy.kind,
      detail: remedy.detail,
      ...(version ? { version } : {}),
    },
  }
}

/**
 * JAM 이 말한 자기 버전. **여기서 정하지 않는다** — 두 제품의 릴리스를 묶지 않기 위해서다.
 * 못 읽으면 undefined 이고, 그러면 계획이 그 도구를 부르지 않는다.
 */
async function jamVersion(projectRoot: string): Promise<string | undefined> {
  const launcher = jamLauncher()
  const { command, args } = resolveJamCommand(process.env, launcher.command, launcher.args)
  try {
    const { stdout } = await execFileAsync(command, [...args, 'doctor', '--json'], { cwd: projectRoot })
    return (JSON.parse(stdout) as { axes?: { packageVersion?: string } }).axes?.packageVersion
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout
    if (!stdout) return undefined
    try {
      return (JSON.parse(stdout) as { axes?: { packageVersion?: string } }).axes?.packageVersion
    } catch {
      return undefined
    }
  }
}

/**
 * `npm` 을 shim으로 부르지 않는다.
 *
 * Windows에서 `npm` 은 `npm.cmd` 이고, Node는 보안 수정 이후 shell 없이 `.cmd` 를 실행하지
 * 않는다 — 그대로 두면 `asc status` 가 전역 설치를 조회하지 못하고 "설치 안 됨"으로
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
    console.error('붙어 있는 Profile 을 알 수 없다 — `asc status` 를 보고, 필요하면 --profile 로 지목하라.')
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

/**
 * 바깥 명령 하나의 표준 출력. 실패는 `null` 이다.
 *
 * `resolveCommand` 를 거친다 — 안 거치면 Windows 에서 `npm` 이 ENOENT 로 죽고, 이 함수는
 * 그것을 "출력이 없다"와 구분하지 않으므로 **전역 설치본이 있는데 없다고 답한다.**
 * 실기계에서 그렇게 됐고, 그 빈 답이 등록물에 placeholder 가 박히는 상류 원인이었다.
 */
async function execText(command: string, args: string[]): Promise<string | null> {
  const [runnable, runArgs] = resolveCommand(command, args)
  try {
    const { stdout } = await execFileAsync(runnable, runArgs)
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
  const relock = async (profile: string): Promise<void> => {
    const root = await discoverRoot(process.cwd(), values.root as string | undefined)
    if (!root) return
    const code = await runProfile('resolve', { ...values, profile, write: true }, root)
    if (code !== 0) throw new Error(`profile re-lock 실패 (exit ${code})`)
  }
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
      registerPersistentRuntime: async () => {
        const adapter = serviceAdapter()
        if (!adapter) return
        const runtime = await serviceRuntime()
        if (runtime.kind !== 'STABLE') {
          console.error(`Persistent runtime not registered — ${runtime.detail}`)
          return
        }
        try {
          await adapter.install(serviceCommand(serviceInterval(values), runtime))
          console.log(`Persistent runtime registered with ${adapter.id}.`)
        } catch (error) {
          // **등록 실패는 attach 실패가 아니다.** 기계 등록은 이 프로젝트가 붙는 것과
          // 다른 축이고, 서비스 관리자가 없거나 거절하는 환경은 흔하다. 조용히 넘기지도
          // 않는다 — 무엇이 안 됐는지 말하고, 상태는 `runtime status` 가 계속 답한다.
          console.error(`Persistent runtime could not be registered with ${adapter.id}: ${String(error)}`)
        }
      },
      // 그 도구의 공식 setup 을 부른다. ASC 가 그 설정을 손으로 조립하지 않는다.
      setupWorkBinding: async (change) => {
        const outcome = await healJam({ cwd: process.cwd(), version: change.version })
        console.log(healLine(outcome))
        if (outcome.kind === 'FAILED') throw new Error(healLine(outcome))
      },
      installHost: async (change) => {
        const code = await runHost('claude', 'install', undefined, { ...values, json: false })
        if (code !== 0) throw new Error(`${change.host} 설치 실패 (exit ${code})`)
      },
      // 이 저장소를 설명하는 Profile 을 만든다. 이름은 plan 이 이미 정했다.
      adoptProfile: async (change) => {
        const code = await runProfileAdopt({ ...values, id: change.profile, json: true }, entry)
        if (code !== 0) throw new Error(`profile adopt 실패 (exit ${code})`)
      },
      // 승인 권한자를 세운다. 이름과 채널뿐이고 비밀은 다루지 않는다.
      wireIdentity: async (change) => {
        const code = await runSetupIdentity({ ...values, actor: change.actor, role: 'both' })
        if (code !== 0) throw new Error(`identity 결선 실패 (exit ${code})`)
      },
      // 발견이 증명한 결합을 Profile 에 적는다. 갈리는 것은 plan 에 들어오지 않는다.
      declareCanonical: async (change) => {
        const written = await writeProfileCanonical(change.profile, change.source)
        if (written) await relock(change.profile)
      },
      declareBindings: async (change) => {
        const written = await writeProfileBindings(change.profile, change.bindings)
        // Profile 을 고쳤으면 lock 이 어긋난다 — 다음 명령이 그 drift 앞에서 멈춘다.
        // 고친 쪽이 닫는다 (setup identity 가 하는 것과 같다).
        if (written) await relock(change.profile)
      },
    })
  } catch (error) {
    // **적용 실패는 stack trace 가 아니라 답이어야 한다.** agent 는 이 문서를 읽고 다음
    // 행동을 정한다 — 예외가 그대로 나가면 stdout 이 비고 아무것도 판단할 수 없다.
    console.log = speak
    const detail = error instanceof Error ? error.message : String(error)
    emit({ ...plan, status: 'apply_failed', changesApplied: false, detail })
    return 1
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
    ...(runtime ? { canonicalSources: runtime.layers.profile.canonical.sources.length } : {}),
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

/** 한 프로세스에서 한 번만 말한다. 사실은 매번 같고, 반복은 읽히지 않는다. */
let staleLockReported = false

async function checkBootstrap(root: string): Promise<{ code: number; runtime?: ResolvedRuntime }> {
  const outcome = await bootstrapGuard({
    ascRoot: root,
    installRoot: installRoot(),
    externalProfileRoot: externalProfileRoot(),
    capabilities: CAPABILITIES,
    adapters: ADAPTER_VERSIONS,
    ascVersion: ASC_VERSION,
  })
  if (outcome.ok) {
    // 판번호만 낡은 lock 은 멈출 이유가 아니다. 다만 조용히 지나가지도 않는다 —
    // 다음 재고정 때 따라온다는 것을 여기서 한 번 말한다.
    // 한 명령 안에서 이 문이 두 번 지나간다. 같은 말을 두 번 하면 그때부터 사람은
    // 이 줄을 읽지 않는다 — 회차 기록에도 매번 두 줄씩 쌓였다.
    if (outcome.staleLock && !staleLockReported) {
      const moved = outcome.staleLock.find((drift) => drift.field === 'ascCore.version')
      if (moved) {
        staleLockReported = true
        console.error(`(profile.lock was written by ASC ${moved.locked}; this is ${moved.current}. \`asc profile resolve --write\` records it.)`)
      }
    }
    return { code: 0, runtime: outcome.runtime }
  }

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

  // 무엇이 실제로 제공되는지는 붙어 있는 Adapter가 정한다 — 상수가 아니라 실측이다 (A5).
  // discover→probe 를 실제로 돌린다: glab 로그인 같은 상태 변화가 resolve 재실행으로
  // 반영된다 (re-probe 수단이 따로 필요 없다). 실측 실패는 그 갈래가 빠질 뿐이다.
  const composed = await composeBindings({ context: { projectRoot: root, env: process.env } }).catch(
    () => ({ bindings: [] as const }),
  )
  for (const binding of composed.bindings) {
    console.log(
      `Binding: ${binding.adapterId}/${binding.resource} — ${binding.state}${binding.detail ? ` (${binding.detail})` : ''}`,
    )
  }
  // lock 의 capability 표기는 아직 상수다 — 실측을 digest 재료로 쓰면 glab 로그인 여부에
  // 따라 lock 이 흔들린다. 실측을 lock 체계에 관통시키는 것은 P1 로 넘기고(재설계 영역),
  // 여기서는 probe 실측을 사람에게 보이는 것까지 한다. 실사용 read 경로(proceed)는
  // buildWorkIngress 가 이미 composeBindings 실측으로 조립한다.
  const result = resolveRuntime(layers, CAPABILITIES, ASC_VERSION)
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
    adapters: ADAPTER_VERSIONS,
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
async function scmFor(resolved?: ResolvedRuntime): Promise<ScmPort | undefined> {
  if (!resolved) return undefined

  const sources = resolved.layers.profile.canonical.sources
  // Profile 은 갈래마다 provider 를 적는다. `git` 이라고 적힌 것은 이 checkout 이 이미
  // 들고 있는 사실이므로 원격 API 로 가지 않는다 — 갈 수 있다는 보장도 없다.
  if (sources.length > 0 && sources.every((source) => source.provider === 'git')) {
    const { root } = await discoverProjectRoot(process.cwd())
    const refs: Record<string, { ref: string; remote?: string }> = {}
    for (const source of sources) {
      if (source.ref) refs[source.id] = { ref: source.ref, ...(source.remote ? { remote: source.remote } : {}) }
    }
    return new LocalCanonicalReader({ cwd: root, sourceRefs: refs })
  }

  const token = await discoverToken()
  if (!token) return undefined

  const sourceRefs: Record<string, { ref: string }> = {}
  for (const source of sources) {
    if (source.ref) sourceRefs[source.id] = { ref: source.ref }
  }
  return new GitHubScm({
    client: new GitHubClient({ token }),
    defaultRepo: resolved.layers.profile.project.repository,
    sourceRefs,
  })
}

/**
 * 이 Run 이 잡고 있던 세션을 놓는다.
 *
 * `host claude release` 와 `work finish` 가 같은 것을 해야 해서 여기 있다. 나뉘어 있던
 * 동안 `finish` 는 이 일을 하지 않았고, 끝난 세션이 Run 을 계속 붙들어 다음 bind 가
 * 거부됐다 (#63). 0.8.0 노트는 finish 가 "releases the physical binding" 이라고 적어
 * 두었으므로, 안 하는 쪽이 계약 위반이다.
 */
async function releaseRuntimeBinding(
  store: MarkdownStateStore,
  target: string,
  physical: string,
  at: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const bindings = claudeBindings(store)
  const audit = auditLedger(store)
  const running = (await audit.executionsOf(target)).filter(
    (evidence) => evidence.status === 'RUNNING' && evidence.physicalReference === physical,
  )
  const released = await bindings.release(target, physical)
  // 소유권은 사라져도 그 실행이 있었다는 사실은 남는다 (C-10 §1.3)
  if (released) for (const evidence of running) await audit.endExecution(evidence.executionId, 'RELEASED', at)
  if (!released) return { ok: false, detail: 'Release failed — you are not the owner' }
  // **놓았다고 말하기 전에 확인한다.** guard 는 이 파일 하나로 관리 대상을 정하므로,
  // 지워지지 않은 채 "released" 라고 적으면 그 세션의 외부 write 가 계속 막힌다.
  const after = await bindings.get(target)
  return after
    ? { ok: false, detail: `Release did not take — ${target} is still bound to ${after.physicalSessionId}.` }
    : { ok: true }
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
  const paths = hostPaths()

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

      // 지워졌어야 할 결합이 남아 있으면 여기서 치운다 (0.7.0).
      // 별도 migration 명령을 만들지 않는 이유는 하나다 — 이 상태를 만나는 자리가
      // 여기이고, 사람이 따로 기억해야 하는 정리 절차는 결국 안 돌아간다.
      for (const dead of await bindings.stale()) {
        if (await bindings.forget(dead.logicalSessionId)) {
          console.error(`(stale binding cleared: ${dead.logicalSessionId} ← ${dead.physicalSessionId})`)
        }
      }

      if (!values.physical) {
        console.error('--physical <Claude session id> is required.')
        return 2
      }
      const physical = values.physical as string

      const audit = auditLedger(store)

      if (command === 'release') {
        const outcome = await releaseRuntimeBinding(store, target, physical, at)
        if (!outcome.ok) {
          console.error(outcome.detail)
          return 1
        }
        console.log(`${target} ownership released`)
        return 0
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
        // 부딪힌 상대가 **어느 세션인지** 말한다. 같은 Run 이 다른 세션을 잡고 있는 경우와
        // 이 세션을 다른 Run 이 잡고 있는 경우는 사람이 할 일이 다르다.
        const other = claimed.current.logicalSessionId
        if (other === target) {
          console.error(
            `RUNTIME_CONFLICT: ${target} 은 이미 ${claimed.current.physicalSessionId} 가 잡고 있다. ` +
              '죽은 세션이 확실하면 --force 로 rebind하라.',
          )
          return 1
        }
        // 같은 Run 이 다른 세션을 잡고 있는 경우에도 사람이 할 일은 둘로 갈린다.
        // **끝난 세션이 아직 붙들고 있는 것**은 놓아야 할 잔재이고, 살아 있는 세션을
        // 잡고 있는 것은 설계대로다 — 그때는 Run 을 나누는 것이 답이다. 둘을 같은
        // 문장으로 말하던 동안 앞의 경우가 세 번이나 사람 실수로 읽혔다 (#63).
        const holder = await store.get('session', other)
        const finished = holder?.status === 'DONE'
        console.error(
          finished
            ? `RUNTIME_CONFLICT: 이 Run(${physical}) 은 끝난 세션 ${other} 을 아직 잡고 있다. ` +
              `놓아라: asc host claude release ${other} --physical ${physical}`
            : `RUNTIME_CONFLICT: 이 Run(${physical}) 은 지금 ${other} 을 잡고 있다. ` +
              '한 Run 은 한 세션만 잡는다 — 그 세션을 계속 쓸 것이면 이 작업은 다른 Run 으로 하고, ' +
              `아니면 먼저 놓아라: asc host claude release ${other} --physical ${physical}`,
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
    // **정본이 없는 것과 다른 실패다.** 정본은 code 쪽 사실이고 이것은 작업 항목 쪽이다.
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
  const adapters = monitorAdapters()
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
    //
    // 다만 **작업 항목을 누구에게 물을지는 여기서 정한다** — code 와 work 가 둘 다 자원
    // 조회를 제공하면 `rolesFor` 는 아무것도 정하지 못하고, 그러면 선언해 둔 work binding 이
    // 있는데도 "통로가 없다" 가 된다 (P0 F7).
    roles: { ...rolesFor(plan, declared), ...workItemRoles(plan, declared) },
    perPage: 30,
    ...jamComposition(projectRoot),
    endpointFor: (binding) => endpointOf(adapters, binding),
  })

  const work = ports.resourceContext
  if (!work) return undefined

  // 저장소는 원격 provider 와 무관하게 본다. 이 한 줄이 P0-E 의 요점이다.
  const repo = new LocalRepoAdapter({ cwd: projectRoot })
  const canonicalSource = resolved?.layers.profile.canonical.sources[0]
  const canonicalRef = canonicalSource?.ref
  // remote 를 버리면 로컬 브랜치를 정본처럼 읽는다 — 실전 오판의 경로였다.
  const canonicalRemote = canonicalSource?.remote
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
        ...(canonicalRemote ? { remote: canonicalRemote } : {}),
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
      // 누락과 오값은 다른 실수다 — "필수"라고 답하면 이미 준 사람은 자기가 무엇을
      // 틀렸는지 모른다 (Windows 실전 실측 ASC-3).
      const roleChoices = SessionRole.options.join('|')
      if (values.role === undefined || !values.goal) {
        console.error(`--role and --goal are required (role: ${roleChoices})`)
        return 2
      }
      const role = SessionRole.safeParse(values.role)
      if (!role.success) {
        console.error(`'${String(values.role)}' is not a role this build knows — choose one of: ${roleChoices}`)
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
      // 오값을 Core까지 흘리면 ZodError 원문이 사람에게 떨어진다 (실측 ASC-5).
      // 사용자 입력 검증은 Surface의 몫이다 — 여기서 고를 수 있는 값을 그대로 준다.
      const parsedClass = DecisionClass.safeParse(decisionClass)
      if (!parsedClass.success) {
        console.error(
          `'${decisionClass}' is not a decision class — choose one of: ${DecisionClass.options.join(', ')}`,
        )
        return 2
      }
      const audit = auditLedger(store)
      const recorded = await audit.decide({
        sessionId: target,
        actor: (values.as as string) ?? (values.principal as string) ?? '(미상)',
        ownership: (values.ownership as string[]) ?? [],
        class: parsedClass.data,
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
  console.log(renderCollect(outcome))

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

/**
 * 조율 증거 원장. Bounded Query 와 **다른 scope** 에 산다 — 기대와 증거는 다른 사실이고,
 * 한 자리에 두면 "물어봤다"와 "전달됐다"가 다시 한 레코드가 된다.
 */
const coordinationLedger = (store: MarkdownStateStore) => new CoordinationLedger(store.scope('coordination'))

/**
 * 지금 이 workspace 의 조율 상태.
 *
 * 기대는 Bounded Query 에서 오고 증거는 원장에서 온다. **여기서 상태를 만들지 않는다** —
 * 둘을 맞춰 파생할 뿐이다.
 */
async function coordinationNow(
  store: MarkdownStateStore,
  resolved?: ResolvedRuntime,
): Promise<CoordinationView[]> {
  const queries = await queryLedger(store, resolved).list()
  return viewCoordination(
    coordinationLedger(store),
    // 답이 이미 안에서 쓰인 질의는 조율 대상이 아니다 — 밖에 물을 이유가 끝났다.
    queries
      .filter((entry) => entry.answer === null)
      .map((entry) => ({ id: entry.query.id, expectsResponse: entry.query.expectedResponse !== undefined })),
  )
}

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
 * 이 workspace 의 관측 통로들을 만든다 (설계 §8).
 *
 * **한 개가 아니라 N 개다.** 코드가 GitLab 에 있고 작업 항목이 Jira 에 있으면 둘 다 봐야
 * 하고, 그것은 모호함이 아니라 선언이다. 채널마다 Engine 을 하나씩 세우므로 cursor·
 * coverage·observation ledger·lease 가 채널별로 갈라지고, Monitor Core 는 예전 그대로
 * 통로 하나만 아는 물건으로 남는다 — Core 에 provider 분기가 생기지 않는다.
 */
type MonitorChannel = { engine: MonitorEngine; sourceId: string; label: string }

async function buildMonitorEngines(
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  resolved: ResolvedRuntime,
): Promise<{ ok: true; channels: MonitorChannel[]; repo: string } | { ok: false; code: number }> {
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
  const adapters = monitorAdapters()
  const declared = resolved.layers.profile.bindings ?? []
  const plan = await composeBindings({
    context: { projectRoot, env: process.env },
    adapters,
    roles: declared.map((b) => ({ adapterId: b.adapter, resource: b.resource, role: b.role })),
  })
  const built = await buildObservationChannels({
    plan,
    perPage: 30,
    ...jamComposition(projectRoot),
    endpointFor: (binding) => endpointOf(adapters, binding),
  })
  // canonical.read 처럼 한 곳이어야 의미가 서는 것은 예전 경로 그대로 역할로 고른다.
  const singular = await buildRuntimePorts({
    plan,
    roles: rolesFor(plan, declared),
    perPage: 30,
    ...jamComposition(projectRoot),
    endpointFor: (binding) => endpointOf(adapters, binding),
  })

  if (built.channels.length === 0) {
    console.error('No monitoring channel could be built:')
    for (const reason of built.unavailable) console.error(`  - ${reason}`)
    console.error('\nDeclare which provider takes which role in the Profile bindings.')
    return { ok: false, code: 2 }
  }

  const canonicalPaths = resolved.layers.profile.canonical.sources.flatMap((source) => source.paths)
  const myRoles = resolved.layers.override?.monitor.roles ?? []

  const channels: MonitorChannel[] = built.channels.map((channel) => {
    const changeContext = channel.changeContext
    const engine = new MonitorEngine({
      store,
      source: channel.eventSource,
      // 정본 대조는 채널이 아니라 프로젝트의 사실이다 — 역할로 고른 하나를 함께 쓴다.
      ...(singular.scm ? { scm: singular.scm } : {}),
      ...(channel.inventory ? { inventory: channel.inventory } : {}),
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
      // scope는 실제로 붙은 source가 정한다 — 채널이 둘이면 기록도 둘로 갈린다.
      observations: new ObservationLedger(store.scope(monitorScope(channel.eventSource.id))),
      // 조사 단계가 요청하는 통로들. 없는 것은 그 단계가 판정 불성립으로 남는다 (C-07 §6.2).
      // 없는 것을 있는 척하지 않는다.
      investigation: {
        ...(channel.resourceContext ? { resource: channel.resourceContext } : {}),
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
    return {
      engine,
      sourceId: channel.eventSource.id,
      label: `${channel.role ?? '(undeclared)'} · ${channel.adapterId}:${channel.resource}`,
    }
  })

  await rememberMonitorSources(store, channels.map((channel) => channel.sourceId))

  // **밀려난 후보를 말한다.** 실 프로젝트 관측에서 나온 것이다: primary가 자격 없음으로
  // 빠지고 mirror에 조용히 붙으면 "감시가 도는데 아무것도 안 잡히는" 상태가 된다.
  // 고르는 것 자체는 막지 않되, 무엇이 밀렸는지 모르게 두지 않는다 (C-11 §7).
  const skipped = plan.bindings.filter((b) => b.state !== 'AVAILABLE' && b.state !== 'DEGRADED')
  if (skipped.length > 0) {
    console.error('Some candidates could not be used:')
    for (const binding of skipped) {
      console.error(`  - ${binding.adapterId}:${binding.resource} — ${binding.state}${binding.detail ? ` (${binding.detail})` : ''}`)
    }
  }
  for (const reason of built.unavailable) console.error(`  - ${reason}`)

  return { ok: true, channels, repo }
}

/**
 * 이 자리에서 background runtime이 돌고 있는가.
 *
 * **붙지 않았으면 없는 것으로 답한다** (`null`). `runtime status` 는 붙기 전에도 답해야
 * 하는 명령이라(C-14 §5) 여기서 attach를 요구하면 그 성질이 깨진다.
 */
async function backgroundHere(values: Record<string, unknown>): Promise<Awaited<ReturnType<typeof readBackground>> | null> {
  const root = await discoverRoot(process.cwd(), values.root as string | undefined).catch(() => null)
  if (!root) return null
  try {
    const scope = new MarkdownStateStore(root).scope('runtime')
    // 기본 주기 1분에서 나온 회수 기준. start가 다른 주기를 썼다면 그쪽이 더 길 뿐이고,
    // 살아 있는 lease를 죽은 것으로 읽지는 않는다 — heartbeat가 회차마다 갱신된다.
    return await readBackground(scope, staleAfter(60_000))
  } catch {
    // 읽지 못한 것을 "안 돌고 있다"로 적지 않는다 (C-12 불변식 ⑫).
    return null
  }
}

/**
 * 이 기계의 지속 등록 상태 (설계 §13.1).
 *
 * PID 는 여기 없다 — 등록물이 정본이고 프로세스는 갈아 끼우는 실행 인스턴스다
 * (설계 §4.2). 물어볼 수 없으면 `null` 이고, 그때 화면에 그 줄이 없다.
 */
async function serviceHealth(
  values: Record<string, unknown>,
): Promise<{ adapter: string; action: string; line: string } | null> {
  const adapter = serviceAdapter()
  if (!adapter) return null
  const runtime = await serviceRuntime()
  if (runtime.kind !== 'STABLE') {
    return { adapter: adapter.id, action: 'unsupported', line: serviceRuntimeLine(runtime) }
  }
  const plan = await planPersistentRuntime(adapter, serviceCommand(serviceInterval(values), runtime)).catch(() => null)
  if (!plan) return null
  return { adapter: adapter.id, action: plan.action, line: persistentRuntimeLine(adapter.id, plan) }
}

/**
 * 이 기계가 아는 workspace 들 (설계 §6).
 *
 * **두 번째 등록부를 읽지 않는다** — workspace index 하나에서 계산한다.
 */
async function machineWorkspaces(): Promise<WorkspaceView[]> {
  const home = ascHome()
  const index = await readIndex(home)
  return viewWorkspaces(
    Object.values(index.workspaces).map((workspace) => ({
      workspaceId: workspace.workspaceId,
      root: join(home, 'workspaces', workspace.workspaceId),
      aliases: workspace.aliases,
      locators: locatorsOf(index, workspace.workspaceId).map((entry) => entry.locator),
    })),
    (path) => existsSync(path),
  )
}

/**
 * `asc runtime list` — 기계 전체 화면 (설계 §13.2).
 *
 * workspace 마다 `cd` 해서 status 를 반복하게 만들지 않는다. 여기서 밖을 치지 않는다 —
 * 이것은 읽기이고, 관측은 회차가 한다.
 */
async function runRuntimeList(values: Record<string, unknown>): Promise<number> {
  const views = await machineWorkspaces()
  if (values.json) {
    console.log(JSON.stringify({ workspaces: views }, null, 2))
    return 0
  }
  for (const line of renderWorkspaces(views)) console.log(line)
  return 0
}

/** 이 OS 의 등록 통로. 모르는 OS 면 `null` — 없는 것을 있는 척하지 않는다. */
function serviceAdapter(): PersistentRuntimeAdapter | null {
  switch (serviceAdapterFor(process.platform)) {
    case 'launchd':
      return launchdAdapter()
    case 'schtasks':
      return schtasksAdapter()
    case 'systemd-user':
      return systemdUserAdapter()
    default:
      return null
  }
}

/**
 * 등록물이 실행할 명령. **한 회차만 돈다.**
 *
 * 지금 도는 실행 파일과 진입점을 그대로 쓴다 — 어느 build 를 쓸지는 그 진입점이 다시
 * 정하므로(C-14), 등록물이 build 를 고르는 일은 없다.
 */
function serviceCommand(intervalSeconds: number, runtime: Extract<ServiceRuntimeResolution, { kind: 'STABLE' }>): ServiceCommand {
  return {
    program: runtime.node,
    args: [runtime.entry, 'runtime', 'tick', '--all'],
    intervalSeconds,
    ...serviceEnvironment(runtime.node),
    logPath: join(ascHome(), 'service.log'),
  }
}

/**
 * 등록물이 가리킬 Node 와 진입점 (P0 — fresh onboarding).
 *
 * 지금 이 프로세스가 어디서 도는지와 **다른 질문이다.** bootstrap 은 npx 캐시에서 돌 수
 * 있고, 그 자리는 지워진다. 전역 설치본이 있으면 그것이 답이고, 없으면 등록하지 않는다.
 */
async function serviceRuntime(): Promise<ServiceRuntimeResolution> {
  const stable = await globalRuntimeEntry()
  const check = await checkNodeRuntime(nodeRuntimeDeps())
  return resolveServiceRuntime({
    // **checkout 은 등록물이 가리킬 자리가 아니다.** 지금 도는 것을 후보로 쓰는 것은 그것이
    // 설치된 패키지일 때뿐이고, 아니면 전역 설치본만 남는다 — 없으면 등록하지 않는다.
    ...(runningFromInstalledPackage() ? { runningEntry: fileURLToPath(import.meta.url) } : {}),
    runningNode: process.execPath,
    runningNodeVersion: process.version,
    ...(stable ? { stableEntry: stable } : {}),
    ...(check.ok ? {} : { nodeCandidates: check.candidates }),
  })
}

/** 전역 설치본의 진입점. npm 이 말하는 prefix 를 쓴다 — 경로를 지어내지 않는다. */
async function globalRuntimeEntry(): Promise<string | undefined> {
  const prefix = await execText('npm', ['prefix', '-g'])
  if (!prefix) return undefined
  const entry =
    process.platform === 'win32'
      ? join(prefix, 'node_modules', RUNTIME_PACKAGE, 'dist', 'cli', 'asc.js')
      : join(prefix, 'lib', 'node_modules', RUNTIME_PACKAGE, 'dist', 'cli', 'asc.js')
  return existsSync(entry) ? entry : undefined
}

/**
 * 서비스가 외부 통로를 열 수 있게 하는 환경 (P0-R1).
 *
 * 여기가 어떤 실행 파일이 필요한지 아는 자리다 — 조립 계층은 provider 를 안다. 지금 도는
 * node 의 디렉터리를 맨 앞에 둬서 같은 node 의 npx 가 먼저 잡히게 한다. Windows 의 예약
 * 작업은 사용자 환경을 그대로 물려받으므로 환경을 싣지 않는다.
 */
function serviceEnvironment(node: string): Pick<ServiceCommand, 'environment'> {
  if (process.platform === 'win32') return {}
  const tools = [node, jamLauncher().command, 'glab', 'git']
  const { path } = servicePath(tools)
  return { environment: { PATH: path } }
}

const serviceInterval = (values: Record<string, unknown>): number =>
  values['interval-min'] === undefined ? 5 * 60 : Math.max(60, Number(values['interval-min']) * 60)

/**
 * `asc update` — 돌던 것을 잃지 않고 갈아 끼운다 (C-14 §3).
 *
 * 이 명령이 있는 이유는 실측이다. 한 라운드에 설치본을 다섯 번 갈아 끼웠고, 매번 사람이
 * 구본을 먼저 지우고 `setup` 을 통째로 다시 돌렸다. 뒤쪽이 특히 나쁘다 — `setup` 은
 * profile·binding·정본을 **다시 추론**하는 경로이고, 업데이트는 이미 정해진 것 위에서
 * 실행본만 바꾸는 일이다. 그래서 여기서는 그 함수들을 부르지 않는다.
 *
 * 순서는 계획이 정하고(`planUpdate`), 여기서는 그대로 실행한다.
 */
/**
 * 옛 이름으로 들어온 명령. **하던 일은 그대로 하고**, 새 이름을 알려 준다 (§58·§59).
 *
 * `--json` 은 문서 하나라는 계약이 있다 — 그래서 안내를 그 문서 **안에** 넣는다.
 * 사람에게는 stderr 한 줄이다. stdout 은 옛 형태 그대로 남아야 기존 스크립트가 안 깨진다.
 */
async function withDeprecation(
  replacement: string,
  values: Record<string, unknown>,
  run: () => Promise<number>,
): Promise<number> {
  if (!values.json) return run()
  const captured: string[] = []
  const log = console.log
  console.log = (...parts: unknown[]) => void captured.push(parts.join(' '))
  let code: number
  try {
    code = await run()
  } finally {
    console.log = log
  }
  const text = captured.join('\n')
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    document = undefined
  }
  if (document !== undefined && document !== null && !Array.isArray(document) && typeof document === 'object') {
    console.log(JSON.stringify({ ...(document as Record<string, unknown>), deprecated: true, replacement }, null, 2))
  } else if (text) {
    // 문서 하나가 아니면 형태를 바꾸지 않는다 — 안내는 이미 stderr 로 나갔다.
    console.log(text)
  }
  return code
}

/** 옛 이름 → 새 이름. 두 minor 동안 여기 남는다 (§58). */
const RENAMED: Record<string, string> = {
  init: 'asc setup',
  proceed: 'asc work start',
  'progress show': 'asc work status',
}

/**
 * AUTO 로 갈 수 있는지 판정할 재료를 **이미 관측되는 사실에서** 모은다 (§8).
 *
 * 새 health 저장소를 만들지 않는다. 여기 있는 것은 전부 다른 명령이 이미 보여 주는 것이고,
 * 이 함수는 그것을 한 판정에 모으기만 한다.
 */
async function observeReadiness(root: string | null, runtime?: ResolvedRuntime): Promise<ReadinessAxis[]> {
  // ① 관리된 쓰기 경로가 조립되는가. 없으면 AUTO 는 막기만 하고 내보내지는 못하는 mode 다.
  //    **설정 파일이 있다는 것으로 답하지 않는다** — Composition 이 실제로 만든 Port 가 근거다.
  const outward = root ? await composedPorts(runtime).then((ports) => ports.scm ?? null).catch(() => null) : null
  const axes: ReadinessAxis[] = [
    outward
      ? { axis: 'executor', state: 'READY', detail: outward.id }
      : { axis: 'executor', state: 'MISSING', detail: 'no binding provides an outward write path' },
  ]

  // ② 막을 것을 실제로 막을 수 있는가. hook 이 없으면 AUTO 는 이름뿐이다.
  const host = await verifyInstall(hostPaths())
  axes.push({
    axis: 'guard',
    state:
      host.status === 'INSTALLED_CURRENT'
        ? 'READY'
        : host.hookRegistered
          ? 'DEGRADED'
          : 'MISSING',
    detail: host.status,
  })

  // ③ 그 상태에서 사람이 ASC 를 계속 부를 수 있는가 — 0.7.1 이 갇혔던 자리다.
  const access = await controlPlaneAccess(hostPaths())
  axes.push({
    axis: 'control-plane',
    state: access.denied ? 'BLOCKED_BY_HOST' : access.allowed ? 'READY' : 'MISSING',
    ...(access.detail ? { detail: access.detail } : {}),
  })
  return axes
}

/** provider 에게 "이걸 할 수 있는가" 를 물을 때 쓰는 행위 목록. 화면 표시용이다. */
const EXTERNAL_ACTIONS = [
  'git.push',
  'coordination.publish',
  'gitlab.mr.create',
  'gitlab.mr.merge',
  'gitlab.note.create',
  'gitlab.issue.update',
  'github.issue_comment.create',
] as const

/**
 * `asc status` — 처음 묻는 자리 (§21·§22).
 *
 * **새 SSOT 를 만들지 않는다.** 여기 나오는 사실은 전부 다른 곳이 이미 아는 것이고,
 * 이 명령은 그것들을 한 화면에 모은다. 그리고 증거보다 강하게 말하지 않는다:
 * 붙어 있다는 것이 건강하다는 뜻이 아니고, AUTO 라는 것이 나갈 길이 있다는 뜻이 아니다.
 */
async function runStatus(values: Record<string, unknown>): Promise<number> {
  const resolution = await resolveRoot(process.cwd(), values.root as string | undefined)
  const root = resolution.kind === 'UNRESOLVED' ? null : resolution.root
  const setup = root
    ? await inspectSetup(root)
    : assessSetup({
        attachment: 'UNATTACHED',
        hasApprovers: false,
        hasControllerIdentities: false,
        hasMonitorIdentities: false,
        hasScmToken: await hasToken(),
      })
  const runtime = root ? await attachedRuntime(root) : undefined
  const host = await verifyInstall(hostPaths())
  const selection = await readRuntimeSelection(ascHome())
  const build = await resolveRuntimeTarget(selection)
  const service = await serviceHealth(values)
  const background = await backgroundHere(values)

  const store = root ? new MarkdownStateStore(root) : null
  const mode = store ? await readExecutionMode(store.scope('policy')) : null
  const readiness = judgeAutoReadiness(await observeReadiness(root, runtime))
  // 밖을 읽을 수 있는가 · 밖에 쓸 수 있는가. 두 답 모두 조립 결과에서 나온다.
  const ports = root ? await composedPorts(runtime).catch(() => null) : null
  const external = {
    read: ports?.eventSource?.id ?? ports?.inventory?.id ?? null,
    write: ports?.scm
      ? {
          id: ports.scm.id,
          // 할 수 있는 행위와, 그 중 되돌려 읽을 수 있는 행위. 둘은 다른 사실이고,
          // 화면이 그것을 뭉개면 사람이 확인되지 않는 쓰기를 확인된 것으로 읽는다.
          actions: EXTERNAL_ACTIONS.filter((action) => ports.scm!.supports?.(action) ?? false),
          verifiable: EXTERNAL_ACTIONS.filter((action) => ports.scm!.verifies?.(action) ?? false),
        }
      : null,
    unavailable: ports?.unavailable ?? [],
  }
  const sessions = store
    ? (await store.list('session')).filter((session) => session.status === 'ACTIVE' || session.status === 'PAUSED')
    : []
  const waiting = store ? await new LocalOperator({ store }).list({}) : []

  // 무엇이 지금 걸려 있는가. 사실에서만 뽑는다 — 여기서 추측을 만들지 않는다.
  const degraded: string[] = []
  if (setup.attachment !== 'READY' && root) degraded.push(`attachment ${setup.attachment}`)
  if (host.status !== 'INSTALLED_CURRENT') degraded.push(`host integration ${host.status}`)
  if (mode?.mode === 'AUTO' && !readiness.ready) {
    for (const axis of readiness.blocking) degraded.push(`AUTO ${axis.axis} ${axis.state}`)
  }
  if (service?.action === 'install') degraded.push('this machine has no persistent registration')

  const next = ((): string => {
    if (!root) return 'asc setup'
    if (setup.attachment === 'LOCK_DRIFT') return 'asc setup — the configuration moved away from the lock'
    if (host.status !== 'INSTALLED_CURRENT' && host.status !== 'INSTALLED_MODIFIED') return 'asc refresh'
    if (mode?.mode === 'AUTO' && !readiness.ready) {
      return 'asc mode manual — or fix what AUTO needs, then `asc mode auto`'
    }
    if (waiting.length > 0) return 'asc inbox'
    if (sessions.length > 0) return `asc work status ${sessions[0]!.id}`
    return 'asc work start <WORK>'
  })()

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          version: RELEASE_VERSION,
          runtime: resolution,
          build: 'code' in build ? { error: build } : build,
          installation: host.status,
          setup,
          executionMode: mode ? { mode: mode.mode, chosen: mode.chosen } : null,
          autoReadiness: { ready: readiness.ready, axes: readiness.axes },
          external,
          work: sessions.map((session) => ({ id: session.id, status: session.status, role: session.role })),
          awaitingHuman: waiting.length,
          ...(service ? { service } : {}),
          ...(background ? { background } : {}),
          degraded,
          nextAction: next,
        },
        null,
        2,
      ),
    )
    return 0
  }

  console.log(`asc ${RELEASE_VERSION}`)
  if (!('code' in build)) console.log(runtimeSelectionLine(build))
  console.log(`Installation: ${host.status}`)
  console.log(resolutionLine(resolution))
  console.log(renderSetup(setup))
  console.log('')
  console.log(
    `Execution Mode: ${mode ? `${mode.mode}${mode.chosen ? '' : ' (never chosen — nothing is being enforced)'}` : '(not attached)'}`,
  )
  // AUTO 는 HITL 의 반대가 아니다 — 실행을 누가 하느냐일 뿐이라는 것을 화면이 말한다.
  console.log('  Mode decides who executes. It never decides what a person must approve.')
  for (const axis of readiness.axes) {
    console.log(`  ${axis.state.padEnd(16)} ${axis.axis}${axis.detail ? ` — ${axis.detail}` : ''}`)
  }
  console.log(readiness.ready ? '  AUTO READY' : '  AUTO NOT AVAILABLE')
  if (root) {
    console.log('')
    console.log(`External read:  ${external.read ?? 'none assembled'}`)
    console.log(
      `External write: ${external.write ? `${external.write.id} — ${external.write.actions.join(', ') || 'no known action'}` : 'none assembled'}`,
    )
    if (external.write) {
      console.log(`  read-back available for: ${external.write.verifiable.join(', ') || 'nothing'}`)
    }
    for (const reason of external.unavailable.slice(0, 3)) console.log(`  ${reason}`)
  }
  console.log('')
  if (sessions.length > 0) {
    console.log('Work in progress:')
    for (const session of sessions) console.log(`  ${session.id} ${session.status} — ${session.goal ?? ''}`)
  } else if (root) {
    console.log('Work in progress: none')
  }
  if (waiting.length > 0) console.log(`Waiting for a person: ${waiting.length} (asc inbox)`)
  if (service) console.log(`Background: ${service.line}`)
  if (background) for (const line of renderBackground(background)) console.log(line)
  if (degraded.length > 0) {
    console.log('')
    console.log('Degraded:')
    for (const reason of degraded) console.log(`  - ${reason}`)
  }
  console.log('')
  console.log(`Next: ${next}`)
  // 진단이지 실패가 아니다 — 막힌 것이 있어도 0이다.
  return 0
}

/**
 * `asc mode` — 실행을 누가 하는가 (Axis C).
 *
 * 이 명령이 바꾸는 것은 **실행 경로 하나**다. 세션의 주인·범위·진행도, 무엇을 사람이
 * 결정해야 하는지도 바꾸지 않는다 (AM-02 · H-01 · H-02).
 */
async function runMode(
  command: string | undefined,
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  root: string,
  runtime?: ResolvedRuntime,
): Promise<number> {
  const scope = store.scope('policy')
  const current = await readExecutionMode(scope)
  const readiness = judgeAutoReadiness(await observeReadiness(root, runtime))

  const show = (state: ExecutionModeState, extra: Record<string, unknown> = {}): void => {
    if (values.json) {
      console.log(
        JSON.stringify(
          {
            mode: state.mode ?? null,
            chosen: state.chosen,
            ...(state.degraded ? { degraded: state.degraded } : {}),
            enforcement: enforcementOf(state),
            autoReadiness: { ready: readiness.ready, axes: readiness.axes },
            ...extra,
          },
          null,
          2,
        ),
      )
      return
    }
    console.log(modeLine(state))
    for (const axis of readiness.axes) {
      console.log(`  ${axis.state.padEnd(16)} ${axis.axis}${axis.detail ? ` — ${axis.detail}` : ''}`)
    }
    console.log(readiness.ready ? '  AUTO READY' : '  AUTO NOT AVAILABLE')
    for (const [key, value] of Object.entries(extra)) console.log(`${key}: ${String(value)}`)
  }

  if (command === undefined || command === 'status') {
    show(current)
    return 0
  }

  if (command !== 'manual' && command !== 'auto') {
    console.error(`Unknown mode: ${command} — use \`asc mode manual\` or \`asc mode auto\`.`)
    return 2
  }
  const wanted: ExecutionMode = command === 'auto' ? 'AUTO' : 'MANUAL'

  if (wanted === 'AUTO') {
    // E-01 — 나갈 길이 실제로 열려 있을 때만 켠다. 하나라도 아니면 **지금 mode 를 그대로 둔다**.
    if (!readiness.ready) {
      if (values.json) {
        console.log(
          JSON.stringify(
            {
              mode: current.mode ?? null,
              chosen: current.chosen,
              requested: 'AUTO',
              applied: false,
              autoReadiness: { ready: false, axes: readiness.axes },
            },
            null,
            2,
          ),
        )
      } else {
        console.error('AUTO is not available — the approved execution path is not usable here:')
        for (const axis of readiness.blocking) {
          console.error(`  ${axis.state} ${axis.axis}${axis.detail ? ` — ${axis.detail}` : ''}`)
        }
        console.error(`Staying in ${current.mode ?? 'the current state'}. Nothing was changed.`)
      }
      return 1
    }
    const record = await writeExecutionMode(scope, 'AUTO', values.as as string | undefined)
    await store.appendHistory({
      at: record.since ?? new Date().toISOString(),
      actor: (values.as as string | undefined) ?? 'unattributed',
      kind: 'execution_mode',
      ref: 'execution-mode',
      detail: `${current.mode ?? current.degraded ?? 'unknown'} → AUTO`,
    })
    show({ ...record, chosen: true }, { applied: 'true' })
    return 0
  }

  // MANUAL 로 내려가는 것은 **막지 않는다**.
  //
  // 이전 회차에는 여기에 Request → Inbox → 승인 → 소진을 세워 뒀다. 그것은 같은 셸을
  // 쥔 Agent 를 막으려는 장치였는데, 같은 셸이면 `asc inbox decide` 도 칠 수 있다 —
  // 실제로 그 안내를 우리가 화면에 찍어 주고 있었다. 막지 못하는 것을 막는 척하면서
  // 사람에게만 세 걸음을 물리는 구조였다. ASC 의 위협 모델은 "협조적이지만 실수하는
  // Agent" 이고, 적대적 Agent 로부터 ASC 자신을 지키는 일은 Host/OS 신뢰 경계의 몫이다.
  //
  // 대신 **크게 남긴다**: 누가 그렇게 했다고 말하는지, 언제 바뀌었는지가 기록에 남고
  // 화면에 나온다. 실수하는 Agent 에게 필요한 것은 잠금이 아니라 드러남이다.
  const record = await writeExecutionMode(scope, 'MANUAL', values.as as string | undefined)
  await store.appendHistory({
    at: record.since ?? new Date().toISOString(),
    actor: (values.as as string | undefined) ?? 'unattributed',
    kind: 'execution_mode',
    ref: 'execution-mode',
    detail: `${current.mode ?? current.degraded ?? 'unknown'} → MANUAL`,
  })
  show({ ...record, chosen: true }, { applied: 'true' })
  return 0
}

/**
 * `asc refresh` — 버전은 그대로 두고, 이 runtime 이 소유한 integration 만 지금 상태로
 * 되맞춘다 (§26·§27).
 *
 * ```text
 * refresh != setup        Profile·workspace·identity 를 다시 추론하지 않는다
 * refresh != repair-all   session·binding·grant·inbox 를 건드리지 않는다
 * refresh != reset        지우고 다시 만들지 않는다
 * ```
 *
 * 그래서 이 함수가 부르는 것은 둘뿐이다: host 설치물, 기계 등록물.
 */
async function runRefresh(command: string | undefined, values: Record<string, unknown>): Promise<number> {
  if (command !== undefined && command !== 'check' && command !== 'plan') {
    console.error(`Unknown refresh command: ${command}\n\n${USAGE}`)
    return 2
  }
  const host = await verifyInstall(hostPaths())
  const access = await controlPlaneAccess(hostPaths())
  const service = await serviceHealth(values)

  const steps: string[] = []
  if (host.status !== 'INSTALLED_CURRENT') steps.push(`host integration (${host.status})`)
  if (!access.allowed && !access.denied) steps.push('control-plane allow rule')
  if (service && (service.action === 'reinstall' || service.action === 'update')) steps.push(`service registration (${service.action})`)

  if (command === 'check' || command === 'plan') {
    if (values.json) {
      console.log(JSON.stringify({ version: RELEASE_VERSION, host: host.status, controlPlane: access, ...(service ? { service } : {}), steps }, null, 2))
    } else {
      for (const line of installReportLines(host)) console.log(line)
      if (service) console.log(service.line)
      console.log(steps.length === 0 ? 'Nothing to converge.' : `Would converge: ${steps.join(', ')}`)
    }
    return 0
  }

  let worst = 0
  // 사람이 고친 설치물은 덮지 않는다 — 그 규칙은 host install 이 그대로 진다 (L-5).
  worst = Math.max(worst, await runHost('claude', 'install', undefined, { ...values, json: false }))
  worst = Math.max(worst, await convergeService(values))

  // 마지막은 언제나 확인이다. 계획했던 것이 실제로 사라졌는가.
  const after = await verifyInstall(hostPaths())
  for (const line of installReportLines(after)) console.log(line)
  if (after.status !== 'INSTALLED_CURRENT' && after.status !== 'INSTALLED_MODIFIED') {
    console.error('refresh: the host integration is still not current.')
    return 1
  }
  console.log(`asc ${RELEASE_VERSION} — integration is current. Version unchanged.`)
  return worst
}

/**
 * `asc uninstall` — 제품과 제품이 심은 것을 걷어낸다. **사용자 상태는 남는다** (§30·§32).
 *
 * 순서가 계약이다: 등록물 → host 설치물 → 확인 → 설치본. 설치본을 먼저 지우면 그 다음
 * 단계를 수행할 실행물이 없다.
 *
 * `~/.asc` 는 지우지 않는다. purge 표면은 만들지 않는다 — 지울 이유가 실제로 확인되기
 * 전까지 되돌릴 수 없는 명령을 두지 않는다.
 */
async function runUninstall(command: string | undefined, values: Record<string, unknown>): Promise<number> {
  if (command !== undefined && command !== 'plan') {
    console.error(`Unknown uninstall command: ${command}\n\n${USAGE}`)
    return 2
  }
  const host = await verifyInstall(hostPaths())
  const adapter = serviceAdapter()
  const installed = await detectStableInstall(nodeProcessRunner, RELEASE_VERSION)
  const home = ascHome()

  // **돌고 있는 일을 몰래 버리지 않는다** (0.8.0 §Q). uninstall 은 제품을 걷어내는
  // 명령이지 일을 끝내는 명령이 아니다 — 살아 있는 세션이나 물리 결합이 있으면 그것을
  // 어떻게 할지는 사람이 정한다. 새 lifecycle 상태를 만들지 않고, 이미 있는 상태를 읽는다.
  const here = await discoverRoot(process.cwd(), values.root as string | undefined)
  const live = here ? await liveWork(here) : { sessions: [], bindings: [] }
  const busy = live.sessions.length > 0 || live.bindings.length > 0

  if (command === 'plan') {
    const payload = {
      remove: {
        service: adapter?.id ?? null,
        hostIntegration: host.status !== 'NOT_INSTALLED',
        runtime: installed.installedVersion ?? null,
      },
      preserve: { state: home, note: 'profiles, workspaces, sessions, audit, evidence and identities all stay' },
      ...(busy ? { blockedBy: { sessions: live.sessions, bindings: live.bindings } } : {}),
    }
    if (values.json) console.log(JSON.stringify(payload, null, 2))
    else {
      console.log('Would remove:')
      if (adapter) console.log(`  the persistent registration (${adapter.id})`)
      if (host.status !== 'NOT_INSTALLED') console.log('  the ASC files and hook registration in ~/.claude')
      if (installed.installedVersion) console.log(`  the installed runtime (${RUNTIME_PACKAGE}@${installed.installedVersion})`)
      console.log(`Would keep: ${home} — profiles, workspaces, sessions, audit, evidence, identities`)
      if (busy) {
        console.log('')
        console.log('Would refuse: work is still running here —')
        for (const id of live.sessions) console.log(`  session ${id}`)
        for (const id of live.bindings) console.log(`  a run is holding ${id}`)
      }
    }
    return 0
  }

  if (busy) {
    console.error('Work is still running in this workspace, and uninstalling would abandon it:')
    for (const id of live.sessions) console.error(`  session ${id}`)
    for (const id of live.bindings) console.error(`  a physical run is holding ${id}`)
    console.error('')
    console.error(`Finish or pause it first: \`asc work finish ${live.sessions[0] ?? '<S-ID>'} --verified "…" --next "…"\``)
    console.error('Nothing was removed.')
    return 2
  }

  let worst = 0
  if (adapter) {
    await adapter.uninstall().catch((error: unknown) => {
      console.error(`service: could not unregister with ${adapter.id}: ${String(error)}`)
      worst = 1
    })
    console.log(`service: unregistered (${adapter.id})`)
  }

  const removedHost = await uninstall(hostPaths())
  for (const path of removedHost.removed) console.log(`removed: ${path}`)
  for (const keep of removedHost.kept) console.log(`kept: ${keep.path} — ${keep.reason}`)

  const afterHost = await verifyInstall(hostPaths())
  if (afterHost.hookRegistered) {
    console.error('host: an ASC hook registration is still in settings.json.')
    worst = 1
  }

  // 설치본은 마지막이다. 개발 checkout 에서 돌고 있으면 그것은 우리가 설치한 것이 아니다.
  if (!installed.installedVersion) {
    console.log('runtime: nothing was installed by npm on this machine.')
  } else {
    const removal = await nodeProcessRunner('npm', ['uninstall', '-g', RUNTIME_PACKAGE])
    if (!removal.ok) {
      console.error(`runtime: could not remove ${RUNTIME_PACKAGE} — ${removal.stderr.trim() || removal.stdout.trim()}`)
      console.error(`Remove it directly: npm uninstall -g ${RUNTIME_PACKAGE}`)
      worst = 1
    } else {
      console.log(`runtime: removed ${RUNTIME_PACKAGE}@${installed.installedVersion}`)
    }
  }

  console.log('')
  console.log(`Your state stays: ${home}`)
  console.log('Profiles, workspaces, sessions, audit, evidence and identities are untouched.')
  console.log(`Install it again later and they are all still there: ${portableCommand(['setup', 'apply'])}`)
  return worst
}

/**
 * 지금 이 workspace 에서 돌고 있는 일. **읽기만 한다.**
 *
 * 두 가지를 본다: 아직 끝나지 않은 논리 세션과, 그 세션을 집고 있는 물리 Run. 어느
 * 하나라도 있으면 제품을 걷어내는 것은 그 일을 버리는 것이 된다.
 */
async function liveWork(root: string): Promise<{ sessions: string[]; bindings: string[] }> {
  try {
    const store = new MarkdownStateStore(root)
    const sessions = (await store.list('session'))
      .filter((session) => session.status === 'ACTIVE' || session.status === 'PAUSED')
      .map((session) => session.id)
    const held = (await claudeBindings(store).current()).map((binding) => binding.logicalSessionId)
    return { sessions, bindings: held.filter((id) => !sessions.includes(id)) }
  } catch {
    // 읽지 못한 것을 "없다" 로 적지 않는다 — 모르면 막는 쪽이 안전하다.
    return { sessions: ['(could not be read)'], bindings: [] }
  }
}

/**
 * `asc work` — 정상 작업 표면 (§34~§42).
 *
 * **새 Work entity 를 만들지 않는다.** 이 함수 아래에서 도는 것은 전부 기존 경로다 —
 * 계약 초안·세션·물리 결합·preflight·진행·handoff·collect·Grant·Executor. 달라지는 것은
 * 사람이 그 순서를 외우지 않아도 된다는 것 하나다.
 */
async function runWork(
  command: string | undefined,
  target: string | undefined,
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  root: string,
  runtime?: ResolvedRuntime,
): Promise<number> {
  /** 지금 도는 세션. 지목이 없으면 하나일 때만 고른다 — 여럿이면 고르지 않는다. */
  const currentSession = async (): Promise<string | null> => {
    if (target) return target
    if (values.session) return values.session as string
    const active = (await store.list('session')).filter((session) => session.status === 'ACTIVE')
    if (active.length === 1) return active[0]!.id
    if (active.length === 0) return null
    console.error(`More than one session is active — say which: ${active.map((session) => session.id).join(', ')}`)
    return null
  }

  switch (command) {
    // 일을 시작한다. 안에서 도는 것: work ingress → 계약 초안 → 발급/재개 → 물리 결합 → preflight.
    case 'start':
      return runProceed({ ...values, ...(target ? { work: target } : {}) }, store, root, runtime)

    case 'status':
      return runProgress('show', target ?? (values.session as string | undefined), values, store)

    case 'inspect': {
      const session = await currentSession()
      if (!session) {
        console.error('Which session? `asc work inspect <S-ID>`')
        return 2
      }
      // 계약·범위·완료조건·결정권·검증·감사가 한 화면에 있어야 한다 (§38).
      const report = await runSession('report', session, values, store, runtime)
      if (report !== 0) return report
      return runSession('audit', session, values, store, runtime)
    }

    case 'pause':
    case 'resume': {
      const session = await currentSession()
      if (!session) {
        console.error(`Which session? \`asc work ${command} <S-ID>\``)
        return 2
      }
      return runSession(command, session, values, store, runtime)
    }

    // 끝낸다. 사람이 두 단계를 알아야 하는 구조를 여기서 끝낸다 (§41).
    case 'finish': {
      const session = await currentSession()
      if (!session) {
        console.error('Which session? `asc work finish <S-ID> --verified <text> --next <text>`')
        return 2
      }
      const done = await runSession('done', session, values, store, runtime)
      if (done !== 0) return done

      // 끝난 세션은 Run 도 놓는다. 이것이 빠져 있던 동안, 끝났다고 보고된 세션이
      // Run 을 계속 붙들어 다음 bind 가 RUNTIME_CONFLICT 로 거부됐다 (#63).
      //
      // **DONE 을 되돌리지는 않는다.** handoff 는 이미 쓰였고, 반쯤 되돌린 상태가
      // 이 결함이 만든 것보다 낫지 않다. 놓지 못했으면 그 사실을 말하고 종료 코드로
      // 드러낸다 — 조용히 성공이라 적지 않는다.
      // `--physical` 이 없는 경로는 여기 오지 못한다 — 결합이 있으면 `done` 이 먼저
      // owner 를 요구하고, 결합이 없으면 놓을 것이 없다. 그래서 분기를 두지 않는다.
      const physical = values.physical as string | undefined
      if (physical && (await claudeBindings(store).get(session))) {
        const released = await releaseRuntimeBinding(store, session, physical, new Date().toISOString())
        if (released.ok) console.log(`${session} ownership released`)
        else console.error(released.detail)
      }

      // handoff 가 쓰였으면 거두는 것까지가 이 명령의 몫이다 — 상태·차단 해제·보관.
      return runController('collect', values, store, runtime)
    }

    // 밖으로 내보낸다. Grant 를 없애는 것이 아니라 그 위에 서는 공식 표면이다 (§42).
    //
    // 순서가 계약이다 (0.8.0 §D):
    //
    //   읽기만 하는 원격 검수 → 결정권 → Grant → 원자적 CLAIM → 실행 직전 재검수
    //   → 외부 변경 한 번 → 되돌려 읽기 → 감사
    //
    // 앞의 검수는 **승인을 다시 받는 자리가 아니다** (§I). 사람이 "게시해" 라고 한 것은
    // 결정권을 이미 해결했다. 여기서 보는 것은 사실이다 — 그 대상이 이 결합의 원격인지,
    // 승인한 commit 이 아직 그 commit 인지, 같은 것이 이미 올라가 있지는 않은지.
    case 'publish': {
      if (!values.action || !values.target) {
        console.error('Usage: asc work publish [S-ID] --action <key> --target <ref> --body-file <path> --as <actor>')
        console.error('       asc work publish … --review    # read the facts, change nothing')
        return 2
      }
      const outward = await externalWritePort(runtime)
      if (!outward) {
        console.error('밖으로 내보낼 통로가 없다 — 이 행위를 수행할 결합이 Profile 에 없다.')
        console.error('지금 무엇이 풀리는지: asc status')
        return 2
      }
      const payload = values['body-file']
        ? await readFile(values['body-file'] as string, 'utf8').catch(() => null)
        : ''
      if (payload === null) {
        console.error(`내용을 읽지 못했다: ${String(values['body-file'])}`)
        return 2
      }
      const action = { action: values.action as string, target: values.target as string, payload }

      // ① 읽기만 하는 검수. MANUAL 이든 AUTO 든 같은 판정이고, 화면만 다르다 (§E).
      const bound = bindingIdentity(runtime, outward.id)
      const facts = outward.review
        ? await outward.review(action)
        : {
            provider: outward.id,
            capability: outward.supports?.(action.action) ?? true,
            verifiable: outward.verifies?.(action.action) ?? false,
            unknown: ['this write path cannot be read before use'],
          }
      const enforcing = enforcementOf(await readExecutionMode(store.scope('policy'))) === 'ENFORCE'
      const review = reviewExternalAction({
        action: action.action,
        target: action.target,
        facts,
        ...(bound ? { basis: { resource: bound } } : {}),
        ...(enforcing ? { requireVerification: true } : {}),
      })
      for (const line of reviewLines(review)) console.log(line)
      for (const [key, value] of Object.entries(facts.observed ?? {})) {
        if (value !== undefined) console.log(`  ${key}: ${value}`)
      }

      // 읽기만 물었으면 여기서 끝이다 — 이 경로로는 아무것도 나가지 않는다.
      if (values.review) return review.verdict === 'NOT_EXECUTABLE' ? 1 : 0

      if (review.verdict !== 'READY') {
        console.error('')
        console.error(
          review.verdict === 'NOT_EXECUTABLE'
            ? 'This cannot go out as it stands. Nothing was sent.'
            : 'Facts here need a person to look — nothing was sent. Widen or correct the action, then run it again.',
        )
        return 1
      }

      const session = await currentSession()
      if (!session) {
        console.error('Which session? `asc work publish --session <S-ID> ...`')
        return 2
      }
      if (!values['body-file'] || !values.as) {
        // **호출됐다는 사실이 승인이 아니다** (§R). 내보낼 내용은 사람이 준 것이어야 하고,
        // 누가 정했는지는 이름으로 남아야 한다. 그 둘이 없으면 Grant 는 만들어지지 않는다.
        console.error('--body-file <path> 와 --as <actor> 가 필요하다 — 내보낼 내용과 그것을 정한 사람이다.')
        console.error('Agent 가 스스로 부른 것은 승인이 아니다.')
        return 2
      }

      // ② 승인이 딛고 선 사실을 못 박는다 (§L). 가지 이름이 아니라 그때의 commit 이다.
      const basis = {
        ...(facts.observed?.['local.head'] ? { sourceSha: facts.observed['local.head'] } : {}),
        ...(facts.observed?.['remote.sha'] ? { remoteBaseline: facts.observed['remote.sha'] } : {}),
        ...(bound ? { resource: bound } : {}),
      }
      const grantId = (values['grant-id'] as string) ?? `G-${String(Date.now()).slice(-4)}`
      const issued = await runGrant(
        'issue',
        undefined,
        { ...values, session, 'grant-id': grantId, basis },
        store,
        root,
        runtime,
      )
      if (issued !== 0) return issued
      // ③ Grant → CLAIM → 재검수 → 실행 1회 → 되돌려 읽기 → 감사. 한 번 쓰고 소진된다.
      return runGrant('run', grantId, values, store, root, runtime)
    }

    default:
      console.error(`Unknown work command: ${command ?? '(none)'}\n\n${USAGE}`)
      return 2
  }
}

async function runUpdate(command: string | undefined, values: Record<string, unknown>): Promise<number> {
  if (command !== undefined && command !== 'check' && command !== 'plan') {
    console.error(`Unknown update command: ${command}\n\n${USAGE}`)
    return 2
  }

  const plan = await observeUpdate()

  if (command === 'check' || command === 'plan') {
    if (values.json) {
      console.log(JSON.stringify({ package: RUNTIME_PACKAGE, ...plan }, null, 2))
    } else {
      console.log(updateLine(plan))
      for (const step of plan.steps) console.log(`  ${step}`)
    }
    // 읽기는 상태를 판정하되 실패로 만들지 않는다 — 물어본 것에는 답한 것이다.
    return 0
  }

  if (plan.steps.length === 0) {
    console.log(updateLine(plan))
    // 못 하는 것과 할 것이 없는 것은 다르다. `CURRENT` 만 성공이다.
    return plan.state === 'CURRENT' ? 0 : 1
  }
  return applyUpdate(plan, values)
}

/**
 * 세상의 사실을 모아 계획에 넘긴다. **판정은 여기서 하지 않는다** (`setup` 과 같은 태도).
 *
 * registry 를 못 물으면 그 사실이 그대로 계획에 간다 — 조회 실패를 "최신" 으로 뭉개면
 * 그 답이 곧 사람이 업데이트를 건너뛰는 근거가 된다.
 */
async function observeUpdate(): Promise<UpdatePlan> {
  const latest = await execText('npm', ['view', RUNTIME_PACKAGE, 'version'])
  const engines = latest ? await execText('npm', ['view', `${RUNTIME_PACKAGE}@${latest}`, 'engines.node']) : null
  const required = requiredMajorFrom(engines ?? undefined)
  const installed = await detectStableInstall(nodeProcessRunner, latest ?? RELEASE_VERSION)
  const node = await checkNodeRuntime(nodeRuntimeDeps())
  return planUpdate({
    ...(installed.installedVersion ? { installed: installed.installedVersion } : {}),
    executableVisible: installed.executableVisible,
    ...(latest ? { latest } : {}),
    ...(required !== undefined ? { requiredNodeMajor: required } : {}),
    nodeVersion: process.version,
    ...(node.ok ? {} : { nodeCandidates: node.candidates }),
  })
}

/**
 * 계획대로 실행한다. **삭제하지 않는다** — npm 전역 설치는 같은 자리를 덮으므로 치울
 * 구본이 없고, 치울 것이 있다고 적으면 그 단계는 언젠가 지우지 말아야 할 것을 지운다.
 */
async function applyUpdate(plan: UpdatePlan, values: Record<string, unknown>): Promise<number> {
  const target = plan.to!
  console.log(updateLine(plan))

  // 무엇이 바뀌면 안 되는지를 **먼저** 적어 둔다. 업데이트가 건드려도 되는 것은 셋뿐이다 —
  // 설치본, host 설치물, 기계 등록물. 나머지는 이미 정해진 것이고, 그것을 다시 정하는
  // 경로(`setup`)를 부르지 않는다는 말은 여기서 증거로 확인된다.
  const before = await protectedState()

  const installed = await installStableRuntime(nodeProcessRunner, target)
  if (!installed.ok) {
    console.error(`install failed: ${installed.detail ?? '(no detail)'}`)
    // 설치가 아예 안 됐다. 돌던 것이 그대로 서 있는지는 확인해야 안다 — npm 은 중간에서도
    // 실패한다.
    return rollbackUpdate(plan)
  }

  // npm 이 화내지 않았다는 것과 그 버전이 실제로 서 있다는 것은 다르다 (C-14 §3.3).
  const verified = await verifyStableInstall(nodeProcessRunner, target)
  if (!verified.ok) {
    console.error(`verify failed: ${verified.remedy ?? verified.state.detail ?? verified.state.status}`)
    return rollbackUpdate(plan)
  }
  console.log(`installed: ${RUNTIME_PACKAGE}@${target}`)

  let worst = 0

  // host 설치물은 버전마다 내용이 바뀐다. 새 runtime 에 낡은 hook 을 남기지 않는다.
  //
  // **새로 설치된 build 가 자기 내용을 쓴다.** 이 프로세스는 아직 갈아 끼우기 **전의**
  // build 이고, 그 build 의 `hookScript()` 는 옛 내용을 만든다 — 실기계에서 update 가
  // "host: …/SKILL.md" 를 적고 끝났는데 probe 는 여전히 INSTALLED_STALE 이었다. 갱신했다고
  // 말하면서 옛 내용을 다시 쓴 것이다.
  //
  // 사람이 고친 것을 덮지 않는 규칙은 그쪽(`host claude install`)이 그대로 진다.
  // 새 build 가 자기 integration 을 맞춘다 — 그것이 `asc refresh` 이고, update 는 그것을
  // 부를 뿐이다 (§25). 두 명령이 각자 host 를 갱신하면 언젠가 서로 다른 것을 쓴다.
  worst = Math.max(worst, await refreshWithNewRuntime())

  // 마지막은 언제나 확인이다.
  const health = await detectStableInstall(nodeProcessRunner, target)
  if (health.status !== 'CURRENT') {
    console.error(`health: ${health.detail ?? health.status}`)
    return 1
  }

  // 상태 불변 — 이 명령의 가장 중요한 계약이다.
  const changed = diffState(before, await protectedState())
  if (changed.length > 0) {
    // 회차가 겹쳐 관측 기록이 늘어난 것일 수도 있다. 어느 쪽이든 **무엇이 달라졌는지
    // 말한다** — "안 바뀌었다"를 확인 없이 적는 것이 이 계약을 없애는 방식이다.
    console.error(`state changed during the update (${changed.length}):`)
    for (const path of changed.slice(0, 10)) console.error(`  ${path}`)
    worst = 1
  } else {
    console.log('state: unchanged')
  }

  console.log(`asc ${target} is current.`)
  return worst
}

/**
 * 바뀌면 안 되는 것들. **위치를 새로 정하지 않는다** — 이 machine 의 `~/.asc` 가 그대로
 * 그 자리이고, 업데이트가 건드려도 되는 셋(설치본·host 설치물·기계 등록물)은 여기 없다.
 *
 * 등록물이 회차마다 다시 쓰는 lease·log 는 상태가 아니라 실행 흔적이라 뺀다.
 */
async function protectedState(): Promise<Map<string, string>> {
  const home = ascHome()
  const state = new Map<string, string>()
  const skip = new Set(['runtime-lease.json', 'service.log'])
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name)
      if (skip.has(relative(home, full))) continue
      if (entry.isDirectory()) await walk(full)
      else state.set(relative(home, full), createHash('sha256').update(await readFile(full).catch(() => Buffer.alloc(0))).digest('hex'))
    }
  }
  await walk(home)
  return state
}

/** 달라진 경로들. 없어진 것도 달라진 것이다. */
function diffState(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = []
  for (const [path, digest] of before) if (after.get(path) !== digest) changed.push(path)
  for (const path of after.keys()) if (!before.has(path)) changed.push(path)
  return changed.sort()
}

/**
 * 새 build 에게 자기 integration 을 맞추게 한다 — 곧 새 build 의 `asc refresh` 다 (§25).
 *
 * 지금 도는 프로세스로 부르지 않는 이유는 하나다: 이 프로세스는 교체되기 **전의** build 이고,
 * 그 build 가 만들어 내는 hook·skill 은 옛 내용이다. 0.7.0 에서 실제로 그랬다 — update 가
 * "host: …/SKILL.md" 를 적고 끝났는데 probe 는 여전히 INSTALLED_STALE 이었다.
 *
 * 전역 실행물을 못 찾으면 갱신하지 않고 그 사실을 말한다. 조용히 건너뛰면 낡은 hook 이
 * 새 runtime 옆에 남고, 그 조합은 아무도 시험한 적이 없다.
 */
async function refreshWithNewRuntime(): Promise<number> {
  const entry = await globalRuntimeEntry()
  if (!entry) {
    console.error('refresh: could not find the installed runtime to refresh with — run `asc refresh`')
    return 1
  }
  const child = spawnSync(process.execPath, [entry, 'refresh'], { encoding: 'utf8' })
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
  for (const line of output.split('\n')) {
    if (
      line.startsWith('installed:') ||
      line.startsWith('skipped:') ||
      line.startsWith('service:') ||
      line.startsWith('Install state:')
    ) {
      console.log(`refresh: ${line}`)
    }
  }
  if (child.status !== 0) {
    console.error(`refresh: failed${output.trim() ? ` — ${output.trim().split('\n').at(-1)}` : ''}`)
    return 1
  }
  return 0
}

/**
 * 되돌린다. **되돌릴 자리가 있을 때만** — 없던 것으로 되돌릴 수는 없고, 그때는 돌던 것이
 * 없었다는 사실을 그대로 말한다.
 */
async function rollbackUpdate(plan: UpdatePlan): Promise<number> {
  if (!plan.rollbackTo) {
    console.error('Nothing to roll back to — this machine had no installed runtime before.')
    return 1
  }
  console.error(`rolling back to ${plan.rollbackTo}`)
  const back = await installStableRuntime(nodeProcessRunner, plan.rollbackTo)
  const verified = back.ok ? await verifyStableInstall(nodeProcessRunner, plan.rollbackTo) : null
  if (verified?.ok) {
    console.error(`UPDATE_FAILED_ROLLED_BACK — asc ${plan.rollbackTo} is current again.`)
    return 1
  }
  // 되돌리기까지 실패했다. 여기서부터는 사람의 자리다 — 숨기지 않는다.
  console.error(`BROKEN — rollback failed: ${back.detail ?? verified?.remedy ?? '(no detail)'}`)
  console.error(`Install it directly: npm install -g ${RUNTIME_PACKAGE}@${plan.rollbackTo}`)
  return 1
}

/** 등록물을 지금 실행본으로 수렴시킨다. 등록이 없던 기계에 새로 만들지는 않는다. */
async function convergeService(values: Record<string, unknown>): Promise<number> {
  const adapter = serviceAdapter()
  if (!adapter) return 0
  const runtime = await serviceRuntime()
  if (runtime.kind !== 'STABLE') {
    console.error(`service: ${serviceRuntimeLine(runtime)}`)
    return 1
  }
  const wanted = serviceCommand(serviceInterval(values), runtime)
  const plan = await planPersistentRuntime(adapter, wanted).catch(() => null)
  if (!plan) return 0
  if (plan.action === 'none' || plan.action === 'unsupported') {
    console.log(`service: ${persistentRuntimeLine(adapter.id, plan)}`)
    return 0
  }
  // `install` 은 ABSENT 와 STALE 을 함께 접은 계획이다. 둘을 여기서 다시 가른다 —
  // 없던 기계에 새로 만들지는 않지만, **낡은 등록은 수렴시킨다.** 그것이 이 함수의 일이다.
  if (plan.state.kind === 'ABSENT') {
    console.log('service: not registered on this machine — leaving it that way (`asc runtime service install`)')
    return 0
  }
  await adapter.install(wanted)
  console.log(`service: converged with ${adapter.id}`)
  return 0
}

/**
 * `asc runtime service` — 이 기계의 지속 등록 (설계 §4).
 *
 * **workspace 마다 하나가 아니다.** 사용자/기계당 하나이고, 그 하나가 아는 workspace
 * 전부를 돌본다. 등록물은 우리가 만든 것만 다룬다.
 */
async function runRuntimeService(
  command: string | undefined,
  values: Record<string, unknown>,
): Promise<number> {
  const adapter = serviceAdapter()
  if (!adapter) {
    const detail = `no user-scope service manager for ${process.platform}`
    if (values.json) console.log(JSON.stringify({ supported: false, detail }, null, 2))
    else console.error(`Persistent runtime: ${detail}`)
    // 못 하는 것을 "했다"로 적지 않는다. 다만 이것이 오류는 아니다.
    return 0
  }

  const runtime = await serviceRuntime()
  if (runtime.kind !== 'STABLE') {
    // 등록물이 가리킬 안정된 자리가 없다. 무엇이 없어서인지 말한다 — 등록하지 않는 것이
    // 답이고, 깨진 등록을 남기는 것은 답이 아니다.
    if (values.json) console.log(JSON.stringify({ supported: true, stable: false, ...runtime }, null, 2))
    else console.error(serviceRuntimeLine(runtime))
    return command === 'status' || command === undefined ? 0 : 1
  }
  const wanted = serviceCommand(serviceInterval(values), runtime)

  if (command === undefined || command === 'status') {
    const plan = await planPersistentRuntime(adapter, wanted)
    if (values.json) {
      console.log(JSON.stringify({ adapter: adapter.id, ...plan }, null, 2))
      return 0
    }
    console.log(persistentRuntimeLine(adapter.id, plan))
    return 0
  }

  if (command === 'install') {
    const plan = await planPersistentRuntime(adapter, wanted)
    if (plan.action === 'unsupported') {
      console.error(persistentRuntimeLine(adapter.id, plan))
      return 1
    }
    if (plan.action === 'none') {
      // 멱등이다 — 같은 것을 다시 등록하지 않는다
      console.log(persistentRuntimeLine(adapter.id, plan))
      return 0
    }
    await adapter.install(wanted)
    console.log(`Persistent runtime registered with ${adapter.id} — one pass every ${wanted.intervalSeconds / 60} min.`)
    return 0
  }

  if (command === 'uninstall') {
    await adapter.uninstall()
    console.log(`Persistent runtime registration removed from ${adapter.id}.`)
    return 0
  }

  console.error(`Unknown runtime service command: ${command}\n\n${USAGE}`)
  return 2
}

/**
 * 기계 전체 한 회차 (설계 §7).
 *
 * 싱글턴은 **판단하지 않는다** — 어느 workspace 가 지금 돌 수 있는지만 고르고, 회차 자체는
 * 기존 경로가 그대로 돈다. workspace 마다 별개의 짧은 프로세스로 도는 이유는 둘이다:
 * 한 workspace 의 실패가 다른 workspace 를 세우지 않고, 기존 lease·cursor·dedupe 경로를
 * 한 줄도 바꾸지 않고 그대로 쓴다.
 *
 * DORMANT 는 건너뛴다. 살아 있는 checkout 이 없는 자리를 대신해 외부에 묻지 않는다.
 */
async function runRuntimeTickAll(values: Record<string, unknown>): Promise<number> {
  // 기계 수준 lease. workspace lease 와 다른 소유 영역이다 (설계 §5.1) — 저쪽은 회차
  // 하나를, 이쪽은 이 기계의 runtime 을 직렬화한다. 등록된 서비스와 사람이 친 명령이
  // 겹치면 늦게 온 쪽이 조용히 물러난다 (C-12 불변식 ⑥).
  const interval = serviceInterval(values) * 1000
  const lease = new RuntimeLease({
    scope: fileScope(join(ascHome(), 'runtime-lease.json')),
    owner: `${process.pid}@${hostname()}`,
    staleMs: staleAfter(interval),
  })
  if (!(await lease.acquire())) {
    const held = await lease.read()
    const detail = held.kind === 'HELD' ? ` (pid ${held.record.pid})` : ''
    if (values.json) console.log(JSON.stringify({ ran: [], skipped: [], busy: true }, null, 2))
    else console.log(`Another machine-wide pass is already running${detail} — leaving it to that one.`)
    return 0
  }

  try {
    return await tickAllWorkspaces(values, lease)
  } finally {
    await lease.release()
  }
}

async function tickAllWorkspaces(values: Record<string, unknown>, lease: RuntimeLease): Promise<number> {
  const views = await machineWorkspaces()
  const due = dueWorkspaces(views)
  const skipped = views.filter((view) => view.health !== 'ACTIVE')

  const results: PassResult[] = []
  for (const workspace of due) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'runtime', 'tick'], {
      cwd: workspace.cwd,
      stdio: values.json ? 'ignore' : 'inherit',
      env: process.env,
    })
    const code = child.status ?? 1
    results.push({ workspaceId: workspace.workspaceId, code })
    // **회차가 어떻게 끝났는지 그 자리에 적는다** (Phase J). 이것이 없으면 실패는
    // service.log 로만 흘러가고, 붙어 있는 workspace 가 여러 릴리스 동안 한 번도 돌지
    // 못한 채 건강해 보인다 — 실측에서 셋 중 둘이 그 상태였다.
    await recordPass(new MarkdownStateStore(workspace.root).scope('runtime'), code).catch(() => undefined)
    // 회차가 길어져도 이 기계의 lease 는 살아 있어야 한다 — 갱신하지 않으면 도는 중에
    // 죽은 것으로 보이고 두 번째 프로세스가 끼어든다.
    await lease.renew()
  }

  const skippedViews = skipped.map((view) => ({ workspaceId: view.workspaceId, health: view.health }))
  const summary = summarizePass(results, skippedViews)
  if (values.json) {
    console.log(
      JSON.stringify(
        {
          ran: results,
          // 건너뛴 것을 조용히 빼지 않는다 — "아무 일도 없었다"와 다른 사실이다
          skipped: skippedViews,
          outcome: summary.outcome,
          failed: summary.failed,
        },
        null,
        2,
      ),
    )
  } else {
    for (const result of results) console.log(`${result.workspaceId}: pass exited ${result.code}`)
    for (const view of skipped) console.log(`${view.workspaceId}: ${view.health} — not observed this pass`)
    console.log(summary.line)
  }
  // 한 workspace 가 실패해도 다른 workspace 는 전부 돌았다. 그러나 실패했다는 사실은 회차의
  // 종료 코드에 남는다 — OS 가 보는 것은 그것 하나뿐이다 (P0-R2).
  return summary.code
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
  if (command !== 'start' && command !== 'tick' && command !== 'stop') {
    console.error(`Unknown runtime command: ${command ?? '(none)'}\n\n${USAGE}`)
    return 2
  }
  if (!resolved) {
    console.error('This only runs inside an attached project. Run `asc init --profile <id>` first.')
    return 2
  }

  // 멈추는 것은 감시를 조립하지 않아도 된다 — 외부 자격이 상해 있어도 끌 수 있어야 한다.
  if (command === 'stop') return stopBackground(store)

  // 떨어져 나가는 것은 감시를 조립하기 **전에** 한다. 부모가 외부를 한 번 치고 나서
  // 자식이 또 치면 같은 회차를 두 번 부르는 셈이다.
  if (command === 'start' && values.detach) return detachRuntime(values)

  const built = await buildMonitorEngines(values, store, resolved)
  if (!built.ok) return built.code
  const { channels } = built

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
        const raw = await scope.get(LAST_RUN_KEY)
        return raw ? (JSON.parse(raw) as Record<string, string>) : {}
      },
      write: async (kind, at) => {
        const raw = await scope.get(LAST_RUN_KEY)
        const current = raw ? (JSON.parse(raw) as Record<string, string>) : {}
        await scope.set(LAST_RUN_KEY, JSON.stringify({ ...current, [kind]: at }))
      },
    },
    actions: {
      // 채널마다 돈다. 한 채널이 터져도 나머지는 계속한다 — 자격 하나가 상했다고
      // 다른 통로까지 조용해지면 그것이 "변경 없음"으로 읽힌다 (C-12 불변식 ⑫).
      delta: async () => {
        for (const channel of channels) {
          const outcome = await channel.engine.scan().catch((error: unknown) => {
            console.error(`  [${channel.label}] scan failed — ${String(error)}`)
            return null
          })
          if (!outcome || outcome.skipped) continue
          console.log(`  [${channel.label}] detected ${outcome.detected} · logged ${outcome.logged} · packets ${outcome.packets.length}`)
        }
      },
      reconcile: async () => {
        for (const channel of channels) {
          const sweep = await channel.engine.reconcile().catch((error: unknown) => {
            console.error(`  [${channel.label}] reconcile failed — ${String(error)}`)
            return null
          })
          if (sweep && !sweep.skipped && !sweep.complete) {
            console.error(`  [${channel.label}] reconcile did not complete${sweep.detail ? ` — ${sweep.detail}` : ''}`)
          }
        }
      },
      census: async () => {
        for (const channel of channels) {
          const sweep = await channel.engine.census().catch(() => null)
          if (sweep && !sweep.skipped && sweep.missing.length > 0) {
            console.log(`  [${channel.label}] ${sweep.missing.length} known items absent from this listing`)
          }
        }
      },
      digest: async () => {
        const outcome = await deliverDigest(store, false)
        if (outcome > 0) console.error('  delivery failed')
      },
    },
  })

  const intervalMs = minutes(values['interval-min'], 1)
  // 회수 기준은 주기가 정한다 — 주기보다 짧은 만료는 자기 lease를 죽은 것으로 읽는다.
  const staleMs = staleAfter(intervalMs)
  const lease = new RuntimeLease({ scope, owner: `${process.pid}@${hostname()}`, staleMs })

  // cron이 부르는 tick과 떨어져 나간 루프가 겹쳐 돌면 같은 회차를 둘이 한다.
  // 같은 문을 지나게 해서 하나만 돌린다 (C-12 불변식 ⑥).
  if (!(await lease.acquire())) {
    const held = await lease.read()
    console.log(
      held.kind === 'HELD'
        ? `Another runtime already holds this workspace (pid ${held.record.pid}) — leaving it to that one.`
        : 'Another runtime already holds this workspace — leaving it to that one.',
    )
    return 0
  }

  if (command === 'tick') {
    try {
      const outcome = await orchestrator.tick()
      console.log(renderTick(outcome))
      return outcome.failures.length > 0 ? 1 : 0
    } finally {
      await lease.release()
    }
  }

  console.log(`Always-on runtime started — one pass every ${intervalMs / 60_000} min. Ctrl+C to stop.`)

  // 자는 동안에도 멈출 수 있어야 한다. 깨우지 않으면 `runtime stop` 이 한 주기를 통째로
  // 기다리고, 주기가 30분이면 30분 동안 "멈추는 중"이 된다.
  let wake: (() => void) | null = null
  const stop = () => {
    console.log('Stopping — a pass still running is carried to the next start by its lease.')
    orchestrator.stop()
    wake?.()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  try {
    await orchestrator.run(intervalMs, async (ms) => {
      // 회차마다 살아 있다고 말한다. 밀려났으면 조용히 물러난다 — 두 루프가 같은
      // workspace를 갈아 대는 것보다 하나가 도는 편이 낫다.
      if (!(await lease.renew())) {
        console.log('Another runtime took this workspace — stopping.')
        orchestrator.stop()
        return
      }
      await new Promise<void>((resolve) => {
        // **unref 하지 않는다.** 예전에는 여기서 타이머를 unref 했는데, 그러면 이벤트
        // 루프를 붙잡는 것이 아무것도 없어 첫 잠에서 프로세스가 끝난다 — Node 는
        // `unsettled top-level await` 로 exit 13 을 낸다. 상시로 돌아야 하는 루프가
        // 조용히 한 회차만 돌고 죽던 원인이다. 멈출 때는 아래 wake 가 타이머를 지운다.
        const timer = setTimeout(resolve, ms)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      wake = null
    })
  } finally {
    await lease.release()
  }
  return 0
}

/**
 * 이 터미널이 닫혀도 계속 보게 한다 (C-12 §0).
 *
 * scheduler 제품을 설치하지 않는다 (불변식 ④) — 같은 명령을 떨어져 나간 프로세스로 다시
 * 띄울 뿐이다. cron·launchd·Task Scheduler로 `asc runtime tick` 을 부르는 길도 그대로
 * 열려 있고, 둘은 같은 lease를 지나므로 겹쳐 돌지 않는다.
 */
async function detachRuntime(values: Record<string, unknown>): Promise<number> {
  // 지금 프로세스가 받은 인자를 그대로 쓰되 --detach 만 뺀다. 옵션을 다시 조립하면
  // 언젠가 부모와 자식이 다른 주기로 돌게 된다.
  const args = process.argv.slice(2).filter((arg) => arg !== '--detach')
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
    env: process.env,
  })
  child.unref()
  if (child.pid === undefined) {
    console.error('Could not start a background runtime.')
    return 1
  }
  console.log(`Background runtime started (pid ${child.pid}). \`asc runtime status\` says whether it is observing.`)
  console.log('`asc runtime stop` ends it.')
  void values
  return 0
}

/**
 * 도는 runtime에게 끝내라고 한다.
 *
 * **lease를 지우는 것으로 멈추지 않는다** — 그러면 프로세스는 살아 있는데 아무도 그것을
 * 모르는 상태가 된다. 신호를 보내고, 그 프로세스가 자기 lease를 놓게 한다.
 */
async function stopBackground(store: MarkdownStateStore): Promise<number> {
  const scope = store.scope('runtime')
  const state = await new RuntimeLease({ scope, owner: '(reader)' }).read()
  if (state.kind === 'FREE') {
    console.log('No background runtime is registered here.')
    return 0
  }
  if (state.kind === 'STALE') {
    // 죽은 프로세스가 남긴 기록이다. 신호를 보낼 곳이 없으므로 기록만 치운다.
    await scope.delete('runtime-lease')
    console.log(`Cleared a stale lease from pid ${state.record.pid} — nothing was running.`)
    return 0
  }
  try {
    process.kill(state.record.pid, 'SIGTERM')
  } catch (error) {
    // 이미 죽은 프로세스다. 기록만 남았으므로 치운다 — 못 지우면 그 사실을 말한다.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      console.error(`Could not signal pid ${state.record.pid}: ${String(error)}`)
      return 1
    }
    await scope.delete('runtime-lease')
    console.log(`pid ${state.record.pid} was already gone — cleared its lease.`)
    return 0
  }
  console.log(`Asked pid ${state.record.pid} to finish its pass and stop.`)
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

/** 판정 결과에서 workspace 신원만 꺼낸다. 갈래마다 모양이 달라 한 곳에서 접는다. */
function workspaceOf(resolution: Resolution): { workspaceId: string; locator: string } | null {
  return resolution.kind === 'REGISTERED' || resolution.kind === 'LINKED_WORKTREE'
    ? { workspaceId: resolution.workspaceId, locator: resolution.locator }
    : null
}

/**
 * Host 세션이 열렸다 (C-12 §4). **이 명령은 실패하지 않는다.**
 *
 * Host lifecycle이 부르는 자리라 세 가지를 지킨다:
 *
 *   붙지 않은 자리        아무 말도 하지 않고 exit 0 — 남의 프로젝트를 방해하지 않는다
 *   상태를 못 읽는 자리    왜인지 말한다 — 조용한 빈 화면을 주지 않는다 (불변식 ⑰)
 *   미등록 linked worktree 공용 resolver가 풀고 등록까지 한다 (C-11 §1.3)
 *
 * **workspace 신원을 여기서 다시 구현하지 않는다.** `resolveRoot` 하나만 부른다.
 */
async function runFrontOpen(values: Record<string, unknown>): Promise<number> {
  const emit = async (opening: Awaited<ReturnType<typeof openFront>>): Promise<number> => {
    const lines = frontOpeningLines(opening)
    if (values.json) {
      // payload는 Claude Code가 SessionStart에서 읽는 봉투다. 다른 host는 lines를 쓴다.
      console.log(JSON.stringify({ kind: opening.kind, lines, payload: sessionStartPayload(lines) }, null, 2))
      return 0
    }
    for (const line of lines) console.log(line)
    return 0
  }

  const resolution = await resolveRoot(process.cwd(), values.root as string | undefined).catch(() => null)
  const workspace = resolution ? workspaceOf(resolution) : null
  // EXPLICIT·PROJECT_LOCAL 은 workspace id가 없지만 붙은 자리다 — 신원 없이도 상태는 읽는다.
  const root = resolution && resolution.kind !== 'UNRESOLVED' ? resolution.root : null
  if (!root) return emit({ kind: 'NOT_ASC' })

  const store = new MarkdownStateStore(root)
  return emit(
    await openFront({
      // 신원을 모르는 자리(project-local)라도 붙은 것은 붙은 것이다
      workspace: workspace ?? { workspaceId: '(project-local)', locator: root },
      restore: async () => {
        const scope = await activeMonitorScope(store)
        return restoreFront({
          store,
          pending: await new LocalOperator({ store }).list({}),
          escalations: await escalationLedger(store).pending(),
          health: evaluateHealth(
            await new CoverageLedger(store.scope(scope)).health(),
            new Date().toISOString(),
            HEALTH_THRESHOLDS,
          ),
          ...(workspace ? { workspace } : {}),
          // 안에서 할 일이 없는 것과 밖에서 답이 안 온 것은 다른 사실이다
          coordination: await coordinationNow(store),
          bindings: claudeBindings(store),
        })
      },
    }),
  )
}

/**
 * 이 workspace 의 조율 표면. 없으면 없다고 말한다 — 아무 데나 대신 게시하지 않는다.
 */
async function coordinationSurfaceFor(resolved?: ResolvedRuntime) {
  const { root: projectRoot } = await discoverProjectRoot(process.cwd())
  const adapters = monitorAdapters()
  const declared = resolved?.layers.profile.bindings ?? []
  const plan = await composeBindings({
    context: { projectRoot, env: process.env },
    adapters,
    roles: declared.map((b) => ({ adapterId: b.adapter, resource: b.resource, role: b.role })),
  })
  const ports = await buildRuntimePorts({
    plan,
    roles: rolesFor(plan, declared),
    ...jamComposition(projectRoot),
    endpointFor: (binding) => endpointOf(adapters, binding),
  })
  return { surface: ports.coordinationSurface, unavailable: ports.unavailable }
}

/**
 * `asc coordination publish` — 기대 하나를 밖에 실제로 내보낸다.
 *
 * 본문을 파일로 받는 이유는 하나다: 사람이 읽을 글이 셸을 지나며 조용히 달라지는 것을
 * 막는다. 그리고 **내부 메모가 섞일 자리를 주지 않는다** — 나가는 것은 제목·본문·라벨뿐이다.
 */
async function runCoordinationPublish(
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  resolved?: ResolvedRuntime,
): Promise<number> {
  const queryId = typeof values.query === 'string' ? values.query : undefined
  const title = typeof values.title === 'string' ? values.title : undefined
  const bodyFile = typeof values['body-file'] === 'string' ? (values['body-file'] as string) : undefined
  if (!queryId || !title || !bodyFile) {
    console.error('coordination publish needs --query, --title and --body-file\n\n' + USAGE)
    return 2
  }

  // **밖으로 나가는 쓰기는 승인된 계약을 지난다** (OM §11.5, 0.7.0 / Phase H).
  //
  // 조율 게시는 오래 이 규칙 밖에 있었다. 근거는 adapter 주석 하나였다 — "물어본 것이
  // 밖에 실제로 있게 하는 행위이지 승인된 단일 행동이 아니다". 그 구분은 뜻이 있지만,
  // 계약을 대체할 결정으로 어디에도 기록되지 않았고 실제로 하는 일은 남의 저장소에
  // 글을 만드는 것이다. 살아 있는 불변식을 따른다.
  //
  // 읽기(status·observe)는 그대로다. 계약을 요구하는 것은 실제로 나가는 이 한 번뿐이다.
  const grantId = typeof values.grant === 'string' ? values.grant : undefined
  if (!grantId) {
    console.error('밖으로 나가는 게시는 승인된 계약을 지난다 — --grant <G-ID> 가 필요하다.')
    console.error('세션이 만든 결과라면:')
    console.error('  asc grant issue --session <S-ID> --action coordination.publish \\')
    console.error('       --target <query-id> --body-file <path> --as <actor>')
    return 2
  }
  const grant = await store.get('grant', grantId)
  if (!grant) {
    console.error(`${grantId} 를 찾지 못했다.`)
    return 1
  }
  if (grant.status !== 'READY') {
    console.error(`${grantId} 는 지금 ${grant.status} 다 — 한 번 쓴 계약은 다시 쓰지 않는다.`)
    return 1
  }
  if (grant.action !== 'coordination.publish') {
    console.error(`${grantId} 가 승인한 것은 '${grant.action}' 이지 게시가 아니다.`)
    return 1
  }
  if (grant.target !== queryId) {
    console.error(`${grantId} 가 승인한 대상은 ${grant.target} 인데 지금 게시하려는 것은 ${queryId} 다.`)
    return 1
  }

  const { surface, unavailable } = await coordinationSurfaceFor(resolved)
  if (!surface) {
    console.error('No coordination surface is bound to this workspace — nothing was published.')
    for (const line of unavailable) console.error(`  ${line}`)
    return 1
  }

  const body = await readFile(bodyFile, 'utf8')
  const audience = (values.audience as string[] | undefined) ?? []
  const known = ((values.known as string[] | undefined) ?? []).map((objectId) => ({
    objectType: 'issue',
    objectId,
  }))
  const workReference = typeof values.work === 'string' ? values.work : undefined

  // **밖을 바꾸기 전에 계약을 집는다** (0.8.0 §O). 예전에는 게시가 성공한 **뒤에**
  // CLAIM 했다 — 그 사이에 다른 Run 이 같은 계약으로 들어오면 같은 글이 두 번 나갈 수
  // 있었다. 원자적 CLAIM 을 통과한 하나만 게시로 넘어간다. 게시가 실패하면 그 계약은
  // 태워진다: 같은 승인으로 다시 시도하지 않는 것이 이 계약의 뜻이다.
  const claimed = await applyTransition(store, 'grant', grantId, (g) =>
    transitionGrant(g, 'CLAIMED', 'executor', { claimedBy: `cli-${process.pid}` }),
  )
  if (!claimed.ok) {
    console.error(`${grantId} 를 집지 못했다 — 다른 Run 이 이미 집었거나 상태가 움직였다.`)
    return 1
  }

  const outcome = await publishOnce(
    {
      queryId,
      publicPayload: { title, body },
      ...(audience.length > 0 ? { audience } : {}),
      ...(known.length > 0 ? { known } : {}),
      ...(workReference ? { workReference } : {}),
    },
    { surface, bindingRole: 'coordination-surface' },
  )

  if (outcome.ok) {
    // 한 번 쓴 계약은 다시 쓰이지 않는다 (OM §11.5 single_use).
    const consumedAt = new Date().toISOString()
    await applyTransition(store, 'grant', grantId, (g) =>
      transitionGrant(g, 'EXECUTED', 'executor', {
        resultRef: outcome.identity.objectId,
        consumedAt,
      }),
    )
    const recorded = await recordPublication(coordinationLedger(store), outcome)
    if (values.json) {
      console.log(JSON.stringify({ publish: outcome, recorded: recorded.ok }, null, 2))
      return 0
    }
    console.log(publishLine(outcome))
    // 이미 적힌 사실을 다시 적지 않는다. 그것은 실패가 아니라 같은 것을 두 번 안 세는 것이다.
    console.log(recorded.ok ? 'recorded as communication evidence' : 'already recorded')
    return 0
  }

  // 집은 계약은 나가지 않았어도 소진된 것으로 닫는다 — 같은 승인으로 다시 시도하지
  // 않기 위해서다. 무엇이 실패했는지는 History 에 남는다.
  await applyTransition(store, 'grant', grantId, (g) => transitionGrant(g, 'INVALIDATED', 'executor'))
  await store.appendHistory({
    at: new Date().toISOString(),
    actor: `cli-${process.pid}`,
    kind: 'grant_invalidated',
    ref: grantId,
    detail: publishLine(outcome),
  })
  if (values.json) console.log(JSON.stringify({ publish: outcome }, null, 2))
  else console.error(publishLine(outcome))
  return 1
}

/**
 * `asc coordination observe` — 게시한 것에 답이 왔는가.
 *
 * **답의 의미를 정하지 않는다.** 여기서 남는 것은 "밖에서 사람이 글을 남겼다"까지이고,
 * 그것이 결정인지 승인인지는 다른 계약의 몫이다. 그 시스템이 스스로 남긴 자국과 우리가
 * 쓴 글은 세지 않는다 — 그 둘을 세면 아무도 답하지 않은 스레드가 답이 온 것으로 보인다.
 */
async function runCoordinationObserve(
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  root: string,
  resolved?: ResolvedRuntime,
): Promise<number> {
  const ledger = coordinationLedger(store)
  const communications = await ledger.communications()
  if (communications.length === 0) {
    console.log('Nothing has been published from here yet.')
    return 0
  }

  const { root: projectRoot } = await discoverProjectRoot(process.cwd())
  const adapters = monitorAdapters()
  const declared = resolved?.layers.profile.bindings ?? []
  const plan = await composeBindings({
    context: { projectRoot, env: process.env },
    adapters,
    roles: declared.map((b) => ({ adapterId: b.adapter, resource: b.resource, role: b.role })),
  })
  // **그 게시물을 만든 통로에게 묻는다.** 프로젝트 전체의 자원 조회를 하나 고르면
  // 어느 것을 고를지 갈리고(실제로 갈렸다), 갈리지 않더라도 다른 시스템에게 남의 게시물을
  // 묻게 된다. 증거에 적힌 adapter 가 곧 그 통로다.
  const built = await buildObservationChannels({
    plan,
    roles: rolesFor(plan, declared),
    ...jamComposition(projectRoot),
    endpointFor: (binding) => endpointOf(adapters, binding),
  })
  const contextOf = (adapterId: string) =>
    built.channels.find((channel) => channel.adapterId === adapterId && channel.resourceContext)?.resourceContext

  // 나를 나로 알아보는 곳은 identities.json 하나다. 채널 접두사를 떼면 계정 이름이 남는다.
  const identity = await loadIdentityMap(root)
  const mine = new Set<string>()
  for (const [name, accounts] of Object.entries(identity)) {
    mine.add(name)
    for (const account of accounts) mine.add(account.includes(':') ? account.slice(account.indexOf(':') + 1) : account)
  }

  let added = 0
  let looked = 0
  for (const communication of communications) {
    const context = contextOf(communication.identity.adapter)
    if (!context) {
      // 못 본 것을 "답이 없다"로 넘기지 않는다.
      console.error(`  ${communication.identity.objectId}: ${communication.identity.adapter} 통로가 열리지 않아 보지 못했다`)
      continue
    }
    looked += 1
    const remarks = await context
      .getComments(communication.identity.objectId, { limit: 100 })
      .catch(() => [])
    for (const response of responsesFrom(communication, remarks, mine)) {
      const outcome = await ledger.responseRecorded(response)
      if (outcome.ok) added += 1
    }
  }

  const views = await coordinationNow(store, resolved)
  if (values.json) {
    console.log(JSON.stringify({ published: communications.length, observed: looked, recorded: added, coordination: views }, null, 2))
    return 0
  }
  console.log(`Looked at ${looked} of ${communications.length} published artefact(s) — ${added} new response(s).`)
  for (const line of coordinationLines(views)) console.log(line)
  return 0
}

/**
 * `asc coordination` — 밖에 물은 것이 실제로 나갔는가, 답이 왔는가.
 *
 * **읽기만 한다.** 이 화면이 상태를 만들지 않는다는 것이 요점이다 — 보이는 것은 전부
 * 기대와 증거에서 파생한 값이다.
 */
async function runCoordination(
  command: string | undefined,
  values: Record<string, unknown>,
  store: MarkdownStateStore,
  root: string,
  resolved?: ResolvedRuntime,
): Promise<number> {
  if (command === 'publish') return runCoordinationPublish(values, store, resolved)
  if (command === 'observe') return runCoordinationObserve(values, store, root, resolved)
  if (command !== undefined && command !== 'status') {
    console.error(`Unknown coordination command: ${command}\n\n${USAGE}`)
    return 2
  }
  const views = await coordinationNow(store, resolved)
  if (values.json) {
    console.log(JSON.stringify({ coordination: views }, null, 2))
    return 0
  }
  for (const line of coordinationLines(views)) console.log(line)
  return 0
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
  // **index를 직접 뒤지지 않는다.** 모든 root 판정이 지나는 같은 문을 쓴다 — 그래야
  // 미등록 linked worktree도 같은 workspace로 풀리고, 그 자리가 등록까지 된다 (C-11 §1.3).
  const located = workspaceOf(await resolveRoot(process.cwd(), values.root as string | undefined))

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
    coordination: await coordinationNow(store),
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

  const built = await buildMonitorEngines(values, store, resolved)
  if (!built.ok) return built.code
  const { channels, repo } = built

  // 채널마다 자기 회차를 돈다. **한 채널의 실패가 다른 채널을 세우지 않는다** — 코드 쪽이
  // 자격을 잃었다고 작업 항목 쪽까지 못 보게 되면, 그것이 곧 "변화 없음"으로 읽힌다.
  let worst = 0

  // 어디까지 확인했는지 보여주기만 한다. 판정하지도, 무엇을 고치지도 않는다.
  if (command === 'status') {
    if (values.json) {
      const perChannel = []
      for (const channel of channels) {
        perChannel.push({ channel: channel.label, source: channel.sourceId, health: await channel.engine.health() })
      }
      console.log(JSON.stringify({ repo, channels: perChannel }, null, 2))
      return 0
    }
    for (const channel of channels) {
      console.log(`[${channel.label}]`)
      console.log(renderHealth(repo, await channel.engine.health()).join('\n'))
    }
    return 0
  }

  if (command === 'reconcile' || command === 'census') {
    for (const channel of channels) {
      const sweep = command === 'reconcile' ? await channel.engine.reconcile() : await channel.engine.census()
      if (sweep.skipped) {
        console.log(`[${channel.label}] another run is in progress. The next pass will pick it up.`)
        continue
      }
      if (values.json) {
        console.log(JSON.stringify({ channel: channel.label, ...sweep }, null, 2))
      } else {
        console.log(`[${channel.label}] ${sweep.kind}: ${sweep.seen} listed · ${sweep.changed} changed · ${sweep.packets.length} packets`)
        if (sweep.missing.length > 0) {
          console.log(`  ${sweep.missing.length} known items absent from this listing: ${sweep.missing.join(', ')}`)
          console.log('  (whether that is deletion, permissions, visibility or a query error is not judged here — a person looks)')
        }
      }
      if (!sweep.complete) {
        // 완주하지 못한 회차를 성공으로 보이면 "확인했다"는 거짓말이 된다
        console.error(`[${channel.label}] the listing did not complete${sweep.detail ? ` — ${sweep.detail}` : ''}. This pass makes no judgement about disappearances.`)
        worst = 1
      }
    }
    return worst
  }

  let packets = 0
  for (const channel of channels) {
    const outcome = await channel.engine.scan()
    if (outcome.skipped) {
      console.log(`[${channel.label}] another scan is in progress. The next pass will pick it up.`)
      continue
    }
    console.log(
      `[${channel.label}] 감지 ${outcome.detected} · 중복 ${outcome.duplicates} · 기록 ${outcome.logged} · ` +
        `보고서 ${outcome.packets.length} · 재시도 ${outcome.retries.length}`,
    )
    packets += outcome.packets.length
  }
  if (packets > 0) {
    const operator = new LocalOperator({ store })
    console.log()
    console.log(renderer.renderList(await operator.list()).text)
  }
  return worst
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
  runtime?: ResolvedRuntime,
): Promise<number> {
  switch (command) {
    case 'issue': {
      // 근거는 둘 중 하나다 — 밖에서 들어온 판단 요청, 또는 계약 안에서 일한 세션.
      const fromSession = (values.session as string | undefined) ?? undefined
      if ((!target && !fromSession) || !values.action || !values.target || !values.as) {
        console.error('Usage: asc grant issue REQ-0042 --action <key> --target <ref> --as <actor>')
        console.error('   or: asc grant issue --session <S-ID> --action <key> --target <ref> --body-file <path> --as <actor>')
        return 2
      }
      // **할 수 없는 일을 승인시키지 않는다** (0.7.0 / F-3).
      //
      // 예전에는 아무 action 으로나 Grant 가 발급되고, 사람이 승인한 **뒤에** 실행에서
      // "unsupported action" 이 나왔다. 승인의 의미가 그 자리에서 무너진다 — 사람은
      // 나갈 것에 동의했는데 나갈 수 없는 것이었다.
      const outward = await externalWritePort(runtime)
      if (!outward) {
        console.error('밖으로 내보낼 통로가 없다 — 이 행위를 수행할 결합이 Profile 에 없다.')
        console.error('지금 무엇이 풀리는지: asc status')
        return 2
      }
      if (outward.supports && !outward.supports(values.action as string)) {
        console.error(`'${String(values.action)}' 를 수행할 수 있는 통로가 없다 (${outward.id}).`)
        console.error('승인 뒤에 실패하는 것보다 지금 멈추는 편이 낫다 — 발급하지 않았다.')
        return 2
      }

      // 발급도 승인 권한자만 할 수 있다 — 외부로 나가는 권한이 여기서 만들어지기 때문이다
      const grants = new GrantService(store, new LocalIdentityBinding(await loadIdentityMap(root)))

      // **범위를 계약에 못 박는다** (0.8.0 보정 P1-3). 이 결합이 가리키는 원격이 곧 이
      // 승인의 실행 범위다 — 행위 하나를 승인했다는 사실이 다른 저장소까지 열어 주지
      // 않는다. 호출자가 이미 근거를 준 경우에는 그것을 그대로 둔다.
      const scoped = ((): ExecutionGrant['basis'] | undefined => {
        const given = values.basis as ExecutionGrant['basis'] | undefined
        const bound = bindingIdentity(runtime, outward.id)
        if (given?.resource || !bound) return given
        return { ...(given ?? {}), resource: bound }
      })()

      if (fromSession) {
        // 사람이 지금 내보내라고 한 것이 승인이다. 그 말과 함께 온 내용이 payload 이고,
        // 여기서 지어내지 않는다 — 사람이 본 적 없는 글이 사람의 이름을 달고 나가면 안 된다.
        const bodyFile = values['body-file'] as string | undefined
        if (!bodyFile) {
          console.error('--body-file <path> 가 필요하다 — 내보낼 내용은 사람이 준 것이어야 한다.')
          return 2
        }
        const payload = await readFile(bodyFile, 'utf8').catch(() => null)
        if (payload === null) {
          console.error(`내용을 읽지 못했다: ${bodyFile}`)
          return 2
        }
        const forSession = await grants.issueForSession({
          grantId: (values['grant-id'] as string) ?? `G-${String(Date.now()).slice(-4)}`,
          sessionId: fromSession,
          // 검수가 읽어 온 사실을 승인에 못 박는다 (0.8.0 §L). 없으면 없는 대로 둔다 —
          // 없는 기준선을 지어내면 재검수가 아무것도 지키지 못한다. 범위(resource)만은
          // 결합에서 채운다: 그것이 이 승인이 미치는 곳의 경계다.
          ...(scoped ? { basis: scoped } : {}),
          issuedBy: values.as as string,
          channel: 'local',
          action: values.action as string,
          target: values.target as string,
          payload,
          ...(values.expires ? { expiresAt: values.expires as string } : {}),
          issuedAt: new Date().toISOString(),
        })
        if (!forSession.ok) {
          console.error(GRANT_ERROR[forSession.failure.kind] ?? forSession.failure.kind)
          return 1
        }
        console.log(`${forSession.grant.id} READY — ${forSession.grant.action} → ${forSession.grant.target}`)
        console.log('The target state is checked again before execution. If it changed in the meantime, nothing runs.')
        return 0
      }

      if (!target) {
        console.error('요청 근거가 없다 — REQUEST_ID 를 주거나 --session <S-ID> 를 쓰라.')
        return 2
      }
      const issued = await grants.issue({
        grantId: (values['grant-id'] as string) ?? `G-${String(Date.now()).slice(-4)}`,
        requestId: target,
        ...(scoped ? { basis: scoped } : {}),
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
      const grant = await store.get('grant', target)
      if (!grant) {
        console.error(`${target} was not found.`)
        return 1
      }
      // **어느 provider 로 나갈지는 여기서 고르지 않는다** (C-09 · B-49).
      //
      // 예전에는 이 자리에서 GitHub client 를 직접 만들었다. 관측 경로는 진작 결합으로
      // 풀리고 있었는데 실행 경로만 한 갈래에 묶여 있어서, 코드가 다른 곳에 있는
      // 프로젝트에서는 승인이 끝난 **뒤에야** 실행할 통로가 없다는 것이 드러났다.
      const scm = await externalWritePort(runtime)
      if (!scm) {
        console.error(
          '밖으로 내보낼 통로가 없다 — Profile bindings 에 외부 쓰기를 제공하는 결합이 필요하다.',
        )
        console.error('지금 무엇이 풀리는지: asc status')
        return 2
      }
      // 강제가 서 있는 자리에서는 되돌려 읽을 수 없는 행위를 실행하지 않는다 (P1-2).
      const enforcing = enforcementOf(await readExecutionMode(store.scope('policy'))) === 'ENFORCE'
      const outcome = await new Executor({
        store,
        scm,
        runId: (values['run-id'] as string) ?? `cli-${process.pid}`,
        ...(enforcing ? { requireVerification: true } : {}),
      }).run(target)

      if (outcome.ok) {
        console.log(`EXECUTED — ${outcome.resultRef}`)
        return 0
      }
      // 실패의 종류를 뭉개지 않는다 (0.8.0 §P) — 다음 행동이 저마다 다르다.
      console.error(`${outcome.reason}${'detail' in outcome ? `: ${outcome.detail}` : ''}`)
      if (outcome.reason === 'UNCERTAIN') {
        console.error('밖에 나갔는지 알 수 없다. 다시 실행하지 마라 — 먼저 원격을 읽어 확인하고,')
        console.error('그 뒤에 사람이 새 Grant 를 낸다. 이 Grant 는 집힌 채로 남아 재사용되지 않는다.')
      }
      if (outcome.reason === 'NOT_VERIFIED') {
        console.error(`나간 것: ${outcome.resultRef} — 그러나 되돌려 읽은 것이 기대와 다르다.`)
        console.error('성공으로 적지 않는다. 원격을 직접 확인하라.')
      }
      return 1
    }

    default:
      console.error(`Unknown grant command: ${command ?? '(none)'}\n\n${USAGE}`)
      return 2
  }
}

/**
 * 이 작업이 가리키는 원격의 신원 (0.8.0 §K).
 *
 * **deny-list 가 아니다.** 검수가 "이 대상이 우리가 맡은 그 원격인가" 를 묻기 위한
 * 기준점이고, 어긋나면 Agent 가 스스로 범위를 넓히는 대신 사람에게 올라간다.
 * 결합이 여럿이면 고르지 않는다 — 고르는 순간 그것이 곧 조용한 범위 확장이다.
 */
function bindingIdentity(runtime: ResolvedRuntime | undefined, adapterId: string): string | undefined {
  const declared = (runtime?.layers.profile.bindings ?? []).filter((binding) => binding.adapter === adapterId)
  return declared.length === 1 ? declared[0]!.resource : undefined
}

/**
 * 승인된 행위가 실제로 나갈 통로 (C-09 · OM §11.5).
 *
 * 조립은 Composition 의 몫이다 — 이 자리에서 provider 를 알면 provider 교체가 다시 CLI
 * 수술이 된다. 없으면 `null` 이고, 없는 것을 있는 척하지 않는다.
 */
async function externalWritePort(runtime?: ResolvedRuntime): Promise<ScmPort | null> {
  return (await composedPorts(runtime)).scm ?? null
}

/**
 * 이 workspace 의 결합이 지금 실제로 조립되는가 (§62·§63).
 *
 * **선언이 아니라 조립 결과가 근거다.** 토큰 하나가 환경에 있다는 사실로 "외부 쓰기 가능"
 * 이라고 적으면, 그 표시는 실제 실행 경로와 어긋난 채로 사람을 안심시킨다 — 0.7 의 D-01 이
 * 그 형태였다. 여기서 나오는 것은 Composition 이 만든 Port 와, 만들지 못한 이유다.
 */
async function composedPorts(runtime?: ResolvedRuntime): Promise<Awaited<ReturnType<typeof buildRuntimePorts>>> {
  const { root: projectRoot } = await discoverProjectRoot(process.cwd())
  const adapters = monitorAdapters()
  const declared = runtime?.layers.profile.bindings ?? []
  const plan = await composeBindings({
    context: { projectRoot, env: process.env },
    adapters,
    roles: declared.map((b) => ({ adapterId: b.adapter, resource: b.resource, role: b.role })),
  })
  const ports = await buildRuntimePorts({
    plan,
    roles: rolesFor(plan, declared),
    repoRoot: projectRoot,
    ...(runtime?.layers.profile.canonical.sources
      ? {
          sourceRefs: Object.fromEntries(
            runtime.layers.profile.canonical.sources
              .filter((source): source is typeof source & { ref: string } => typeof source.ref === 'string')
              .map((source) => [source.id, { ref: source.ref }]),
          ),
        }
      : {}),
    endpointFor: (binding) => endpointOf(adapters, binding),
  })
  return ports
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
    '(현재 상태는 `asc status`).',
  NO_PAYLOAD: '내보낼 내용이 없다.',
  SESSION_NOT_FOUND: '그 세션을 찾지 못했다.',
  SESSION_NOT_RUNNABLE: '아직 시작하지 않은 세션이다 — 내보낼 결과가 없다.',
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
