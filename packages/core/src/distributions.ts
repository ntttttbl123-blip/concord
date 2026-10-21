import { abs, mulDiv, parseRatio, type Rounding } from "./amount.js";
import type { AssetEvent, EventKind } from "./events.js";
import type { HoldingsState } from "./holdings.js";
import type { Severity } from "./reconcile.js";

/**
 * Corporate actions reduce to one question: given the record-date holdings, what should each
 * holder have received (or lost), and what did the ledger actually show?
 */
export type ExpectedFlows = Map<string, bigint>;

export interface DividendTerms {
  /** Pay-asset units per one whole unit held, any precision, e.g. "0.0123456789". */
  ratePerUnit: string;
  baseDecimals: number;
  payDecimals: number;
  rounding?: Rounding;
  /** Holders with no entitlement, e.g. treasury stock. */
  exclude?: Iterable<string>;
}

export function dividendEntitlements(snapshot: HoldingsState, terms: DividendTerms): ExpectedFlows {
  const rate = parseRatio(terms.ratePerUnit);
  const exclude = new Set(terms.exclude ?? []);
  const num = rate.num * 10n ** BigInt(terms.payDecimals);
  const den = rate.den * 10n ** BigInt(terms.baseDecimals);
  const out: ExpectedFlows = new Map();
  for (const [address, units] of snapshot.balances) {
    if (exclude.has(address) || units <= 0n) continue;
    const entitlement = mulDiv(units, num, den, terms.rounding);
    if (entitlement > 0n) out.set(address, entitlement);
  }
  return out;
}

/** Forward split when num > den, reverse when num < den. Fractions of the smallest unit drop. */
export function splitDeltas(
  snapshot: HoldingsState,
  ratio: { num: bigint; den: bigint },
  exclude: Iterable<string> = [],
): ExpectedFlows {
  if (ratio.num <= 0n || ratio.den <= 0n) throw new Error("split ratio must be positive");
  const skip = new Set(exclude);
  const out: ExpectedFlows = new Map();
  for (const [address, units] of snapshot.balances) {
    if (skip.has(address) || units <= 0n) continue;
    const delta = mulDiv(units, ratio.num, ratio.den) - units;
    if (delta !== 0n) out.set(address, delta);
  }
  return out;
}

/** Pro-rata redemption of num/den of every holding. 1/1 redeems the asset in full. */
export function redemptionDeltas(
  snapshot: HoldingsState,
  fraction: { num: bigint; den: bigint },
  exclude: Iterable<string> = [],
): ExpectedFlows {
  if (fraction.num <= 0n || fraction.den <= 0n || fraction.num > fraction.den) {
    throw new Error("redemption fraction must be in (0, 1]");
  }
  const skip = new Set(exclude);
  const out: ExpectedFlows = new Map();
  for (const [address, units] of snapshot.balances) {
    if (skip.has(address) || units <= 0n) continue;
    const redeemed = mulDiv(units, fraction.num, fraction.den);
    if (redeemed > 0n) out.set(address, -redeemed);
  }
  return out;
}

export interface FlowWindow {
  /** Inclusive ledger bounds of the execution window. */
  fromLedger?: number;
  toLedger?: number;
  /** Exclusive ISO-8601 lower bound, normally the record time. */
  afterTime?: string;
  /** Inclusive ISO-8601 upper bound. */
  untilTime?: string;
  /** Kinds that add to a holder. A transfer counts only when sent by `payer` to another address. */
  plus: EventKind[];
  /** Kinds that take from a holder. */
  minus: EventKind[];
  /** Paying agent for transfer-based distributions. */
  payer?: string;
}

export interface ObservedFlow {
  amount: bigint;
  txHashes: string[];
}

export function observeFlows(events: AssetEvent[], window: FlowWindow): Map<string, ObservedFlow> {
  const out = new Map<string, ObservedFlow>();
  const add = (address: string | undefined, delta: bigint, txHash: string) => {
    if (!address) return;
    const flow = out.get(address) ?? { amount: 0n, txHashes: [] };
    flow.amount += delta;
    if (!flow.txHashes.includes(txHash)) flow.txHashes.push(txHash);
    out.set(address, flow);
  };
  for (const ev of events) {
    if (window.fromLedger !== undefined && ev.ledger < window.fromLedger) continue;
    if (window.toLedger !== undefined && ev.ledger > window.toLedger) continue;
    if (window.afterTime !== undefined && ev.closedAt <= window.afterTime) continue;
    if (window.untilTime !== undefined && ev.closedAt > window.untilTime) continue;
    if (ev.kind === "transfer") {
      if (window.plus.includes("transfer") && window.payer && ev.from === window.payer && ev.to !== ev.from) {
        add(ev.to, ev.amount, ev.txHash);
      }
    } else if (window.plus.includes(ev.kind)) {
      add(ev.kind === "mint" ? ev.to : ev.from, ev.amount, ev.txHash);
    } else if (window.minus.includes(ev.kind)) {
      add(ev.from, -ev.amount, ev.txHash);
    }
  }
  return out;
}

export type DistributionBreakType = "MISSING" | "SHORT" | "EXCESS" | "UNEXPECTED";

export interface DistributionLine {
  address: string;
  /** Record-date holding the expectation was derived from. */
  basis: bigint;
  expected: bigint;
  observed: bigint;
  /** observed minus expected. */
  difference: bigint;
  txHashes: string[];
  status: "ok" | DistributionBreakType;
}

export interface DistributionBreak {
  type: DistributionBreakType;
  severity: Severity;
  key: string;
  address: string;
  expected: bigint;
  observed: bigint;
  difference: bigint;
  message: string;
}

export interface DistributionReconciliation {
  lines: DistributionLine[];
  breaks: DistributionBreak[];
  summary: {
    holders: number;
    expectedTotal: bigint;
    observedTotal: bigint;
    difference: bigint;
    breakCount: number;
  };
}

const MESSAGES: Record<DistributionBreakType, string> = {
  MISSING: "Entitled holder shows no flow in the execution window",
  SHORT: "Holder received less than the entitlement",
  EXCESS: "Holder received more than the entitlement",
  UNEXPECTED: "Flow to a holder with no entitlement at the record date",
};

export function reconcileDistribution(
  snapshot: HoldingsState,
  expected: ExpectedFlows,
  observed: Map<string, ObservedFlow>,
  options: { tolerance?: bigint; ignore?: Iterable<string> } = {},
): DistributionReconciliation {
  const tolerance = options.tolerance ?? 0n;
  const ignore = new Set(options.ignore ?? []);
  const addresses = new Set<string>([...expected.keys(), ...observed.keys()]);
  const lines: DistributionLine[] = [];
  const breaks: DistributionBreak[] = [];
  let expectedTotal = 0n;
  let observedTotal = 0n;

  for (const address of [...addresses].sort()) {
    if (ignore.has(address)) continue;
    const want = expected.get(address) ?? 0n;
    const flow = observed.get(address);
    const got = flow?.amount ?? 0n;
    const difference = got - want;
    expectedTotal += want;
    observedTotal += got;
    let status: DistributionLine["status"] = "ok";
    if (abs(difference) > tolerance) {
      if (want === 0n || (got !== 0n && want > 0n !== got > 0n)) status = "UNEXPECTED";
      else if (got === 0n) status = "MISSING";
      else status = abs(got) < abs(want) ? "SHORT" : "EXCESS";
    }
    lines.push({
      address,
      basis: snapshot.balances.get(address) ?? 0n,
      expected: want,
      observed: got,
      difference,
      txHashes: flow?.txHashes ?? [],
      status,
    });
    if (status !== "ok") {
      const oppositeSign = want !== 0n && got !== 0n && want > 0n !== got > 0n;
      const severity: Severity = status === "UNEXPECTED" && !oppositeSign ? "medium" : "high";
      breaks.push({
        type: status,
        severity,
        key: `${status}:${address}`,
        address,
        expected: want,
        observed: got,
        difference,
        message: MESSAGES[status],
      });
    }
  }

  return {
    lines,
    breaks,
    summary: {
      holders: lines.filter((l) => l.expected !== 0n || l.observed !== 0n).length,
      expectedTotal,
      observedTotal,
      difference: observedTotal - expectedTotal,
      breakCount: breaks.length,
    },
  };
}
