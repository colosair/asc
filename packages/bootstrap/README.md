# @asc-agent/bootstrap

Zero-install first run for ASC (Agent Session Control).

```bash
npx --yes @asc-agent/bootstrap@0.3.1 init
```

**This package holds no setup logic of its own.** It depends on `@asc-agent/runtime` at an
exact version and forwards to the same commands the installed `asc` runs. A decision made
here would be a second implementation to keep in sync.

What it does is run ASC's ordinary setup — detect, plan, apply, verify — where the plan
includes installing the runtime globally at that exact version. After it verifies the
install in a new process, `asc` is the stable command and this package has no further job.

For a coding agent on a fresh machine:

```bash
npx --yes @asc-agent/bootstrap@0.3.1 setup apply --json
```

`stdout` is a single JSON document. Run `actions[].portable`, not `display` — they differ
exactly while the runtime is not yet installed.

The full runbook — the ordered path and the decisions already made — is `AGENTS.md` in the
[repository](https://github.com/colosair/asc).

See the [repository README](https://github.com/colosair/asc#readme).
