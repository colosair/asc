# Setting ASC up for a team

Two situations: someone joining who has never run ASC, and someone who already ran v0.1.0
and is moving to a newer runtime. Both are short.

## A new person, from nothing

Prerequisite: **Node 24 or newer** (`node --version`). Nothing else.

```bash
# 1. first run — installs the runtime on this machine
npx --yes @asc-agent/bootstrap@0.2.0 init

# 2. your team's profile, in your own directory
mkdir -p ~/.asc/profiles/<profile-id>
cp <the file your team shared> ~/.asc/profiles/<profile-id>/profile.json
#    — no profile to share yet? make one from the repository instead:
#      cd <your project> && asc profile adopt

# 3. attach the project you actually work in
cd <your project>
asc setup plan --profile <profile-id>     # shows what would change; changes nothing
asc setup apply --profile <profile-id>

# 4. see where you stand
asc setup status
asc front
```

Step 1 leaves a normal `asc` command on the machine — installed by npm at an exact version,
not re-downloaded per call. Open a new shell and `asc` is simply there.

Step 3 leaves **nothing in the repository**. ASC's state lives in `$ASC_HOME`
(default `~/.asc`), so a project stays clean whether or not its team uses ASC.

`asc setup status` is the honest summary: what works right now, what is still closed, and
why. It also names the profile in use and whether it came from your own directory or from
the package.

### What a teammate has to hand you

Only the profile file, and only if the team has one yet. The first person does not need
anyone to hand them anything: `asc profile adopt` writes a starting profile from the
repository's own remote, and the team fills in canonical branches and role boundaries as
it agrees on them ([docs/profiles.md](profiles.md)). Whoever does that shares the file. Nothing about ASC needs a shared
server, an account, or a token. Adapters that talk to GitHub, GitLab or a messenger read
credentials from your environment when you enable them — the profile never carries them.

## Moving from an older runtime

The state ASC keeps is yours and it is not rewritten on upgrade:

```bash
npm install -g @asc-agent/runtime@<new version>
asc setup status
```

An attached workspace stays attached, the profile digest does not move because it is
computed from the profile's contents rather than its path, and sessions that were open
stay open. If something really did change, ASC says so and stops rather than fixing your
state behind your back — re-locking is a command you run, not something that happens while
you are looking away.

The bootstrap path (`npx --yes @asc-agent/bootstrap@<version> init`) reaches the same place
and is the one to use when a machine has no runtime yet.

## Two things worth agreeing on early

**Where the profile file lives for your team.** A private repository or wherever the team
already keeps configuration. There is no registry, and ASC does not fetch profiles for you
— it reads the one you placed.

**Who approves what.** ASC will let sessions run inside their declared boundary without
asking, and stop at the boundary you declared. That is a policy decision, and it belongs in
the profile before people start using it, not after.
