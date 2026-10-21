# Writing Tests in `packages/core`

This guide explains how to write unit and reconciliation tests in [`packages/core`](../../packages/core).

---

## 1. Design Principles of `packages/core`

[`packages/core`](../../packages/core) is the deterministic accounting engine of Concord. It operates under strict design constraints:
- **Zero I/O:** No network requests, file system access, or database queries.
- **No Clocks:** Current timestamps, historical windows, and cutoffs are passed in explicitly as arguments or ISO strings.
- **Integer Accounting:** All token quantities and balances are exact `bigint` values in the asset's smallest unit (e.g. 7 decimals for classic Stellar assets, where 1 unit = `10_000_000n` stroops). No floating-point math is used.

Because core modules are pure functions over plain data, tests are fast, completely deterministic, and run without mocks or external fixtures.

---

## 2. Test Fixtures and Helpers

The test suite lives in [`packages/core/test/`](../../packages/core/test). Shared test helpers are located in [`packages/core/test/fixtures.ts`](../../packages/core/test/fixtures.ts).

### `u(n)`: Unit to Stroop Scaling
```typescript
import { u } from "./fixtures.js";

// Scales whole decimal units to 7-decimal bigint stroops
const tenUnits = u(10); // 100_000_000n
const hundredUnits = u(100); // 1_000_000_000n
```
Use `u(n)` whenever declaring balances, transfer amounts, or register units in tests to maintain readable whole numbers while asserting against raw `bigint` values.

### `ev(kind, ledger, fields)`: Deterministic Event Builder
```typescript
import { ev, u } from "./fixtures.js";

const mintEvent = ev("mint", 1, { to: "A", amount: u(100) });
const transferEvent = ev("transfer", 2, { from: "A", to: "B", amount: u(10) });
const freezeEvent = ev("set_authorized", 3, { from: "B", authorized: false });
```
`ev()` generates an `AssetEvent` with:
- **`id`:** Padded deterministic sequence string (`0000000001-0000000001`).
- **`closedAt`:** Deterministic ISO-8601 timestamp calculated as `T0 + ledger * 60_000` ms, where `T0` is fixed to `2026-10-01T00:00:00Z`.
- **`txHash`:** Defaults to `tx1`, `tx2`, etc., unless explicitly overridden in `fields.txHash`.
- **`assetId`:** Defaults to `"CASSET"`.

---

## 3. Test Structure & Naming Conventions

Follow standard Vitest conventions as demonstrated in [`packages/core/test/core.test.ts`](../../packages/core/test/core.test.ts):

```typescript
describe("position reconciliation", () => {
  // Shared state replayed once for the block
  const chain = replay([
    ev("mint", 1, { to: "A", amount: u(100) }),
    ev("mint", 1, { to: "B", amount: u(40) }),
  ]);

  it("agrees when the books agree, including omnibus accounts", () => {
    // 1. Arrange inputs using parse helpers or fixtures
    // 2. Act by calling the pure reconciliation function
    // 3. Assert on output breaks and summary metrics
  });

  it("flags quantity mismatch when on-chain units differ from register", () => {
    // Assert break types, differences, and gross metrics
  });
});
```

### Conventions:
- **Test Names:** Use active, present-tense verbs describing the exact behavior: `"agrees when the books agree"`, `"flags every kind of break"`, `"honours tolerance and ignored addresses"`.
- **Mock Account Identifiers:** Use simple capital letters (`"A"`, `"B"`, `"C"`) for on-chain addresses, and simple prefixes (`"H1"`, `"H2"`) for holder IDs. Never use real public keys, live customer names, or production data.

---

## 4. What Makes a Good Reconciliation Test

Every test covering reconciliation logic should assert both sides of the balance sheet:

1. **Test the Happy Path First:** Verify that matching books produce `breaks = []` and increment `matchedLines`.
2. **Omnibus & Multi-Holder Accounts:** Verify accounts mapped to multiple `holderIds` combine units correctly without spurious breaks.
3. **Assert the Summary Block:** Do not check only `r.breaks`. Check summary statistics:
   - `r.summary.matchedLines`
   - `r.summary.breakCount`
   - `r.summary.grossDifference`
   - `r.summary.chainSupply` vs `r.summary.registerTotal`
4. **Test Boundaries:**
   - `tolerance: 1n` (differences within tolerance do not flag breaks).
   - `ignore: ["TREASURY"]` (excluded accounts are omitted from both chain and register sides).
   - Fractional rounding and invalid CSV rows (`issues` reporting line numbers).

---

## 5. Worked Example: Testing a New Break Condition

Suppose you are testing a break condition where an investor on the register has no corresponding on-chain balance (`MISSING_ON_CHAIN`). Here is the standard pattern:

```typescript
import { describe, expect, it } from "vitest";
import { parseRegisterCsv, reconcilePositions, replay } from "../src/index.js";
import { ev, u } from "./fixtures.js";

describe("missing on-chain holder test", () => {
  it("flags MISSING_ON_CHAIN when a registered account has zero on-chain balance", () => {
    // 1. Build chain state with address A holding 50 units, but address B having no events
    const chain = replay([
      ev("mint", 1, { to: "A", amount: u(50) }),
    ]);

    // 2. Build register with address A (50 units) and address B (25 units)
    const { positions, issues } = parseRegisterCsv(
      "holder_id,account,units\nH1,A,50\nH2,B,25\n",
    );
    expect(issues).toEqual([]);

    // 3. Run reconciliation
    const result = reconcilePositions(chain, positions);

    // 4. Assert specific break type, key, and quantities
    expect(result.breaks).toHaveLength(1);
    const breakItem = result.breaks[0]!;
    expect(breakItem.type).toBe("MISSING_ON_CHAIN");
    expect(breakItem.severity).toBe("high");
    expect(breakItem.key).toBe("MISSING_ON_CHAIN:B");
    expect(breakItem.address).toBe("B");
    expect(breakItem.chainUnits).toBe(0n);
    expect(breakItem.registerUnits).toBe(u(25));
    expect(breakItem.difference).toBe(-u(25));

    // 5. Assert summary metrics reflect the mismatch
    expect(result.summary.chainSupply).toBe(u(50));
    expect(result.summary.registerTotal).toBe(u(75));
    expect(result.summary.matchedLines).toBe(1);
    expect(result.summary.breakCount).toBe(1);
    expect(result.summary.grossDifference).toBe(u(25));
  });
});
```

---

## 6. Running the Tests

To run the core test suite:

```bash
# Run unit tests in packages/core
pnpm --filter @concord/core test

# Run all test suites across the workspace
pnpm test
```
