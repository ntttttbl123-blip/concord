# ADR-0001: One SQLite database per workspace

- **Status:** accepted (in effect since the first API commit)
- **Date recorded:** 2026-10-18

## Context

Concord's workspaces hold the most sensitive data the product sees: uploaded registers that
say who holds what. Workspaces belong to different organisations, and a tenant-isolation bug
here is not an embarrassment but a breach — `SECURITY.md` lists "reading or changing another
workspace's data" first among in-scope reports.

The classic design is one shared database where every row carries an `org_id` and every query
must remember to filter by it. That makes isolation a property of query discipline: hundreds of
statements, each one a place to forget the filter, and code review the only enforcement.

Concord is also deliberately small: one process on one disk (README, **Limits**, "Scale"), run
by an operator, not a fleet.

## Decision

Each workspace gets its own SQLite database file, `orgs/<orgId>.db` under `CONCORD_DATA_DIR`,
holding everything that workspace stores: assets, events, registers, journals, instructions,
runs, actions, notes (`ORG_MIGRATIONS`). Accounts, memberships, sessions and invitations live
apart in `control.db` (`CONTROL_MIGRATIONS`). Both schemas are in `services/api/src/schema.ts`;
the file layout is `fileStore` in `services/api/src/tenants.ts`.

A request is resolved to a workspace handle first (`Tenants.forOrg`), and every query the
request runs goes through that handle's connection. There is no `org_id` column and no tenant
filter, because there is nothing to filter: the connection can only see one workspace's file.
Isolation is by construction, not by discipline.

SQLite itself is `node:sqlite` (`DatabaseSync`, `services/api/src/db.ts`) in WAL mode with a
5-second busy timeout, so the CLI and the server can hold the same file; migrations are an
append-only list applied on open, with `PRAGMA user_version` as the count
(`docs/ARCHITECTURE.md`, **Data**).

## Alternatives considered

- **One shared database with an `org_id` column.** Standard, and makes cross-tenant queries
  (fleet metrics, billing) trivial. Rejected because the failure mode is the worst one Concord
  has: any single query that forgets the filter leaks one tenant's register to another. The
  cost of the chosen design — no cross-workspace SQL — buys the guarantee that matters most.
- **Postgres.** Brings row-level security (which enforces the filter in the server rather than
  in review), concurrent writers and managed hosting. Rejected for now because it adds a
  service to run, a connection to secure and an operations burden that contradicts
  "one process on one disk"; RLS policies are themselves code that can be wrong. Nothing in
  `packages/core` knows about SQLite, so this decision is confined to `services/api` and could
  be revisited at a scale that demands it (`docs/ROADMAP.md` tracks load testing).

## Consequences

- **One process.** SQLite has one writer per file; the design assumes a single API process
  owning `CONCORD_DATA_DIR`. No serverless or multi-instance deployment: the README's
  **Deploying** section says it plainly — one always-on instance with a local disk at `/data`
  (the Render free-plan blueprint runs without a persistent disk, as an ephemeral preview
  only).
- **Handle management.** The process holds an open handle per active workspace
  (`Tenants.open`, a map), opened on first use. Deleting a workspace closes the handle and
  removes the `.db` file along with its `-wal` and `-shm` siblings (`Tenants.drop`).
- **Backups are per file.** `concord backup DIR` copies `control.db` and every workspace file
  with SQLite's online backup API while the server runs (`services/api/src/cli.ts`). A backup
  of the data directory is a complete, restorable copy — and deserves the same protection as
  the live host (`docs/SECURITY-MODEL.md` once merged; `SECURITY.md` today).
- **No cross-workspace queries.** Anything fleet-wide (the sync pass, `Tenants.syncAll`)
  iterates workspaces and opens each in turn. That is a loop in code rather than a join in
  SQL, and it is the price of the isolation.
- **Schema changes multiply.** A migration to `ORG_MIGRATIONS` runs once per workspace file,
  on open. Migrations must therefore stay append-only and cheap.

## Links

- `services/api/src/tenants.ts` — `fileStore`, `Tenants`
- `services/api/src/db.ts` — `Db` over `node:sqlite`, WAL, migrations
- `services/api/src/schema.ts` — `CONTROL_MIGRATIONS`, `ORG_MIGRATIONS`
- `docs/ARCHITECTURE.md`, **Data** — the two kinds of database
- `SECURITY.md`, **In scope** — why isolation is the first-listed property
