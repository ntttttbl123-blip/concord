# Data directory

For operators. Everything Concord stores is a SQLite file under one directory,
`CONCORD_DATA_DIR`. This page says what is in it, who may read it, how it grows, and what is
safe to delete. File references are to the current code.

## Where it is

| Setting | Value |
|---|---|
| `CONCORD_DATA_DIR` | Unset: `data/` at the repository root (`services/api/src/config.ts`). The Docker image sets it to `/data` (`Dockerfile`). |

The path is resolved with `path.resolve`, so a relative `CONCORD_DATA_DIR` is relative to the
process's working directory. The `pnpm` scripts run inside `services/api`, so a relative path
resolves from there rather than from where you typed the command; use an absolute path. If the server and the command
line see different values, they use different data without any error: each simply creates its
own empty set of files.

The directory must be on a local disk. SQLite's write-ahead log does not work over NFS
(`.env.example`).

## Layout

```
$CONCORD_DATA_DIR/
├── control.db            accounts, workspaces, memberships, sessions, invitations, one-time tokens
├── control.db-wal        (while open) write-ahead log
├── control.db-shm        (while open) shared-memory index
├── orgs/
│   ├── <16 hex>.db       one workspace
│   ├── <16 hex>.db-wal
│   └── <16 hex>.db-shm
└── demo/                 only if you ran `pnpm demo:testnet`
    ├── register.csv
    ├── journal.csv
    └── instructions.csv
```

Created by `Db` (`services/api/src/db.ts`), which makes the directory if it does not exist.
Nothing else is written under it: Concord does not store uploaded CSV files, only what it parsed
from them (the tables are in `services/api/src/schema.ts`).

### `control.db`

One per installation. Holds users, their credentials (a password hash, or a Google subject
identifier), workspaces, memberships, sessions, invitations and the one-time sign-up and
password-reset tokens (`CONTROL_MIGRATIONS` in `services/api/src/schema.ts`). Tokens and
session identifiers are stored as hashes, not as the values handed to people.

### `orgs/<16 hex>.db`

One per workspace. The name is the workspace's id: sixteen lowercase hexadecimal characters
(`newId` in `services/api/src/security.ts`). `concord orgs` lists the ids. The file holds the
workspace's watched assets, indexed events, opening balances, uploaded registers, journal,
instructions, reconciliation runs, corporate actions and break notes (`ORG_MIGRATIONS`).

- Concord opens a workspace file only for an id that is in `control.db`
  (`Tenants.forOrg`, `services/api/src/tenants.ts`). A file with no matching workspace is never
  opened, and is not copied by `backup`.
- Each file records the workspace id it belongs to in its `meta` table. Renaming or copying a
  file to another workspace's id makes Concord refuse to open it:
  `the database for workspace X belongs to Y`.

### `-wal` and `-shm`

Every database is opened in write-ahead-log mode (`PRAGMA journal_mode = WAL`). While a
database is open, SQLite keeps `<name>-wal` and `<name>-shm` beside it. The `-wal` file can hold
committed changes not yet written back to the main file. Both are normally removed when the last
connection closes cleanly.

The server and the command line may open the same files at once; a writer waits up to five
seconds for another (`busy_timeout = 5000`).

### `demo/`

Written by `pnpm demo:testnet` (`services/api/src/demo/testnet.ts`): a register, journal and
instruction file that disagree with a practice asset on Stellar testnet in known ways. It is
development material. Concord never reads this directory; you upload the files by hand. The
script writes only these three files and never opens a Concord database.

### The legacy `concord.db`

Before workspaces, the database was a single file named by the `CONCORD_DB` setting. That
setting is retired, and Concord refuses to start while it is set:
`CONCORD_DB is no longer read: use CONCORD_DATA_DIR; each workspace has its own database under it`
(`RETIRED` in `services/api/src/config.ts`). I could find nothing in the current code that opens
or writes a file called `concord.db`.

- Concord does not migrate it. A database from before schema versioning is rejected at open with
  `... predates schema versioning and cannot be upgraded; move it aside` (`Db.migrate`).
- If you still have one, it is no longer part of the running system. Keep it until you have
  confirmed nothing you need is only in it (it may be the only copy of books uploaded in the old
  layout), then delete it. Concord will not notice either way.

## Permissions

Concord sets no file modes or umask of its own. New files get whatever the process's umask gives
them, and the directory needs to be writable by that user, because SQLite creates `-wal` and
`-shm` files beside the database.

What is in the files decides how to protect them:

- `control.db`: email addresses, names, password hashes (scrypt), session and token hashes.
- `orgs/*.db`: holder identifiers and names, Stellar addresses and unit counts from uploaded
  registers, and the names recorded against sign-offs.

A reasonable setup, which is a recommendation and not something Concord enforces: run the server
as its own unprivileged user, make that user the owner of the directory, and remove access for
everyone else (for example mode `0700` on the directory). The Docker image runs as the `node`
user and makes `/data` owned by it (`Dockerfile`).

## Disk sizing

The code contains no size limit, and I have no measured figures to give, so size it by looking at
what grows, and measure your own deployment with `du -sh $CONCORD_DATA_DIR`.

What grows (see the tables in `services/api/src/schema.ts`):

| Where | Grows with | Shrinks when |
|---|---|---|
| `events` | One row per on-chain event of each watched asset, kept indefinitely. | The asset is unwatched, or rebuilt (which deletes its events and re-reads history). |
| `openings` | One row per holder of a classic asset at the opening ledger. | Same as above. |
| `registers` and `register_positions` | One register per `register` import, with one row per holder. Importing the same file twice stores it twice. | A register is deleted (in the dashboard), or the asset is unwatched. |
| `runs` | One run per reconciliation. Each stores its full result as JSON, including a line for every compared position. | Its register is deleted, or the asset is unwatched. |
| `actions` | One row per corporate action; once reconciled it stores a snapshot of every holder at the record time and the result. | The asset is unwatched. |
| `journal`, `instructions` | One row per `ref`; re-importing an existing `ref` replaces it. | The asset is unwatched. |
| `control.db` | Users, workspaces, sessions, invitations and tokens. I found no routine that removes expired sessions, invitations or used tokens, but they are small rows. | A user signs out, or a workspace is deleted. |

Runs and registers are the likely growth for a workspace that reconciles daily, because each
day adds a register and a run for every watched asset. Plan for the `-wal` file too: it can be
larger than usual during a long write (an import or a `rebuild`) and returns to a small size
after SQLite checkpoints it.

## What is safe to delete

| What | Safe? | Notes |
|---|---|---|
| `demo/` | Yes | Concord never reads it. |
| A legacy `concord.db` | Yes, once you are sure you do not need it | See above. |
| `-wal` / `-shm` of a database that is **closed** (server and CLI both stopped) | Leave them | After a clean close they are already gone. If they are left after a crash, SQLite recovers from them on the next open; deleting a `-wal` that holds committed changes loses those changes. |
| `-wal` / `-shm` of an open database | **No** | |
| `orgs/<id>.db` for a workspace listed by `concord orgs` | **No**, unless you mean to destroy that workspace's books | Use `concord org-delete`, which also removes the workspace and the file's `-wal` and `-shm` (`OrgStore.remove`). Deleting the file by hand leaves the workspace in `control.db` and a fresh, empty database is created the next time it is opened. |
| `orgs/<id>.db` for an id **not** in `concord orgs` | Yes | Concord does not open it. Check twice that the id really is absent. |
| `control.db` | **No** | It holds every account and the list of workspaces. Without it, workspace files are orphans: nothing can sign in to them. |

To remove a watched asset and its books but keep the workspace, use `pnpm concord unwatch`; to
keep the books but re-read history, use `pnpm concord rebuild`. Both are defined in
`services/api/src/cli.ts`.

## Backing up

Copy with `pnpm concord backup DIR`, which uses SQLite's online backup for `control.db` and every
workspace database, so it is consistent while the server is running. Copying the files with
`cp` while the server is running can miss changes that are still in the `-wal` file and can
capture a database and its log at different moments.

A backup directory has the same layout as the data directory (`control.db` and `orgs/<id>.db`),
so restoring is stopping Concord and copying the files back into `CONCORD_DATA_DIR`. I did not
test a restore.
