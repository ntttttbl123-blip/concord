# Concord

Reconciliation between tokenized securities on Stellar and the official books kept by transfer
agents, custodians and fund administrators.

When a security lives both on-chain and in a register, someone has to prove the two agree, every
day. Dividends, splits, freezes and clawbacks have to land on both sides. Today that work is
manual. Concord does it from ledger events.

**Status:** working, and ready to put in front of people. The indexer, reconciler,
corporate-actions engine, controls log and audit export run end to end behind sign-in, with a
private workspace per organisation. It has been exercised against Stellar mainnet: watching
Franklin Templeton's BENJI, Concord's unit total matched Horizon's own figure to the last decimal,
and a register built from the chain's holdings reconciled clean across all 1,005 positions. No
customer has used it. The product brief and kill criteria are in [`BRIEF.md`](./BRIEF.md).
Questions, bug reports and what to expect back: [`SUPPORT.md`](./SUPPORT.md).

## Run it

Needs Node 24+ and pnpm 10.22 (pinned in `package.json`). Nothing else: storage is SQLite through `node:sqlite`.

```sh
pnpm install
pnpm build
pnpm start            # API and dashboard on http://127.0.0.1:4400
```

Open the address, create a workspace, and watch an asset. Mainnet and testnet are both served;
the switch is at the top left. A new workspace is empty. Concord ships no sample data: the chain
side comes from the ledger, and the register side is the file you upload. The
[dashboard user guide](./docs/user-guide.md) walks through each tab.

`pnpm test` runs the unit and service tests. `pnpm dev` runs the API and the dashboard with reload.

Configuration is by environment variable, or a `.env` file beside `package.json`; see
[`.env.example`](./.env.example), and [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md) for every
variable's default, accepted values and validation. With nothing set, mainnet uses free public
RPC endpoints, which suit light use. Point `CONCORD_MAINNET_RPC_URLS` at a provider for anything
more.

Where the databases live, and what is safe to delete, is in
[`docs/data-directory.md`](./docs/data-directory.md). What personal data Concord stores, where,
how long it is kept and how to remove it is in [`docs/privacy.md`](./docs/privacy.md).

## Accounts and workspaces

- A **workspace** holds the assets an organisation watches and the books it uploads. Each one is
  a SQLite file of its own under `data/orgs/`, so nothing a workspace stores can be reached from
  another. Accounts, memberships and sessions live in `data/control.db`. Why one file per
  workspace: [`docs/adr/0001-sqlite-per-tenant.md`](./docs/adr/0001-sqlite-per-tenant.md).
- People sign in with **email and password**, or with **Google** when
  `CONCORD_GOOGLE_CLIENT_ID` and `CONCORD_GOOGLE_CLIENT_SECRET` are set. Concord sends no email:
  an owner creates an invitation link and passes it on, and a forgotten password is reset with a
  link from `pnpm concord reset-link EMAIL`. See the [Google sign-in setup guide](./docs/google-signin.md)
  to configure Google or understand how it works with existing accounts, invitations and sign-up codes.
- **Owners** invite and remove people, stop watching assets and can delete the workspace.
  **Members** do everything else. Whoever signs off a break is recorded from their session.
- `CONCORD_SIGNUP=open` lets anyone create a workspace. `CONCORD_SIGNUP=code` requires a code
  from `pnpm concord signup-code`.
  The [operator guide](./docs/operator-guide.md) covers codes, reset links and deleting a
  workspace.

## Command line

Everything on the dashboard except sign-off and team management is also on the command line. It
works on the same data directory as the server, and may run while the server does.

```sh
pnpm concord orgs
export CONCORD_ORG="Harbourline Transfer"     # or pass --org to each command
pnpm concord watch FUND:GISSUER... --name "Example Fund" --ignore GTREASURY...
pnpm concord register FUND ./register.csv --as-of 2026-10-06T21:00:00Z
pnpm concord journal FUND ./journal.csv
pnpm concord instructions FUND ./instructions.csv
pnpm concord action FUND dividend --record 2026-10-01T21:00:00Z --rate 0.05 --pay-asset USDC --payer GAGENT...
pnpm concord action FUND split --record 2026-10-01T21:00:00Z --ratio 2:1
pnpm concord controls FUND
pnpm concord export FUND --out audit.json
pnpm concord backup ./backup-2026-10-08
pnpm concord --help
```

Every command, option and exit code is in the [command-line reference](./docs/cli.md).

The audit pack format (JSON sections, CSV columns, period rules and file names) is documented in [`docs/audit-pack.md`](./docs/audit-pack.md).

## Deploying

The [`Dockerfile`](./Dockerfile) builds one image that serves the API and the dashboard. Give it
a volume at `/data`, put TLS in front (see [`docs/deploy/nginx.md`](./docs/deploy/nginx.md) for an
nginx and Certbot recipe, or the [Caddy TLS recipe](docs/deploy/caddy.md) for automated Let's Encrypt
certificates), and set `CONCORD_PUBLIC_URL` to the https address people open. For
multi-container orchestrations, volumes, healthchecks, and upgrade procedures, see
[Deploying with Docker Compose](docs/deploy/docker-compose.md).

```sh
docker build -t concord .
docker run -p 4400:4400 -v concord-data:/data -e CONCORD_PUBLIC_URL=https://concord.example.com concord
```

For a long-running host, [`deploy/docker-compose.yml`](./deploy/docker-compose.yml) does the same
with a named volume, a restart policy and the health check. Copy `.env.example` to `.env` at the
repository root, then run `docker compose -f deploy/docker-compose.yml up -d --build` from there.

Concord is a single process with a background indexer and SQLite files, so it needs one
always-on instance with a local disk. It does not fit serverless hosts.

[`render.yaml`](./render.yaml) deploys it to Render's **free** plan for a preview. That plan has
no persistent disk: every account, upload and sign-off is erased when the service restarts or
spins down after fifteen idle minutes. `CONCORD_EPHEMERAL=1` makes the dashboard say so on every
page. For anything people should come back to, use a paid instance with a disk at `/data` (or
Fly.io, or a VPS with [nginx](./docs/deploy/nginx.md)) and remove that variable.

Before upgrading, read [`docs/versioning.md`](./docs/versioning.md): what a version number
promises, what counts as breaking for the input files, the audit pack and the database, and why a
downgrade means restoring a backup.

Upgrading an existing instance, including how migrations run, taking a backup and rolling back, is
covered in [`docs/upgrading.md`](./docs/upgrading.md).

## Layout

| Path | What it is |
|---|---|
| `packages/core` | The accounting, with no I/O: holdings replay, position and movement reconciliation, entitlements, controls matching |
| `services/api` | RPC indexer, SQLite stores, accounts and workspaces ([how they are isolated](./docs/tenancy.md)), HTTP API, CLI |
| `apps/web` | Dashboard: sign-in, breaks and sign-off, holdings, corporate actions, controls log, audit export, team |

The tables in `control.db` and in each workspace database are described in
[`docs/schema.md`](./docs/schema.md).

## Input files

All CSV with a header row. Amounts are decimals in whole units; more precision than the asset
carries is rejected, not rounded (see [`docs/adr/0002-bigint-amounts.md`](./docs/adr/0002-bigint-amounts.md)).
Rows that cannot be read are listed with their line number and
the reason, and the rest of the file is loaded. Each import form offers a blank template.

| File | Columns |
|---|---|
| Register | `holder_id`, `units`, and optionally `holder_name`, `account`, `status` (`active` or `frozen`). Several holders may share one `account` (omnibus). |
| Journal | `ref`, `date`, `type` (`issue`, `transfer`, `redeem`, `clawback`), `units`, and optionally `from_account`, `to_account`, `tx_hash` |
| Instructions | `ref`, `type` (`authorize`, `freeze`, `unfreeze`, `clawback`), `account`, `issued_at`, and optionally `units` (required for a clawback), `approved_by`, `reason` |

## What it flags

- **Positions:** quantity mismatch, holder on chain but not on the register, holder on the
  register but not on chain, register holder with no address, frozen/active disagreement, total
  supply mismatch.
- **Movements** (when a journal is loaded): on-chain movement missing from the journal, journal
  entry with no ledger event, entry whose cited transaction moved a different amount.
- **Corporate actions:** per holder, entitlement at the record time against what the ledger
  showed in the execution window: missing, short, excess, or paid to someone not entitled. An
  action recorded ahead of its record time is reconciled by itself once the chain passes it.
- **Controls:** a freeze, authorisation or clawback with no instruction issued in the 72 hours
  before it, and an instruction that was never executed.

A break can be acknowledged or resolved with a note. The sign-off holds only while the figures it
was written against are unchanged; if the break moves, it reopens. See
[`docs/breaks.md`](./docs/breaks.md) for the complete break-type glossary, root causes, investigation
steps, and sign-off lifecycle.

A reconciliation runs when a register is imported and whenever someone re-runs it. Nothing
reconciles on a timer: a new day's comparison needs that day's register.

## Limits

Which of these are next to fall, and what never will, is in
[`docs/ROADMAP.md`](./docs/ROADMAP.md).

- **History.** Stellar RPC keeps about seven days of events. A classic asset is therefore
  watched from opening balances: every trustline's balance from Horizon, then events from that
  ledger on. Horizon does not list balances held by liquidity pools, claimable balances or
  contracts, so opening balances understate supply by whatever those hold. Holdings before the
  opening balances cannot be queried. For full architecture, retention rules, and timeline diagrams, see
  [`docs/history-and-baselines.md`](docs/history-and-baselines.md).
- **Contract tokens.** A SEP-41 token that is not the contract of a classic asset has no opening
  balances to read, so its holdings count only movements from the oldest ledger the RPC keeps.
  The dashboard says so on every page of such an asset. Tokens that do not emit the standard
  `set_authorized` and `clawback` events will show an empty controls log.
- **Gaps.** If the indexer is down for longer than RPC retention, the events in between are
  lost. Concord detects this, stops indexing the asset and says why; **Rebuild history** in the
  asset's settings starts it again from fresh opening balances and keeps the uploaded books.
- **Decimals.** Classic assets carry seven. A contract token's are read from the contract; one
  that does not state them has to be told when it is watched.
- **Email.** None is sent. Addresses are not verified at sign-up, invitations travel by link, and
  password resets go through the operator. See [`docs/adr/0003-no-email.md`](./docs/adr/0003-no-email.md) for the
  architectural decision and threat model.
- **Scale.** One process, one SQLite file per workspace, holdings replayed from events in
  memory. It has run an asset with a thousand holders and seven thousand events comfortably; it
  has not been load-tested beyond that.
- **Splits.** Fractions of the smallest unit are dropped; cash in lieu is not modelled.

## Practice asset on testnet

`pnpm demo:testnet` issues a regulated fund share on testnet (auth required, revocable, clawback
enabled) and runs subscriptions, a cash dividend, a transfer, a freeze, a clawback, a redemption
and a 2:1 split against it. It then writes a register, journal and instruction file that disagree
with the chain in known ways to `data/demo/`, and prints what to watch. The script never opens a
Concord database: you watch the asset with the network set to Testnet and upload the files by
hand, the way a user would. The books it writes are invented, and exist for development only.
[`docs/demo-testnet.md`](./docs/demo-testnet.md) walks through the whole flow: what the script
prints, what to watch for on the chain, how to load the books, and why each break appears.

## Prior-art check

The brief's first kill criterion is that someone already ships this for Stellar. The check, a dated
source for every finding, the kill criteria and the re-check schedule are kept in
[`docs/prior-art.md`](./docs/prior-art.md).

## Why now

- DTCC's tokenization service plans to connect to Stellar in **H1 2027**. First assets: Russell
  1000 stocks, major index ETFs, US Treasuries (DTCC press release, 2026-05-27).
- Stellar already holds about **$4B** of tokenized RWAs (SDF Dune dashboard, 2026-08-29). Spiko,
  Franklin Templeton (BENJI), Ondo and WisdomTree all keep official registers alongside the chain.
- CAP-67 (Final, Protocol 23) makes classic Stellar operations emit `transfer`, `mint`, `burn`,
  `clawback` and `set_authorized` events in the same format as Soroban. For the first time,
  regulated-asset activity can be indexed without decoding every operation type by hand.

## What it does

| Module | Job |
|---|---|
| Indexer | Read CAP-67 events for a watched set of regulated assets (classic and SEP-41) |
| Reconciler | Match on-chain holdings and movements against each register export as it is imported, and on demand; flag breaks |
| Corporate actions | Record-date snapshots; dividend, split and redemption reconciliation — see [`docs/corporate-actions.md`](./docs/corporate-actions.md) |
| Controls log | Every freeze, authorisation change and clawback, tied to the instruction that caused it |
| Audit export | Regulator- and auditor-ready reports |

Read-only. Concord never holds keys or moves money. The reasoning, the one exception (the testnet
practice script), and the rules for proposals that would add signing are in
[`docs/adr/0004-read-only.md`](./docs/adr/0004-read-only.md).

## Who buys it

Transfer agents, custodians and fund administrators serving issuers on Stellar. Priced as
software: per asset and per seat.

## Contributing

Contributions are welcome. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md) for setup and the
rules that matter, and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for how the code fits
together. To read the ledger from a new source, see
[`docs/contributing/chain-source.md`](./docs/contributing/chain-source.md), see [`docs/breaks.md`](./docs/breaks.md) for the break-type glossary, see [`docs/contributing/core-tests.md`](./docs/contributing/core-tests.md) for testing guidelines in `packages/core`, and see [`docs/accessibility.md`](./docs/accessibility.md) for our accessibility statement and conformance goals. Report security problems
privately, as described in [`SECURITY.md`](./SECURITY.md).
Everyone taking part is expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE).

## Changelog

User-visible and schema changes are listed in [`CHANGELOG.md`](./CHANGELOG.md), Keep a
Changelog format.

## Relationship to other projects

Concord is a stand-alone company. It was split from the Ballast idea set on 2026-09-16 because
it shares no buyer, balance sheet or regulatory load with Ballast. See
`../ballast/README.md` for the reasoning.
