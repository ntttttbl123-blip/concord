import { describe, test } from "vitest";
import type { AssetEvent } from "../src/events.js";
import { replay } from "../src/holdings.js";
import { reconcilePositions } from "../src/reconcile.js";
import type { RegisterPosition } from "../src/register.js";

const HOLDERS = 10_000;
const EVENTS = 100_000;

// Seeded PRNG so every run benchmarks identical data.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const address = (i: number) => `G${String(i).padStart(55, "0")}`;

function generateEvents(): AssetEvent[] {
  const rand = mulberry32(42);
  const events: AssetEvent[] = [];
  const push = (e: Omit<AssetEvent, "id" | "assetId" | "ledger" | "closedAt" | "txHash">) => {
    const i = events.length;
    const ledger = 1 + Math.floor(i / 10);
    events.push({
      id: `${String(i).padStart(19, "0")}-0000000000`,
      assetId: "BENCH:ISSUER",
      ledger,
      closedAt: new Date(Date.UTC(2026, 0, 1) + ledger * 5000).toISOString(),
      txHash: i.toString(16).padStart(64, "0"),
      ...e,
    });
  };
  // One mint per holder first, large enough that no balance can go negative below.
  for (let h = 0; h < HOLDERS; h++) push({ kind: "mint", to: address(h), amount: 1_000_000_000n });
  while (events.length < EVENTS) {
    const r = rand();
    const a = address(Math.floor(rand() * HOLDERS));
    const b = address(Math.floor(rand() * HOLDERS));
    const amount = BigInt(1 + Math.floor(rand() * 1000));
    if (r < 0.9) push({ kind: "transfer", from: a, to: b, amount });
    else if (r < 0.95) push({ kind: "burn", from: a, amount });
    else push({ kind: "set_authorized", from: a, amount: 0n, authorized: rand() < 0.5 });
  }
  return events;
}

function shuffled<T>(items: T[]): T[] {
  const rand = mulberry32(7);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// Setup runs once, outside the measured callbacks.
const sorted = generateEvents();
const unsorted = shuffled(sorted);
const state = replay(sorted);

const matching: RegisterPosition[] = [...state.balances].map(
  ([account, units], i) => ({ holderId: `H${i}`, account, units, status: "active" }) as RegisterPosition,
);
// Every 100th holder is off by one unit, so the break-building path is exercised too.
const withBreaks: RegisterPosition[] = matching.map((p, i) =>
  i % 100 === 0 ? ({ ...p, units: p.units + 1n } as RegisterPosition) : p,
);

// Vitest 5 benchmarks are tests: `bench` comes from the test context and results are reported
// when the test finishes. Setup above runs once, outside the measured callbacks.
const opts = { warmupIterations: 1, iterations: 10 };

describe(`replay (${EVENTS} events, ${HOLDERS} holders)`, () => {
  test("replay", { timeout: 120_000 }, async ({ bench }) => {
    await bench.compare(
      bench("events already in id order", () => void replay(sorted)),
      bench("events in random order", () => void replay(unsorted)),
      opts,
    );
  });
});

describe(`reconcilePositions (${HOLDERS} holders)`, () => {
  test("reconcilePositions", { timeout: 120_000 }, async ({ bench }) => {
    await bench.compare(
      bench("register matches chain", () => void reconcilePositions(state, matching)),
      bench("1% of holders mismatched", () => void reconcilePositions(state, withBreaks)),
      opts,
    );
  });
});
