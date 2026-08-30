# ASC — Agent Session Control

**A local-first control plane for coding agents.** Run several AI sessions without losing
track of what each one is allowed to do, what it decided, and what still needs you.

ASC gives an agent a contract — a goal, done-criteria, a write boundary — lets it proceed
on what it owns, and stops it at the boundaries that are yours: ownership, shared
contracts, secrets, irreversible actions. Nothing reaches an external system without an
approved execution grant. Everything is auditable afterwards.

> **The packages are on npm.** Install them with the exact commands below. Cloning this
> repository is the [contributor path](#development) — it is not how you use ASC.
>
> If the version pinned here is not on the registry, this source is ahead of the release:
> report that the exact version is unpublished and stop. **Do not fall back to another
> version** — `@latest` or an older pin is a runtime nobody tested these instructions
> against.

> **Coding agent?** Read [AGENTS.md](AGENTS.md) — the ordered path from this URL to a ready
> control plane, with the decisions already made, and the rules for turning a work request
> into a session contract once there is real work.

> Korean: [README.ko.md](README.ko.md). This file is canonical.

## The problem it solves

Running parallel agents, a person becomes the memory: carrying context between sessions,
remembering which one was allowed to touch what, re-deriving why a decision was made.
ASC moves that into a runtime that lives in your own space — not in the repository you are
working on.

- **Sessions with contracts** — a goal, verifiable done-criteria, a write boundary.
- **Proceed by default** — an agent does not ask permission for what it owns.
- **Escalation at real boundaries** — and only there. Uncertainty is not a boundary.
- **Audit** — issuance and actual execution recorded separately, decisions with their
  reasons, independent verification kept apart from self-reports.
- **Offline after install** — local control-plane commands need no network.

## What ASC is not

- Not an agent, and not a model router. It does not do your work.
- Not a task tracker. It points at your canonical sources; it does not copy them.
- Not a sync service. Runtime state does not follow you between machines.

## Requirements

- **Node 24 or newer** — declared in `engines`. Lower versions are not supported.
- One runtime dependency: `zod`.

## Install

ASC ships as two packages:

| Package | Role |
|---|---|
| `@asc-agent/runtime` | The runtime — core, CLI, adapters. Provides the `asc` command. |
| `@asc-agent/bootstrap` | Zero-install first run. Holds no setup logic of its own. |

### First run, on a machine with nothing installed

```bash
npx --yes @asc-agent/bootstrap@0.3.1 init
```

### A profile for your project

The packaged profiles are examples — neither describes a real project. A profile that
describes *yours* lives in your own directory and is picked up from there.

Make one from the repository you are in:

```bash
asc profile adopt          # writes ~/.asc/profiles/<repo>/profile.json
asc setup apply --profile <repo>
asc setup status           # profile: <repo> — your own profile directory
```

`adopt` writes only what a git remote proves: the project's identity. Canonical branches
and role boundaries stay empty, because this repository cannot tell you what your team
decided — add them as you agree on them. If someone already handed you a profile file, put
it in place instead:

```bash
mkdir -p ~/.asc/profiles/my-team
cp path/to/profile.json ~/.asc/profiles/my-team/profile.json
asc setup apply --profile my-team
```

Full rules — precedence, id collisions, what a profile may not do, and why moving one does
not break an existing attachment — are in [docs/profiles.md](docs/profiles.md).

### Where `asc` comes from

The command does not appear by magic, and this is the whole chain:

```text
npx --yes @asc-agent/bootstrap@0.3.1 init
        ↓  the bootstrap runs ASC's ordinary setup: detect → plan → apply → verify
        ↓  the plan lists "install the runtime on this machine" as a change
        ↓  apply runs: npm install -g @asc-agent/runtime@0.3.1
        ↓  npm owns the executable link (on Windows, npm's own asc.cmd)
        ↓  verify checks the installed version and that a NEW process can run it
bootstrap exits
        ↓
asc ...      the stable local command, from here on
```

Installation is a change **listed in the plan**. The bootstrap never installs behind your
back, and it holds no setup policy of its own — it forwards to the same core the installed
`asc` uses.

ASC does not edit your shell profile or your `PATH`. If npm installs the package but `asc`
is not visible in the current process, ASC says exactly that instead of claiming success:

```text
Runtime package was installed, but `asc` is not visible in this process.
Open a new terminal and run `asc setup status`.
```

### Three ways to run ASC

Every command exists in all three tiers; only the entry differs.

| Tier | Entry | When |
|---|---|---|
| Zero-install | `npx --yes @asc-agent/bootstrap@0.3.1 <command> --json` | nothing is installed yet |
| Persistent | `npm install -g @asc-agent/runtime@0.3.1`, then `asc <command>` | the stable local command — and the fallback when `npx` itself cannot start |
| Development | `asc runtime use development <checkout>` | run a built checkout instead of the package |

If `npx` or `npm exec` dies before any ASC process starts — a package-runner or `PATH`
failure, not anything ASC printed — that is not an ASC failure, and there is no ASC error
code to branch on. Install the persistent tier and re-run the same subcommand as `asc …`.
This is different from `HOST_EXECUTION_PERMISSION_REQUIRED`, where the host refused a
command ASC asked to run: that one is ASC speaking, and its JSON says what to do next.

### Everyday use

```bash
asc setup status     # what works, what is blocked, and why
asc proceed          # pick up the runnable work you own
asc front            # what is running, what is waiting on you
asc runtime status   # which build is in use
```

### For a coding agent

**[AGENTS.md](AGENTS.md) is the runbook** — the ordered path, and the rules for what you
decide yourself versus what you bring to a human. This section describes the data it works
on.

Non-interactive and machine-readable. `stdout` is a single JSON document; diagnostics go
to `stderr`.

On a fresh machine, start from the bootstrap — there is no `asc` yet:

```bash
npx --yes @asc-agent/bootstrap@0.3.1 setup apply --json
```

The document carries a stable shape:

```jsonc
{
  "status": "ready_to_apply",       // or already_configured / user_action_required / applied
  "code": "ASC_PROFILE_SELECTION_REQUIRED",  // present only when a human must decide
  "executionMode": "bootstrap",     // or installed-runtime
  "changes": [
    { "target": "runtime-install", "package": "@asc-agent/runtime",
      "version": "0.2.0", "strategy": "npm-global", "from": "NOT_INSTALLED" },
    { "target": "attach-workspace", "scope": "local", "profile": "..." }
  ],
  "requiresUserAction": false,
  "changesApplied": false,
  "actions": [
    // ordered by what actually opens the way. `adopt_profile` appears when a profile
    // must exist before anything can be selected.
    { "type": "apply_setup",
      "display":  "asc setup apply",
      "portable": "npx --yes @asc-agent/bootstrap@0.3.1 setup apply" }
  ],
  "nextActions": ["npx --yes @asc-agent/bootstrap@0.3.1 setup apply"],
  "evidence": ["project=/path", "git=yes", "attached=no", "runtime=NOT_INSTALLED"]
}
```

**Run `actions[].portable`, never `display`.** The two differ exactly while the runtime is
not yet installed: `display` is the short form a person types afterwards, `portable` is
what runs on this machine right now. Once `executionMode` is `installed-runtime`, they are
the same string.

Branch on `code` and `requiresUserAction`. Never parse the prose.

## Local-first and zero footprint

`asc init` defaults to **local scope**, and in that mode **nothing is created inside the
target repository**.

```text
--scope local (default)   runtime = $ASC_HOME/workspaces/<W-id>/   repo footprint 0
--scope project           runtime = <repo>/.asc/                   only if the team decided so
```

- `ASC_HOME` defaults to `~/.asc`. It holds one directory per workspace plus a reverse
  index, `workspace-index.json`.
- **There is no automatic promotion from local to project.** Putting state inside a
  repository is an explicit decision expressed only by `--scope project`.
- `.git/info/exclude` is touched under project scope only. Local scope does not modify a
  single byte of the repository.

Measured, not asserted: see (비공개 evidence 저장소).

## Workspace identity

A workspace points at a project, not at a path.

| Concept | Meaning |
|---|---|
| Workspace Identity | `W-…` — the canonical, stable, logical identity |
| Alias | A normalized remote URL. **Evidence of identity, never proof of it.** |
| Locator | Where this checkout sits on this machine. It can change. |

So moving or re-cloning a checkout can still resolve to the same workspace.

```bash
asc workspace list
asc init --profile <id> --workspace <W-id>   # you declare the match; ASC never picks for you
```

If a repository already contains a `repo/.asc` from the older layout:

```bash
asc workspace migrate
```

It first judges whether that state is team-adopted or personal legacy, and refuses to
move when it cannot tell. It copies, verifies, and **never deletes the original** — that
is yours to do after you have checked.

## Runtime: package or development

```bash
asc runtime status
asc runtime use package
asc runtime use development /path/to/asc/packages/runtime
```

`package` is the globally installed runtime — the one `npm install -g` put there.
`development` runs a built checkout instead.

The path is validated before it is stored: a checkout that is missing, is not ASC, or has
not been built is rejected the moment you point at it, not later with a
module-not-found. When it is simply unbuilt, the remedy **names the checkout it applies
to** rather than assuming your current directory is it:

```text
ASC_DEVELOPMENT_SOURCE_INVALID: /path/to/asc/packages/runtime has not been built yet
  target: /path/to/asc/packages/runtime
  Build that checkout and retry — do not run this in the current directory.
  Run: npm run build
```

This selection is machine-local, kept under `ASC_HOME`. **Changing it does not change any
project**, and attaching or moving a workspace does not change it.

## Host integration

Claude Code as a host:

```bash
asc host claude install    # guard hook + skill bundle, into ~/.claude
asc host claude guard      # worker settings, inside an attached project
asc host claude probe      # capability measurement + install state
```

Host artefacts are **user-owned, not project-owned**. `install` writes to your home
directory; `uninstall` removes only what ASC installed.

Install state is judged against the current source, not just against what was recorded
at install time:

```text
NOT_INSTALLED · INSTALLED_CURRENT · INSTALLED_STALE · INSTALLED_MODIFIED · BROKEN
```

`STALE` means the source moved on and you did not — reinstall converges it.
`MODIFIED` means you edited an ASC-owned file — it is preserved, and `--force` is the
only way to overwrite it.

## Proceed-by-default and escalation

An agent proceeds on what it owns. It escalates only when it hits a real boundary:
ownership, a shared contract, an acceptance change, a secret or permission, an
irreversible action, an explicit rule, or a conflict in the canonical source. Being
uncertain, or having two options, is not a boundary.

An open escalation blocks the criteria it names — not the whole session:

```text
blocked: N2 extend response schema
scope:   server/**
running: N1 introduce runtime configuration
```

## Audit

`asc session audit <S-ID>` shows issuance and actual execution separately, the decisions
an agent made without approval and why, the escalations it raised and the boundaries
they name, independent validation, and who currently holds the session.

## Upgrade and uninstall

Upgrading the runtime is the same npm command with a new exact version:

```bash
npm install -g @asc-agent/runtime@<exact>
```

Updating the runtime can leave host artefacts behind — `asc setup plan` reports that as
`INSTALLED_STALE` and lists the repair as a change. Runtime removal and deleting your data
are **not the same command**: `ASC_HOME` state is kept unless you say otherwise.

## Security

- No credential is ever written into a project file.
- No machine-specific absolute path is ever written into a project file.
- External writes leave only through an approved execution grant; a guard hook blocks
  them at the point of execution for ASC-managed sessions.
- Host installation touches only the ASC namespace. Your files and other tools' hooks
  are left alone.

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| `Cannot find package 'zod'` across every test | dependencies not installed | `npm ci` |
| Setup says a decision is required | a real human boundary | read `code` and `nextActions` |
| `ASC_DEVELOPMENT_SOURCE_INVALID` | the selected checkout is gone, is not ASC, or is unbuilt | follow the `nextCommand` it prints |
| `probe` reports `STOP` | `claude` is not on `PATH` | a missing prerequisite, not an ASC failure |
| Host shows `INSTALLED_STALE` | the runtime moved on | `asc host claude install` |

## Development

```bash
git clone https://github.com/colosair/asc.git
cd asc
npm ci
npm test
npm run typecheck
npm run build
```

Run the CLI straight from the checkout — Node executes the TypeScript sources directly:

```bash
node packages/runtime/cli/asc.ts --help
```

That is the contributor path. It is not how a consumer installs ASC.

Distribution artefacts are compiled, because Node refuses to strip types under
`node_modules`:

```bash
npm run build          # packages/runtime/dist
npm run pack:all       # tarballs into private/packs
npm run smoke          # install those tarballs into a throwaway HOME and drive the real bin
npm run release:check  # version, namespace and documented-command drift
```

`npm run smoke` is the one that matters before a release: it never touches your real
`~/.asc`, `~/.claude`, or npm cache. `release:check` does not publish anything — publishing
stays human-controlled; only drift detection is automated.

## Document map

| What | Where | Nature |
|---|---|---|
| Canonical design (v5.1, frozen) | [docs/design/operating-model.md](docs/design/operating-model.md) | referenced as `OM §x` |
| Contracts — ports and boundaries | [C-01](docs/contracts/C-01_approval-port.md) · [C-02](docs/contracts/C-02_port-interface.md) · [C-03](docs/contracts/C-03_operator-host-adapter.md) | Approval Port / Port boundary / Operator·Host Adapter |
| Contracts — responsibility and entry | [C-04](docs/contracts/C-04_responsibility.md) · [C-05](docs/contracts/C-05_skill-bundle.md) · [C-06](docs/contracts/C-06_bootstrap.md) | Responsibility / Skill Bundle / Zero-base Bootstrap |
| Contracts — observation and independence | [C-07](docs/contracts/C-07_monitoring-completion.md) · [C-08](docs/contracts/C-08_presentation-digest.md) · [C-09](docs/contracts/C-09_capability-binding.md) | Monitoring / Presentation·Digest / External-System Independence |
| Contracts — audit, storage, always-on, autonomy | [C-10](docs/contracts/C-10_orchestration-audit.md) · [C-11](docs/contracts/C-11_workspace-local-first.md) · [C-12](docs/contracts/C-12_always-on-runtime.md) · [C-13](docs/contracts/C-13_autonomous-escalation.md) | Orchestration Audit / Workspace·Local-first / Always-On / Autonomous Escalation |
| Contract — distribution | [C-14](docs/contracts/C-14_distribution-runtime-entry.md) | how the executable exists on a machine |
| Architecture — distribution | [docs/architecture/distribution-and-runtime.md](docs/architecture/distribution-and-runtime.md) | English |
| Profiles — bringing your own | [docs/profiles.md](docs/profiles.md) | where a real project's profile lives |
| Team setup and upgrading | [docs/team-setup.md](docs/team-setup.md) | onboarding a teammate; moving to a newer runtime |
| **Product status (SSOT)** | [docs/status.md](docs/status.md) | what exists, what is proven, what is not claimed |
| Block-level history | (비공개 evidence 저장소) §2 | development record — private evidence repository |
| Measured evidence | (비공개 evidence 저장소) | runtime observations — private evidence repository |

The canonical design (OM v5.1) and C-01~C-03 are **frozen**. They reopen only on evidence
that a port, profile, or adapter boundary cannot solve the problem. Later contracts are
follow-ons that do not modify them.

## Evidence levels

Reports here distinguish four claims, and do not blur them:

```text
DOCUMENTED         it is written down
TEST_VERIFIED      an automated test covers it
RUNTIME_OBSERVED   it was watched happening through the real CLI
DOGFOOD_VERIFIED   it was watched happening during real work
```

## Operating rule

**No new block starts without measured evidence.** A candidate has to be tied to
something that actually happened, be likely to recur, and carry a clear gate. When the
evidence is thin, the next block stays undecided.

## Security

ASC controls what an agent may do and reads credentials from your environment. Report
issues through GitHub private vulnerability reporting — see [SECURITY.md](SECURITY.md),
including what **not** to put in a report.

## License

ISC. See [LICENSE](LICENSE).
