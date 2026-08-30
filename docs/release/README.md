# Releasing ASC

**The canonical release path is remote.** Push a `v<version>` tag on a main
commit and `.github/workflows/release.yml` does the rest: re-runs the full gate
(typecheck, build, test, release:check, pack, smoke), publishes
`@asc-agent/runtime` then `@asc-agent/bootstrap` via npm Trusted Publishing
(OIDC — no local login, no long-lived token, no OTP), waits for the registry to
serve the new version, runs a published smoke, and creates the GitHub Release.

Prerequisite, once per package on npmjs.com: connect `colosair/asc` +
`release.yml` as the trusted publisher for `@asc-agent/runtime` and
`@asc-agent/bootstrap`.

The per-version checklists in this directory are the **manual emergency
fallback** (GitHub Actions or OIDC down) and the record of what each release
verified. `release:check` still requires a `v<version>-checklist.md` per
release — the checklist documents acceptance that no workflow can perform;
the workflow replaces only the mechanical publish/tag/Release steps.

Version consistency (manifests, docs pins, checklist) is enforced by
`npm run release:check`; tag ↔ manifest ↔ main consistency is enforced again
inside the workflow before anything publishes.
