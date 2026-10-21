# Break-Type Glossary & Investigation Guide

This document defines every break type emitted by Concord across position, movement, corporate action (distribution), and issuer control reconciliations. It details the severity, stable key format, typical root causes, investigation workflows, and the sign-off lifecycle for reconciliation analysts.

---

## The Break Lifecycle & Sign-Offs

When Concord compares on-chain ledger events against off-chain books (the register, transaction journal, or approved instructions), any difference beyond the configured tolerance produces a **Break**.

### Scopes

Breaks are partitioned into three note scopes ([`services/api/src/concord.ts`](../services/api/src/concord.ts)):
- `recon`: Position breaks and journal movement breaks evaluated during register and movement reconciliation.
- `controls`: Authorization, freeze, unfreeze, and clawback breaks evaluated against approved issuer instructions.
- `action:<id>`: Corporate action breaks evaluated for a specific dividend, split, or redemption distribution.

### Stable Keys & Fingerprints

Every break carries:
1. **`key`**: A stable identifier across reconciliation runs (e.g., `QUANTITY_MISMATCH:GABC...`). The key allows Concord to age breaks over time and preserve analyst notes across subsequent register uploads.
2. **`fingerprint`**: A hash or string representation of the quantities involved in the break:
   - **Positions & Movements:** `${chainUnits}|${registerUnits}`
   - **Distributions:** `${expected}|${observed}`
   - **Controls:** `key`

### Statuses & Sign-Off Workflow

Analysts can sign off on a break through the API or dashboard:
- **`open`**: The default state. A discrepancy exists that has not been acknowledged or resolved.
- **`acknowledged`**: The analyst has reviewed the discrepancy and determined it represents an understood in-flight state (e.g., standard T+1 settlement timing or a pending transfer). A non-empty explanatory note is required.
- **`resolved`**: The underlying discrepancy has been rectified off-chain or an adjustment is completed.

### Automatic Reopening (`noteStale`)

A sign-off is tied to the exact numbers present when the note was written. If an analyst acknowledges a discrepancy of 10 units, and on the next run the discrepancy widens to 25 units or narrows to 5 units, the `fingerprint` no longer matches the note's recorded fingerprint. 

Concord marks the note as stale (`noteStale: true`) and automatically reverts the break's effective status to `open`. This guarantees that partial or shifting breaks are never silently masked by previous sign-offs.

---

## 1. Position Breaks

Defined in [`packages/core/src/reconcile.ts`](../packages/core/src/reconcile.ts). Produced when comparing the on-chain `HoldingsState` derived from ledger events against the uploaded `RegisterPosition[]`.

| Type | Severity | Key Format | Description |
|---|---|---|---|
| `QUANTITY_MISMATCH` | `high` | `QUANTITY_MISMATCH:<address>` | On-chain balance differs from register units |
| `MISSING_IN_REGISTER` | `high` | `MISSING_IN_REGISTER:<address>` | Account holds on-chain balance but is absent from the register |
| `MISSING_ON_CHAIN` | `high` | `MISSING_ON_CHAIN:<address>` | Register records units for an account with zero on-chain balance |
| `UNMAPPED_HOLDER` | `medium` | `UNMAPPED_HOLDER:<holderId>` | Register holder has units but no associated on-chain Stellar address |
| `STATUS_MISMATCH` | `medium` | `STATUS_MISMATCH:<address>` | Register status (`active`/`frozen`) conflicts with on-chain trustline authorization |
| `SUPPLY_MISMATCH` | `high` | `SUPPLY_MISMATCH` | Total on-chain supply differs from total register units |
| `INCOMPLETE_HISTORY` | `high` | `INCOMPLETE_HISTORY:<address>` | Indexed events do not cover the account's complete history |

### `QUANTITY_MISMATCH`
- **Key:** `QUANTITY_MISMATCH:<address>`
- **Severity:** `high`
- **Typical Causes:**
  - Settlement timing differences (T+1 / T+2): trade settled on-chain before the transfer agent booked the subscription/redemption, or vice versa.
  - Off-chain transfer recorded in transfer agent books without an on-chain transfer transaction.
  - Rounding or decimal precision mismatch during CSV export.
- **Investigation:**
  1. Inspect the on-chain balance and recent transaction history for `<address>`.
  2. Inspect the transfer agent's position report as of the register's `asOf` timestamp.
  3. Verify pending journal entries or recent transfer transactions involving the address.
- **Sign-off Meaning:** Acknowledging indicates the cause of the variance is known and pending settlement; resolving indicates off-chain records or on-chain adjustments have aligned the balances.

### `MISSING_IN_REGISTER`
- **Key:** `MISSING_IN_REGISTER:<address>`
- **Severity:** `high`
- **Typical Causes:**
  - Secondary market transfer occurred between two on-chain wallets, but the receiving holder has not completed KYC/onboarding with the transfer agent.
  - Omission of an account in the transfer agent's CSV export filter.
- **Investigation:**
  1. Identify the transaction that funded `<address>` using the events view.
  2. Query the transfer agent's records to see if the holder is pending approval or mapped to a different account.
- **Sign-off Meaning:** Acknowledged while the transfer agent completes investor onboarding or updates the register export.

### `MISSING_ON_CHAIN`
- **Key:** `MISSING_ON_CHAIN:<address>`
- **Severity:** `high`
- **Typical Causes:**
  - Transfer agent recorded an issuance or subscription, but the on-chain mint transaction has not yet been broadcast or failed in the mempool.
  - An investor created a trustline that was later closed or merged.
  - Typo in the Stellar public key recorded in the register CSV.
- **Investigation:**
  1. Check the issuer's transaction broadcast queue for pending mint operations.
  2. Verify that `<address>` exists on Stellar and has an established trustline for the asset.
- **Sign-off Meaning:** Acknowledged while awaiting transaction broadcast or correcting the registered public key.

### `UNMAPPED_HOLDER`
- **Key:** `UNMAPPED_HOLDER:<holderId>`
- **Severity:** `medium`
- **Typical Causes:**
  - A traditional investor holds units in the transfer agent register, but has not provided or linked a Stellar account address.
  - Units are held in escrow or a pending distribution pool off-chain.
- **Investigation:**
  1. Review the holder profile in the transfer agent portal.
  2. Confirm whether the investor elected for tokenized custody or traditional paper/book-entry holding.
- **Sign-off Meaning:** Acknowledged if off-chain holding without a wallet address is permitted by fund terms.

### `STATUS_MISMATCH`
- **Key:** `STATUS_MISMATCH:<address>`
- **Severity:** `medium`
- **Typical Causes:**
  - Compliance officer placed an off-chain compliance hold on an account, but the on-chain `set_authorized` freeze transaction has not yet been submitted.
  - An on-chain freeze was executed following a court order or sanctions match, but the transfer agent register status was not updated to `frozen`.
- **Investigation:**
  1. Compare the register status (`active` vs `frozen`) with the on-chain trustline authorization flag (`chainStatus`).
  2. Check the controls log for recent `freeze` or `unfreeze` events and corresponding instructions.
- **Sign-off Meaning:** Acknowledged while coordinating between compliance and operations to submit the matching on-chain or off-chain status update.

### `SUPPLY_MISMATCH`
- **Key:** `SUPPLY_MISMATCH`
- **Severity:** `high`
- **Typical Causes:**
  - Net sum of all position breaks across the asset.
  - Unmapped holder units where units exist on the register without on-chain tokens minted.
  - Treasury or issuer reserve tokens excluded or included inconsistently between chain and register.
- **Investigation:**
  1. Check the summary figures: `chainSupply` vs `registerTotal` and `unmappedUnits`.
  2. Check whether issuer treasury accounts should be added to the `--ignore` list.
- **Sign-off Meaning:** Supply mismatch is an aggregate alert. Resolving individual position breaks will typically resolve the supply mismatch.

### `INCOMPLETE_HISTORY`
- **Key:** `INCOMPLETE_HISTORY:<address>`
- **Severity:** `high`
- **Typical Causes:**
  - The indexer's event window starts after the holder had pre-existing balance activity, leaving initial history unindexed.
- **Investigation:**
  1. Review the asset indexation starting ledger sequence.
  2. Take a verified baseline (`pnpm concord baseline` or Horizon opening balances) at a known ledger checkpoint.
- **Sign-off Meaning:** Acknowledged while establishing an authoritative baseline checkpoint.

---

## 2. Movement Breaks

Defined in [`packages/core/src/movements.ts`](../packages/core/src/movements.ts). Evaluated when a transaction journal CSV is imported, matching ledger transfer, mint, burn, and clawback events against off-chain journal records.

| Type | Severity | Key Format | Description |
|---|---|---|---|
| `MOVEMENT_AMOUNT_MISMATCH` | `high` | `MOVEMENT_AMOUNT_MISMATCH:<entry.ref>` | Journal entry and its matching on-chain transaction disagree on units |
| `UNSETTLED_ENTRY` | `high` | `UNSETTLED_ENTRY:<entry.ref>` | Journal entry has no matching on-chain transaction |
| `UNRECORDED_MOVEMENT` | `high` | `UNRECORDED_MOVEMENT:<eventId>` | On-chain ledger movement has no matching journal entry |

### `MOVEMENT_AMOUNT_MISMATCH`
- **Key:** `MOVEMENT_AMOUNT_MISMATCH:<entry.ref>`
- **Severity:** `high`
- **Typical Causes:**
  - Partial execution or fee netting applied on-chain but recorded gross in the journal (or vice versa).
  - Data entry error in the journal CSV `units` field.
- **Investigation:**
  1. Compare the journal entry's `units` against the transaction event `amount` on the ledger (`txHash`).
  2. Inspect the transaction operations to determine if fees or splits occurred.
- **Sign-off Meaning:** Acknowledged while correcting the journal entry or issuing an adjustment transaction.

### `UNSETTLED_ENTRY`
- **Key:** `UNSETTLED_ENTRY:<entry.ref>`
- **Severity:** `high`
- **Typical Causes:**
  - Journal entry was booked in anticipation of settlement, but the transaction was rejected, ran out of fee pool, or has not yet been submitted.
  - The cited `tx_hash` is invalid or refers to a different asset/network.
- **Investigation:**
  1. If `tx_hash` is present, check Horizon/RPC to see if the transaction exists or failed.
  2. If matching by attributes (parties, units, date window), verify whether the transaction date falls outside the matching window (`windowMs`).
- **Sign-off Meaning:** Acknowledged if the transaction is pending execution; resolved once settled or voided in the journal.

### `UNRECORDED_MOVEMENT`
- **Key:** `UNRECORDED_MOVEMENT:<eventId>`
- **Severity:** `high`
- **Typical Causes:**
  - Peer-to-peer transfer between token holders occurred without transfer agent notification.
  - An administrative mint, burn, or clawback was performed on-chain but omitted from the journal export.
- **Investigation:**
  1. Inspect the on-chain event `kind` (`mint`, `burn`, `transfer`, `clawback`) and the participating accounts (`from`, `to`).
  2. Cross-reference with transfer agent pending batches.
- **Sign-off Meaning:** Acknowledged while the transfer agent books the retroactive journal entry.

---

## 3. Issuer Control Breaks

Defined in [`packages/core/src/controls.ts`](../packages/core/src/controls.ts). Ensures that every administrative intervention on Stellar (`set_authorized` freeze/unfreeze, authorization, and clawback) is backed by an authorized off-chain instruction within an allowable execution window (default 72 hours).

| Type | Severity | Key Format | Description |
|---|---|---|---|
| `UNINSTRUCTED_CONTROL` | `high` | `UNINSTRUCTED_CONTROL:<eventId>` | On-chain control action was executed without an approved instruction |
| `UNEXECUTED_INSTRUCTION` | `medium` | `UNEXECUTED_INSTRUCTION:<instruction.ref>` | Approved off-chain instruction was never executed on-chain before expiry |

### `UNINSTRUCTED_CONTROL`
- **Key:** `UNINSTRUCTED_CONTROL:<eventId>`
- **Severity:** `high`
- **Typical Causes:**
  - Emergency key usage by operations without prior ticket creation.
  - The off-chain instruction was approved outside the 72-hour window (`windowMs`) relative to the on-chain execution time.
  - Discrepancy in the clawback amount between the instruction and the ledger event.
- **Investigation:**
  1. Determine the transaction signer and source account from the on-chain transaction.
  2. Check internal compliance and operations ticketing systems for emergency freezes or clawbacks.
  3. Verify whether an instruction was logged with a mismatched timestamp or identifier.
- **Sign-off Meaning:** Critical security review. Acknowledging confirms management review of an uninstructed or emergency operation.

### `UNEXECUTED_INSTRUCTION`
- **Key:** `UNEXECUTED_INSTRUCTION:<instruction.ref>`
- **Severity:** `medium`
- **Typical Causes:**
  - An instruction was approved by compliance (e.g. to freeze an account or claw back units), but operations failed to broadcast the transaction.
  - The instruction was cancelled or superseded off-chain without updating Concord's instruction list.
- **Investigation:**
  1. Check why the approved action was not executed within the 72-hour execution window.
  2. Determine if the instruction is still required or should be formally cancelled.
- **Sign-off Meaning:** Acknowledged if the action was cancelled or re-issued under a new reference.

---

## 4. Corporate Action / Distribution Breaks

Defined in [`packages/core/src/distributions.ts`](../packages/core/src/distributions.ts). Evaluated during corporate actions (cash/stock dividends, stock splits, pro-rata redemptions). Compares expected entitlement flows calculated from record-date holdings with observed ledger payments in the execution window.

| Type | Severity | Key Format | Description |
|---|---|---|---|
| `MISSING` | `high` | `MISSING:<address>` | Entitled record-date holder received no distribution flow |
| `SHORT` | `high` | `SHORT:<address>` | Holder received less than their calculated entitlement |
| `EXCESS` | `high` | `EXCESS:<address>` | Holder received more than their calculated entitlement |
| `UNEXPECTED` | `medium` | `UNEXPECTED:<address>` | Flow received by an account with zero entitlement at record date |

### `MISSING`
- **Key:** `MISSING:<address>`
- **Severity:** `high`
- **Typical Causes:**
  - Paying agent payout batch failed for this address (e.g., missing trustline for the payment asset).
  - Holder address was omitted from the payment disbursement file.
- **Investigation:**
  1. Verify if `<address>` has an established trustline for `payAsset`.
  2. Check paying agent disbursement logs for payment failures.
- **Sign-off Meaning:** Acknowledged while initiating a manual catch-up payment.

### `SHORT`
- **Key:** `SHORT:<address>`
- **Severity:** `high`
- **Typical Causes:**
  - Withholding tax or transaction fees deducted without reflecting net rate terms.
  - Rounding differences in fractional unit calculations.
- **Investigation:**
  1. Compare `expected` vs `observed` units.
  2. Check if the difference matches standard withholding tax percentages or rounding rules (`rounding` option in `DividendTerms`).
- **Sign-off Meaning:** Acknowledged if the shortfall represents verified tax withholding or agreed fractional rounding.

### `EXCESS`
- **Key:** `EXCESS:<address>`
- **Severity:** `high`
- **Typical Causes:**
  - Duplicate disbursement transaction executed by the paying agent.
  - Incorrect entitlement calculation applied off-chain.
- **Investigation:**
  1. Inspect `txHashes` on the observed flow to identify duplicate payments.
  2. Calculate the difference and contact the recipient / paying agent.
- **Sign-off Meaning:** Acknowledged while arranging a reclamation or offsetting adjustment.

### `UNEXPECTED`
- **Key:** `UNEXPECTED:<address>`
- **Severity:** `medium`
- **Typical Causes:**
  - Payment sent to an account that acquired tokens after the record date cutoff.
  - Non-holder or excluded address (e.g. treasury) included in the payout batch by mistake.
- **Investigation:**
  1. Check the account's holding balance at the exact `recordTime`.
  2. Determine why the paying agent included this recipient.
- **Sign-off Meaning:** Acknowledged while documenting the reason for non-entitled distribution or initiating return of funds.
