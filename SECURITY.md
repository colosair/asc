# Security Policy

ASC sits on a boundary that matters: it controls what a coding agent is allowed to do,
holds the approval and execution gates, installs a guard hook into your Claude Code
configuration, and reads SCM credentials from your environment. A defect here can let an
agent write somewhere it should not, or can leak a token into a log.

Reports are welcome, including ones that turn out to be nothing.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes — the current line |
| < 0.1 | No — nothing was released before this |

ASC is pre-1.0. Fixes land on the current minor line; there is no long-term support
branch yet.

## Reporting a vulnerability

Open a report through **GitHub private vulnerability reporting** on this repository
(Security → Report a vulnerability). That keeps the details out of public view while it
is being fixed.

If private reporting is not available to you, open a normal issue that says only that you
have a security report and how to reach you — **do not put the details in it**. We will
find a private channel from there.

There is no dedicated security mailing address. This document will not invent one:
sending a report to an address nobody reads is worse than not sending it.

### Please do not include

- API tokens, passwords, session cookies, or any other credential — not even expired ones
- Private repository contents, or private Jira / GitLab / Mattermost data
- Customer or employer data of any kind
- Full paths that identify you or your organisation, when a redacted path would do

If reproducing the issue genuinely requires a credential, say so and we will work out how
to reproduce it without one.

### Please do include

- ASC version (`asc --help` prints the CLI; the package version is in `package.json`)
- Operating system and Node version (`node --version`)
- Which package: `@asc-agent/runtime` or `@asc-agent/bootstrap`
- Reproduction steps with sanitised data — a fake token like `ghp_EXAMPLE` is fine
- What you expected, and what happened instead

## What we consider a vulnerability

- An external write that reaches a real system without an approved execution grant
- The external-write guard failing to block a command in an ASC-managed session
- A credential appearing in a file ASC writes, in its output, or in a log
- ASC writing outside the boundaries it declares: a repository under local scope, a file
  outside a session's write boundary, or a user file the host installer does not own
- An install or update path that overwrites something a person edited without `--force`
- Anything that lets a plan apply a change it did not list

## What we do not consider a vulnerability

- A prerequisite being absent — for example `claude` not on `PATH`, or a missing token.
  ASC reports these as blocked, and that is the intended behaviour.
- An agent making a poor decision inside a boundary it was correctly granted. ASC bounds
  authority; it does not judge taste.
- Requiring a human decision. Stopping at a boundary is the product working.

## Scope

This policy covers the `@asc-agent/runtime` and `@asc-agent/bootstrap` packages and this
repository. It does not cover Claude Code, npm, or any SCM provider — report those to
their own maintainers.
