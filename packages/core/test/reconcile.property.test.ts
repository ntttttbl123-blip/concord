import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { reconcilePositions } from "../src/reconcile.js";
import type { HoldingsState } from "../src/holdings.js";
import type { RegisterPosition } from "../src/register.js";

interface Holder {
  id: number;
  amount: bigint;
  parts: number;
}

const holdersArb = fc.uniqueArray(
  fc.record({
    id: fc.integer({ min: 1, max: 999999 }),
    amount: fc.bigInt({ min: 1000n, max: 10n ** 15n }),
    parts: fc.integer({ min: 1, max: 3 }),
  }),
  { selector: (h) => h.id, minLength: 1, maxLength: 25 },
);

const addressOf = (h: Holder): string => `G${String(h.id).padStart(8, "0")}`;

function chainOf(holders: Holder[]): HoldingsState {
  const balances = new Map<string, bigint>();
  let supply = 0n;
  for (const h of holders) {
    balances.set(addressOf(h), h.amount);
    supply += h.amount;
  }
  return {
    balances,
    authorized: new Map(),
    supply,
    ledger: 0,
    eventCount: 0,
    incomplete: [],
  };
}

// One holder per address, or several holders sharing one address (omnibus).
function registerOf(holders: Holder[]): RegisterPosition[] {
  const out: RegisterPosition[] = [];
  for (const h of holders) {
    const share = h.amount / BigInt(h.parts);
    for (let i = 0; i < h.parts; i++) {
      const units =
        i === h.parts - 1 ? h.amount - share * BigInt(h.parts - 1) : share;
      out.push({ holderId: `H${h.id}-${i}`, account: addressOf(h), units });
    }
  }
  return out;
}

describe("reconcilePositions properties", () => {
  it("a register built from chain holdings reconciles with no breaks", () => {
    fc.assert(
      fc.property(holdersArb, (holders) => {
        const result = reconcilePositions(chainOf(holders), registerOf(holders));
        expect(result.breaks).toEqual([]);
        expect(result.summary.breakCount).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  it("mutating one amount gives exactly one QUANTITY_MISMATCH plus SUPPLY_MISMATCH", () => {
    fc.assert(
      fc.property(
        holdersArb,
        fc.nat(),
        fc.bigInt({ min: 1n, max: 1000000000n }),
        (holders, pick, delta) => {
          const register = registerOf(holders);
          const index = pick % register.length;
          const target = register[index]!;
          register[index] = { ...target, units: target.units + delta };

          const result = reconcilePositions(chainOf(holders), register);

          expect(result.breaks.map((b) => b.key).sort()).toEqual(
            [`QUANTITY_MISMATCH:${target.account}`, "SUPPLY_MISMATCH"].sort(),
          );
          expect(result.breaks.map((b) => b.type).sort()).toEqual([
            "QUANTITY_MISMATCH",
            "SUPPLY_MISMATCH",
          ]);
        },
      ),
      { numRuns: 200 },
    );
  });
});
