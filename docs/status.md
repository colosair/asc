# ASC — product status

> What exists today, what is proven, and what is deliberately not claimed.
> This file is the **public single source of truth for product status**. It describes the
> product, not any project ASC has been pointed at.

Which version is current is not written here. The published packages and the latest
GitHub Release answer that, and they answer it without anyone remembering to edit a
document. This file answers a different question: what the product does, what has actually
been proven, and what is deliberately not claimed.

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
Workspace continuity        a logical workspace is not a path; linked checkouts of the
                            same repository resolve to it, while independent clones of
                            the same remote stay separate
Persistent observation      one user-scope runtime per machine, registered with the OS,
                            observes every attached workspace without a conversation or
                            terminal being open
Host front binding          opening a supported host in an attached directory restores
                            what is already pending there, and creates nothing
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
Zero-base setup path — a repository URL,    RUNTIME_OBSERVED — `npx` the published
  no profile name, through adopt · attach     bootstrap into a machine with nothing
  · attachment READY                          installed, against a project ASC had never
                                              seen. Every command after the first came
                                              from the previous command's JSON, unedited.
                                              Driven by a person following the runbook.
                                              Also TEST_VERIFIED on tarballs, in CI.
Two-URL run under a coding agent            NOT PASSED as pure auto mode. The agent found
  in automatic mode                           the right path on its own and classified the
                                              refusal correctly, but Claude Code's
                                              automatic mode blocked ASC before the
                                              process started, and a person had to switch
                                              the permission mode before it could
                                              continue. Recognising the boundary and
                                              recovering through it is RUNTIME_OBSERVED;
                                              completing without a human is not.
Node below the supported floor stops        RUNTIME_OBSERVED — the published artifact on
  instead of half-working                     Node 22 answers NODE_RUNTIME_REQUIRED and
                                              names the newer Node already installed.
The installed `asc` knows it is installed   RUNTIME_OBSERVED — `executionMode:
                                              installed-runtime`, portables are `asc …`
                                              and need no network. A registry run found
                                              this defect and it is closed.
Real registry distribution — `npx` the      RUNTIME_OBSERVED
  published bootstrap into a zero state,
  it installs the exact runtime globally
Windows physical machine — npm global,      RUNTIME_OBSERVED
  `asc.cmd` resolution, new-process `asc`
Installed ASC with no network — local       RUNTIME_OBSERVED
  control-plane commands keep working
Multi-agent orchestration end to end        DOGFOOD_VERIFIED (development checkout)
Linked-worktree continuity                  DOGFOOD_VERIFIED — a worktree created and
                                              never registered resolved to its workspace
                                              and registered itself; an independent clone
                                              of an already-registered remote resolved to
                                              nothing and was not registered.
Host first-open restore                     DOGFOOD_VERIFIED — a host hook run in that
                                              unregistered worktree, with no prior ASC
                                              command, restored the real pending state.
Two observation channels at once            DOGFOOD_VERIFIED — a project declaring both a
                                              code binding and a work binding observed
                                              both in one pass, and a repeated pass over
                                              unchanged external state produced no new
                                              reports, across a process restart.
Machine-level persistent runtime            RUNTIME_OBSERVED (macOS) — registered with the
                                              OS, loaded by it, a pass run and exited
                                              cleanly, with no user action.
```

## What is not claimed

```text
Distribution dogfood            NOT OBSERVED — a real multi-agent task driven by the
                                published package, not by a development checkout.
                                Installing cleanly is not the same as being used.
Pure auto-mode Two-URL          NOT OBSERVED — see above. The one run that reached READY
                                needed a person to change the host's permission mode
                                first, so it does not demonstrate this and is not
                                recorded as though it does.
True zero-base JAM              NOT OBSERVED — JAM reached ready in the same run, but on
                                a machine that already carried JAM state. A fresh-state
                                run is a different claim.
Approval routing over a real    WAITING_FOR_CREDENTIAL — implemented; the end-to-end
  messenger server (B-13)       run needs a server and credentials we do not have
Windows and Linux machine       NOT OBSERVED — both adapters are fixed by contract
  runtime registration          tests only. Neither has been run on a live machine.
Reboot and login recovery       NOT OBSERVED — the macOS registration runs at load, which
                                is that path, but no reboot has been performed.
Credentials under a service-    NOT OBSERVED — whether provider credentials resolve the
  started process               same way when the OS starts the process, rather than a
                                shell, has not been measured.
A second host adapter           NOT OBSERVED — host neutrality is fixed structurally: core
                                imports no adapter and branches on no host id. Only one
                                host has been driven.
```

Waiting for a credential is not the same as unfinished code. Neither is written down as
done.

## What the host observation found

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

## Still owed

```text
Host classifier, published   the classifier observation above was made against a
                             candidate build. It has not been repeated against a
                             published package, and a thing not observed is not written
                             down as observed. Nothing in that finding depends on which
                             build it was, but the sentence stays honest.
Public surface English II    the deep operational renderers (monitor, investigation,
                             digest, query, closure, preflight, resolver, entities) are
                             still Korean. The entry surface is English.
Distribution dogfood         a real multi-agent task driven by the published package.
                             Setting it up from a URL is observed; being used for a real
                             task is not the same thing, and is still owed.
```

## Where the detail lives

Block-by-block development history, pilot transcripts, and real-project observations are
kept in a **private evidence repository**, together with the profiles of the projects ASC
was actually pointed at. That separation is deliberate: the product is public, the
observations of someone else's project are not.

This file carries the product-level answer. It is updated when the product changes, not
when a document does.
