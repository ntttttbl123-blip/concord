# Testnet practice asset walkthrough

Concord ships no sample data: the chain side comes from the ledger, the register side is whatever
file you upload, and a fresh workspace is empty. To make the first hour interesting,
`pnpm demo:testnet` issues a fake regulated fund share on Stellar's public testnet, runs a
complete life cycle against it — subscriptions, a cash dividend, a transfer, a freeze, a
clawback, a redemption and a 2:1 split — and then writes three "official books" (a register, a
journal and an instruction log) that disagree with the chain in known ways. Nothing is loaded for
you: you watch the asset and import the files by hand, the way a real user would, and Concord
should find exactly the breaks the script planted.

This document covers the whole walk: what the script does and prints, what to look at on the
testnet ledger, how to load the books, and every break Concord raises, with the reason each one
appears. Every statement below was checked against the code ([`services/api/src/demo/testnet.ts`](../services/api/src/demo/testnet.ts)
and the reconciliation modules in [`packages/core/src`](../packages/core/src)) and against a live
run of the script plus a full load of its output.

The books the script writes are invented. They use fictional holder names and fresh Stellar
testnet keys generated per run; they exist for development and practice only, and contain no real
holder data. The script never opens a Concord database and never signs anything after it has
finished — Concord itself is read-only.

## What `pnpm demo:testnet` does

The script ([`services/api/src/demo/testnet.ts`](../services/api/src/demo/testnet.ts)) generates
random Stellar keypairs, funds the issuer from [friendbot](https://friendbot.stellar.org), and
settles nine life-cycle transactions plus its friendbot funding on public testnet. It then writes three CSVs to `data/demo/` under the
data directory ([`services/api/src/config.ts`](../services/api/src/config.ts), so
`CONCORD_DATA_DIR` moves it) and prints what to watch for each break.

Sequence of the scripted life cycle (`submit` calls in the file):

1. **Accounts + regulated flags.** Creates the paying agent, five holders, and turns on
   `AUTH_REQUIRED`, `AUTH_REVOCABLE` and `AUTH_CLAWBACK_ENABLED` on the issuer. Anything
   Concord's indexer reacts to — authorization changes, the clawback rail — is live from here.
2. **Trustlines + authorizations.** Six trustlines and authorizations, for the paying agent and
   the five practice holders. The bank mints the paying agent 100,000 units of the cash asset
   USDX, which is what the later dividend is paid in.
3. **Subscriptions (mints).** The issuer mints 11,250 fund units: 1,000 to the paying agent and
   10,250 across the five practice holders.
4. **Cash dividend (USDX).** The paying agent pays 0.05 USDX per fund unit held at the mint
   step — deliberately one holder short and one holder missed — 495 USDX to four accounts.
5. **Transfer.** One holder sends 400 units to another.
6. **Freeze.** The issuer freezes one holder's trustline.
7. **Clawback.** The issuer claws 100 units straight out of an account with no instruction behind
   it. Concord has no way to know: there is nothing in the instruction log.
8. **Redemption.** A holder pays 50 units back to the issuer (a burn).
9. **Split (mints).** 2:1, executed as mints (9,600 more units), skipping the frozen holder.

The three files, written by the script: `register.csv` (holder list the books claim as of
shortly after the redemption), `journal.csv` (eight journal entries) and `instructions.csv`
(authorizations behind the first issue, a freeze, and a stale unexecuted freeze).

## Before you start

- Node 24+ and pnpm 10.22 (see CONTRIBUTING), `pnpm install` as usual. `pnpm build` is only needed if you will run
  the built server (`pnpm start`); the script itself runs on `tsx` from source.
- Outbound access — testnet RPC at `soroban-testnet.stellar.org` and friendbot funding.
- A few minutes of wall time. Transactions settle in seconds and the script polls with backoff,
  exiting non-zero if any step fails. If friendbot rate-limits, wait a moment and re-run; each
  run starts over with fresh keys.

## 1 · Run the script

```
$ pnpm demo:testnet

Funding the issuer from friendbot…
Running the asset life cycle on testnet:
  accounts and regulated flags       ledger 5257215
  trustlines and authorisations      ledger 5257216
  subscriptions (mints)              ledger 5257217
  cash dividend from paying agent    ledger 5257218
  holder 1 transfers 400 to holder 2 ledger 5257219
  issuer freezes holder 3            ledger 5257221
  issuer claws back 100 from holder 4 ledger 5257222
  holder 5 redeems 50                ledger 5257223
  2:1 split (mints)                  ledger 5257224

On testnet now (split settled in <HASH>).

Watch these in a workspace, with the network set to Testnet:
  ACMEF:GBB7Q7U6PIGPFLUC7DJNM7KGQH3AQ7UCZ6EVUUFRUYHZUWB7POKPEMCZ
      keep off the register: GCK2O3ZNH3D6A22GFGZAATKF3DB4OETQMJYU3QA77XP2LXPX6MLKLNLE
  USDX:GDZOIBBKKLZE4EZKH63CRV4WM5OS4DTQALPHO42FQIPI2JQPBMJXCBPW

Then load the practice books from /…/data/demo:
  register.csv      as of 2026-10-18T07:48:22.000Z
  journal.csv
  instructions.csv

Corporate actions to try:
  dividend  record 2026-10-18T07:47:52.000Z  window to 2026-10-18T07:48:22.000Z  rate 0.05  paid in USDX  payer GCK2O3ZNH3D6A22GFGZAATKF3DB4OETQMJYU3QA77XP2LXPX6MLKLNLE
  split     record 2026-10-18T07:48:22.000Z  ratio 2:1
```

Yours will differ in every account address, transaction hash, timestamp, and ledger number: the
script generates fresh keys each run. The *shape* is always the same: one line per life-cycle
step, then the assets to watch, then the three books, and two "corporate actions to try" lines
that give you the record times and rate to run in step 5.

Hold on to four things the output prints:

- the **first ledger number** (`accounts and regulated flags … ledger <N>`) — you will pass it to
  `--from` in step 4 so Concord can replay the full life cycle,
- the **fund asset** (`ACMEF:<issuer>`) and the **pay** asset (`USDX:<bank>`),
- the **paying agent** — the address after `keep off the register`,
- the **as-of time** of the register and the **record times** of the two actions (the dividend
  record is the settle time of the mint step, the split record is the redemption's).

## 2 · Watch the asset on testnet

Nothing you must do here, but the point of the exercise is to be able to point a skeptical
third party at the chain and see the same numbers. Open a testnet explorer such as
[StellarExpert](https://stellar.expert/explorer/testnet) and search for the issuer
address the script printed. If the run succeeded you should find, under the issuer account:

- an asset `ACMEF`, flagged **Auth required / Auth revocable / Clawback enabled** (the
  `setOptions` call in step 1);
- six authorized trustlines — the five practice holders and the paying agent — and one frozen
  one (the holder the issuer froze in step 6);
- payments the issuer made: the 11,250 mints of step 3, the 400-unit transfer, the 100-unit
  clawback, the burned 50, and the 9,600 split mints. The dividend events live on the USDX
  asset's page instead, under the same run's bank address.

The date is arbitrary and the units are fake ACMEF units; the keys were friendbot-funded
throwaways, so do not put anything real in them. The asset stays on public testnet, address
and all, for as long as you keep the run's records.

## 3 · Point Concord at it

Either use the dashboard or the CLI, whichever is easier. With the dashboard: start the server
(`pnpm start`, or `pnpm dev`), open its address and sign up. Concord serves both networks; the
switch is at the top left of the asset list. Create a workspace and add the asset.

On the command line, against the same data directory as the server if one is running
([`pnpm concord`](../services/api/src/cli.ts)):

```sh
export CONCORD_ORG="My Workspace"        # or pass --org to each command

pnpm concord watch 'ACMEF:<issuer>' \
    --network testnet \
    --from <first ledger from step 1> \
    --name 'ACMEF Fund' \
    --ignore '<paying agent from step 1>'

pnpm concord watch 'USDX:<cash issuer>' \
    --network testnet \
    --from <first ledger from step 1> \
    --name 'USDX (pay asset)'
```

Two details worth understanding rather than copying:

- **`--from <ledger>`.** Concord for classic assets defaults to *baseline mode*: on watch it
  reads every current balance from Horizon and only indexes events from that moment on. For this
  asset, whose entire life cycle has likely already settled by the time you watch it, a baseline
  contains the *end* state, and the historical record times the printed dividend and split want
  are unreachable. `--from <ledger>` tells Concord to replay the events themselves from that
  ledger (and works because testnet RPC retention, roughly a week, still covers it). That is
  what makes all four record-time reconstructions in step 5 exact.
- **`--ignore <paying agent>`.** The paying agent is the issuer's own distribution account:
  the script prints `keep off the register` because the books the script writes do not list it.
  Ignoring it is not cosmetic. The ignore list drops an address from both sides of every
  comparison — positions, movements and corporate actions — so the remaining breaks are exactly
  the planted ones. Every check in the next section was run with the paying agent ignored. If
  you leave it out, expect one extra `MISSING_IN_REGISTER` break for an address the register
  never names; that is what the printed hint is protecting you from.

If reconciliation on the asset page complains about an "incomplete history" or the numbers look
twice-counted, you did not pass `--from`; delete the asset (`pnpm concord unwatch ACMEF` — books
and all, or under settings in the dashboard) and watch again with a ledger number.

## 4 · Load the practice books

All three, in the same workspace, all against ACMEF. Via the CLI:

```sh
pnpm concord register ACMEF data/demo/register.csv --as-of '<printed redeem time, e.g. 2026-10-18T07:48:22.000Z>'
pnpm concord journal ACMEF data/demo/journal.csv
pnpm concord instructions ACMEF data/demo/instructions.csv
```

Via the dashboard, ACMEF's asset page has an **Import** panel with register, journal and
instructions — each form takes the file and (for the register only) the as-of time; every form
offers a blank template if you want to see the columns with none of the values.

What each import triggers (all in [`services/api/src/concord.ts`](../services/api/src/concord.ts):
`importRegister` / `importJournal` / `importInstructions` and the reconciliations behind them):

- the **register** import runs a position reconciliation at the as-of time and immediately
  posts the breaks it finds;
- then the **journal** import runs movement reconciliation across the import window;
- the **instructions** import builds the controls log (no break output at import time; check
  the "Controls" tab, or run `pnpm concord controls ACMEF`).

The register's as-of time is the script's *redemption* settle time: that is the instant the
books purport to be a snapshot. Everything else in the files is the script's fixed practice
data: holders H001–H006, eight journal entries, eight instructions.

## 5 · What you should find, and why

The whole point of the practice asset is that every break has a reason: the script plants known
faults on purpose, and Concord should catch exactly those and nothing else. What follows is the
verified result of one live run, with the reason for every planted row.

### 5.1 Positions (after the register import)

| Break | Subject | What the row says | Why it appears |
|---|---|---|---|
| `QUANTITY_MISMATCH` | H001's account | chain 4,600 vs register 5,000 (−400) | The books show the original 5,000-unit subscription. The chain shows 5,000 less the 400-unit transfer of step 5, because the register has not posted that transfer. |
| `QUANTITY_MISMATCH` | H002's account | chain 3,400 vs register 3,000 (+400) | The other side of the same transfer: the register never posted the 400 units that arrived on chain, so the books stay at the original 3,000 while the chain balances at 3,400 before anything else happens. |
| `STATUS_MISMATCH` | H003's account | register `active`, chain `frozen` | The issuer froze that trustline in step 6 (instruction I-007, court order), but the register still lists the holder as `active`. This is a plain disagreement about the holder's state, not their units — which is why the quantity columns match. |
| `UNMAPPED_HOLDER` | H006 | register 100 units, no account | H006, the "estate" line, has units in the books but no address: a placeholder for paper that has not yet been mapped to the chain. Concord cannot check a holder it cannot find, so it flags the row instead of silently counting it. |
| `SUPPLY_MISMATCH` | — | chain 10,100 vs register 10,200 (−100) | With the paying agent ignored, both sides are complete and the ±400 quantity breaks cancel, so the whole supply difference is exactly the 100 estate units H006 holds in the books and the chain holds nowhere. The supply line is where an unmapped row like that eventually has to show. |

Two lines match: H004's omnibus account, whose two rows total 400 on both sides, and H005,
whose register line agrees with its chain balance. With the paying agent ignored there are no
`MISSING_IN_REGISTER` breaks.

It is worth pressing on the ±400 pair: one real transfer appears as exactly two mirrored
quantity breaks, one per account, and no third phantom break. The chain is the truth both rows
measure against; Concord does not pair breaks with each other, or let one bad row hide its
counterparty.

### 5.2 Movements (after the journal import)

| Break | Subject | What the row says | Why it appears |
|---|---|---|---|
| `UNSETTLED_ENTRY` | J-008 (transfer, 200 units) | journal entry with no matching ledger event | J-008 records a 200-unit transfer between H002's and H003's accounts that never happened on chain. Matched by amount, parties and a day-wide window, no ledger event is close enough, so the entry stays unsettled — a book row with nothing behind it. |
| `UNRECORDED_MOVEMENT` | H001 → H002 account (400 units) | on-chain transfer not in the journal | The one real transfer of step 5 exists on the chain but was never journalled. Read together with J-008 the books look like a transfer that went between the wrong accounts — a posting error — but Concord does not have to guess that: one journal entry with no ledger event, one ledger event with no journal entry, two independent high-severity flags. |

(The movement report is scoped to the register's as-of, so the four split mints that settled
after it are outside the window and are not flagged here; the dividend was paid in USDX, which
the fund's journal does not cover. Seven of the eight journal entries matched an on-chain event
by amount and parties — J-001 to J-005 the issues, J-006 the clawback, J-007 the redemption —
so the books' matchable side is near-perfect; the two planted breaks are the only thing left.
Run `pnpm concord reconcile ACMEF` to re-run against the same register.)

Notice what does **not** appear: no movement break for the 9,600 units of split mints. The
journal carries no issue entries for the split because the split is handled as a corporate
action (5.4) on its own record-time basis, not as journalled movements; had the books journalled
the split as issues, the ledger would have shown the same mints and they would have matched.

### 5.3 Controls (after the instructions import)

| Break | Subject | What the row says | Why it appears |
|---|---|---|---|
| `UNINSTRUCTED_CONTROL` | H004's account (clawback, 100 units) | on-chain clawback with no instruction behind it | Step 7 executes a real clawback on-chain. `instructions.csv` contains no `clawback` row at all, so there is nothing the action could be tied to and Concord raises a high-severity break against the on-chain event. If the file had contained a row for the wrong amount, or issued outside the 72-hour corridor, the same break type is what would surface. |
| `UNEXECUTED_INSTRUCTION` | I-008 (freeze, H005's account) | instruction issued five days ago, never executed | The instruction log contains a freeze for H005 dated five days before the run, "sanctions screening hit" as the recorded reason. Nothing at all happened to H005's trustline on-chain, so after the 72-hour execution window passes it is flagged as an instruction that was never carried out. |

The other seven instructions all match cleanly: I-001–I-006 tie to the on-chain authorization
of each account, and I-007 (the freeze) ties to the on-chain freeze of step 6. An instruction
stands behind an action only when it names the same account and type and was issued in the 72
hours before it ([`packages/core/src/controls.ts`](../packages/core/src/controls.ts)), which is
exactly the margin the script's dates respect. Both break types are the failure modes of that
rule: an event the paper trail cannot explain, and a paper trail the chain never acted on.

### 5.4 Corporate actions

Both were printed at the end of step 1. The record times *are* the on-chain times the script
settled the mints (step 3) and the redemption (step 8), so the snapshot Concord takes at each
record time is the true holding state at that exact ledger close.

**Dividend** — `record 2026-10-18T07:47:52.000Z · rate 0.05 · paid in USDX ·
payer <paying agent>`:

| Line | Basis (units at the record time) | Expected (USDX) | Observed (USDX) | Status |
|---|---|---|---|---|
| H001 | 5,000 | 250.0 | 250.0 | ok |
| H002 | 3,000 | 150.0 | 150.0 | ok |
| H003 | 1,500 | 75.0 | 70.0 | **SHORT by 5.0** |
| H004 (omnibus) | 500 | 25.0 | 25.0 | ok |
| H005 | 250 | 12.5 | 0.0 | **MISSING (12.5 owed)** |
| total | | 512.5 | 495.0 | difference −17.5 |

Why each break: the script's dividend deliberately pays H003 seventy USDX where seventy-five
are due, and pays H005 nothing at all. The entitlement is computed per holder from the fund's
holdings at the record time, then compared against the USDX flows actually observed on the pay
asset in the execution window — which is why step 3 has you watch USDX too. The two planted
breaks are the five-USDX shortfall and the whole missed 12.5; the three clean lines show what
agreement looks like sitting between two disagreements.

**Split 2:1** — `record 2026-10-18T07:48:22.000Z · ratio 2:1`:

| Line | Basis (units at the record time) | Expected delta (units) | Observed delta (units) | Status |
|---|---|---|---|---|
| H001 | 4,600 | +4,600 | +4,600 | ok |
| H002 | 3,400 | +3,400 | +3,400 | ok |
| H003 | 1,500 | +1,500 | 0 | **MISSING (+1,500 owed)** |
| H004 (omnibus) | 400 | +400 | +400 | ok |
| H005 | 200 | +200 | +200 | ok |
| total | | 10,100 | 8,600 | difference −1,500 |

Why it appears: the split transaction (step 9) mints the doubled amounts to every account
**except the frozen H003 trustline** — a frozen account cannot receive, so the paying agent's
script left it out, and that is precisely the operational problem the reconciliation catches: at
the record date H003 was entitled to +1,500 units, and the chain never attempted to deliver
them. Check the transaction on StellarExpert to see only five mints leaving the issuer in the
split transaction.

Note the *shape*: like the dividend, the basis is the true chain state at the record time, not
the books you imported, and the observed side is the mints the ledger shows in the window after
that record. Both corporate-action reconciliations depend on the `--from` watch in step 3.

## 6 · Fixing the books, and what happens next

Concord's sign-off model is that a break's resolution is carried forward against the exact
figures it was written against ([`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)). Practice manipulations:

- Add a journal entry for the missing transfer (400 units, H001 → H002, with the on-chain
  transaction hash) and re-import the journal: imports are upserts keyed by ref, so the new row
  is all it takes. The UNRECORDED_MOVEMENT clears; the UNSETTLED_ENTRY for J-008 has no chain
  event anywhere to match, so it stays.
- Fix the register (H001 to 4,600, H002 to 3,400, H003's status to frozen) and import again at
  the same as-of; the latest import becomes the register of record. The three position breaks
  clear, leaving the supply difference — still exactly the 100 estate units — until H006 is
  mapped or removed.
- Import a `clawback` row into `instructions.csv` for the step-7 clawback: 100 units, H004's
  account, issued in the 72 hours leading up to it. The `UNINSTRUCTED_CONTROL` clears.
- Take a sign-off on a break in the dashboard (sign-off is the one thing without a CLI
  command), then import a changed register at the same as-of and re-run: a sign-off holds only
  while the figures it was written against are unchanged, so it reopens.

To reset the whole workspace exercise, `pnpm concord unwatch ACMEF` (and `USDX`) deletes the
asset, its index and all its books; the testnet asset itself stays where it is, yours to re-watch
from the same first ledger.

## Caveats

- Every address, hash, ledger and timestamp above comes from one live run and **will differ in
  yours**; the units and the break types are fixed by the script.
- The testnet asset and the fictional books are for practicing with Concord, for showing new
  people the room, and for evaluator demos. The holder names are made up, the money is worthless,
  and no production transfer agent is on the other end of it.
- The script takes [free public endpoints](https://soroban-testnet.stellar.org) and can be
  adversarial about rate limits or friendbot uptime. Retrying it whole is safe: each run uses
  new keys, so no state carries over between attempts.
- Nothing in this walkthrough touches a real network side: the script is hard-wired to the
  testnet endpoints in [`services/api/src/config.ts`](../services/api/src/config.ts), and
  Concord itself never signs or submits anything. Running it against a real asset is the same
  walkthrough with higher stakes, which is what the README's limits and prior-art sections are
  about.
