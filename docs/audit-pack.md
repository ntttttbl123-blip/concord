# Audit pack format reference

This document describes the audit pack Concord produces for one watched asset: the JSON pack, its four CSV sections, the period rules and the file names. It is written for auditors and integrators.

## How to get a pack

| Route                                                                       | Output                                                                                                        |
| :-------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------ |
| `GET /api/assets/:id/export`                                                | The JSON pack, returned inline                                                                                |
| `GET /api/assets/:id/export?download=1`                                     | The same JSON, sent as a download named as in [File names](#file-names)                                       |
| `GET /api/assets/:id/export?section=<name>`                                 | One CSV section. `<name>` is `holdings`, `events`, `controls` or `breaks`                                     |
| `concord export ASSET [--from ISO] [--to ISO] [--csv SECTION] [--out FILE]` | The same JSON or CSV from the CLI. With no `--out` it writes to stdout; the file name is whatever you give it |

`from` and `to` are optional query parameters on the API routes and `--from` / `--to` flags on the CLI. An unsupported section is rejected with `section must be holdings, events, controls or breaks`.

_Source: `services/api/src/api.ts` (export route), `services/api/src/cli.ts` (export command), `services/api/src/concord.ts` (`exportCsv`)._

## File names

Names are built from the asset code and the UTC date the file was generated (`YYYY-MM-DD`). Any character in the asset code outside `A-Za-z0-9._-` is replaced with `-`.

- **JSON pack:** `concord-{code}-audit-{YYYY-MM-DD}.json`. This name is only sent when `download` is set; without it the JSON is returned inline with no download name.
- **CSV section:** `concord-{code}-{section}-{YYYY-MM-DD}.csv`

_Source: `services/api/src/api.ts`._

## Period semantics

A pack covers the window `[from, to]`. Both bounds are inclusive.

- `from`: defaults to `1970-01-01T00:00:00.000Z`.
- `to`: defaults to the asset's indexed-to time (`asset.syncedAt`). If the asset has never synced, it defaults to the time of the request.
- Any value `Date.parse` accepts is allowed. It is normalised to an ISO 8601 UTC string. An unparseable value is rejected with `<field> is not a valid date`.
- The applied bounds are reported back in `period`.

### What the period filters

| Section                                  | Filtered by period?                                 | Field compared   |
| :--------------------------------------- | :-------------------------------------------------- | :--------------- |
| `reconciliations`                        | Yes                                                 | the run's `asOf` |
| `corporateActions`                       | Yes                                                 | `recordTime`     |
| `controls.records`                       | Yes                                                 | `closedAt`       |
| `events`                                 | Yes                                                 | `closedAt`       |
| `holdings`                               | No. State of the ledger as of `to`                  | n/a              |
| `controls` (everything except `records`) | No. Current state as of the asset's indexed-to time | n/a              |

`holdings` is the derived ledger state at `to`. It is not limited by `from`.

`controls.summary`, `controls.pending`, `controls.breaks`, `controls.openBreaks` and `controls.asOf` are not narrowed by the period. Only `controls.records` is.

_Source: `services/api/src/concord.ts`, `auditExport` (`inPeriod = (t) => t >= from && t <= to`)._

## JSON pack: top-level keys

| Key                | Contents                                                                                                                                                                                                                           |
| :----------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generatedAt`      | ISO 8601 time the pack was generated                                                                                                                                                                                               |
| `generator`        | Generator identifier. Currently the fixed string `concord/0.1.0`                                                                                                                                                                   |
| `sha256`           | SHA-256 hex digest of the pack content, see below                                                                                                                                                                                  |
| `asset`            | The watched asset and its indexing state: `id`, `network`, `code`, `issuer`, `name`, `decimals`, `indexedFromLedger`, `baselineLedger`, `historyFrom`, `indexedToLedger`, `indexedTo`, `ignoredAddresses`. Unset values are `null` |
| `period`           | `{ from, to }` as applied                                                                                                                                                                                                          |
| `holdings`         | Ledger state as of `to`: `asOf`, `ledger`, `supply`, `holderCount`, `incomplete`, `holders`                                                                                                                                        |
| `reconciliations`  | Reconciliation runs whose `asOf` is in the period, oldest first, each with its `breaks`                                                                                                                                            |
| `corporateActions` | Corporate actions (`dividend`, `split` or `redemption`) whose `recordTime` is in the period, newest first                                                                                                                          |
| `controls`         | The controls log: `asOf`, `summary`, `records`, `pending`, `breaks`, `openBreaks`. `records` is filtered by period and listed newest first                                                                                         |
| `events`           | Indexed ledger events closed in the period, in ascending `id` order                                                                                                                                                                |

### The `sha256` digest

The digest covers `asset`, `period`, `holdings`, `reconciliations`, `corporateActions`, `controls` and `events`, serialised with `JSON.stringify` in that key order. It does not cover `generatedAt`, `generator` or `sha256` itself. Two packs built from the same data and period have the same digest.

_Source: `services/api/src/concord.ts`, `auditExport`, `holdings`, `controls`, `eventJson`._

## CSV sections

Each section is built from the pack for the requested period, so the period rules above apply.

### CSV formatting

- One header row, then one row per record.
- Fields containing a comma, double quote, `\r` or `\n` are wrapped in double quotes, and any double quote inside is doubled (`""`). This follows RFC 4180 quoting.
- Missing values (`null` or `undefined`) are written as empty fields.
- Rows end with `\n`, not `\r\n`, and the file ends with a trailing newline.

_Source: `packages/core/src/csv.ts`, `toCsv`._

### holdings

State at `to`. One row per holder.

| Column    | Notes                                                                    |
| :-------- | :----------------------------------------------------------------------- |
| `address` | Holder address                                                           |
| `units`   | Balance, formatted with the asset's decimals                             |
| `share`   | Holder's share of supply, as a percentage                                |
| `status`  | `active`, `frozen`, or empty when the holder has no authorization record |
| `ignored` | `true` if the address is on the asset's ignore list                      |

### events

Events with `closedAt` in the period.

| Column       | Notes                                                      |
| :----------- | :--------------------------------------------------------- |
| `id`         | Event id                                                   |
| `ledger`     | Ledger sequence number                                     |
| `closedAt`   | Ledger close time                                          |
| `kind`       | `transfer`, `mint`, `burn`, `clawback` or `set_authorized` |
| `from`       | Source address, if any                                     |
| `to`         | Destination address, if any                                |
| `units`      | Amount. Empty for `set_authorized` events                  |
| `authorized` | Authorization flag, if the event sets one                  |
| `txHash`     | Transaction hash                                           |

_Source for event kinds: `packages/core/src/events.ts`._

### controls

Control actions with `closedAt` in the period, newest first.

| Column           | Notes                                                   |
| :--------------- | :------------------------------------------------------ |
| `closedAt`       | Ledger close time                                       |
| `ledger`         | Ledger sequence number                                  |
| `type`           | `authorize`, `freeze`, `unfreeze` or `clawback`         |
| `account`        | Affected account                                        |
| `units`          | Amount, if the control carries one (clawbacks)          |
| `txHash`         | Transaction hash                                        |
| `instructionRef` | Reference of the matching instruction, or empty if none |
| `approvedBy`     | Approver recorded on the instruction, or empty          |
| `reason`         | Reason recorded on the instruction, or empty            |

_Source for control types: `packages/core/src/controls.ts`._

### breaks

Discrepancies collected from three places, in this order: reconciliation runs in the period, corporate actions in the period, then the controls log. A break that does not carry a given field leaves that column empty. Breaks with `source` set to `controls` come from the current controls log and are not filtered by period.

| Column          | Notes                                                                                                                                                                                                                                                                                                                                                                                        |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`        | `reconciliation {run id}`, `{action type} {action id}`, or `controls`                                                                                                                                                                                                                                                                                                                        |
| `asOf`          | The run's `asOf`, the action's `recordTime`, or for controls breaks the period's `to`                                                                                                                                                                                                                                                                                                        |
| `scope`         | Which check produced the break: `position`, `movement`, `distribution` or `control`                                                                                                                                                                                                                                                                                                          |
| `type`          | Break classification, by scope. Position: `QUANTITY_MISMATCH`, `MISSING_IN_REGISTER`, `MISSING_ON_CHAIN`, `UNMAPPED_HOLDER`, `STATUS_MISMATCH`, `SUPPLY_MISMATCH`, `INCOMPLETE_HISTORY`. Movement: `UNRECORDED_MOVEMENT`, `UNSETTLED_ENTRY`, `MOVEMENT_AMOUNT_MISMATCH`. Distribution: `MISSING`, `SHORT`, `EXCESS`, `UNEXPECTED`. Control: `UNINSTRUCTED_CONTROL`, `UNEXECUTED_INSTRUCTION` |
| `severity`      | `high`, `medium` or `low`                                                                                                                                                                                                                                                                                                                                                                    |
| `address`       | Address concerned                                                                                                                                                                                                                                                                                                                                                                            |
| `ref`           | Related reference (for example a journal entry or instruction reference)                                                                                                                                                                                                                                                                                                                     |
| `txHash`        | Related transaction hash                                                                                                                                                                                                                                                                                                                                                                     |
| `chainUnits`    | Units on chain                                                                                                                                                                                                                                                                                                                                                                               |
| `registerUnits` | Units on the register                                                                                                                                                                                                                                                                                                                                                                        |
| `expected`      | Expected amount. Distribution breaks only                                                                                                                                                                                                                                                                                                                                                    |
| `observed`      | Observed amount. Distribution breaks only                                                                                                                                                                                                                                                                                                                                                    |
| `difference`    | Difference between the two figures compared. For position breaks it is chain minus register                                                                                                                                                                                                                                                                                                  |
| `message`       | Human-readable description                                                                                                                                                                                                                                                                                                                                                                   |
| `firstSeen`     | Reconciliation breaks only: the `asOf` of the earliest run that reported this break, carried forward by break key. Empty for distribution and controls breaks                                                                                                                                                                                                                                |
| `status`        | `open`, `acknowledged` or `resolved`. A break is `open` unless a sign-off exists for its current figures; if the figures change, an earlier sign-off no longer applies                                                                                                                                                                                                                       |
| `note`          | Sign-off note                                                                                                                                                                                                                                                                                                                                                                                |
| `noteAuthor`    | Who signed the note                                                                                                                                                                                                                                                                                                                                                                          |

_Source: `services/api/src/concord.ts` (`exportCsv`, `reconcile` and `annotate`), `packages/core/src/{reconcile,movements,distributions,controls}.ts`._
