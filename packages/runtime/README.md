# @asc-agent/runtime

The ASC (Agent Session Control) runtime: core, CLI, and adapters.

This package provides the `asc` command. Everything ASC decides — sessions, checkpoints,
proceed-by-default, escalation, audit, the external-write guard, host integration — lives
here.

```bash
npm install -g @asc-agent/runtime@0.1.0
```

npm owns the executable link (on Windows, npm's own `asc.cmd`). This package never edits
your shell profile or `PATH`.

Once installed, `asc` works offline: the local control-plane commands do not require
network access. Only bootstrap, install and update do.

On a machine with nothing installed yet, start from
[`@asc-agent/bootstrap`](https://www.npmjs.com/package/@asc-agent/bootstrap) instead.

Driving this from a coding agent? The runbook is `AGENTS.md` in the
[repository](https://github.com/colosair/asc).

See the [repository README](https://github.com/colosair/asc#readme).
