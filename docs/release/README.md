# Releasing ASC

Two stages, two dispatches, one invariant:

**A tag is created only after acceptance passes against the published packages.**

A tag is a claim that the published artefacts work. npm versions are immutable,
so the order — publish, accept, then tag — is the only thing that keeps that
claim honest. The pipeline encodes the order instead of asking anyone to
remember it:

```text
release-prep PR (version bump + docs/releases/v<X.Y.Z>.md)
        ↓ merged to main
Stage 1  .github/workflows/release.yml        (workflow_dispatch: version)
         full gate → npm Trusted Publishing (OIDC) → registry verification
         → published smoke.  No tag. No Release.
        ↓
acceptance against the PUBLISHED packages     (human — see below)
        ↓
Stage 2  .github/workflows/release-finalize.yml (workflow_dispatch: version)
         verifies registry + release note → annotated tag `vX.Y.Z`
         → GitHub Release from docs/releases/v<X.Y.Z>.md
```

Both workflows take a `dry_run` input that runs every gate and changes nothing —
use it to exercise the pipeline before a real release.

Prerequisite, once per package on npmjs.com: connect `colosair/asc` +
`release.yml` as the trusted publisher for `@asc-agent/runtime` and
`@asc-agent/bootstrap`. The publish workflow's filename must therefore stay
`release.yml` — the connection is bound to it.

## Release prep

One `chore(release)` PR carrying, together:

- the lockstep version bump (manifests, `release.ts`, documented pins — 
  `npm run release:check` enforces the full list)
- `docs/releases/v<X.Y.Z>.md` — the Release body, authored, in English, with the
  mandatory sections (What changed / Install / Upgrade / Agent setup /
  Compatibility / Verified / Known limitations). `release:check` and the
  finalize workflow both refuse a release without it.
- `docs/release/v<X.Y.Z>-checklist.md` — the acceptance record and the manual
  emergency fallback.

## Acceptance between the stages

From the published packages, never a local build:

1. `npx --yes @asc-agent/bootstrap@<version> setup plan --json` answers from a
   zero state with machine-readable JSON.
2. The persistent path installs and `asc --version` prints the release version.
3. `asc host claude probe` finds the host and judges `external_write_guard`
   honestly on a machine that has one.
4. Whatever the release changed, exercised through the published artefact.

Record the run in the version's checklist. A measurement not taken is recorded
as not taken — never written up as a pass. Only then dispatch finalize.

## Failure recovery

- **Stage 1 gate fails** — nothing was published. Fix on a normal PR, bump if
  anything already went out, dispatch again.
- **Stage 1 publish succeeded but a later step failed** — the version is on the
  registry and immutable. Do not re-dispatch stage 1 with the same version (it
  refuses: the version-exists gate). Verify the registry state by hand, run
  acceptance, and continue with finalize as normal.
- **Acceptance fails** — do not finalize. The published version stays untagged
  (a version nobody is told to install), the fix goes out as the next patch.
- **Finalize fails** — nothing about npm changed. Fix and re-dispatch; the
  tag-exists gate makes it idempotent.

## Emergency fallback (GitHub Actions or OIDC down)

The per-version checklists in this directory carry the manual procedure:
publish runtime → bootstrap locally, verify the registry, run acceptance, then
create the annotated tag and the Release by hand — same order, same artefacts,
same note file.

## Release artefact conventions

| Artefact | Rule |
|---|---|
| Branch name | English, `<type>/<slug>` matching the commit type |
| PR title | English Conventional Commit — it becomes the squash subject |
| PR body | Korean allowed |
| main subject | the PR title, without a `(#N)` suffix where the tooling allows |
| Tag | annotated, `vX.Y.Z`, message first line `ASC vX.Y.Z` + one English sentence |
| Release title | `ASC vX.Y.Z` — what it is about belongs in the notes |
| Release body | `docs/releases/vX.Y.Z.md`, English, mandatory sections above |
| Version bump | its own `chore(release)` PR, never bundled into a feature PR |
| Historical repair | Release bodies may be corrected later from recorded evidence; tags, history and npm are never rewritten |

Existing lightweight tags (v0.3.0–v0.3.2) stay as they are — history is not
rewritten to satisfy a convention adopted later.
