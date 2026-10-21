# Upgrading and migrating

For operators of a Concord instance. It explains where the databases live, how schema migrations run
when a new build starts, what happens when a database does not match the build, how to take a backup
first, how to roll back, and the container upgrade procedure.

Concord is a single process with a local disk, so an upgrade is: stop the old version, back up the
data directory, start the new version, and let it migrate. There is no separate migration step.
Migrations are forward only; read the rollback section before you upgrade.

## Where the data lives

Everything is under `CONCORD_DATA_DIR` ([`config.ts`](../services/api/src/config.ts) `loadConfig`).
In a checkout it defaults to `data/` beside `package.json`; in the container it is `/data`. It holds:

- `control.db`: accounts, workspaces, memberships, sessions and invitations.
- `orgs/<id>.db`: one database per workspace, holding that workspace's watched assets, indexed events,
  uploaded books, reconciliation runs, corporate actions and sign-off notes.

Each database is opened through the `Db` class ([`db.ts`](../services/api/src/db.ts)), which runs its
migrations in the constructor. The server opens `control.db` at startup
([`main.ts`](../services/api/src/main.ts) `openRuntime`) and each workspace database the first time it
is needed, so migrations reach a given workspace the first time that workspace is opened after the
upgrade.

## How migrations run

The schema is an ordered list of SQL migrations ([`schema.ts`](../services/api/src/schema.ts)). A
database's `PRAGMA user_version` is how many have been applied. `Db.migrate` reads that number and
applies every entry from there to the end of the list ([`db.ts`](../services/api/src/db.ts)):

1. If `user_version` is greater than the number of migrations the build knows, the open is refused.
2. If `user_version` is `0` but the file already contains tables, the open is refused.
3. Otherwise each pending migration runs in its own transaction. After the SQL, the database is
   checked with `PRAGMA foreign_key_check`; if it passes, `user_version` is set to the new count and
   the transaction commits. If anything fails, the transaction rolls back and the error is thrown.

A migration that fails leaves the database at the last version that committed. The process that was
opening it does not start serving.

Migrations are append only. A shipped entry is never edited; a change to the schema is a new entry at
the end of the list ([`CONTRIBUTING.md`](../CONTRIBUTING.md), [`schema.ts`](../services/api/src/schema.ts)).
An upgrade therefore only ever adds.

### When a database does not match the build

- **From a newer build.** If a database was migrated by a newer build and an older build opens it, the
  older build refuses with a message such as
  `control.db is at schema 3; this build only knows 2` ([`db.ts`](../services/api/src/db.ts)). The fix
  is to run the newer build, or to restore a backup taken before the newer build touched the file.
- **From before versioning.** A file that has tables but still reports `user_version = 0` predates
  schema versioning and is refused with `predates schema versioning and cannot be upgraded; move it
  aside`. Such a file is not migrated; keep it and start with a new data directory if you need to.

## Take a backup first

Before an upgrade, copy the whole data directory. From a checkout on the same machine as the data, the
operator command does a consistent copy while the server runs, using SQLite's own backup, and covers
`control.db` and every workspace database ([`cli.ts`](../services/api/src/cli.ts) `backup`):

```sh
pnpm concord backup ./backup-before-upgrade
```

It writes `control.db` and `orgs/<id>.db` under the given directory. Databases run in WAL mode, so do
not copy the files by hand while the server is running; use this command, or stop the server first and
copy the directory.

## Rolling back

There are no down migrations. Once a database has been migrated to a version an older build does not
know, that older build refuses to open it. A rollback is therefore one of:

- **Restore the backup.** Stop the new version, put the pre-upgrade directory back, and start the old
  version. This is the reliable rollback and the reason to back up first.
- **Go forward instead.** Ship a new migration that reverses the change, and run the newer build.

Do not delete or lower `user_version` by hand to force an older build to open a newer database; the
schema may already differ in ways the older code cannot read.

## Upgrading the container

The image serves the API and the dashboard and keeps the databases in a volume at `/data`
([`Dockerfile`](../Dockerfile)). Deploying is described in the [README](../README.md#deploying). The
upgrade procedure:

1. **Back up the volume.** Stop the container so the databases close cleanly, then copy the volume:
   ```sh
   docker stop concord
   docker run --rm -v concord-data:/data -v "$PWD":/backup alpine \
     tar czf /backup/concord-data.tgz -C /data .
   ```
2. **Build the new image.**
   ```sh
   docker build -t concord:new .
   ```
3. **Start it against the same volume.** Migrations run on start as the server opens `control.db`.
   ```sh
   docker run -d --name concord -p 4400:4400 -v concord-data:/data \
     -e CONCORD_PUBLIC_URL=https://concord.example.com concord:new
   ```
4. **Check it came up.** The container's healthcheck polls `/api/health`
   ([`Dockerfile`](../Dockerfile)); watch the logs for the startup line and for any migration error.
   Open a workspace to migrate its database, since workspace databases migrate on first open.
5. **If it fails, roll back.** Stop the new container, restore the volume from the archive, and start
   the previous image:
   ```sh
   docker stop concord && docker rm concord
   docker run --rm -v concord-data:/data -v "$PWD":/backup alpine \
     sh -c "rm -rf /data/* && tar xzf /backup/concord-data.tgz -C /data"
   docker run -d --name concord -p 4400:4400 -v concord-data:/data \
     -e CONCORD_PUBLIC_URL=https://concord.example.com concord:old
   ```

Run one version at a time against a given data directory. Two processes, or two versions, opening the
same databases can each try to migrate them, and the results are undefined.

## Checking a database's version

`PRAGMA user_version` on any of the files is the number of migrations applied, which is how many
entries of the build's list it knows. For example:

```sh
sqlite3 data/control.db 'PRAGMA user_version;'
```

The value tells you which builds can open the file: a build whose migration list is at least this
long will open and migrate it, and one that is shorter will refuse it.
