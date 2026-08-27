# AGENTS.md — from this URL to a working session

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

## The path

Run `actions[].portable` from the JSON you get back. Branch on `code`. Never parse prose.

**1 — first run.** No `asc` exists yet, so start from the bootstrap:

```bash
npx --yes @asc-agent/bootstrap@0.2.0 init --agent
```

This installs the runtime and attaches, in one pass. `--agent` is the non-interactive
form: `stdout` is a single JSON document, everything else goes to `stderr`. It changes
nothing and exits `1` when something is genuinely left to decide — including the case in
step 2.

**2 — a profile for this project.** If the plan comes back with
`code: "ASC_PROFILE_SELECTION_REQUIRED"`, the packaged profiles are examples and none of
them describes this project. Run the `adopt_profile` action's `portable` command:

```bash
asc profile adopt --json     # before install: npx --yes @asc-agent/bootstrap@0.2.0 profile adopt --json
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
asc setup apply --profile <id> --agent
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

**A BLOCKED gate blocks only the outward path it names.** It does not block session issue.
Each gate carries `missing[]` and `howTo[]` — surface those to the person as what remains,
and note that filling them needs credentials, which is theirs to do, not yours.

**5 — prove it works.**

```bash
asc session issue <ID> --role implementer --goal "<goal>" --boundary '<path>/**' \
  --criteria "<how you will know it is done>" --criteria "<...>"
asc session start <ID>
asc front
```

A session that reaches `ACTIVE` is the end of setup. Report what you did, what `status`
says is still blocked, and which `warnings` from adopt the team needs to answer.

## What you never do here

- Install a version other than the pinned one, or fall back to `@latest`.
- Write inside the target repository. Local scope is the default and leaves zero footprint;
  `--scope project` is a team's explicit decision, never yours.
- Fill a profile's canonical sources or role boundaries with plausible-looking values.
- Ask for, store, or enter a credential. Gates that need one stay blocked, and you say so.
