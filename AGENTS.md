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
4. Ask for **one** allow rule scoped to that exact command. In Claude Code, a project or
   user permission rule of the form `Bash(<the exact command>)`. Never a wildcard, never
   `npx:*` or `npm:*`, never blanket shell access. ASC does not write to
   `~/.claude/settings.json` or any host config — granting the rule is the person's action,
   in their own interface.
5. Once it is granted, run **the same command again**, once. Then continue from where you
   were. If a later `actions[].portable` is blocked too, it gets its own exact rule by the
   same pattern.

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
npx --yes @asc-agent/bootstrap@0.2.1 setup apply --json
```

This is the canonical entry, and the only one you need to remember. `setup plan --json`
answers the same question without changing anything; `apply` is what carries out the plan,
and it carries out nothing that was not in it. `stdout` is a single JSON document,
everything else goes to `stderr`. It changes nothing and exits `1` when something is
genuinely left to decide — including the case in step 2.

**2 — a profile for this project.** If the plan comes back with
`code: "ASC_PROFILE_SELECTION_REQUIRED"`, the packaged profiles are examples and none of
them describes this project. Run the `adopt_profile` action's `portable` command:

```bash
asc profile adopt --json     # before install: npx --yes @asc-agent/bootstrap@0.2.1 profile adopt --json
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
- Retry a host-blocked command in a different shape, or ask for a permission rule wider
  than the one command that was blocked.
- Edit a host's settings or a shell profile to make something run. That is the person's
  interface, not yours.
