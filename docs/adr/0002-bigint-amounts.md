# ADR-0002: Amounts Are `bigint` in the Smallest Unit and Parsing Never Rounds

- **Status:** Accepted
- **Date:** 2026-10-18

---

## Context

Concord reconciles tokenized securities on Stellar against off-chain registers, transaction journals, corporate-action schedules, and issuer-control instructions. Across Stellar's two asset representations, balances and movements are stored on-chain as exact integers scaled by a fixed number of decimal places:

- **Classic Stellar assets** carry `7` decimal places (`DEFAULT_DECIMALS = 7` in [`packages/core/src/amount.ts`](../../packages/core/src/amount.ts#L2)), where `1` whole unit equals `10,000,000` stroops (`i64` on-chain).
- **Soroban SEP-41 contract tokens** declare an integer `decimals` between `0` and `18` (`services/api/src/concord.ts#L354`) and emit event amounts as 128-bit integers (`i128` / `u128` in Soroban XDR, decoded in [`services/api/src/chain.ts`](../../services/api/src/chain.ts)).

In a reconciliation system, an off-by-one discrepancy in the smallest unit (`0.0000001` on a 7-decimal asset) is a genuine break (`QUANTITY_MISMATCH`, `SUPPLY_MISMATCH`, or `MOVEMENT_AMOUNT_MISMATCH`). The representation of amounts in memory, in SQLite, and over HTTP/JSON must preserve every digit without binary floating-point drift or silent rounding.

---

## Decision

1. **In-memory representation (`bigint`):**
   Every token balance, movement, entitlement, and difference inside `@concord/core` and `@concord/api` is represented as a JavaScript `bigint` in the asset's smallest unit (`10n ** BigInt(decimals)` per whole unit).
2. **Strict decimal parsing without rounding (`parseUnits`):**
   [`parseUnits(input, decimals)`](../../packages/core/src/amount.ts#L11-L24) trims whitespace, strips valid thousands-group commas (`GROUPED`), strips trailing fractional zeros, and checks `frac.length > decimals`. If the input string carries more non-zero fractional places than the asset's `decimals`, `parseUnits` throws `Error('"<input>" has more than <decimals> decimal places')` rather than rounding.
3. **Exact rational corporate-action arithmetic (`Ratio` and `mulDiv`):**
   Dividend rates and split ratios are parsed into exact integer numerator/denominator pairs via [`parseRatio(input)`](../../packages/core/src/amount.ts#L45-L50). Entitlements are computed in [`mulDiv(value, num, den, rounding)`](../../packages/core/src/amount.ts#L55-L60) using `bigint` multiplication before division, with an explicit `Rounding` policy (`"floor"` or `"half-up"`).
4. **String storage in SQLite (`TEXT`):**
   SQLite columns that hold amounts (`events.amount`, `openings.amount`, `register_positions.units`, `journal.units`, `instructions.units` in [`services/api/src/schema.ts`](../../services/api/src/schema.ts)) are declared as `TEXT` and store the base-10 string form of the smallest-unit `bigint` (`units.toString()`, reconstructed via `BigInt(String(row.units))`).
5. **Formatted decimal strings in JSON and CSV outputs (`formatUnits`):**
   At API, CLI, and CSV boundaries, [`formatUnits(value, decimals)`](../../packages/core/src/amount.ts#L26-L33) converts the smallest-unit `bigint` back into a canonical human-readable decimal string (trimming trailing fractional zeros).

---

## Rationale

### Why Excess Precision Is Rejected as a Reconciliation Problem

Off-chain transfer-agent exports occasionally compute share quantities with floating-point formulas or more decimal places than the on-chain token supports (for example, `100.12345678` on a 7-decimal classic asset). If Concord rounded `100.12345678` to `100.1234568` during CSV import:

- The imported register would no longer equal the transfer agent's own book total.
- Rounding half-up or floor across hundreds of holders would manufacture false `QUANTITY_MISMATCH` or `SUPPLY_MISMATCH` breaks—or worse, mask a real discrepancy between the register and the ledger.

Instead, `parseUnits` throws on excess precision (`packages/core/src/amount.ts#L19-L21`). During register, journal, or instruction CSV imports (`packages/core/src/register.ts#L75-L77`), the row is recorded in `issues: ParseIssue[]` with its 1-based line number and exact error message so the operator sees that the register row carries unrepresentable precision.

### Why `TEXT` in SQLite Instead of `INTEGER` or `REAL`

- SQLite's `REAL` is a 64-bit IEEE-754 float with only 53 bits of significand (~15–17 decimal digits), which loses precision on large supplies and 18-decimal SEP-41 tokens.
- SQLite's `INTEGER` is a signed 64-bit integer (`max ~9.22 × 10^18`), whereas Soroban SEP-41 tokens use 128-bit integers (`i128` / `u128`) and allow up to `18` decimals (`services/api/src/concord.ts#L354`), where a single whole token is `10^18` base units and any realistic supply exceeds 64 bits.
- Storing `bigint.toString()` in `TEXT` columns (`services/api/src/db.ts#L9`) is exact for arbitrary-precision integers, avoids SQLite integer overflow, and keeps all aggregation and replay logic in `@concord/core` (`packages/core/src/holdings.ts`) rather than split between SQL and TypeScript.

---

## Alternatives Considered

1. **IEEE-754 `number` (JavaScript floats):**
   Rejected immediately. `0.1 + 0.2 !== 0.3`, and `Number.MAX_SAFE_INTEGER` (`9,007,199,254,740,991`) overflows at ~`900,719,925.4740991` units of a 7-decimal asset or less than `0.01` units of an 18-decimal token.
2. **Third-party decimal libraries (`decimal.js`, `big.js`, `bignumber.js`):**
   Rejected. `@concord/core` is kept free of runtime dependencies (`packages/core/package.json`). Once an asset's `decimals` count is known, every addition, subtraction, comparison, and rational `mulDiv` over smallest-unit `bigint` values is native to the JavaScript engine, faster to replay across thousands of events, and requires ~60 lines of auditable code in [`packages/core/src/amount.ts`](../../packages/core/src/amount.ts).
3. **Silent rounding on CSV import:**
   Rejected for the audit integrity reasons above. Only corporate-action entitlement calculations (`packages/core/src/distributions.ts`), where a dividend rate or split ratio mathematically produces sub-unit fractions, apply an explicit `Rounding` rule (`mulDiv`) or drop sub-unit split fractions as documented in `README.md#L168`.

---

## Consequences

- **JSON serialization:** Native `JSON.stringify` throws a `TypeError` on raw `bigint` values. Service methods in [`services/api/src/concord.ts`](../../services/api/src/concord.ts) must convert `bigint` fields prior to serialization—using `formatUnits(v, asset.decimals)` for HTTP/JSON responses and audit packs (`concord.ts#L664`, `L888`), or `.toString()` when persisting snapshots (`concord.ts#L1171`).
- **Explicit `decimals` required per asset:** Every watched asset stores its `decimals` integer in the `assets` table (`services/api/src/schema.ts#L19`) and passes it into `parseRegisterCsv`, `parseJournalCsv`, `parseInstructionsCsv`, and `formatUnits`.
- **Auditable simplicity:** All amount parsing and formatting rules live in a single file ([`packages/core/src/amount.ts`](../../packages/core/src/amount.ts)) covered by unit tests in [`packages/core/test/core.test.ts`](../../packages/core/test/core.test.ts).
