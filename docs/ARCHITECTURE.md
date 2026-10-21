# Architecture

Concord is one Node process: a background indexer, an HTTP API, and the dashboard it serves. It
reads Stellar and compares what it sees with books a user uploads. It never signs or submits
anything.

```
 Stellar RPC (getEvents)  ─┐
 Horizon (opening balances)┴─►  chain.ts ──► events ──┐
                                                      ▼
 CSV: register / journal / instructions ──► core: parse + replay + reconcile
                                                      │ results
                                                      ▼
                                   concord.ts ──► SQLite (one file per workspace)
                                                      ▲
                          api.ts / cli.ts ────────────┘   ◄── dashboard (apps/web)
```

## The three packages

### `packages/core` — the accounting, no I/O

Pure functions over plain data. Nothing here reads a file, a clock, a database or the network;
callers pass everything in. All amounts are `bigint` in the asset's smallest unit.

| Module | Role |
|---|---|
| `events.ts` | `AssetEvent`: the CAP-67 event set (`transfer`, `mint`, `burn`, `clawback`, `set_authorized`) as Concord sees it, and ledger ordering |
| `holdings.ts` | `replay`: events (plus optional opening balances) → `HoldingsState`, the balance, authorisation and supply per address at a point in time |
| `register.ts` | Parse a register CSV into `RegisterPosition`s; report unreadable rows by line |
| `reconcile.ts` | `reconcilePositions`: holdings vs register → position breaks (quantity, missing either side, unmapped holder, status, supply, incomplete history) |
| `movements.ts` | Parse a journal; `reconcileMovements`: on-chain movements vs journal entries |
| `distributions.ts` | Corporate actions: dividend and split entitlements from record-date holdings, `observeFlows` from the ledger, `reconcileDistribution` between them |
| `controls.ts` | Parse instructions; `buildControlsLog` matches each freeze, authorisation or clawback to an instruction issued in the 72 hours before it |
| `amount.ts`, `csv.ts` | Exact decimal parsing and formatting; RFC 4180 CSV |

A break has a stable `key` (for example `STATUS_MISMATCH:<address>`). Sign-offs attach to that key
and record the figures they were written against, which is how a sign-off knows to reopen when
the break moves.

### `services/api` — I/O and orchestration

| File | Role |
|---|---|
| `chain.ts` | `ChainSource` interface and `StellarSource`. Pages RPC `getEvents`, decodes them with `decodeEvent`, fails over between endpoints, and reads Horizon for opening balances. Also `resolveAsset` (`CODE:ISSUER` or a `C...` contract id) |
| `concord.ts` | The `Concord` class for one workspace: watch/unwatch/rebuild assets, `sync`, import books, `reconcile`, corporate actions, sign-off notes, controls, `auditExport` |
| `tenants.ts` | Opens a workspace's `Concord` on demand. One SQLite file per workspace under `data/orgs/` |
| `db.ts`, `schema.ts` | Thin wrapper over `node:sqlite` (WAL mode) and the migration lists |
| `auth.ts`, `auth-api.ts`, `security.ts` | Accounts, memberships, sessions, invitations, reset links, Google sign-in, scrypt password hashing, signed cookies, rate limiting |
| `api.ts` | The Hono routes. Rejects cross-origin requests; every call carries the workspace in `x-concord-org` |
| `main.ts` | Builds the runtime, serves the built dashboard, starts the indexer loop (`CONCORD_SYNC_INTERVAL`) |
| `cli.ts` | The `pnpm concord` commands, operating on the same data directory as the server |
| `demo/testnet.ts` | Development tool: issues a practice regulated asset on testnet and writes books that disagree with the chain in known ways |

### `apps/web` — the dashboard

React 19, Vite and Tailwind 4. `api.ts` is the only place that talks to the server. Tabs under
`src/tabs` are per-asset views (reconciliation, holdings, events, corporate actions, controls,
export); `Settings.tsx` and `Auth.tsx` cover workspace and sign-in. In production the API serves
the built files from the same origin, so there is no CORS and the session cookie is `SameSite=Strict`.

## Data

Two kinds of database, all under `CONCORD_DATA_DIR`:

- `control.db`: users, workspaces, memberships, sessions, invitations. Schema is
  `CONTROL_MIGRATIONS`.
- `orgs/<id>.db`: one per workspace, so nothing a workspace stores can be reached through another.
  Schema is `ORG_MIGRATIONS`: watched assets, indexed events, uploaded registers, journals,
  instructions, reconciliation runs, corporate actions, notes.

Migrations are an ordered list; `PRAGMA user_version` is the count applied. Add to the end and
never edit one that has shipped. Amounts are stored as decimal strings of the smallest unit.

## How the main flows work

**Watching an asset.** `watchAsset` resolves the spec, then asks the chain source for a baseline.
A classic asset starts from every trustline's balance (Horizon) at a ledger, then takes events
from there, because RPC keeps only about seven days. A contract token has no baseline, so its
holdings count from the oldest ledger RPC retains, and the dashboard says so.

**Indexing.** `sync` reads events after the stored cursor and appends them. If the cursor has
fallen out of RPC retention, events were lost: Concord stops indexing that asset and reports the
gap; `rebuild` takes a fresh baseline and keeps the uploaded books.

**Reconciling.** Importing a register triggers `reconcile`: replay events to the register's
`as_of`, compare with `reconcilePositions`, add `reconcileMovements` if a journal exists, store
the run. Nothing reconciles on a timer.

**Corporate actions.** An action records terms (dividend rate, split ratio) and a record time.
Once the chain has passed that time, `reconcileAction` takes holdings at the record time,
computes expected entitlements, observes the actual flows in the execution window, and diffs
them. An action recorded ahead of its record time is picked up by `reconcileDue`.

## Audit pack contract

The JSON returned by `GET /api/assets/:id/export` is the artifact auditors keep. Its shape is
published as a versioned JSON Schema: [`audit-pack.schema.json`](./audit-pack.schema.json) (v1).
`services/api/test/service.test.ts` generates a pack from the service fixture, validates it with
Ajv, and snapshots its key paths, so adding or removing a field requires a schema change and a new
schema version.

## Testing

`vitest` in `packages/core` and `services/api`. API tests build a real `Concord` with an in-memory
store and a `FakeChain` (`services/api/test/helpers.ts`), so the suite needs no network and runs
real password hashing at a low cost. The dashboard has no automated tests yet.

## Deliberate limits

Documented in the README under **Limits**: RPC history of about seven days, supply understated by
pool/claimable/contract balances for classic assets, one process and one disk, no email ([`docs/adr/0003-no-email.md`](./adr/0003-no-email.md)). Changes
that remove a limit should update that section.
