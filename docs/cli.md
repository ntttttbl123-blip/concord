# Command-line reference

For operators and scripters. The command line is defined in
[`services/api/src/cli.ts`](../services/api/src/cli.ts); the usage text printed by
`pnpm concord --help` is the same text it holds. References below are to that file unless
another is named.

Everything on the dashboard except sign-off and team management is also here. The CLI works
on the same data directory as the server (`CONCORD_DATA_DIR`, default `data/` at the repository
root) and may run while the server does: databases are SQLite in WAL mode with a five
second busy timeout (`services/api/src/db.ts`).

## Running it

```sh
pnpm concord <command> [arguments] [options]
```

`concord` is a root script that runs `tsx src/cli.ts` inside `services/api` (`package.json`,
`services/api/package.json`). It needs `pnpm install` and `pnpm build` to have been run: the CLI
imports the built `@concord/core` package, and without `packages/core/dist` it fails with
`ERR_MODULE_NOT_FOUND`.

`pnpm concord ...` prints two `> concord@ ...` banner lines on standard output before the
command's own output. In a script, or whenever you read standard output (`--json`, `export`
without `--out`), run `pnpm --silent concord ...` instead, which prints nothing but the
command's output. Node also prints an `ExperimentalWarning: SQLite is an experimental feature`
line to standard error on every run; it is harmless. Settings come from the environment or a `.env` file beside the
root `package.json`; see [`.env.example`](../.env.example). `pnpm concord --help`, `-h`, or no
command at all prints the usage text and exits `0`.

Every command opens the data directory first, creating `control.db` and the `orgs/` directory
if they are missing, so a typo in the data directory path makes an empty, separate set of data
rather than an error. Check `CONCORD_DATA_DIR` before running commands you expect to find
existing workspaces.

## Options

Options are parsed with `node:util` `parseArgs`. An option that is not in the table below is an
error. Positional arguments and options may appear in any order.

| Option | Used by | Meaning |
|---|---|---|
| `--org <id \| name>` | every workspace command | The workspace to act on. Falls back to the `CONCORD_ORG` environment variable. |
| `--json` | see [`--json` coverage](#json-coverage) | Print machine-readable JSON. |
| `--network mainnet\|testnet` | `watch` | Network of the asset. Defaults to `CONCORD_DEFAULT_NETWORK`, itself defaulting to `mainnet`. |
| `--name <text>` | `watch` | Display name. Defaults to the asset code. |
| `--ignore A,B` | `watch` | Comma-separated addresses to leave out of reconciliation (treasury, issuer). |
| `--from <ledger>` | `watch` | Start indexing at this ledger instead of taking opening balances. |
| `--no-baseline` | `watch` | Do not take opening balances from Horizon; index the retained event window only. |
| `--decimals <0-18>` | `watch` | Decimals of a contract token that does not state them. Classic assets always have 7. |
| `--as-of <ISO>` | `holdings`, `register` | Point in time. Required by `register`. |
| `--register <id>` | `reconcile` | Reconcile this register import instead of the latest. |
| `--record <ISO>` | `action` | Record time: holdings at this instant are the entitlement basis. Required. |
| `--rate <decimal>` | `action ... dividend` | Pay-asset units per whole unit held. Required for a dividend. |
| `--pay-asset <asset>` | `action ... dividend` | Watched asset the dividend is paid in, on the same network. Defaults to the asset itself. |
| `--payer <address>` | `action ... dividend` | The paying agent. Without one, mints of the pay asset are counted. |
| `--ratio NUM:DEN` | `action ... split\|redemption` | Whole numbers. Required for a split or redemption. |
| `--until <ISO>` | `action` | End of the execution window. Open-ended when absent. |
| `--label <text>` | `action` | Name for the action. Defaults to a description such as `Split 2:1`. |
| `--exclude A,B` | `action` | Comma-separated addresses excluded from the entitlement. |
| `--from <ISO>`, `--to <ISO>` | `export` | Period of the export. Without `--to`, the end is the time the asset was last indexed. |
| `--csv <section>` | `export` | Write one section as CSV: `holdings`, `events`, `controls` or `breaks`. |
| `--out <file>` | `export` | Write to a file instead of standard output. |
| `--note <text>` | `signup-code` | A note stored with the code. |
| `--help`, `-h` | any | Print the usage text. |

`--from` means a ledger number for `watch` and an ISO time for `export`.

`ASSET` in a command is a contract id, or an asset code when exactly one watched asset in the
workspace has it (case-insensitive). With two assets of the same code the command fails and asks
for the contract id (`Concord.asset` in `services/api/src/concord.ts`). `ISO` means an ISO-8601
time such as `2026-10-06T21:00:00Z`.

## Which commands need `--org`

A workspace is named by `--org` (its id, or its exact name) or `CONCORD_ORG`. A name shared by
two workspaces is refused: use the id (`Auth.findOrg`, `services/api/src/auth.ts`).

- **Need a workspace:** `watch`, `unwatch`, `rebuild`, `assets`, `holdings`, `register`,
  `journal`, `instructions`, `reconcile`, `action`, `actions`, `controls`, `export`.
- **`sync`:** with an `ASSET`, needs a workspace. With no `ASSET` it syncs every asset in the
  named workspace, or every workspace when none is named (and then also advances any corporate
  action whose record time the indexed chain has passed).
- **Operator commands, no workspace:** `orgs`, `signup-code`, `reset-link`, `org-delete`,
  `backup`, `serve`.

Without a workspace the error is ``missing --org (see `concord orgs`)``.

## Workspace commands

### `watch <CODE:ISSUER | CONTRACT>`

Starts indexing an asset, then runs one sync before returning.

```sh
pnpm concord watch FUND:GISSUER... --name "Example Fund" --ignore GTREASURY...
pnpm concord watch CABC... --network testnet --decimals 6
```

- A classic asset is `CODE:ISSUER`. A Soroban token is its contract id (`C...`). A contract id
  that turns out to be the wrapper of a classic asset is watched as that asset.
- A classic asset starts from opening balances (every trustline's balance from Horizon) unless
  `--no-baseline` or `--from` is given. A contract token has no opening balances, so it starts
  at the oldest ledger the RPC keeps unless `--from` is given. `--from` older than the RPC keeps
  is refused.
- A contract token that does not state its decimals needs `--decimals`.
- Watching an asset that is already watched fails.
- If establishing the starting point fails (for example the RPC is unreachable), the asset is
  removed again and the command exits `1`. If that succeeds and the first sync then fails, the
  asset stays watched and the sync error is shown on `assets`.

On success it prints
`watching CODE (id) on network from ledger N; M events indexed`.

### `unwatch ASSET`

Stops watching and **deletes the asset and its books** (registers, journal, instructions,
reconciliation runs, corporate actions, sign-offs). There is no confirmation prompt.

### `rebuild ASSET`

Throws away the indexed events and opening balances and indexes again from fresh opening
balances (for a classic asset) or from the oldest retained ledger. Registers, runs and sign-offs
stay. Use it after the indexer was down for longer than RPC retention.

### `assets`

A table of watched assets: code, network, supply, holders, events, last sync time, status of the
last reconciliation, number of open breaks, and any sync problem.

### `sync [ASSET]`

Pulls new events. With an `ASSET` it prints `{"added": N}`. With a workspace but no `ASSET` it
prints an object keyed by asset id (`{"added": N}` or `{"error": "..."}` for each). With no
workspace at all it prints an array of `{orgId, assetId, added | error}`. The server does the
same on a timer (`CONCORD_SYNC_INTERVAL`, default 30 seconds); the CLI is for a server that is
stopped, a sync interval of `0`, or forcing a pass.

### `holdings ASSET [--as-of ISO]`

On-chain holders as of the given time, or as of the last sync. Prints a summary line (supply,
holder count, ledger) and a table of holders with address, units, share, status and whether the
address is ignored. With `--json`, the whole object, including `incomplete` notes.

### `register ASSET FILE --as-of ISO`

Imports a register export (CSV) and immediately reconciles it. `--as-of` is required: it is the
time the register is true for. The columns are listed in the README under
[Input files](../README.md#input-files).

- Prints `register ID: N positions, M rejected rows`, then one line per rejected row with its
  line number and reason. Rows that cannot be read are skipped; the rest are loaded. A file with
  no usable rows is an error.
- Then prints the reconciliation (see `reconcile`).
- Every call adds a new register import. Running it twice with the same file creates two
  registers.
- With `--json` the reconciliation is JSON, but the two lines above still go to standard output
  first, so the output as a whole is not one JSON document. To script a daily run, prefer the
  [pattern below](#daily-reconciliation-from-cron).

### `journal ASSET FILE`

Imports the register's transaction journal, a CSV. Always prints JSON: `{"entries": N,
"issues": [{"line", "message"}]}`. An entry with a `ref` that already exists for the asset
replaces the earlier one, so re-importing an overlapping export is safe. A journal makes the
next reconciliation also compare movements.

### `instructions ASSET FILE`

Imports control instructions, a CSV. Always prints JSON: `{"instructions": N, "issues": [...]}`.
An instruction with an existing `ref` replaces the earlier one. The controls log matches
freezes, authorisations and clawbacks against these.

### `reconcile ASSET [--register ID]`

Re-runs a reconciliation of the latest register (or the one named by `--register`) against the
chain at that register's as-of time. It first tries to sync the asset; if that fails, the run
goes ahead and the failure is shown as a warning. It fails if no register has been imported.

Human output: a header
`reconciliation ID · as of TIME · CLEAN|BREAKS`, any warnings, a summary table, then a table of
breaks (type, subject, chain units, register units, difference, status). With `--json`, the run
object: `status` is `clean` or `breaks`, with `summary`, `lines`, `movement` and `breaks`.

A reconciliation that finds breaks still exits `0`. See [Exit codes](#exit-codes).

### `action ASSET <dividend|split|redemption> --record ISO ...`

Records a corporate action and reconciles it.

```sh
pnpm concord action FUND dividend --record 2026-10-01T21:00:00Z --rate 0.05 --pay-asset USDC --payer GAGENT...
pnpm concord action FUND split --record 2026-10-01T21:00:00Z --ratio 2:1
pnpm concord action FUND redemption --record 2026-10-01T21:00:00Z --ratio 1:4 --until 2026-10-08T00:00:00Z
```

- A dividend needs `--rate`; a split or redemption needs `--ratio NUM:DEN`. A redemption cannot
  exceed 1 (`NUM` greater than `DEN` is refused).
- Until the indexed chain has passed the record time the action is `scheduled`. It is then
  reconciled by itself on a later sync (by the server, or by `concord sync` with no `--org`).
- Prints `LABEL · record TIME · STATE`, and when there is a result, a summary table and a table
  of per-holder lines. With `--json`, the action object.

### `actions ASSET`

A table of corporate actions, newest record time first: id, label, record time, state, open
breaks. `state` is `scheduled` before the record time has been indexed, then the result
(`clean` or `breaks`). No `--json`.

### `controls ASSET`

The freeze, authorisation and clawback log: a summary table, then one row per record with time,
type, account, units and the instruction that caused it (`— none —` when there is none). With
`--json`, the whole log.

### `export ASSET [--from ISO] [--to ISO] [--csv SECTION] [--out FILE]`

Without `--csv`, the audit pack as JSON: asset details, period, holdings, reconciliation runs,
corporate actions, controls log and events, with a `generatedAt`, a `generator` and a `sha256`
of the contents. With `--csv`, one section: `holdings`, `events`, `controls` or `breaks`.
With `--out FILE` it writes the file and prints `wrote FILE`; otherwise it writes to standard
output with no trailing newline. `--json` has no effect: JSON is already the default.

## Operator commands

These act on the whole installation, not one workspace.

### `orgs`

A table of workspaces: id, name, member count, creation time. No `--json`.

### `signup-code [--note TEXT]`

Prints a one-time code that lets one new workspace be created while `CONCORD_SIGNUP=code`.
Valid for 14 days; it is used up by the workspace created with it.

### `reset-link EMAIL`

Prints a link, `<CONCORD_PUBLIC_URL>/#/reset/<token>`, then a reminder line. The link is valid for
one day and works once. It fails with `no account for EMAIL` if there is no such account. Set
`CONCORD_PUBLIC_URL` first, or the link points at the local default address.

### `org-delete ORG`

Deletes a workspace, named by id or exact name: its row in `control.db` (and with it its
memberships and invitations), its database file under `orgs/`, and any account left with no
workspace. There is no confirmation prompt.

### `backup DIR`

Copies `control.db` and every workspace database into `DIR` (`DIR/control.db` and
`DIR/orgs/<id>.db`) using SQLite's online backup, so it is safe while the server runs. Creates
`DIR` if needed. Prints how many workspaces were copied.

### `serve`

Runs the API and dashboard, the same as `pnpm start` does for the built output.
`pnpm concord serve` runs it from source through `tsx`.

## `--json` coverage

| Command | `--json` |
|---|---|
| `holdings`, `reconcile`, `action`, `controls` | Whole result as JSON instead of tables. |
| `register` | The reconciliation becomes JSON, but the import summary lines come first as text. |
| `sync`, `journal`, `instructions` | Always JSON; the flag changes nothing. |
| `export` | Always JSON unless `--csv`; the flag changes nothing. |
| `orgs`, `assets`, `actions` | Always a table. |
| `watch`, `unwatch`, `rebuild`, `signup-code`, `reset-link`, `org-delete`, `backup` | Always text. |

## Exit codes

There are two. `0` is success; `1` is any error, with the message on standard error. Errors
include a missing argument or option, an unknown command (the usage text follows the message), a
workspace or asset that does not exist, a CSV that cannot be read at all, and a Stellar RPC
failure that stops the command. A command that finds reconciliation breaks still exits `0`, so a
script that cares has to read the result (`status` in the `--json` output of `reconcile`).

## Daily reconciliation from cron

A new day's comparison needs that day's register: nothing reconciles on a timer. A script
therefore does three things in order: import the day's journal if there is one, import the
register, read the result.

```sh
#!/bin/sh
set -eu
export CONCORD_ORG="Example Workspace"
cd /path/to/concord                    # inside the checkout, so pnpm finds the root script
AS_OF="$(date -u +%Y-%m-%dT21:00:00Z)"
concord() { pnpm --silent concord "$@"; }

concord journal FUND /srv/exports/journal.csv > /dev/null
concord instructions FUND /srv/exports/instructions.csv > /dev/null
concord register FUND /srv/exports/register.csv --as-of "$AS_OF" > /tmp/register.out
concord reconcile FUND --json > /tmp/run.json
grep -q '"status": "clean"' /tmp/run.json || echo "FUND has breaks; see /tmp/run.json" >&2
```

Notes on this script:

- It uses absolute paths for the CSV files; see [Relative paths](#relative-paths).
- `register` reconciles as part of importing, and prints the result as text. The following
  `reconcile --json` runs the same comparison again, on the same register, to get JSON; it does
  not change the result.
- `status` is `clean` or `breaks`. The script's own non-zero exit is its choice, because
  `concord` exits `0` either way.
- To keep dated audit packs: `pnpm --silent concord export FUND --out /srv/audit/audit-$(date -u +%F).json`.
- To back up daily: `pnpm --silent concord backup /srv/backups/concord-$(date -u +%F)`.

### Relative paths

`concord` runs through `pnpm --filter @concord/api cli`, and pnpm runs a package script in that
package's directory, `services/api`. A relative `FILE` or `--out` is resolved from there, not
from where you typed the command. Use absolute paths in scripts.

## What the CLI does not do

- Sign-off on breaks (acknowledge or resolve with a note) and team management (invitations,
  removing people, roles) are dashboard-only.
- Creating a workspace or an account. Those happen through the sign-up page; the operator
  commands only issue codes and reset links.
- Concord never holds keys or moves money; no command submits a transaction.
