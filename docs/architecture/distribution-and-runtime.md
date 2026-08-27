# Distribution and runtime

How ASC exists on a machine, and which build gets called.

This is the architecture note. The normative rules live in
[C-14](../contracts/C-14_distribution-runtime-entry.md); block status lives in
implementation-plan §2 (비공개 evidence 저장소). Where this document and C-14
disagree, C-14 wins.

## The governing rule

> Entry may branch. Runtime resolution may branch. Nothing past that point may.

A human typing `asc` and an agent calling `asc setup apply --agent` reach the same
planner. A packaged install and a development checkout reach the same core. If two
entry points need to behave differently, that difference belongs in a **plan**, never in
a second implementation.

Shapes that are forbidden, by name:

```text
HumanSetupService  vs  AgentSetupService
PackageAscCore     vs  DevelopmentAscCore
PackageOperator    vs  DevelopmentOperator
```

## Topology

```text
repository root         private workspace. Not a publish target — that is the point.
│
├── packages/runtime    the runtime: core, CLI, adapters, composition, schemas,
│                       profiles, presets. Provides `asc`. Ships compiled JS.
│
└── packages/bootstrap  zero-install first run. Holds no setup logic of its own.
                        Depends on runtime at an exact version and forwards.
```

Dependency direction is `bootstrap → runtime`, exact-pinned, never the reverse.

### Why there is no launcher package

JAM, the project this pattern came from, has a third package: a launcher. It exists
because a committed `.mcp.json` has to name a machine-independent executable that an
editor will spawn, and because an MCP server is a long-lived process for which a per-start
`npx` is acceptable.

ASC has neither property. Nothing committed names the ASC executable — host integration
writes a generated hook to an absolute path that is already machine-local. And
`asc proceed` is typed dozens of times a day: putting an indirection in front of every
local command would buy nothing and cost latency.

So runtime selection is a step **inside** the runtime's own bin, not a package. If
evidence appears that a launcher is needed, it can be added then.

## Why the artefact is compiled

Node refuses to strip TypeScript types under `node_modules`:

```text
ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
```

A package that ships `.ts` sources therefore cannot be installed and run — measured on
Node 22 and Node 26 alike. That single fact is why distribution waited for a build step.

The build uses `rewriteRelativeImportExtensions`, so the 543 `.ts` import specifiers in
the sources are untouched and the emitted JavaScript carries `.js`. Development still
runs the sources directly. **Distribution does not hold development hostage.**

`profiles/` and `presets/` are data, not code. `tsc` does not know about them, so the
build script copies them into `dist/` at the same relative position — which is why
`installRoot()` needed no change.

## The stable executable

The command a person types does not appear by magic:

```text
npx --yes @asc-agent/bootstrap@<exact> init
        ↓  ordinary setup: detect → plan → apply → verify
        ↓  the plan lists "install the runtime on this machine" as a change
        ↓  apply: npm install -g @asc-agent/runtime@<exact>
        ↓  npm owns the executable link (on Windows, npm's own asc.cmd)
        ↓  verify: the installed version, and that a NEW process can run it
bootstrap exits
        ↓
asc ...
```

Installation is a change **in the plan**. The bootstrap never installs behind anyone's
back, and it holds no setup policy of its own.

Exact versions only. No `@latest`, no major alias — an installer must never quietly run a
runtime nobody tested against it.

**ASC does not edit shell profiles or `PATH`, and does not write its own shim.** That is
npm's job. What ASC does instead is verify: if the package installed but `asc` is not
visible in this process, it says so rather than claiming success, because node version
managers move the global prefix around and a silent success there strands the user.

A user-owned installer under `$ASC_HOME/bin` was considered and **not adopted for v0.1** —
npm already manages prefixes, links and platform shims, and rebuilding that is writing a
second package manager. It reopens only if global-install failures turn out to be
*repeated*, not on the first one.

## Runtime resolution

```text
mode: package        the installed executable runs itself. No child process, no network.
mode: development    the installed bin runs a built checkout instead.
```

The selection lives in a machine-local file under `ASC_HOME`. It holds the selection and
nothing else: no credentials, no project keys, no workspace state. An unreadable
selection is treated as absent — interpreting half of it would call the wrong build.

A development source is validated before it is stored, in order: the path exists, it
contains a `package.json`, that manifest is `@asc-agent/runtime`, and the build output
is present. Rejecting here is far cheaper than a module-not-found later.

When the checkout is merely unbuilt, the remedy **names the checkout it applies to**.
`npm run build` on its own is dangerous advice: the directory someone is standing in is
usually the application they are working on, not the ASC checkout.

Two rules keep people from getting stuck:

- The runtime never re-dispatches to itself.
- `asc runtime status` and `asc runtime use` are never re-dispatched. A broken selection
  must not prevent the commands that inspect and fix it.

## Setup: detect → plan → apply → verify

```text
detect    a read-only snapshot of the world
plan      pure judgement — no network, no subprocess, no clock, no writes
apply     performs exactly the listed changes, and re-decides nothing
verify    detects again; an idempotent apply leaves an empty plan
```

The planner is pure so that "what would this command change?" can be answered without
changing anything. Facts about the world are observed by the caller and handed in.

Apply re-decides nothing. If it looked at the world again and changed its mind, the plan
a person approved and the thing that happened would differ — and at that moment the plan
guarantees nothing.

### Status codes

```text
ASC_PROFILE_SELECTION_REQUIRED       more than one candidate, or none; a person chooses
ASC_PROJECT_SCOPE_REQUIRES_CONSENT   putting state in a repository is the team's decision
ASC_HOST_INSTALL_MODIFIED            a person edited an ASC-owned file; --force is theirs to pass
```

These are stops, not failures. They mean a human boundary was reached — and an agent
receives exactly the same boundary. Guessing on a human's behalf is a decision, not a
detection.

## The agent surface

```text
stdout    one parseable JSON document. No ANSI. No prompts.
stderr    diagnostics.
```

Tests parse the whole of stdout, not a JSON-looking part of it — otherwise the contract
is not actually verified. Commands that setup calls internally were written to speak to
people; on the agent path their prose is routed to stderr.

### Invocation provenance

A short `asc setup apply` and a fresh-machine `npx --yes @asc-agent/bootstrap@<exact>
setup apply` are the same intent, but only one of them runs on a machine with nothing
installed. Confusing the two puts commands into documents and JSON that cannot execute.

So each action carries both:

```jsonc
{ "type": "apply_setup",
  "display":  "asc setup apply",
  "portable": "npx --yes @asc-agent/bootstrap@0.1.0 setup apply" }
```

**An agent runs `portable`.** A person reads `display`. `executionMode` says which world
the plan was computed in — `bootstrap` before the runtime exists, `installed-runtime`
after — and once it is `installed-runtime` the two strings are identical.

The same rule governs remediation: an action that says "build this" carries the path of
the thing to build, not a bare command that assumes a working directory.

## Offline

After installation, the local control plane does not need the network:

```text
front · proceed · session · progress · audit · report · escalate
· preflight · closure · query · freeze/thaw · host local checks
```

Remote provider capability is reported as degraded or unavailable — shown, never hidden.
Only bootstrap, install and update require the network.

## Install ownership

The host-installation rules are unchanged by distribution:

```text
ASC-owned          may be updated
user-modified      never overwritten without --force
unrelated files    untouched
other tools' hooks untouched
```

Updating the runtime leaves host artefacts behind; that surfaces as `INSTALLED_STALE`,
and the repair appears as a change in the plan rather than happening silently.

Removing the runtime and deleting your data are not the same command.

## Versions

Executable wiring uses exact versions. No `@latest`, no major alias.

Three axes are deliberately separate, even when the numbers currently match:

```text
package version         the executable
workspace/state schema  the user's stored state
host install payload    the installed artefacts (already judged by digest)
```

Keeping them separate avoids inventing migration coupling that does not exist.

Drift between the release constants, the manifests and the commands printed in
documentation is caught by `npm run release:check`. **It publishes nothing.** Publishing
stays a human decision; only the detection of drift is automated.

## Testing

```bash
npm run build       # compile + copy runtime assets
npm run pack:all    # apply the files allowlist for real
npm run smoke       # install the tarballs into a throwaway HOME, drive node_modules/.bin/asc
```

The smoke run clears `ASC_*` and provider credentials and overrides `HOME`,
`USERPROFILE`, `ASC_HOME`, the working directory and the npm cache. A real `~/.asc`, a
real `~/.claude`, or a real token would make a broken package look healthy. Running the
repository sources directly does not count as a package smoke.

## Done since this was written

```text
2026-08-27  npm publish                 v0.1.0 is on the registry, and installing it from
                                        there into a zero state was observed
2026-08-27  @asc-agent scope ownership  held; the packages publish under it
2026-08-27  repository visibility       public
2026-08-27  Windows fresh install       observed on a real machine — global install,
                                        `asc.cmd` resolution, a new process running `asc`
```

## Not done

```text
license                     still ISC
```
