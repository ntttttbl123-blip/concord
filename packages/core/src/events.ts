/** The CAP-67 unified event set for an asset, classic or SEP-41. */
export const EVENT_KINDS = ["transfer", "mint", "burn", "clawback", "set_authorized"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface AssetEvent {
  /** RPC event id, `<digits>-<digits>`. `sortEvents` orders by its numeric parts. */
  id: string;
  assetId: string;
  kind: EventKind;
  ledger: number;
  /** ISO-8601 close time of the ledger. */
  closedAt: string;
  txHash: string;
  from?: string;
  to?: string;
  /** Smallest unit. Zero for set_authorized. */
  amount: bigint;
  /** set_authorized only. */
  authorized?: boolean;
}

export function isEventKind(value: string): value is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(value);
}

const EVENT_ID = /^(\d+)-(\d+)$/;

function idKey(id: string): [bigint, bigint] {
  const m = EVENT_ID.exec(id);
  if (!m) throw new Error(`event id "${id}" is not in the RPC form <digits>-<digits>`);
  return [BigInt(m[1]!), BigInt(m[2]!)];
}

const compare = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/** Ledger order. Both parts of the id compare as numbers, so padding does not matter. */
export function sortEvents<T extends { id: string }>(events: T[]): T[] {
  return events
    .map((ev) => ({ ev, key: idKey(ev.id) }))
    .sort((a, b) => compare(a.key[0], b.key[0]) || compare(a.key[1], b.key[1]))
    .map(({ ev }) => ev);
}

/** The holder a control or supply event acts on. */
export function subject(ev: AssetEvent): string | undefined {
  return ev.kind === "mint" ? ev.to : ev.from;
}
