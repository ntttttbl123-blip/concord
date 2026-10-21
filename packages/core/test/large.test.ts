import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  replay,
  reconcilePositions,
  type AssetEvent,
  type EventKind,
  type HolderStatus,
  type RegisterPosition,
} from "../src/index.js";

/**
 * Scaled-up regression for the reconciliation path the README's mainnet run
 * exercised: 1,000 holders, ~7,000 events, zero breaks when the register is
 * built from the replay, and exactly the injected breaks once known positions
 * are perturbed. Everything derives from a fixed seed so the dataset (and
 * therefore the expected break set) is stable across runs and machines.
 */

// --- Dataset constants (acceptance criterion: seed and sizes are constants) --

const SEED = 0x936936;
const HOLDER_COUNT = 1000;
const TARGET_EVENTS = 7000;
/** Cumulative thresholds over one uniform draw: transfer 60%, burn 18%, clawback 10%, freeze rest. */
const MIX: readonly [number, EventKind][] = [
  [0.6, "transfer"],
  [0.78, "burn"],
  [0.88, "clawback"],
  [1, "set_authorized"],
];
/** The holder the generator freezes, so a status perturbation is deterministic. */
const FROZEN_HOLDER = 5;
const OVERSTATED_HOLDER = 42;
const DROPPED_HOLDER = 777;
const RUNTIME_BUDGET_MS = 2000;

// --- Seeded generator --------------------------------------------------------

/** mulberry32: tiny, deterministic, good enough uniformity for test data. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const u = (n: number) => BigInt(n) * 10_000_000n;

/** Stable address for holder index i; used by both the generator and the assertions. */
function addressOf(i: number): string {
  return `G${String(i).padStart(64, "0")}`.slice(0, 68);
}

interface Dataset {
  events: AssetEvent[];
  /** Final balance per address, used to build the register. */
  balances: Map<string, bigint>;
}

function generate(): Dataset {
  const rand = mulberry32(SEED);
  const pick = () => Math.floor(rand() * HOLDER_COUNT);

  // Ledger numbers start above any baseline so no replay cutoff logic interferes.
  let ledger = 100;
  let seq = 0;
  const events: AssetEvent[] = [];
  const push = (kind: EventKind, fields: Omit<AssetEvent, "id" | "assetId" | "kind" | "ledger" | "closedAt" | "txHash">) => {
    seq++;
    ledger++;
    events.push({
      id: `0000001-${String(seq).padStart(6, "0")}`,
      assetId: "LARGE",
      kind,
      ledger,
      closedAt: new Date(Date.parse("2026-10-01T00:00:00Z") + ledger * 60_000).toISOString(),
      txHash: `tx${String(seq).padStart(6, "0")}`,
      ...fields,
    });
  };

  // Phase 1: one fresh mint per holder so every address starts funded and present.
  const balances = new Map<string, bigint>();
  for (let i = 0; i < HOLDER_COUNT; i++) {
    const amount = u(1 + Math.floor(rand() * 10_000));
    balances.set(addressOf(i), amount);
    push("mint", { to: addressOf(i), amount });
  }

  // Phase 2: a mix of transfers, reductions and authorisation flips. Leaving one
  // slot before TARGET_EVENTS guarantees room for the deterministic freeze below.
  const authorized = new Map<string, boolean>();
  while (events.length < TARGET_EVENTS - 1) {
    const roll = rand();
    let kind: EventKind = "transfer";
    for (const [threshold, k] of MIX) {
      if (roll <= threshold) {
        kind = k;
        break;
      }
    }
    const a = addressOf(pick());
    if (kind === "transfer") {
      const from = addressOf(pick());
      const to = addressOf(pick());
      if (to === from) continue;
      const available = balances.get(from) ?? 0n;
      // Never drain a balance to zero, and never move more than 5% in one go,
      // so the replay never marks a holder's history incomplete.
      if (available <= u(10)) continue;
      const amount = u(1 + Math.floor(Number(available / 10_000_000n) * rand() * 0.05));
      if (amount >= available) continue;
      balances.set(from, available - amount);
      balances.set(to, (balances.get(to) ?? 0n) + amount);
      push(kind, { from, to, amount });
    } else if (kind === "burn" || kind === "clawback") {
      const available = balances.get(a) ?? 0n;
      if (available <= u(10)) continue;
      const amount = u(1 + Math.floor(Number(available / 10_000_000n) * rand() * 0.02));
      balances.set(a, available - amount);
      push(kind, { from: a, amount });
    } else {
      const next = !(authorized.get(a) ?? true);
      authorized.set(a, next);
      push(kind, { from: a, authorized: next });
    }
  }

  // Deterministic freeze: holder FROZEN_HOLDER ends unauthorised, so the
  // reconciliation sees a known chain status ("frozen") for that address.
  authorized.set(addressOf(FROZEN_HOLDER), false);
  push("set_authorized", { from: addressOf(FROZEN_HOLDER), authorized: false });

  return { events, balances };
}

// --- Dataset (replayed once per file; Vitest caches across tests in a file) --

const { events, balances } = generate();
const datasetStart = performance.now();
const chain = replay(events);
const datasetMs = performance.now() - datasetStart;

/** A register assembled from the replay itself: every address mapped, statuses consistent. */
function registerFrom(state: { balances: Map<string, bigint>; authorized: Map<string, boolean> }): RegisterPosition[] {
  const out: RegisterPosition[] = [];
  for (const address of [...state.balances.keys()].sort()) {
    const flag: boolean | undefined = state.authorized.get(address);
    const status: HolderStatus | undefined = flag === undefined ? undefined : flag ? "active" : "frozen";
    const pos: RegisterPosition = { holderId: `H-${address}`, account: address, units: state.balances.get(address)! };
    if (status !== undefined) pos.status = status;
    out.push(pos);
  }
  return out;
}

const cleanRegister = registerFrom(chain);

/** The same register with three known positions perturbed. */
function perturbedRegister(): RegisterPosition[] {
  const reg = cleanRegister.map((p) => ({ ...p }));
  const idxOf = (i: number) => reg.findIndex((p) => p.account === addressOf(i));

  // 1) Overstate one holder's units by 25 -> QUANTITY_MISMATCH.
  reg[idxOf(OVERSTATED_HOLDER)].units += u(25);

  // 2) Drop one mapped position entirely -> MISSING_IN_REGISTER.
  reg.splice(idxOf(DROPPED_HOLDER), 1);

  // 3) Report the frozen holder as active -> STATUS_MISMATCH.
  reg[idxOf(FROZEN_HOLDER)].status = "active";

  return reg;
}

describe("large scale reconciliation (seeded)", () => {
  it(`replays ${TARGET_EVENTS} events over ${HOLDER_COUNT} holders and re-derives the generated balances`, () => {
    expect(events.length).toBe(TARGET_EVENTS);
    expect(chain.balances.size).toBe(HOLDER_COUNT);
    expect(chain.eventCount).toBe(TARGET_EVENTS);
    expect(chain.ledger).toBeGreaterThan(0);
    let supply = 0n;
    for (const amount of balances.values()) supply += amount;
    expect(chain.supply).toBe(supply);
    for (const [address, amount] of balances) {
      expect(chain.balances.get(address)).toBe(amount);
    }
    expect(chain.incomplete).toEqual([]);
  });

  it(`reconciles the replay-built register clean across all ${HOLDER_COUNT} positions`, () => {
    const r = reconcilePositions(chain, cleanRegister);
    expect(r.breaks).toEqual([]);
    expect(r.summary.matchedLines).toBe(HOLDER_COUNT);
    expect(r.summary.chainHolders).toBe(HOLDER_COUNT);
    expect(r.summary.registerHolders).toBe(HOLDER_COUNT);
    expect(r.summary.chainSupply).toBe(chain.supply);
    expect(r.summary.registerTotal).toBe(chain.supply);
    expect(r.summary.unmappedUnits).toBe(0n);
    expect(r.summary.grossDifference).toBe(0n);
  });

  it("reports exactly the breaks injected into the perturbed register", () => {
    const r = reconcilePositions(chain, perturbedRegister());
    expect(r.breaks.map((b) => b.key).sort()).toEqual(
      [
        `MISSING_IN_REGISTER:${addressOf(DROPPED_HOLDER)}`,
        `QUANTITY_MISMATCH:${addressOf(OVERSTATED_HOLDER)}`,
        "SUPPLY_MISMATCH",
        `STATUS_MISMATCH:${addressOf(FROZEN_HOLDER)}`,
      ].sort(),
    );

    // Per-address difference is chain minus register: the overstated register
    // reads 25 units short, the dropped holder reads its full balance short.
    const bump = u(25);
    const dropped = chain.balances.get(addressOf(DROPPED_HOLDER))!;
    const qty = r.breaks.find((b) => b.type === "QUANTITY_MISMATCH")!;
    expect(qty.difference).toBe(-bump);
    const missing = r.breaks.find((b) => b.type === "MISSING_IN_REGISTER")!;
    expect(missing.difference).toBe(dropped);
    // One aggregate supply break whose difference nets the two quantity drifts.
    const supply = r.breaks.find((b) => b.type === "SUPPLY_MISMATCH")!;
    expect(supply.difference).toBe(dropped - bump);
    // No quarrel about severity: quantity breaks are high, status is medium.
    expect(r.breaks.filter((b) => b.severity !== "high" && b.type !== "STATUS_MISMATCH")).toEqual([]);
    expect(r.summary.breakCount).toBe(4);
    expect(r.summary.matchedLines).toBe(HOLDER_COUNT - 3);
    expect(r.summary.grossDifference).toBe(dropped + bump);
  });

  it("stays within the two-second runtime budget", () => {
    expect(datasetMs).toBeLessThan(RUNTIME_BUDGET_MS);
    const t0 = performance.now();
    reconcilePositions(chain, cleanRegister);
    const t1 = performance.now();
    reconcilePositions(chain, perturbedRegister());
    const t2 = performance.now();
    expect(t1 - t0).toBeLessThan(RUNTIME_BUDGET_MS);
    expect(t2 - t1).toBeLessThan(RUNTIME_BUDGET_MS);
  });
});
