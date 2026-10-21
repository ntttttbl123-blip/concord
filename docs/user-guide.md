# Dashboard user guide

For analysts using Concord to reconcile a Stellar asset against their register. It covers signing in,
watching an asset, the six tabs on an asset page, importing files, reading and signing off breaks, and
the workspace and team settings. Every screen described here is the dashboard in `apps/web/src`.

## Signing in and creating a workspace

A **workspace** holds the assets your organisation watches and the books you upload. Nobody else can
reach it: each workspace is a database of its own (see [`ARCHITECTURE.md`](./ARCHITECTURE.md)).

- **Create a workspace.** On the sign-in page follow **Create one**. The form asks for your name (shown
  beside every break you sign off), your work email, a workspace name and a password of at least ten
  characters. When the server is configured for invite-only sign-up, it also asks for a sign-up code
  issued by the operator. Signing up with Google is offered when the server has Google configured
  (`apps/web/src/Auth.tsx`).
- **Sign in.** Email and password, or Google when configured. A forgotten password is reset from the
  operator's command line with `pnpm concord reset-link EMAIL`; the link works once and signs out the
  account's other sessions.
- **Colleagues.** Owners invite people by email from the team page. Concord sends no email: the owner
  creates an invitation link and passes it on. The link works once and expires after seven days.

After signing in you land on **All assets** for the current network.

## Networks

When the server serves more than one network, a Mainnet/Testnet switch sits at the top left of every
page (`apps/web/src/App.tsx`). The asset list, the watched assets and every figure are per network, so
switching shows the assets watched on the other one. On Testnet a notice reminds you that nothing
there is a real security or a real holder. Opening an asset that belongs to the other network brings
the switch with it.

## Watching an asset

From **All assets** choose **Watch asset** (`apps/web/src/Overview.tsx`). Nothing is watched on a
guess, so Concord finds the asset first:

1. Enter an asset code of up to twelve letters or digits (such as `BENJI`), a full `CODE:ISSUER`, or a
   SEP-41 contract id starting with `C`.
2. For a bare code, Concord lists every issuer using it. Anyone can issue an asset under any code, so
   pick by the issuer address your records hold. The table shows each issuer's trustline count,
   authorised units and issuer controls (approval required, freezable, clawback).
3. Confirm the asset. A display name is optional, and is how the asset is listed in the workspace.
   **Addresses kept off the register** are issuer treasury or distribution accounts whose balances are
   not compared with the register.
4. A contract token that does not state its decimals asks for them before it can be watched.

**Watch asset** reads the ledger and takes a baseline, which can take a minute or two for a widely held
asset. The asset page shows an **Indexing** badge and fills in on its own. A classic asset starts from
every trustline's balance (Horizon) at a ledger, then follows events from there. A contract token has
no opening balances, so its holdings count only movements from the oldest ledger the RPC keeps, about
seven days back, and the page says so.

Each asset's **Settings** button (`apps/web/src/App.tsx`, `AssetSettings`) shows its contract, network,
decimals and history range, and offers:

- **Save** a new display name or a new list of addresses kept off the register.
- **Rebuild history** to discard the indexed events and read the asset again from fresh opening
  balances. Registers, journals, instructions, past reconciliations and sign-offs are kept. Use it
  after a gap in indexing.
- **Stop watching**, which only an owner can do. It removes the asset and every book recorded against
  it, and cannot be undone.

## The six tabs

Every asset page has the same six tabs in this order (`apps/web/src/App.tsx`). A tab carries a count
badge when it has open breaks: positions for Reconciliation, controls for Controls, entitlements for
Corporate actions.

### Reconciliation

The main tab. Import the register your transfer-agent system exports and Concord compares it with the
asset's on-chain holdings at the as-of instant (`apps/web/src/tabs/Reconciliation.tsx`).

- **Register export** is CSV with `holder_id` and `units`, and optionally `holder_name`, `account`
  (the holder's Stellar address) and `status` (`active` or `frozen`). Several holders may share one
  `account` (omnibus).
- **Register as of** is the instant the register is taken. Chain holdings are read at the same instant.
- **Import and reconcile** uploads the file and runs the comparison. Importing a register raises a
  reconciliation by itself; so does re-running one. Nothing reconciles on a timer.
- The optional **transaction journal** is CSV with `ref`, `date`, `type` (`issue`, `transfer`,
  `redeem` or `clawback`) and `units`, and optionally `from_account`, `to_account`, `tx_hash`. It
  enables movement matching against the ledger.

Once a run exists, the tab lists the runs in a selector with a **Re-run** button and an **Import
register** toggle. The figures at the top are the result, units on chain and on register, the supply
difference, positions matched, and open breaks. Below them:

- **Breaks** is the list described under [Reading and signing off breaks](#reading-and-signing-off-breaks).
- **Positions** lists a row per address with the register holders, chain units, register units, the
  difference and both statuses. **Only unmatched** hides the rows that agree. The register file's
  SHA-256 is printed under the table so a reviewer can tie the run to an exact file.
- **Imported registers** lists every register file for the asset, with the rows it turned away, who
  imported it, and a way to delete it. Deleting a register also deletes the reconciliations run
  against it.

Rows a CSV import could not read are listed with their line number and the reason, and the rest of the
file is loaded. Each import form offers a blank template.

### Holdings

Holdings at a chosen instant, defaulting to the latest indexed ledger (`apps/web/src/tabs/Holdings.tsx`).
The **As of** field takes a local time and blanks back to the latest. The figures are units
outstanding, holders, the instant shown, and the last ledger applied. Each holder row shows the
address, units, share of supply and status, and addresses kept off the register carry an **Off
register** badge. If any holder comes out with a negative derived balance the tab says the asset has
history from before the indexed range and points at **Rebuild history**.

### Corporate actions

Record a dividend, split or redemption and Concord freezes holdings at its record time, works out what
each holder is owed, and compares that with the ledger afterwards (`apps/web/src/tabs/Actions.tsx`).

- **Dividend or distribution** takes a rate per unit, the asset it is paid in (a watched asset on the
  same network; the same asset means paid in kind), and an optional paying agent address. An empty
  paying agent counts mints of the pay asset.
- **Split** takes new units and old units (2 for 1 is new 2, old 1).
- **Redemption** takes units redeemed and the holding they are out of (1 of 1 redeems in full).
- **Record time** is the instant holdings set the entitlement. **Execution window ends** is optional
  and open-ended when empty. **Label** is an optional name for reports.

**Snapshot and reconcile** creates the action. An action recorded ahead of its record time is
**scheduled**: Concord takes the snapshot and reconciles it by itself once the chain passes the record
time. The detail view shows the expected and observed totals and their difference, the breaks, and an
**Entitlements** table with each holder's record holding, expected, observed, difference, result and
transaction hashes. **Reconcile again** reruns it.

### Controls

Closes each freeze, authorisation change or clawback on the ledger against the instruction that
caused it (`apps/web/src/tabs/Controls.tsx`). The figures are control actions on chain, those backed by
an instruction, those with no instruction, instructions never executed, and instructions awaiting
execution. **Exceptions** lists the breaks, and the **Log** lists each control action with its
instruction, approver, reason and transaction. **Awaiting execution** lists instructions not yet seen
on chain.

Upload **instructions** as CSV with `ref`, `type` (`authorize`, `freeze`, `unfreeze` or `clawback`),
`account` and `issued_at`, and optionally `units` (required for a clawback), `approved_by` and `reason`.
An instruction covers an action taken within 72 hours after it.

### Events

The raw event trail the figures are derived from (`apps/web/src/tabs/Events.tsx`). Filter by event type
(transfer, mint, burn, clawback or authorisation) and by address. The table shows the close time,
ledger, event, from and to addresses, units and transaction. **Load older** pages back a hundred events
at a time. When the index has moved on since the list was read, the refresh button reads newer events.

### Audit export

Regulator and auditor reports for a period (`apps/web/src/tabs/Export.tsx`). **Period from** empty
starts at the first indexed ledger; **Period to** empty ends at the latest. The **audit pack** is one
JSON file with holdings, reconciliations, corporate actions, the controls log and the event trail for
the period, carrying a SHA-256 digest of its content so a reviewer can confirm it was not altered.
Separate CSV downloads are offered for holdings, breaks, the controls log and ledger events.

## Reading and signing off breaks

One break list serves positions, movements, corporate actions and controls (`apps/web/src/breaks.tsx`).
Each row is a break type (`Quantity mismatch`, `Not on register`, `Status mismatch`, `Supply mismatch`,
`Incomplete history`, `Unrecorded movement`, and so on), its subject (an address, a reference, holder
ids or the whole asset), the two figures and their difference, when it was first seen, and its status.

Choose **Review** to open the sign-off panel. A note is required to acknowledge or resolve: it is what
an auditor reads beside the sign-off. The buttons are:

- **Acknowledge**: seen, not yet closed.
- **Resolve**: closed, with the note recorded.
- **Reopen**: shown once a break is not open, to return it to open with a note.

Who signed is taken from the session on the server, so nothing typed can change it. A sign-off holds
only while the figures it was written against are unchanged. If the break moves, it reopens on its own
and the panel says the figures changed after the last sign-off, keeping the earlier note below. Notes
and statuses are carried into the audit export.

## Workspace and team

**Settings** in the sidebar holds three sections (`apps/web/src/Settings.tsx`).

- **Your account** shows your name, email and sign-in methods (password, Google). You can set or change
  a password; changing it signs out your other sessions. When the server has Google configured and the
  account has no Google yet, you can connect the Google account for the same address.
- **Team** lists members with their role and join date. Owners can change a member's role, remove a
  member, and create invitation links by email with a member or owner role. A member who belongs to
  more than one workspace can leave the current one.
- **Workspace** shows the workspace name; owners can rename it or delete it. Deleting a workspace
  removes every watched asset, register, journal, instruction, reconciliation and sign-off in it, and
  the accounts of people who belong to no other workspace, and cannot be undone. If you belong to more
  than one workspace, a selector switches between them.

## Where to look next

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) for how the code fits together.
- [`../README.md`](../README.md) for the input file columns, what Concord flags, and its stated limits.
