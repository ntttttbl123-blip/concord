# Tenancy

How workspaces are isolated from one another, mechanism by mechanism, and how the test suite
proves it. Written for operators and security reviewers; the authoritative code is
`services/api/src/tenants.ts`, and the proof is `services/api/test/tenancy.test.ts`. The
architecture overview is [`ARCHITECTURE.md`](./ARCHITECTURE.md), **Data**.

## Two kinds of database

Everything lives under `CONCORD_DATA_DIR` (`services/api/src/config.ts`):

- **`control.db`** — users, workspaces, memberships, sessions, invitations
  (`CONTROL_MIGRATIONS` in `services/api/src/schema.ts`). It knows *that* a workspace exists
  and who belongs to it, never what the workspace stores.
- **`orgs/<orgId>.db`** — one file per workspace (`fileStore`,
  `services/api/src/tenants.ts`), holding everything that workspace stores: watched assets,
  indexed events, registers, journals, instructions, reconciliation runs, corporate actions,
  notes (`ORG_MIGRATIONS`).

A request authenticates against `control.db`, is resolved to one workspace handle, and every
query it runs goes through that handle's connection. There is no `org_id` column on workspace
data and no tenant filter to forget: the connection can only see one file.

## The org id, validated before it touches a path

A workspace id is 16 lowercase hex characters, generated server-side
(`newId = randomBytes(8).toString("hex")`, `services/api/src/security.ts`). `Tenants.forOrg`
re-validates it against `ORG_ID = /^[0-9a-f]{16}$/` before doing anything else, because the id
becomes part of a file name — anything else, including path fragments like `../x`, uppercase,
or a non-string, is answered `no such workspace` (`services/api/src/tenants.ts`). It then
checks the id is one the control records actually know (`known`), so an unused-but-well-formed
id is refused too, before any file is opened or created.

## The meta `org_id` check

Every workspace database records which workspace it belongs to: on first open, `forOrg` writes
the org id into the database's own `meta` table (`CREATE TABLE meta`, `ORG_MIGRATIONS`); on
every later open it reads the row back and refuses the handle — closing it and throwing
`the database for workspace X belongs to Y` — if the stored id is not the id it was opened
under (`services/api/src/tenants.ts`, `forOrg`). This catches the class of mistake file-level
isolation alone cannot: a file restored to the wrong name from backup, copied over another, or
a store bug handing back the wrong database. The wrong tenant's data is never served; the open
fails instead.

## `Tenants.forOrg`, the single gate

`forOrg` is the only way request handlers reach workspace data. In order it: validates the id
format, returns the cached open handle if there is one, refuses ids the control records do not
know, opens the file, runs the meta check above, and caches the `Concord` instance. The HTTP
layer resolves the session to its workspace and calls `forOrg(session.org.id)` — route
parameters never choose the file. Asset ids, run ids and action ids in URLs are looked up
*inside* the already-chosen workspace database, so another tenant's ids are simply absent
rows (404), not reachable objects.

## Deletion

Deleting a workspace (`DELETE /api/org`, which requires retyping the workspace name exactly —
`services/api/src/api.ts` — or `concord org-delete`, `services/api/src/cli.ts`) removes the
control records (`auth.deleteOrg`) and then `Tenants.drop` closes the open handle and deletes
the workspace's `.db` file together with its `-wal` and `-shm` siblings
(`fileStore.remove`, `services/api/src/tenants.ts`). The data is gone with the file; no other
workspace's file is touched, and the sole member's account goes with the workspace so the
email address is free again.

## How the tests prove it

`services/api/test/tenancy.test.ts`, `describe("workspace isolation")`, runs against a real
`Concord` with seeded books. Workspace A is filled with marker strings that exist nowhere else
(`MARKERS`: a holder id, a holder name, a sign-off note, journal and instruction refs, the org
name); workspace B is empty. Then:

- **Every workspace route, probed.** The suite enumerates the HTTP routes from the running
  app, requires a probe for each one — *a route added without a probe fails the suite, so a
  new endpoint cannot ship unexamined* — and calls each probe as workspace B using workspace
  A's real ids. No response may contain any marker, and probes naming A's asset, run or action
  ids must answer 404. Workspace A is then re-read to prove it is exactly as seeded.
- **No session, no route.** Every probe repeated anonymously must answer 401.
- **Same asset, separate books.** Two workspaces watch the same on-chain contract; each gets
  its own asset row, holdings cut to its own baseline, its own run numbering, and exports with
  different hashes — B's export must not contain A's markers.
- **Id discipline.** `forOrg` refuses `../x`, `..%2Fx`, the empty string, uppercase hex,
  well-formed-but-unknown ids, and a non-string.
- **The meta check.** Two `Tenants` handed the *same* underlying database under different org
  ids: the second open must throw `belongs to <first id>`.
- **Deletion.** Deleting workspace A (with the exact-name confirmation enforced) removes
  exactly A's store, kills A's sessions, frees A's email, and leaves B answering normally.

The suite needs no network: the chain is a `FakeChain` and the stores are in memory
(`services/api/test/helpers.ts`). The seeded holder data is invented for the test
(`ALPHA-HOLDER-7`, `Northgate Secret Trust`); no real holder data appears there or here.

## What tenancy does not cover

Isolation is between workspaces through the product's surfaces. Anyone with the server's disk
reads every file (`SECURITY.md`, out of scope); members of the *same* workspace see that
workspace's data by design, with owner/member roles as the only distinction (README,
**Accounts and workspaces**).
