# ASC — current operating model

The product model as shipped. `operating-model.md` is the frozen v5.1 design snapshot that
`OM §x` references point at; this file is what ASC does today, and the two are not the same
document on purpose.

```text
current model          this file
current implementation docs/status.md
current user flow      README.md
historical design      docs/design/operating-model.md  (v5.1, frozen)
```

---

## 1. What it is for, and what it does not claim

ASC is a control plane for agents doing real work: it holds who owns what, what a person
must decide, and how a decided action actually reaches the outside world.

The agent it is built for is **capable and fallible, not hostile**. That distinction sets
the whole boundary:

```text
ASC defends      scope drift · acting beyond the instruction · lost work or handoffs ·
                 writing to the wrong target · acting on facts that moved after a decision ·
                 in AUTO, going around the managed path with a raw write ·
                 calling a write successful when nobody read it back

ASC does not     a hostile process holding the same OS user, shell and filesystem.
                 It can edit ASC's state, answer its own inbox, remove the hook.
                 That needs a boundary ASC does not own — an OS or host trust boundary —
                 and simulating one with more internal state buys nothing while making
                 the normal path heavier.
```

Where a requirement crosses that line, the honest answer is *deferred to an external trust
boundary*, not another internal check.

## 2. The normal user flow

```text
"이거 작업해"      asc work start <WORK>
"지금 상황?"       asc work status   ·  asc status
"게시해"           asc work publish
"마무리해"         asc work finish
"수동/자동으로"     asc mode manual | asc mode auto
```

A person types work-shaped commands. They do not type `session issue`, `host bind`,
`grant issue` or `controller collect` on a healthy path — those still exist, under
`asc help --advanced`, for diagnosis and recovery.

The public surface is nine namespaces:

```text
setup · status · update · refresh · uninstall · mode · work · inbox · runtime
```

## 3. Work, Logical Session, physical Agent

```text
Work              what has to be done, named by the project's own tracker
Logical Session   a contract: goal, done-criteria, write boundary, owner, dependencies
Physical Agent    a process that holds a Logical Session for a while
```

**A Logical Session is not a physical agent.** One agent can hold a session across
restarts; a session outlives the process that started it; a physical run holding a session
is recorded as a binding, and losing the process does not lose the work.

Asking another part a question does not transfer ownership. The work stays with whoever
holds the contract until it is handed off.

## 4. Decision Authority and HITL

The question this axis answers: *is this decision a person's?*

```text
already decided   the user's instruction covers this action → it is decided
not decided       the action is wider than what was asked, or an authority boundary
                  is crossed → it goes to the inbox and waits for a person
```

**A decision already made is not asked for again.** "MR 올려" settles creating the merge
request; it does not settle merging it. Widening the action is what creates a new decision,
not repeating the old one in another layer.

The inbox is not a gate in front of every write. It is where a *new* human decision lives.

## 5. Execution Mode

The question this axis answers: *who carries out an approved act?*

```text
MANUAL   ASC manages work, sessions, decisions, review and audit.
         It does not route external writes through itself.
         The guard hard-blocks nothing; it leaves one advisory line.

AUTO     An ASC-managed agent runs on its own.
         Outward writes travel the managed path, and the guard blocks a raw bypass.
```

Three facts about mode, each one a rule the code keeps:

```text
Mode never decides what a person must decide, and a decision never decides the mode.
A workspace nobody chose for is not in AUTO — an absent record enforces nothing.
A mode record that cannot be read is not MANUAL either: raw external writes stay
blocked and the reason is named, because otherwise a stored AUTO would fall away
over one damaged file.
```

Turning AUTO on asks three questions — the ones only activation can answer:

```text
executor        does a managed write path assemble here
guard           is the guard actually installed
control-plane   do ASC's own commands still run in this host
```

Whether a *particular* action can go out is answered when that action is attempted.

Stepping back to MANUAL is one command. It is recorded in history with the name given and
shown in `asc status`. `--as` is attribution, not authentication: inside one shell no
internal ritual can prove who typed a command, so ASC makes the change visible instead of
pretending to prevent it.

## 6. DECIDE → CHECK → DO + VERIFY

Every outward action passes three stages, and no stage repeats another's question.

```text
DECIDE   the user's instruction, an existing decision, or the inbox when a new human
         decision is genuinely needed

CHECK    Binding + Remote Review — is the decided action executable against the outside
         world as it is right now: the target's identity, the source and remote commit,
         divergence, an already-open change, facts that could not be read.
         This is factual review. It is not a second approval.

DO       Grant → atomic claim → a narrow re-check of what can have moved → exactly one
         external mutation
VERIFY   read the result back from the provider and compare it with what was expected
```

Failure has meaning, and the meanings are kept apart:

```text
DRIFT           the ground the approval stood on moved — nothing went out
NOT_EXECUTABLE  the action does not hold as it stands — nothing went out
REJECTED        the outside refused — confirmed that nothing went out
UNCERTAIN       the outcome is unknown — never retried blindly
NOT_VERIFIED    it went out, and what came back is not what was expected
```

`UNCERTAIN` and `NOT_VERIFIED` end terminal, never as `EXECUTED`: a spent grant and a
verified result are different facts.

## 7. What each primitive owns

One primitive, one question. Anything answering two is a defect.

```text
Work / Session   who owns this, in what boundary, how far along
Decision Auth.   is a new human decision needed, and what is it
Binding          which provider and which resource this work is tied to
Remote Review    does the decided action hold against the outside world right now
Execution Mode   who carries out an approved act
Guard            is an AUTO-managed agent bypassing the managed path with a raw write
Grant            an immutable one-shot ticket for one already-decided action
Executor         perform that fixed action once
Verify           does the outside now show what was expected
```

Explicitly **not** the guard's business: approvals, controllers, mergeability, commit
semantics, branch policy, project conventions. It answers one question and knows nothing
about providers.

Explicitly **not** the grant's business: proving who a person is, or deciding anything.

## 8. Adaptive agent composition

```text
simple work                                   the agent already running does it
responsibility needs isolating                a new Logical Session
parallelism, permission isolation or an
independent verifier is materially better     a separate physical agent
otherwise                                     do not spawn anything
```

A role existing is not a reason for an agent. AUTO is not a reason for an executor agent.
Review is not a reason for a reviewer agent. Loading a project plugin is not a reason for a
project agent. Execution Mode decides the execution route, never the number of agents.

## 9. Project plugin boundary

```text
project layer   what has to be done, on which branch, in what order, by which convention
ASC             who owns it · what a person must decide · whether the chosen action is
                executable right now · execution · audit
provider/JAM    safe access to the outside system
```

ASC does not own a project's workflow. A canonical source is what judgement is *measured
against* — not a list of the only branches that may be written — so a part branch inside
the bound repository is not a binding mismatch. A target in a different repository is one,
and approving the action again does not clear it: the binding is the scope of managed
execution, and changing it is its own decision.

Project-specific vocabulary stays out of `core/`, and there are tests that keep it out.

## 10. Lifecycle, and what is deliberately not here

```text
setup       make the machine and this project usable for the first time
status      what is set up, what runs, what is blocked, what to do next
update      move to a newer published release, then let that build refresh its own integration
refresh     same version — re-converge only what this runtime installed
uninstall   remove the product; every byte of ASC_HOME stays. No purge command
runtime     which build this machine actually runs
```

JAM answers to the same six words. That is shared vocabulary, not a shared release train:
neither product updates the other, and neither pins the other's version.

Not goals:

```text
an agent, or a model router          ASC does not do the work
a task tracker                       it points at canonical sources, it does not copy them
a sync service                       runtime state does not follow you between machines
a security boundary against a
hostile same-user process            see §1
```
