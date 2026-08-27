# ASC — product status

> What exists today, what is proven, and what is deliberately not claimed.
> This file is the **public single source of truth for product status**. It describes the
> product, not any project ASC has been pointed at.

Current release: **v0.2.0, team-ready distribution** — published to npm. v0.1.0 was
something one person could install; it could not be handed to a team, because the profile
that describes a real project had nowhere to live except inside the package, and an agent
given only the repository URL could not get past that. v0.2.0 is that gap closed: profiles
live in `$ASC_HOME/profiles/`, `asc profile adopt` makes one from the repository you are
in, and [AGENTS.md](../AGENTS.md) is the path from a URL to a running session.

In development on `main`: **v0.2.1.** Re-running the two-URL path on a real machine, the
host refused to execute the bootstrap command *before any ASC process started* — so ASC
could not report anything at all. This release is about what sits before ASC: one canonical
agent command, a named boundary for a host that will not run it, a deterministic answer
about Node, and the executionMode defect closed. Not published yet.

Nothing below is dated by a release — it says what is true now.

## What is implemented

```text
Local-first control plane   sessions, contracts, boundaries, and progress live in
                            user-owned storage; a repository ASC attaches to gets
                            zero footprint
Multi-agent orchestration   issue → start → checkpoint → handoff → reclaim, with
                            independent verification as a separate execution
Autonomy and escalation     proceed-by-default inside a declared boundary; escalation
                            only for predicates that qualify, with recorded evidence
Audit and provenance        every claim carries where it came from; stale claims are
                            corrected rather than silently overwritten
Observation                 provider-neutral monitoring through capability bindings —
                            GitHub, GitLab, and work-item adapters behind one port set
Distribution                a stable `asc` executable installed by npm at an exact
                            version, plus a zero-install bootstrap entry point
```

## What is proven, and how

Reports use four levels and do not blur them. The level names appear in the README as well.

```text
DOCUMENTED        written down, not executed
TEST_VERIFIED     an automated test or CI run asserts it
RUNTIME_OBSERVED  observed on a real machine, running the installed artifact
DOGFOOD_VERIFIED  a real multi-agent task went through it end to end
```

Current standing:

```text
3-OS CI (ubuntu · macOS · windows)          TEST_VERIFIED
Zero-base agent path — a repository URL,    RUNTIME_OBSERVED — `npx` the published
  no profile name, through adopt · attach     0.2.0 bootstrap into a machine with
  · READY · a started session                 nothing installed, against a project ASC
                                              had never seen; no human answered anything.
                                              Also TEST_VERIFIED on tarballs, in CI.
Real registry distribution — `npx` the      RUNTIME_OBSERVED
  published bootstrap into a zero state,
  it installs the exact runtime globally
Windows physical machine — npm global,      RUNTIME_OBSERVED
  `asc.cmd` resolution, new-process `asc`
Installed ASC with no network — local       RUNTIME_OBSERVED
  control-plane commands keep working
Multi-agent orchestration end to end        DOGFOOD_VERIFIED (development checkout)
```

## What is not claimed

```text
Distribution dogfood            NOT OBSERVED — a real multi-agent task driven by the
                                published package, not by a development checkout.
                                Installing cleanly is not the same as being used.
Approval routing over a real    WAITING_FOR_CREDENTIAL — implemented; the end-to-end
  messenger server (B-13)       run needs a server and credentials we do not have
Coverage health against a real  WAITING_FOR_CREDENTIAL — same shape: code complete,
  self-hosted GitLab (B-37)     evidence gated on access
```

Waiting for a credential is not the same as unfinished code. Neither is written down as
done.

## What the host observation found (0.2.1 candidate)

```text
Host denial is not about the   RUNTIME_OBSERVED. The canonical command was denied twice in
  command                      one session and allowed in another; substituting `--agent`
                               changed nothing. Whatever the automatic classifier is
                               reacting to, it is not a property of the command, and no
                               cause is claimed here.
Recovery that works            RUNTIME_OBSERVED. Adding an allow rule for the exact command
                               did NOT get it through — the same denial returned. Switching
                               the session's permission mode and approving the single run
                               did, and ASC then started and answered normally. AGENTS.md
                               carries that path and no other.
```

Tests cannot reach a host classifier and none was faked to look as though they can.

## Not yet observed on 0.2.1

```text
Published two-URL run        a tarball is not the registry. Whatever the candidate shows,
                             the onboarding claim is re-made against published 0.2.1.
```

## After v0.2.0

```text
executionMode under-reports  CLOSED in 0.2.1 (unreleased). The installed `asc` reported
                             `executionMode: "bootstrap"` and handed back `npx …` when
                             plain `asc …` would do. The entry point now decides it,
                             which is what `profile adopt` already did.
Public surface English II    the deep operational renderers (monitor, investigation,
                             digest, query, closure, preflight, resolver, entities) are
                             still Korean. The entry surface is English.
Distribution dogfood         a real multi-agent task driven by the published package.
                             Setting it up from a URL is now observed; being used for a
                             real task is not the same thing, and is still owed.
```

## Where the detail lives

Block-by-block development history, pilot transcripts, and real-project observations are
kept in a **private evidence repository**, together with the profiles of the projects ASC
was actually pointed at. That separation is deliberate: the product is public, the
observations of someone else's project are not.

This file carries the product-level answer. It is updated when the product changes, not
when a document does.
