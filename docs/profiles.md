# Profiles — bringing your own

A Profile is what tells ASC about *your* project: which repository, which branches hold the
canonical spec, which role may write where, which labels are urgent. It is data, not code.

ASC ships two example profiles inside the package (`pilot-local`, `example-team`). They
exist to show the shape. **They are not meant to govern a real project** — the layout of
your repository, your role boundaries and your canonical branches are yours, and we do not
put anyone's real project settings in a public package.

So you keep your own profile in your own directory.

## Where it goes

```text
$ASC_HOME/profiles/<profile-id>/profile.json      default: ~/.asc/profiles/…
```

That is a user-owned location: not inside the repository ASC is attached to, and not
inside the installed package. Attaching ASC to a project still leaves the repository
untouched.

## Making one from the repository you are in

```bash
asc profile adopt          # or: asc profile adopt --id <name>
asc setup apply --profile <id>
```

`adopt` reads the repository's git remote and writes a profile there. **It records only
what the remote proves** — the project's identity. Canonical branches, role boundaries and
policy stay empty, and the `warnings` in its output say so.

That restraint is the point. A canonical source you did not declare would make session
issue try to read a baseline it has no credential for; a role boundary you did not choose
would stop you with a scope error you never agreed to. An adopted profile is a starting
point the team grows — the file says the same thing in its own comments.

It refuses to overwrite. If a profile of that name already exists, adopt stops and names
the file, so nobody's policy is replaced by a generated one.

## Placing one you were given

```bash
mkdir -p ~/.asc/profiles/my-team
cp path/to/profile.json ~/.asc/profiles/my-team/profile.json

asc setup plan --profile my-team     # what would change; nothing is applied
asc setup apply --profile my-team
asc setup status                     # says which profile is in use, and where it came from
```

`asc setup status` prints a line like:

```text
profile: my-team — your own profile directory
```

or, when a bundled example is in use:

```text
profile: pilot-local — bundled with the installed package
```

That distinction is worth reading. Running a real project on a bundled example is
something you want to notice early, not after a session has been governed by the wrong
policy.

## Which profile wins

```text
1. the id you name        asc setup apply --profile <id>
2. your own directory     $ASC_HOME/profiles/<id>/profile.json
3. the installed package  the bundled examples
```

**If the same id exists in both your directory and the package, ASC stops** and names both
files. It does not pick one for you: which policy applies must not depend on lookup order.
Rename one of them and run the command again.

## What a profile may not do

A profile is read as data, validated against the schema, and hashed. It cannot run
anything — no scripts, no hooks, no commands. A profile id is a single directory name:
path fragments (`../secrets`, `team/a`) are refused, and a file outside the profiles
directory cannot be reached by naming it.

## Moving a profile does not break an existing attachment

The profile digest recorded in `profile.lock` is computed from the profile's *contents*.
Moving the same profile from the package into your own directory — or between machines —
keeps the same digest, so an attached workspace keeps working. Changing what the profile
says is a different matter, and that is exactly when ASC stops to tell you.

## Sharing one with a team

There is no profile registry, and v0.2 does not add one. In practice a team keeps the file
wherever it keeps its private configuration — a private repository, a shared drive, a
password-manager attachment for the ones that carry endpoints — and each person drops it
into `$ASC_HOME/profiles/`. Credentials never belong in a profile: they live in your
environment or your credential store, and ASC reads whether a credential exists, not its
value.
