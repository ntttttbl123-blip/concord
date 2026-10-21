# Versioning and compatibility

This page is for operators who run Concord and for integrators who exchange files with it. It
covers what a version number promises, what counts as a breaking change, how long a deprecated
feature keeps working, and how database migrations fit in.

Each section first says what the code does today, with file references, and then the policy that
applies from the first tagged release.

## Where things stand

- **Every package is version `0.1.0`.** That covers the root project, `packages/core`,
  `services/api` and `apps/web` (their `package.json` files).
- **Nothing has been released.** There are no tagged releases, and only the latest commit on
  `main` is supported ([`SECURITY.md`](../SECURITY.md)).
- **One version string is written into output.** The audit pack names its producer as
  `"generator": "concord/0.1.0"`, a string written in `services/api/src/concord.ts`
  (`auditExport`). It is not read from `package.json`, so it has to be updated by hand at release
  time.

Until the first tag, any commit on `main` may change any surface described below. From the first
tag on, the rules in this page apply.

## What a version number means

Concord is an application, not a library, so its version describes the surfaces that people and
systems outside the code depend on. A version is `MAJOR.MINOR.PATCH`, as in
[Semantic Versioning](https://semver.org/):

- **PATCH:** fixes only. Nothing an operator or integrator relies on changes.
- **MINOR:** additions that existing users can ignore, plus deprecations, which are announced but
  keep working.
- **MAJOR:** a breaking change to any surface below, including removal of something deprecated.

**While the version is `0.x`,** SemVer allows anything to change. Concord narrows that: a breaking
change raises the **minor** number (`0.1` to `0.2`), and a patch release is never breaking. `1.0.0`
will be cut once the surfaces below have held still for a while; from then on, breaking means
major.

One version covers the whole repository. The packages are not versioned separately: the API, the
dashboard and `packages/core` ship together, as one Docker image.

## The surfaces

### Input files: register, journal, instructions

These are the CSV files people upload or pass to `pnpm concord`. The README lists their columns.
Today:

- **Headers are normalised.** Header names are trimmed and lower-cased, and spaces and hyphens
  become `_`, so `Holder ID` reads as `holder_id` (`parseCsvTable` in
  `packages/core/src/csv.ts`).
- **Register columns accept aliases.** For example, `balance`, `shares`, `quantity` and `holding`
  all mean `units` (`ALIASES` in `packages/core/src/register.ts`). The journal accepts aliases for
  the type value, such as `mint` for `issue` (`TYPE_ALIASES` in `packages/core/src/movements.ts`).
- **Missing required columns reject the file:**
  - register: `holder_id` and `units`
  - journal: `ref`, `date`, `type` and `units`
  - instructions: `ref`, `type`, `account` and `issued_at`
- **Unknown columns are ignored.**
- **Bad rows don't stop the import.** A row that cannot be read is reported with its line number,
  and the rest of the file loads.
- **Amounts never lose precision.** Amounts with more precision than the asset carries are
  rejected, not rounded.

**Breaking:**

- making an optional column required
- removing a column name, an alias or an accepted value (a status word, a journal type, an
  instruction type)
- changing what a column or value means
- rejecting a file or row that used to load
- changing how amounts or dates are parsed

**Not breaking:**

- a new optional column
- a new alias or accepted value
- accepting a file or row that used to be rejected
- clearer error messages

A file that imports today keeps importing, with the same meaning, until the next major version.

### Output: audit pack and CSV export

The audit pack is the JSON returned by `GET /api/assets/:id/export` and the dashboard's export
button. The four CSV sections are `holdings`, `events`, `controls` and `breaks`, requested as
`?section=…` on the same route (`exportCsv` in `services/api/src/concord.ts`). Today:

- **The pack's top-level fields are:**
  - `generatedAt`, `generator` and `sha256`
  - then `asset`, `period`, `holdings`, `reconciliations`, `corporateActions`, `controls` and
    `events`
- **The pack has no schema version field.** `generator` is the only version marker.
- **`sha256` covers the content, in order.** It is the SHA-256 of `JSON.stringify` of everything
  except `generatedAt`, `generator` and `sha256`, in the order the fields appear. To verify a
  pack, rebuild that object in the same field order and hash it. That is why field order is part
  of the format.
- **Each CSV section has fixed columns.** Every section writes a header row with its columns in a
  fixed order (`toCsv` in `packages/core/src/csv.ts`).

**Breaking:**

- removing or renaming a field or CSV column
- changing a field's type or meaning, or the units an amount is expressed in
- reordering pack fields or CSV columns
- changing how `sha256` is computed

Auditors and scripts may hold packs for years, so these changes need the strictest care.

**Not breaking:**

- adding a pack field at the end of an object
- adding a CSV column at the end of a section
- adding a new section or break type

A consumer should ignore fields and columns it does not know, and match CSV columns by header,
not by position.

When the pack's format first changes, it will gain a `schemaVersion` field, so a pack states its
own format without relying on `generator`.

### The HTTP API

Today the API serves the dashboard, not third parties:

- **It is unversioned.** Every route is under `/api/` with no version segment
  (`services/api/src/api.ts`, `auth-api.ts`).
- **It needs a browser session.** A request authenticates with the session cookie, and there is
  no API token: `CONCORD_API_TOKEN` is retired and refused at start-up
  (`services/api/src/config.ts`).
- **Writes need the dashboard's origin.** Any request that changes something must carry
  `Sec-Fetch-Site: same-origin`, or an `Origin` equal to `CONCORD_PUBLIC_URL`.

So the API is **not a stable interface**, and a minor release may change any route. The only
exception is `GET /api/health`, which health checks depend on (`Dockerfile`, `render.yaml`):
- it stays at that path
- it answers `200` while the service can read its control database

The export route is stable only as the carrier of the audit pack and CSV sections above.

If a public API is added, it gets a version segment, such as `/api/v1/`, and its own entry in
this page.

### The command line

`pnpm concord` is the supported way to script Concord. Its commands, options and exit status
follow the rules for input files:
- removing or renaming a command or option, or changing what one does, is breaking
- adding one is not

`--json` output follows the rules for the audit pack: fields may be added, not removed or
renamed. Plain-text output is for people and may change in any release.

### Configuration

The environment variables read in `services/api/src/config.ts`, and listed in
[`.env.example`](../.env.example), follow the same rules.

- **Breaking:** removing or renaming a variable, changing its default in a way that changes
  behaviour, or narrowing the values it accepts.
- **Removal is never silent.** A removed variable moves to `RETIRED` in
  `services/api/src/config.ts`, so setting it stops start-up with a message naming the
  replacement. Five variables have already been retired this way.

### The database

The data directory holds `control.db` and one database per workspace under `orgs/`. Its tables
are not an interface: read Concord's data through the CLI, the export or a backup, not by
querying the files. Compatibility is defined by what a build does when it opens a data directory.
See the next section.

## Migrations

Today (`services/api/src/db.ts`, `services/api/src/schema.ts`):

- **Two schemas, two lists.** Each schema is an ordered list of SQL migrations: `ORG_MIGRATIONS`
  for workspace databases, `CONTROL_MIGRATIONS` for `control.db`. Each list has one entry today.
- **`user_version` records progress.** A database's `PRAGMA user_version` is the number of
  entries applied.
- **Opening a database brings it up to date.** Every pending migration runs whenever the server
  or any `pnpm concord` command opens it. Each migration runs in its own transaction, which rolls
  back if the migration fails or leaves a dangling foreign key.
- **A newer database is refused.** A database ahead of the build is refused with
  `… is at schema N; this build only knows M`. A database that has tables but no
  `user_version` is refused as predating versioning.
- **Lists are append-only.** New migrations go at the end, and a shipped entry is never edited
  ([`CONTRIBUTING.md`](../CONTRIBUTING.md)). Editing one would leave databases that ran the old
  text out of step with new ones, at the same `user_version`.

What this means for releases:

- **Upgrading is automatic and one-way.** Starting a newer build migrates the data directory in
  place. There are no down migrations.
- **Downgrading means restoring a backup.** After an upgrade has run a migration, an older build
  refuses the data. To go back, restore the backup taken before the upgrade. Take one with
  `pnpm concord backup DIR` before every upgrade.
- **A schema change alone is not breaking,** because the upgrade is automatic. It doesn't need a
  major version.
- **What makes a migration breaking:**
  - it changes what an existing record means, or discards data
  - it can't run unattended, for example because it needs a decision from the operator
  - it would take long enough on a large data directory that operators must plan downtime

  Any of these makes it a major change, and the release notes say so.
- **Migrations are additive.** Columns are added and tables rebuilt in place, rather than
  removing what a previous release wrote.
- **Rolling deployments are not supported.** Concord runs as a single process. Two builds at
  different schema versions must never share a data directory: the older one stops at its next
  start, and the CLI and the server must be the same build.

## Deprecation

When something on the surfaces above is to be removed or changed incompatibly, it is deprecated
first:

1. **Announce it in a minor release.** The release notes name what is deprecated, what replaces
   it, and the release it will be removed in. Where Concord can detect use of it, the server or
   CLI prints a warning when it is used.
2. **Keep it working for at least one minor release, and at least 90 days,** whichever is
   longer. After `1.0.0`, removal waits for the next major version.
3. **Remove it, loudly.** A removed setting goes to `RETIRED`, so it stops start-up rather than
   being ignored. A removed input column or value produces an error that says what to use
   instead.

Security fixes are the exception. If keeping something would leave users exposed, it may change
in a patch release, and the release notes explain why.

## Release notes

Each tagged release lists, under separate headings:
- breaking changes
- deprecations
- schema migrations it runs
- everything else

An operator should be able to read only the first three before upgrading.
