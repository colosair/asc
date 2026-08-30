# AGENTS.md — from this URL to a ready control plane

You were pointed at this repository and asked to apply ASC to a project. This file is the
whole path. It answers the questions you would otherwise bring back to the person who
asked, so do not bring them back — they are answered here.

ASC (Agent Session Control) is a local-first control plane for coding agents: it gives a
session a contract (goal, done-criteria, write boundary), lets it proceed on what it owns,
and stops it at real boundaries. It is a tool you install, not a library you vendor.

## Decisions already made — do not ask

| Question | Answer |
|---|---|
| Which project? | The git repository you are working in. That is the target. |
| Install, or clone the source? | **Install the published package.** Cloning is the contributor path for people changing ASC itself. |
| Is setting up local tooling in scope? | **Yes.** Someone asked you to apply ASC; installing it is that request, not a new one. Proceed. |
| Should this be a ticket first? | No. Setting up your own machine is not tracked work. |
| No profile matches this project? | Make one — `asc profile adopt`. See step 2. |

**The only human boundaries here are secrets, permissions, and irreversible actions.**
Asking for a credential, granting access to an external system, deleting or overwriting
someone's data — those stop and go to a person. Nothing else on this page does.

## The version is exact, on purpose

Every command below pins an exact version. If that version is not on the registry, this
source is ahead of its release.

**Say so and stop.** Do not try `@latest`, do not drop to an older pin, do not install from
a git checkout instead. Those are runtimes nobody tested these instructions against, and
the person who asked you needs to know the release has not happened yet — that is a real
answer, not a failure.

## Two boundaries sit before ASC

Everything below the next section assumes an ASC process actually started. Two things can
stop that from happening, and neither of them can be reported by ASC — there is no ASC
running to report it. Recognise them by the situation, not by matching an error string.

### The host will not run the command — `HOST_EXECUTION_PERMISSION_REQUIRED`

Your host refused to execute the command before any ASC code ran. This is not an ASC
defect, not a setup decision, and not a secret. It is a permission boundary, and it is one
of the three things a human is here for.

What to do, in order:

1. **Do not try the same thing in another shape.** Not a different wrapper, not an absolute
   path, not a `PATH=` prefix, not another package manager. If the host is refusing to
   start the process, every variant is the same request wearing a hat, and a pile of denied
   attempts is worse evidence than one clear denial.
2. Do not paraphrase or "simplify" the command. It goes to the person exactly as written.
3. Show them the exact command, and say plainly that the host blocked it before ASC ran.
4. Ask them to **switch the session's permission mode** — in Claude Code, out of automatic
   approval and into the mode where each command is approved as it is asked for. Do not ask
   for a broad standing rule: no `Bash(npx:*)`, no `npm:*`, no blanket shell access. ASC
   never writes to `~/.claude/settings.json` or any host config; changing the mode is the
   person's action in their own interface.
5. Once they have switched, run **the same command again**, once, and let them approve that
   single run. Then continue from where you were. A later `actions[].portable` that is
   blocked is handled the same way.

A measured note, so nobody repeats the experiment: on the machine where this was observed,
adding an allow rule for the exact command **did not** get it through — the same denial came
back. Switching the mode and approving the one run did. An allow rule is not the recipe
here, and the reason the automatic mode refuses is not established: the same command was
denied twice in one session and allowed in another, so treat the denial as a property of the
session you are in, not of the command you are holding.

### This Node cannot run ASC — `NODE_RUNTIME_REQUIRED`

ASC needs Node 24 or newer, and it says so instead of half-working. If ASC did start and
answered with this code, read `candidates`: it lists newer Node runtimes already on the
machine, each with a `use_node_runtime` action whose `portable` runs the same canonical
command under that Node for this invocation only. It changes no profile, no `PATH` on disk,
nothing outside that one command.

Run it if the host allows it. **If the host refuses to run that form, do not go looking for
another one** — that is `HOST_EXECUTION_PERMISSION_REQUIRED` above, and it is handled
there. If `candidates` is empty, installing Node is the person's to do: say which version
is needed and stop.

This form exists to remove ambiguity about which Node runs ASC. It is not a way around a
host that is refusing to execute things, and it must not be reached for as one — that a
`PATH=`-prefixed command was once allowed where a plain one was denied says something about
that session, not something you can rely on.

### Three kinds of outcome, everywhere below

```text
human boundary   stop and ask — secrets, permissions, irreversible actions
self-heal        the JSON handed you a portable command; run it and carry on
hard fault       report it; do not retry it in a different shape
```

## The path

Run `actions[].portable` from the JSON you get back. Branch on `code`. Never parse prose.
Every portable answers in JSON — that is why they end in `--json`.

**1 — first run.** No `asc` exists yet, so start from the bootstrap:

```bash
npx --yes @asc-agent/bootstrap@0.3.1 setup apply --json
```

This is the canonical entry, and the only one you need to remember. `setup plan --json`
answers the same question without changing anything; `apply` is what carries out the plan,
and it carries out nothing that was not in it. `stdout` is a single JSON document,
everything else goes to `stderr`. It changes nothing and exits `1` when something is
genuinely left to decide — including the case in step 2.

If `npx` or `npm exec` dies before any ASC process starts — a package-runner or `PATH`
failure, no ASC JSON on stdout — that is not an ASC failure, and there is no `code` to
branch on. Do not retry the same shape. Fall back to the persistent entry:
`npm install -g @asc-agent/runtime@0.3.1`, then re-run the same subcommand as `asc …`.
This is distinct from `HOST_EXECUTION_PERMISSION_REQUIRED`, where the host refused a
command ASC asked to run — that one is ASC speaking, and its JSON says what to do.

**2 — a profile for this project.** If the plan comes back with
`code: "ASC_PROFILE_SELECTION_REQUIRED"`, the packaged profiles are examples and none of
them describes this project. Run the `adopt_profile` action's `portable` command:

```bash
asc profile adopt --json     # before install: npx --yes @asc-agent/bootstrap@0.3.1 profile adopt --json
```

It reads this repository's git remote and writes `~/.asc/profiles/<id>/profile.json` — in
the user's own space, nothing inside the repository. It records only what the remote
proves. Canonical branches and role boundaries are left empty on purpose: they are the
team's decisions, and a wrong guess makes sessions fail later. The `warnings` array says
what was left empty. Report those; do not fill them in by guessing.

If a profile file was handed to you instead, place it at
`~/.asc/profiles/<id>/profile.json` and skip adopt.

**3 — attach.**

```bash
asc setup apply --profile <id> --json
```

`changesApplied: true` and `remaining: []` means it is done and idempotent.

**4 — judge whether you are ready.**

```bash
asc setup status --json
```

`attachment` is the verdict: `READY`, `UNATTACHED`, `BROKEN`, or `LOCK_DRIFT`. The exit
code is always `0` — it is a diagnostic, so read the field, not the status code.

**`READY` means technical readiness: this machine can run the local session loop.** Issue,
start, checkpoint, progress, finish, closure — all of it. It does not mean every gate is
open, and right after a first attach they will not be:

```text
approval        BLOCKED   identities.json is an empty template
monitor         BLOCKED   no controller identity, no SCM token
external-write  BLOCKED   no approver, no SCM token
```

**A BLOCKED gate blocks only the outward path it names.** It does not block the local
session loop. Each gate carries `missing[]` and `howTo[]` — surface those to the person as
what remains, and note that filling them needs credentials, which is theirs to do, not
yours.

**`READY` is the end of setup.** There is no step 5.

If what you were asked to do was install or apply ASC, you are finished here. Say so, and
report three things: what you did, what `status` says is still blocked, and which
`warnings` from adopt the team needs to answer.

**Do not create a session to prove the setup worked.** A session carries an id, a goal, a
write boundary and done-criteria — a contract about real work. If nobody asked for real
work, none of those exist, and inventing them to produce a green line is the same mistake
as filling in a profile's canonical branch with a guess: it manufactures a fact where there
was none. `READY` already means the session loop runs; a demonstration adds nothing to it
and leaves a fictional contract in the record.

Sessions come next only when there is actual work to do — see below.

## When there is real work

A request like "implement ABC-123" is a work intent, and it is what a session is for. You
draft the contract; ASC validates it. Read [the session contract section](#drafting-a-session-contract)
before issuing anything.

## Drafting a session contract

A session is a contract: an id, a role, a goal, a write boundary, and done-criteria. When
someone asks for real work — "implement ABC-123" — those five have to come from somewhere,
and the two easy answers are both wrong. Inventing them is fabrication. Asking a person to
type all five is handing back the job you were given.

**You draft it. ASC checks it.**

```bash
asc session plan --json \
  --id <S-ID> --role implementer --goal "<what the work item asks for>" \
  --boundary '<narrowest path set>' --criteria "<acceptance>" --criteria "<...>" \
  --provenance id=FACT:user --provenance goal=FACT:work_item --provenance boundary=PROPOSAL:repository
```

It writes nothing. `status` comes back as one of three:

```text
READY_TO_ISSUE   the contract holds; nothing is left to decide about its content
NEEDS_DECISION   the structure is fine, but something is genuinely a person's call
INVALID          this draft is not a contract — the syntax or the id is wrong
```

### A valid contract is not permission to issue it

Issuing a session is the Controller's act — a person's. `READY_TO_ISSUE` says the contract
holds, not that you may create it. Read `issuance`:

```text
authority: "delegated"   the Controller delegated issuance for this role. actions[0].portable
                         issues it, and you may go on to `session start`.
authority: "controller"  nobody delegated it. The command is in `forController` — give it to
                         the person and stop. Do not run it, and do not ask them to approve
                         your running it.
```

A team delegates by naming roles in their profile's `policy.unionLists.issuanceDelegation`.
That is their decision to make and record, never yours to propose your way into.

### Say where each value came from

Mark every field with `--provenance <field>=<FACT|PROPOSAL|DECISION_REQUIRED>[:<source>]`:

```text
FACT               you read it: the person said it, the work item states it, the profile
                   declares it, the canonical source contains it
PROPOSAL           you inferred it, and you can say from what
DECISION_REQUIRED  you must not settle it
```

Sources are `user`, `work_item`, `profile`, `repository`, `canonical`, `agent_proposal`. A field
with no declared source is counted as a proposal, never as a fact — a value nobody can trace
is a value nobody can correct later.

### Fill in what you can, then ask about one thing

"S15P21A604-247 구현해" already carries more than it looks like:

```text
id        FACT       the person named the work item
goal      FACT       the item states the requirement — read it, do not restate it as your own
role      PROPOSAL   implementation was asked for
boundary  PROPOSAL   from the item's ownership and this repository's layout
criteria  PROPOSAL   the item's acceptance, plus the checks this repository already runs
```

If that comes back `READY_TO_ISSUE`, issue it. Do not ask for confirmation of a draft ASC
has already validated — uncertainty is not a boundary.

If a value is genuinely open, `unresolved` names **one field at a time**, with `options` and
a `recommended` index where a recommendation is possible. Ask that one question. Do not
convert it into a form for the person to fill in.

### Where the line is

`unresolved[].reason` uses the same vocabulary as escalation: `ownership_boundary`,
`shared_contract_change`, `acceptance_change`, `secret_or_permission`,
`irreversible_action`, `explicit_rule_requires_approval`, `canonical_conflict` — plus
`missing_input` and `multiple_options`, which are not boundaries and must not be presented
as though a person is being asked to approve something.

Being unsure is not a reason to escalate. Neither is having more than one option, wanting a
second opinion, or expecting a reviewer might disagree. Those are states, not boundaries.

### What a draft may never do

- Widen a boundary to make a mismatch go away. Narrow it, split the session, or hand the
  part to whoever owns it.
- Invent product acceptance. "Tests pass" is a verification criterion you may propose;
  "60fps in every browser" is a requirement you would be creating.
- Spend a real work item on a setup check. If there is no work, there is no session.
- Record a proposal as a fact, or drop the provenance when you issue.

## What you never do here

- Install a version other than the pinned one, or fall back to `@latest`.
- Write inside the target repository. Local scope is the default and leaves zero footprint;
  `--scope project` is a team's explicit decision, never yours.
- Fill a profile's canonical sources or role boundaries with plausible-looking values.
- Create a session to demonstrate that setup worked. Setup ends at READY.
- Ask for, store, or enter a credential. Gates that need one stay blocked, and you say so.
- Retry a host-blocked command in a different shape, or ask for a standing permission rule
  when what is needed is one approved run.
- Edit a host's settings or a shell profile to make something run. That is the person's
  interface, not yours.
