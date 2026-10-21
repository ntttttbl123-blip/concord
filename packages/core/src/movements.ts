import { parseUnits, DEFAULT_DECIMALS } from "./amount.js";
import { parseCsvTable } from "./csv.js";
import type { AssetEvent, EventKind } from "./events.js";
import { sortEvents } from "./events.js";
import type { ParseIssue } from "./register.js";
import type { Severity } from "./reconcile.js";

export type JournalType = "issue" | "transfer" | "redeem" | "clawback";

/** One entry in the register's transaction journal. */
export interface JournalEntry {
  ref: string;
  /** ISO-8601. A bare date covers the whole UTC day. */
  date: string;
  type: JournalType;
  from?: string;
  to?: string;
  units: bigint;
  txHash?: string;
}

/** A forced redemption is executed as a clawback, a voluntary one as a payment to the issuer. */
const KINDS: Record<JournalType, EventKind[]> = {
  issue: ["mint"],
  transfer: ["transfer"],
  redeem: ["burn", "clawback"],
  clawback: ["clawback"],
};

const TYPE_ALIASES: Record<string, JournalType> = {
  issue: "issue",
  issuance: "issue",
  subscription: "issue",
  mint: "issue",
  transfer: "transfer",
  redeem: "redeem",
  redemption: "redeem",
  burn: "redeem",
  clawback: "clawback",
};

export const JOURNAL_COLUMNS = ["ref", "date", "type", "from_account", "to_account", "units", "tx_hash"] as const;

export function parseJournalCsv(
  text: string,
  decimals = DEFAULT_DECIMALS,
): { entries: JournalEntry[]; issues: ParseIssue[] } {
  const table = parseCsvTable(text);
  for (const required of ["ref", "date", "type", "units"]) {
    if (!table.headers.includes(required)) throw new Error(`journal CSV needs a ${required} column`);
  }
  const entries: JournalEntry[] = [];
  const issues: ParseIssue[] = [];
  for (const { line, values } of table.records) {
    try {
      const type = TYPE_ALIASES[values.type!.toLowerCase()];
      if (!type) throw new Error(`unknown type "${values.type}"`);
      if (!values.ref) throw new Error("missing ref");
      if (Number.isNaN(Date.parse(values.date!))) throw new Error(`bad date "${values.date}"`);
      const entry: JournalEntry = {
        ref: values.ref,
        date: values.date!,
        type,
        units: parseUnits(values.units!, decimals),
      };
      const from = values.from_account ?? values.from;
      const to = values.to_account ?? values.to;
      if (from) entry.from = from;
      if (to) entry.to = to;
      if (values.tx_hash) entry.txHash = values.tx_hash.toLowerCase();
      if (type === "issue" && !entry.to) throw new Error("issue needs to_account");
      if (type !== "issue" && !entry.from) throw new Error(`${type} needs from_account`);
      if (type === "transfer" && !entry.to) throw new Error("transfer needs to_account");
      entries.push(entry);
    } catch (err) {
      issues.push({ line, message: (err as Error).message });
    }
  }
  return { entries, issues };
}

export type MovementBreakType = "UNRECORDED_MOVEMENT" | "UNSETTLED_ENTRY" | "MOVEMENT_AMOUNT_MISMATCH";

export interface MovementBreak {
  type: MovementBreakType;
  severity: Severity;
  key: string;
  ref?: string;
  eventId?: string;
  txHash?: string;
  address?: string;
  chainUnits?: bigint;
  registerUnits?: bigint;
  difference?: bigint;
  message: string;
}

export interface MovementMatch {
  ref: string;
  eventId: string;
  txHash: string;
  by: "tx_hash" | "attributes";
}

export interface MovementReconciliation {
  matches: MovementMatch[];
  breaks: MovementBreak[];
  summary: { events: number; entries: number; matched: number; breakCount: number };
}

export interface MovementOptions {
  /** Inclusive ISO-8601 bounds on what gets reported. Matching looks one window beyond them. */
  from?: string;
  to?: string;
  /** How far apart a journal entry and its ledger event may be. Default 24h. */
  windowMs?: number;
}

const DAY_MS = 86_400_000;

function span(date: string): [number, number] {
  const start = Date.parse(date);
  return /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) ? [start, start + DAY_MS - 1] : [start, start];
}

function distance(entry: JournalEntry, ev: AssetEvent): number {
  const [start, end] = span(entry.date);
  const t = Date.parse(ev.closedAt);
  return t < start ? start - t : t > end ? t - end : 0;
}

function sameParties(entry: JournalEntry, ev: AssetEvent): boolean {
  if (!KINDS[entry.type].includes(ev.kind)) return false;
  if (entry.type === "issue") return ev.to === entry.to;
  if (entry.type === "transfer") return ev.from === entry.from && ev.to === entry.to;
  return ev.from === entry.from;
}

export function reconcileMovements(
  events: AssetEvent[],
  journal: JournalEntry[],
  options: MovementOptions = {},
): MovementReconciliation {
  const windowMs = options.windowMs ?? DAY_MS;
  const lo = options.from ? Date.parse(options.from) : -Infinity;
  const hi = options.to ? Date.parse(options.to) : Infinity;
  const movements = sortEvents(events).filter((e) => e.kind !== "set_authorized");
  const used = new Set<string>();
  const matches: MovementMatch[] = [];
  const breaks: MovementBreak[] = [];
  const entries = [...journal].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const pending: JournalEntry[] = [];

  for (const entry of entries) {
    if (!entry.txHash) {
      pending.push(entry);
      continue;
    }
    const sameTx = movements.filter((e) => e.txHash === entry.txHash && !used.has(e.id) && sameParties(entry, e));
    const exact = sameTx.find((e) => e.amount === entry.units);
    const hit = exact ?? sameTx[0];
    if (!hit) {
      pending.push(entry);
      continue;
    }
    used.add(hit.id);
    matches.push({ ref: entry.ref, eventId: hit.id, txHash: hit.txHash, by: "tx_hash" });
    if (!exact) {
      breaks.push({
        type: "MOVEMENT_AMOUNT_MISMATCH",
        severity: "high",
        key: `MOVEMENT_AMOUNT_MISMATCH:${entry.ref}`,
        ref: entry.ref,
        eventId: hit.id,
        txHash: hit.txHash,
        chainUnits: hit.amount,
        registerUnits: entry.units,
        difference: hit.amount - entry.units,
        message: `Journal entry ${entry.ref} and its transaction disagree on units`,
      });
    }
  }

  for (const entry of pending) {
    let best: AssetEvent | undefined;
    let bestDistance = Infinity;
    for (const ev of movements) {
      if (
        used.has(ev.id) ||
        ev.amount !== entry.units ||
        !sameParties(entry, ev) ||
        (entry.txHash && ev.txHash !== entry.txHash)
      ) {
        continue;
      }
      const d = distance(entry, ev);
      if (d <= windowMs && d < bestDistance) {
        best = ev;
        bestDistance = d;
      }
    }
    if (best) {
      used.add(best.id);
      matches.push({ ref: entry.ref, eventId: best.id, txHash: best.txHash, by: "attributes" });
      continue;
    }
    const [start, end] = span(entry.date);
    if (end < lo || start > hi) continue;
    const item: MovementBreak = {
      type: "UNSETTLED_ENTRY",
      severity: "high",
      key: `UNSETTLED_ENTRY:${entry.ref}`,
      ref: entry.ref,
      registerUnits: entry.units,
      message: entry.txHash
        ? `Journal entry ${entry.ref} cites a transaction with no matching ledger event`
        : `Journal entry ${entry.ref} has no matching ledger event`,
    };
    const address = entry.type === "issue" ? entry.to : entry.from;
    if (address) item.address = address;
    if (entry.txHash) item.txHash = entry.txHash;
    breaks.push(item);
  }

  let reported = 0;
  for (const ev of movements) {
    const t = Date.parse(ev.closedAt);
    if (t < lo || t > hi) continue;
    reported++;
    if (used.has(ev.id)) continue;
    const item: MovementBreak = {
      type: "UNRECORDED_MOVEMENT",
      severity: "high",
      key: `UNRECORDED_MOVEMENT:${ev.id}`,
      eventId: ev.id,
      txHash: ev.txHash,
      chainUnits: ev.amount,
      message: `On-chain ${ev.kind} is not in the register journal`,
    };
    const address = ev.kind === "mint" ? ev.to : ev.from;
    if (address) item.address = address;
    breaks.push(item);
  }

  return {
    matches,
    breaks,
    summary: { events: reported, entries: journal.length, matched: matches.length, breakCount: breaks.length },
  };
}
