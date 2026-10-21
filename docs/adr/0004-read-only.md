# ADR-0004: Read-only by design — no keys, no transactions

- **Status:** Accepted
- **Date:** 2026-10-18
- **Deciders:** maintainers
- **Related:** [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md), [`SECURITY.md`](../../SECURITY.md)

## Context

Concord compares a tokenized security on Stellar with the official books kept by a transfer agent,
custodian or fund administrator. The chain side is read from RPC and Horizon; the book side is a
register, journal and instruction file that a user uploads. The output is a set of breaks, a
controls log and an audit export.

The README states it in one line — "Read-only. Concord never holds keys or moves money."
(`README.md`, *What it does*) — and `docs/ARCHITECTURE.md` says the process "never signs or submits
anything". Both sentences were assertions without an argument behind them. This ADR records the
decision, what it costs, and the exception that `pnpm demo:testnet` makes.

It is written for two readers: maintainers deciding what to build, and a prospective customer's
security or operations reviewer deciding whether this software can be put near their assets.

The question keeps coming up because the product is adjacent to the operations it checks. A
reconciler sees the issuer freeze a holder without an instruction, or a dividend paid short. The
next idea is always "let Concord fix it". This ADR is the answer to that idea.

## Decision

Concord does not hold Stellar secret keys, does not build or sign a transaction, and has no code
path that submits one. That applies to every part that runs in production:

- **The server** reads the chain and writes only Concord's own SQLite databases
  (`services/api/src/main.ts`, `services/api/src/concord.ts`).
- **The CLI** has no command that transfers, issues, freezes, claws back or submits
  (`services/api/src/cli.ts`, commands listed in `USAGE`).
- **The HTTP API** accepts uploads, reconciliation runs, corporate-action terms, notes and
  team management — no endpoint takes a transaction or a key (`services/api/src/api.ts`).
- **The dashboard** only calls that API (`apps/web/src/api.ts`).

Corporate actions are *recorded and reconciled*, not executed. `reconcileAction` takes holdings at
the record time, computes what each holder should have received, observes the flows that actually
happened in the execution window, and reports the difference
(`services/api/src/concord.ts:1180`; `packages/core/src/distributions.ts`). The controls log is
likewise a log: `controlEvents` extracts the freezes, authorisation changes and clawbacks from the
event stream, and `buildControlsLog` matches them against the instructions filed beforehand
(`packages/core/src/controls.ts:108` and `:139`). Concord can tell an operator that a clawback had
no instruction. It cannot stop one.

The one place the codebase signs anything is the testnet practice script, covered below.

## Why

### 1. A key is custody, whatever the deployment is called

Whoever can sign for an issuer or a paying agent can move other people's assets. Holding that
capability makes the operator a custodian in substance — with the capital, insurance, audit,
key-ceremony and incident-response obligations that follow, whether or not the paperwork says so.
Concord is a software company selling a checking layer to firms that are already the regulated
party. Operators act as the transfer agent or custodian; Concord should not quietly become one.

### 2. The comparison has to be independent to be worth anything

Reconciliation works because the two sides are maintained by different processes: the chain by the
issuer's operations, the books by the registrar. If Concord executed the dividend *and* checked it,
the check would be against its own output — the self-referential version of a control. Keeping
execution out of the product is what makes "the register disagrees with the chain" a finding rather
than a tautology.

### 3. Key custody is a different engineering problem

Signing safely means an HSM or KMS, dual control over who can turn it on, rotation and recovery
drills, a key-ceremony audit trail, custody insurance, and somebody on call at 3am when a
transaction is stuck. A read-only deployment needs none of that: no wallet, no fee balance, no hot
key, no signing service to page someone about. Adding signing would bring a whole operational
surface — key custody and transaction recovery — for a capability the buyer's own desk already has.

### 4. The blast radius is smaller, and the damage is reversible

A read-only deployment still holds confidential data — who holds what, at which address, plus
account credentials. That is a serious incident (see `SECURITY.md`), but it is not an on-chain one.
The worst outcome of a compromise is disclosure and tampering with stored results, both of which can
be detected and rebuilt from the chain and the customer's own books. A stolen signing key produces
transactions that cannot be undone: a dividend paid to the wrong address is a claim, a tax event and
a client conversation, not a database restore.

### 5. Irreversibility cuts against the product's own purpose

Reconciliation exists because corporate actions go wrong. The tool that finds a short-paid dividend
is most useful when it has no power to repeat the mistake at scale, and when a human still decides
what to do about it. Automation of execution would turn every reconciliation bug into a payment
bug.

### 6. It is what buyers ask for

The firms that would deploy Concord are examined on custody and change control. A vendor asking for
a signing key widens their vendor-risk review, needs their security team to approve key material
leaving their boundary, and puts the vendor in the transaction path of assets they are accountable
for. "It cannot move anything" is a shorter conversation than any control set we could build.

## Where the line sits in the code

- `services/api/src/chain.ts` imports only readers from the SDK — `Address`, `Asset`, `StrKey`,
  `scValToNative`, `xdr` (line 2) — and talks to RPC `getEvents` and Horizon for opening balances.
  Nothing in that file builds a transaction.
- `services/api/src/concord.ts` writes assets, events, registers, journals, instructions, runs,
  actions and notes. Its outbound calls are the chain source's reads.
- `.env.example` has no signing key. The secrets it does carry are unrelated to Stellar:
  `CONCORD_GOOGLE_CLIENT_SECRET` (OAuth) and, optionally, an RPC provider's API key through
  `CONCORD_RPC_HEADERS`, which is read access. Session cookies are signed with a secret generated at
  boot and never persisted (`services/api/src/security.ts:81`).
- `services/api/src/config.ts` describes networks by passphrase, RPC and Horizon endpoints only —
  there is no field for an account secret anywhere in `Config`.
- The API's write endpoints stop at Concord's own records: workspace membership
  (`services/api/src/api.ts:135-166`) and, under `/assets/:id`, registers, journal, instructions,
  reconciliations, actions, notes, sync and rebuild (`:191-305`). There is no submit route to
  disable or protect.

A grep for `Keypair`, `SecretKey`, `TransactionBuilder` or `sendTransaction` outside tests returns
exactly one file: the practice script.

## The practice script is the exception, and it is boxed in

`pnpm demo:testnet` (`package.json:18` → `services/api/package.json:14`) issues a fake regulated fund
share and runs a full life cycle against it — subscriptions, a cash dividend, a transfer, a freeze, a
clawback, a redemption and a 2:1 split executed as mints. To produce a chain that disagrees with the
books in interesting ways, something has to *be* the issuer. That is why it is the only code in the
repository that signs.

It is deliberately not a prototype of a signing feature:

- **Throwaway keys, in memory only.** Every keypair is `Keypair.random()` inside `main`
  (`services/api/src/demo/testnet.ts:82-85`). Nothing is read from the environment, nothing is
  written to disk, and no secret is printed. The files it writes contain public addresses only.
- **Testnet by construction, not by flag.** The script takes `config.networks.testnet`
  (`services/api/src/demo/testnet.ts:27`) and funds accounts from `friendbot.stellar.org`
  (line 45). No setting or argument selects a network, and friendbot only funds testnet accounts,
  so there is no supported way to run it against mainnet.
- **It never opens a Concord database.** It imports `toCsv` from `@concord/core` and `loadConfig`,
  and writes three CSVs under `data/demo/`. A test enforces the boundary: it parses the script's
  imports and fails if `db`, `concord`, `tenants`, `main`, `auth` or `schema` appear, or if
  `watchAsset`, `importRegister` or `DatabaseSync` are mentioned
  (`services/api/test/tenancy.test.ts:720-727`).
- **Nothing in the product imports it.** It is reachable only through its own package script; the
  server, CLI and dashboard have no reference to it.
- **The books it writes are invented.** The holders are seven fictional rows — `H001`–`H006`,
  with `H004A` and `H004B` sharing one omnibus address — for a fictional fund. The register, journal
  and instruction files exist to make reconciliation produce known breaks. They are development
  fixtures, never sample customer data.

The isolation matters for the same reason as the decision: if the script shared a code path with
the server, "the server cannot sign" would stop being structurally true. Keeping the only signing
code in a separate entry point that no production module imports makes the guarantee auditable by
inspection, and the test above keeps it that way.

## How to treat proposals that add signing

A proposal that adds signing is not a feature request against this codebase; it is a proposal to
change the product's regulatory position. Treat it as a superseding decision, not a pull request:

1. **Start with an ADR that supersedes this one.** It should name the operator on whose behalf the
   key acts, the asset classes, the networks, and the legal review that was done. Maintainer
   sign-off is required before code.
2. **Keep it out of the server process and the dashboard.** A signing capability belongs in a
   separate tool or service with its own credentials and its own deployment, never in the process
   that serves uploads to signed-in users, and never behind an HTTP route that a session cookie can
   reach.
3. **Keys never touch Concord's storage.** They come from a secret manager or an external signer
   (HSM, KMS, custody provider), are held only for the duration of a request, and are never written
   to a workspace database, a log, a crash dump or the audit export.
4. **Testnet is the default; mainnet is an explicit, separate opt-in.** No setting today selects a
   network to write on, and a signing path must refuse mainnet unless configured for it by name —
   not inferred from `CONCORD_DEFAULT_NETWORK`.
5. **A human confirms each transaction.** Preflight the operation, show what will move and to whom,
   require an explicit confirmation, and store the resulting hash against the record that motivated
   it. No background loop signs anything.
6. **Assume the transaction will be wrong sometimes.** Define the correction runbook first (who is
   notified, what the compensating transaction is, who approves it) and make retries idempotent.
7. **Reconciliation must stay independent.** If Concord starts executing an action, keep reconciling
   it from the ledger against the books — and keep the two code paths separate, so a bug in
   execution cannot hide itself in the check.
8. **Update `SECURITY.md` and the threat model in the same change.** Key handling, network allowlists
   and refusal paths are in scope for review and for tests.

Proposals that should be declined even then: auto-executing corporate actions on a schedule,
signing from a web session, storing keys "for convenience", reusing the demo script's `submit`
helper as a production path, and anything that makes mainnet the default.

## Consequences

**Good.** No wallet, no fee balance, no key rotation, no custody audit in scope for the product. The
deployed service can be handed to a security reviewer as a read-only web app with an indexer. A
compromise cannot move client assets. The comparison stays independent of the operations it checks,
which is the whole point of the product.

**Costly.** Concord cannot repair what it finds. A short-paid dividend, a frozen holder that should
be active, or a split executed as mints all have to be fixed by the issuer or agent in their own
tooling; Concord supplies the evidence and the export, not the fix. Some prospects will ask for
"just a button" and the answer is no. The demo remains the only way to see Concord reconcile against
a chain that was built to break, and it needs an internet connection and a funded testnet account.

**Neutral.** The practice script keeps signing, so the guarantee is "no production code signs",
enforced by module boundaries and a test rather than by absence of the SDK.

## References

- `README.md` — *What it does*: "Read-only. Concord never holds keys or moves money."
- `docs/ARCHITECTURE.md` — "It never signs or submits anything."
- `services/api/src/chain.ts:2` — the SDK surface the indexer uses (decoders only)
- `services/api/src/concord.ts:1180` — `reconcileAction`: entitlements vs observed flows
- `packages/core/src/controls.ts:108`, `:139` — `controlEvents` and `buildControlsLog`: the log is
  built from the ledger, not from a command channel
- `services/api/src/api.ts:191-305` — the API's write surface
- `services/api/src/demo/testnet.ts` — the only signing code; testnet and throwaway keys
- `services/api/test/tenancy.test.ts:720-727` — the test that keeps the script away from every database
