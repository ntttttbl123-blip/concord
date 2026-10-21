import { createHash } from "node:crypto";
import {
  buildControlsLog,
  dividendEntitlements,
  formatUnits,
  observeFlows,
  parseInstructionsCsv,
  parseJournalCsv,
  parseRegisterCsv,
  reconcileDistribution,
  reconcileMovements,
  reconcilePositions,
  redemptionDeltas,
  replay,
  splitDeltas,
  toCsv,
  type AssetEvent,
  type EventKind,
  type ExpectedFlows,
  type HoldingsState,
  type Instruction,
  type JournalEntry,
  type Opening,
  type RegisterPosition,
  type Rounding,
} from "@concord/core";
import { StrKey } from "@stellar/stellar-sdk";
import {
  ChainError,
  cursorLedger,
  resolveAsset,
  type AssetCandidate,
  type ChainHead,
  type ChainSource,
  type ResolvedAsset,
} from "./chain.js";
import { NETWORK_NAMES, isNetworkName, type NetworkName } from "./config.js";
import type { Db, Row } from "./db.js";

export class NotFound extends Error {}
export class Invalid extends Error {}

/** Who did something: a signed-in user, or the operator at the command line. */
export interface Actor {
  id: string;
  label: string;
}

export interface NetworkHandle {
  passphrase: string;
  chain?: ChainSource;
}

/** The networks a workspace can read. One process serves both. */
export type Networks = Partial<Record<NetworkName, NetworkHandle>>;

export interface AssetRecord {
  id: string;
  network: NetworkName;
  code: string;
  issuer?: string;
  name: string;
  decimals: number;
  /** "indexing" until where history starts has been established. */
  state: "indexing" | "ready";
  /** Opening balances from Horizon, a ledger the caller named, or the oldest the RPC holds. */
  startMode: "baseline" | "ledger" | "window";
  startLedger?: number;
  baselineLedger?: number;
  /** With startMode "window": roughly when the indexed history begins. */
  historyFrom?: string;
  cursor?: string;
  syncedLedger?: number;
  syncedAt?: string;
  /** Why the last indexing pass failed. Cleared by the next one that succeeds. */
  syncError?: string;
  syncErrorAt?: string;
  ignore: string[];
  createdAt: string;
}

export interface WatchInput {
  network: NetworkName;
  /** CODE:ISSUER or a contract id. */
  asset: string;
  name?: string;
  /** Contract tokens only, and only when the contract does not state them. */
  decimals?: number;
  /** Replay from this ledger instead of taking opening balances. */
  fromLedger?: number;
  /** Classic assets take opening balances from Horizon unless this is false. */
  baseline?: boolean;
  /** Addresses outside the register, e.g. the issuer's distribution account. */
  ignore?: string[];
}

export type ActionType = "dividend" | "split" | "redemption";

export interface ActionInput {
  type: ActionType;
  label?: string;
  /** ISO-8601. Holdings at this instant are the entitlement basis. */
  recordTime: string;
  /** End of the execution window. Open-ended when absent. */
  windowTo?: string;
  exclude?: string[];
  /** Dividend: pay-asset units per whole unit held. */
  ratePerUnit?: string;
  /** Dividend: watched asset the dividend is paid in. Defaults to the asset itself (in kind). */
  payAsset?: string;
  /** Dividend: paying agent. Without one, mints of the pay asset are counted. */
  payer?: string;
  rounding?: Rounding;
  /** Split ratio or redemption fraction. */
  num?: string;
  den?: string;
}

export interface NoteInput {
  fingerprint: string;
  status: "open" | "acknowledged" | "resolved";
  note: string;
}

interface StoredBreak {
  scope: string;
  type: string;
  severity: string;
  key: string;
  fingerprint: string;
  message: string;
  firstSeen?: string;
  address?: string | null;
  holderIds?: string[];
  ref?: string | null;
  txHash?: string | null;
  eventId?: string | null;
  chainUnits?: string | null;
  registerUnits?: string | null;
  expected?: string;
  observed?: string;
  difference?: string | null;
}

interface RunResult {
  registerId: number;
  registerSha256: string;
  asOf: string;
  chainLedger: number;
  chainSyncedAt: string | null;
  chainBehind: boolean;
  warnings: string[];
  status: "clean" | "breaks";
  summary: Record<string, string | number | null>;
  lines: Array<Record<string, unknown>>;
  movement: Record<string, unknown> | null;
  breaks: StoredBreak[];
}

interface ActionResult {
  reconciledThrough: string | null;
  warnings: string[];
  status: "clean" | "breaks";
  flowAsset: { id: string; code: string };
  summary: Record<string, string | number>;
  lines: Array<Record<string, unknown>>;
  breaks: StoredBreak[];
}

const now = () => new Date().toISOString();
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function isoTime(input: string, field: string): string {
  const t = Date.parse(input);
  if (Number.isNaN(t)) throw new Invalid(`${field} is not a valid date: "${input}"`);
  return new Date(t).toISOString();
}

function addresses(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500 || value.some((v) => typeof v !== "string" || v.length > 80)) {
    throw new Invalid(`${field} must be a list of addresses`);
  }
  return [...new Set((value as string[]).map((v) => v.trim()).filter(Boolean))];
}

function address(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const list = addresses([value], field);
  const s = list[0];
  if (!s || (!StrKey.isValidEd25519PublicKey(s) && !StrKey.isValidContract(s) && !StrKey.isValidMed25519PublicKey(s))) {
    throw new Invalid(`${field} must be a valid Stellar address`);
  }
  return s;
}

function label(value: unknown, field: string, max = 120): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max) throw new Invalid(`${field} must be text of at most ${max} characters`);
  return value.trim() || undefined;
}

/** What to tell the dashboard about a failed pass. Internals stay in the server log. */
function describeFailure(err: unknown): string {
  if (err instanceof ChainError || err instanceof Invalid || err instanceof NotFound) return err.message;
  console.error(err);
  return "Indexing stopped on an unexpected error.";
}

function toAsset(row: Row): AssetRecord {
  const asset: AssetRecord = {
    id: String(row.id),
    network: String(row.network) as NetworkName,
    code: String(row.code),
    name: String(row.name),
    decimals: Number(row.decimals),
    state: String(row.state) as AssetRecord["state"],
    startMode: String(row.start_mode) as AssetRecord["startMode"],
    ignore: JSON.parse(String(row.ignore_addresses)) as string[],
    createdAt: String(row.created_at),
  };
  if (row.issuer) asset.issuer = String(row.issuer);
  if (row.start_ledger !== null) asset.startLedger = Number(row.start_ledger);
  if (row.baseline_ledger !== null) asset.baselineLedger = Number(row.baseline_ledger);
  if (row.history_from) asset.historyFrom = String(row.history_from);
  if (row.cursor) asset.cursor = String(row.cursor);
  if (row.synced_ledger !== null) asset.syncedLedger = Number(row.synced_ledger);
  if (row.synced_at) asset.syncedAt = String(row.synced_at);
  if (row.sync_error) asset.syncError = String(row.sync_error);
  if (row.sync_error_at) asset.syncErrorAt = String(row.sync_error_at);
  return asset;
}

function toEvent(row: Row): AssetEvent {
  const ev: AssetEvent = {
    id: String(row.id),
    assetId: String(row.asset_id),
    kind: String(row.kind) as EventKind,
    ledger: Number(row.ledger),
    closedAt: String(row.closed_at),
    txHash: String(row.tx_hash),
    amount: BigInt(String(row.amount)),
  };
  if (row.from_addr) ev.from = String(row.from_addr);
  if (row.to_addr) ev.to = String(row.to_addr);
  if (row.authorized !== null) ev.authorized = Number(row.authorized) === 1;
  return ev;
}

/**
 * One workspace: every operation the API and the CLI expose over a single database.
 * Reads the chain, never writes it.
 */
export class Concord {
  private readonly syncing = new Map<string, Promise<{ added: number }>>();
  /** Current holdings per asset; replaying every event on each dashboard poll is too slow. */
  private readonly stateMemo = new Map<string, HoldingsState>();
  private seenVersion: number;

  constructor(
    readonly db: Db,
    readonly networks: Networks,
  ) {
    this.seenVersion = db.dataVersion();
  }

  /** Forget cached holdings for an asset this instance just changed. */
  private touch(assetId: string): void {
    this.stateMemo.delete(assetId);
  }

  /** Forget everything cached when another process (the CLI, say) has written to the file. */
  private fresh(): void {
    const version = this.db.dataVersion();
    if (version !== this.seenVersion) {
      this.seenVersion = version;
      this.stateMemo.clear();
    }
  }

  // ── assets ────────────────────────────────────────────────────────────────

  /** By contract id, or by code when exactly one watched asset carries it. */
  asset(ref: string): AssetRecord {
    const byId = this.db.get("SELECT * FROM assets WHERE id = ?", ref);
    if (byId) return toAsset(byId);
    const byCode = this.db.all("SELECT * FROM assets WHERE code = ? COLLATE NOCASE LIMIT 2", ref);
    if (byCode.length > 1) throw new Invalid(`more than one watched asset is called ${ref}; use its contract id`);
    if (!byCode[0]) throw new NotFound(`asset ${ref} is not watched`);
    return toAsset(byCode[0]);
  }

  assets(network?: NetworkName): AssetRecord[] {
    const rows = network
      ? this.db.all("SELECT * FROM assets WHERE network = ? ORDER BY created_at", network)
      : this.db.all("SELECT * FROM assets ORDER BY created_at");
    return rows.map(toAsset);
  }

  networkNames(): NetworkName[] {
    return NETWORK_NAMES.filter((name) => this.networks[name]);
  }

  private handle(network: NetworkName): NetworkHandle {
    const handle = isNetworkName(network) ? this.networks[network] : undefined;
    if (!handle) throw new Invalid("network must be mainnet or testnet");
    return handle;
  }

  private requireChain(network: NetworkName): ChainSource {
    const chain = this.handle(network).chain;
    if (!chain) throw new Invalid(`no chain source configured for ${network}`);
    return chain;
  }

  /** Classic assets on a network that carry this code, most widely held first. */
  async lookup(network: NetworkName, code: string): Promise<AssetCandidate[]> {
    const chain = this.requireChain(network);
    if (typeof code !== "string" || !/^[A-Za-z0-9]{1,12}$/.test(code)) {
      throw new Invalid("an asset code is 1 to 12 letters or digits");
    }
    if (!chain.search) throw new Invalid("asset search is not available");
    return chain.search(code);
  }

  /**
   * Start watching an asset. With `defer`, the call returns once the asset is recorded and the
   * opening balances and first pass happen in the background; otherwise it waits for them.
   */
  async watchAsset(input: WatchInput, options: { defer?: boolean; actor?: Actor } = {}): Promise<AssetRecord> {
    const { passphrase } = this.handle(input.network);
    const chain = this.requireChain(input.network);
    let resolved: ResolvedAsset;
    try {
      resolved = resolveAsset(String(input.asset ?? ""), passphrase);
    } catch (err) {
      throw new Invalid((err as Error).message);
    }
    if (this.db.get("SELECT id FROM assets WHERE id = ?", resolved.id)) {
      throw new Invalid(`${resolved.code} is already watched`);
    }
    const ignore = addresses(input.ignore, "ignore");
    let name = label(input.name, "name");
    let decimals = input.decimals;
    if (input.fromLedger !== undefined && (!Number.isInteger(input.fromLedger) || input.fromLedger < 1)) {
      throw new Invalid("fromLedger must be a ledger sequence");
    }

    if (chain.describe) {
      const found = await chain.describe(resolved);
      if (!found) {
        const what = resolved.issuer ? `asset ${resolved.code} from that issuer` : "contract with that id";
        throw new Invalid(`${input.network} has no ${what}`);
      }
      // A contract id that turns out to wrap a classic asset is watched as that asset.
      resolved = { ...resolved, ...(found.code ? { code: found.code } : {}), ...(found.issuer ? { issuer: found.issuer } : {}) };
      decimals ??= found.decimals;
      name ??= found.name;
    }
    // Classic assets carry seven decimals by protocol. A contract token must say, or be told.
    if (resolved.issuer) {
      if (input.decimals !== undefined && input.decimals !== 7) {
        throw new Invalid("classic assets always carry 7 decimals");
      }
      decimals = 7;
    }
    if (decimals === undefined) {
      throw new Invalid("this token does not state its decimals; give them when watching it");
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Invalid("decimals must be 0 to 18");
    if (input.baseline && !resolved.issuer) throw new Invalid("opening balances are only available for classic assets");
    const startMode: AssetRecord["startMode"] =
      input.fromLedger !== undefined ? "ledger" : resolved.issuer && input.baseline !== false ? "baseline" : "window";

    this.db.run(
      `INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, start_ledger, ignore_addresses, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'indexing', ?, ?, ?, ?)`,
      resolved.id,
      input.network,
      resolved.code,
      resolved.issuer ?? null,
      name ?? resolved.code,
      decimals,
      startMode,
      input.fromLedger ?? null,
      JSON.stringify(ignore),
      options.actor?.label ?? null,
      now(),
    );
    this.touch(resolved.id);
    if (options.defer) {
      // sync() records its own failure on the asset, where the dashboard shows it.
      void this.sync(resolved.id).catch(() => {});
      return this.asset(resolved.id);
    }
    try {
      return await this.prepare(this.asset(resolved.id));
    } catch (err) {
      this.db.run("DELETE FROM assets WHERE id = ?", resolved.id);
      throw err;
    }
  }

  /** Establish where history starts, then mark the asset ready to index. */
  private async prepare(asset: AssetRecord, head?: ChainHead): Promise<AssetRecord> {
    const chain = this.requireChain(asset.network);
    if (asset.startMode === "baseline") {
      if (!asset.issuer) throw new Invalid("opening balances are only available for classic assets");
      const baseline = await chain.baseline(asset.code, asset.issuer, asset.decimals);
      this.db.tx(() => {
        this.db.run("DELETE FROM openings WHERE asset_id = ?", asset.id);
        for (const [address, o] of baseline.openings) {
          this.db.run(
            "INSERT INTO openings (asset_id, address, amount, authorized, as_of_ledger) VALUES (?, ?, ?, ?, ?)",
            asset.id,
            address,
            o.amount.toString(),
            o.authorized === undefined ? null : o.authorized ? 1 : 0,
            o.asOfLedger,
          );
        }
        this.db.run(
          "UPDATE assets SET state = 'ready', baseline_ledger = ?, start_ledger = ?, history_from = NULL WHERE id = ?",
          baseline.ledger,
          baseline.ledger + 1,
          asset.id,
        );
      });
    } else {
      const { latest, oldest, oldestClosedAt } = head ?? (await chain.latestLedger());
      if (asset.startMode === "ledger") {
        if (asset.startLedger === undefined || asset.startLedger < oldest) {
          throw new Invalid(
            `ledger ${asset.startLedger} is older than the RPC retains (oldest ${oldest}); use a baseline`,
          );
        }
        this.db.run("UPDATE assets SET state = 'ready' WHERE id = ?", asset.id);
      } else {
        // The retention window slides while we work, so do not start on its very edge.
        this.db.run(
          "UPDATE assets SET state = 'ready', start_ledger = ?, history_from = ? WHERE id = ?",
          Math.min(oldest + 20, latest),
          oldestClosedAt ?? null,
          asset.id,
        );
      }
    }
    this.touch(asset.id);
    return this.asset(asset.id);
  }

  updateAsset(ref: string, patch: { name?: string; ignore?: string[] }): AssetRecord {
    const asset = this.asset(ref);
    const name = label(patch.name, "name");
    this.db.run(
      "UPDATE assets SET name = ?, ignore_addresses = ? WHERE id = ?",
      name ?? asset.name,
      JSON.stringify(patch.ignore === undefined ? asset.ignore : addresses(patch.ignore, "ignore")),
      asset.id,
    );
    return this.asset(asset.id);
  }

  /** Stop watching: the asset, its events and every book uploaded against it are deleted. */
  async unwatchAsset(ref: string): Promise<void> {
    const asset = this.asset(ref);
    // A pass still running would write its events into an asset watched again under the same id.
    await this.syncing.get(asset.id)?.catch(() => {});
    this.db.run("DELETE FROM assets WHERE id = ?", asset.id);
    this.touch(asset.id);
  }

  /**
   * Throw away the indexed history and start again from fresh opening balances. This is the way
   * out of a gap left by the indexer being down for longer than the RPC keeps events. Uploaded
   * books, past runs and sign-offs stay.
   */
  async rebuild(ref: string, options: { defer?: boolean } = {}): Promise<AssetRecord> {
    const asset = this.asset(ref);
    await this.syncing.get(asset.id)?.catch(() => {});
    this.db.tx(() => {
      this.db.run("DELETE FROM events WHERE asset_id = ?", asset.id);
      this.db.run("DELETE FROM openings WHERE asset_id = ?", asset.id);
      this.db.run(
        `UPDATE assets SET state = 'indexing', start_mode = ?, start_ledger = NULL, baseline_ledger = NULL,
           history_from = NULL, cursor = NULL, synced_ledger = NULL, synced_at = NULL, sync_error = NULL, sync_error_at = NULL
         WHERE id = ?`,
        asset.issuer ? "baseline" : "window",
        asset.id,
      );
    });
    this.touch(asset.id);
    if (options.defer) void this.sync(asset.id).catch(() => {});
    else await this.sync(asset.id);
    return this.asset(asset.id);
  }

  // ── indexer ───────────────────────────────────────────────────────────────

  /** Pull new events for one asset. Concurrent calls share one pass. */
  sync(ref: string, head?: ChainHead): Promise<{ added: number }> {
    const asset = this.asset(ref);
    const running = this.syncing.get(asset.id);
    if (running) return running;
    const pass = this.runSync(asset, head).finally(() => this.syncing.delete(asset.id));
    this.syncing.set(asset.id, pass);
    return pass;
  }

  /**
   * One pass over every asset. Networks run side by side, so an outage on one cannot stall the
   * other. Keyed by asset id.
   */
  async syncAll(): Promise<Record<string, { added: number } | { error: string }>> {
    const out: Record<string, { added: number } | { error: string }> = {};
    await Promise.all(
      this.networkNames().map(async (network) => {
        const assets = this.assets(network);
        if (assets.length === 0) return;
        // One look at the chain's range serves every asset on the network.
        const head = await this.networks[network]?.chain?.latestLedger().catch(() => undefined);
        for (const asset of assets) {
          try {
            out[asset.id] = await this.sync(asset.id, head);
          } catch (err) {
            out[asset.id] = { error: describeFailure(err) };
          }
        }
      }),
    );
    return out;
  }

  private async runSync(asset: AssetRecord, head?: ChainHead): Promise<{ added: number }> {
    try {
      const chain = this.requireChain(asset.network);
      head ??= await chain.latestLedger();
      const ready = asset.state === "indexing" ? await this.prepare(asset, head) : asset;
      if (ready.cursor) {
        const at = cursorLedger(ready.cursor);
        if (at + 1 < head.oldest) {
          throw new Invalid(
            "Indexing was paused for longer than the network keeps events, so movements in between are missing. Rebuild this asset to start again from fresh opening balances.",
          );
        }
        if (at > head.latest + 1000) {
          throw new Invalid(`The ${ready.network} ledger is now behind this asset's history: the network was reset. Stop watching it.`);
        }
      }
      const out = await this.syncPass(ready, chain);
      if (asset.syncError) {
        this.db.run("UPDATE assets SET sync_error = NULL, sync_error_at = NULL WHERE id = ?", asset.id);
      }
      return out;
    } catch (err) {
      this.db.run("UPDATE assets SET sync_error = ?, sync_error_at = ? WHERE id = ?", describeFailure(err), now(), asset.id);
      throw err;
    }
  }

  private async syncPass(asset: AssetRecord, chain: ChainSource): Promise<{ added: number }> {
    if (asset.startLedger === undefined) throw new Invalid("this asset has no starting ledger yet");
    const limit = 1000;
    let from: { startLedger: number } | { cursor: string } = asset.cursor
      ? { cursor: asset.cursor }
      : { startLedger: asset.startLedger };
    let added = 0;
    for (let i = 0; i < 10_000; i++) {
      const page = await chain.getEvents(asset.id, from, limit);
      const cursor = page.cursor ?? page.events.at(-1)?.id;
      const previous = "cursor" in from ? from.cursor : undefined;
      // Caught up when the cursor stops moving, or a short page ends at the chain's tip.
      const atTip =
        !cursor || cursor === previous || (page.events.length < limit && cursorLedger(cursor) >= page.latestLedger);
      let wrote = 0;
      this.db.tx(() => {
        for (const ev of page.events) wrote += this.insertEvent(asset.id, ev) ? 1 : 0;
        if (atTip) {
          this.db.run(
            `UPDATE assets SET cursor = COALESCE(?, cursor), synced_ledger = MAX(COALESCE(synced_ledger, 0), ?),
               synced_at = COALESCE(?, synced_at) WHERE id = ?`,
            cursor ?? null,
            page.latestLedger,
            page.latestLedgerClosedAt ?? null,
            asset.id,
          );
        } else {
          // Only a pass that reaches the tip may say how far the asset is indexed. Moving the
          // watermark on every page would have a pass that dies half-way claim the whole chain.
          this.db.run("UPDATE assets SET cursor = ? WHERE id = ?", cursor, asset.id);
        }
      });
      if (wrote > 0) {
        added += wrote;
        this.touch(asset.id);
      }
      if (atTip || !cursor) break;
      from = { cursor };
    }
    return { added };
  }

  private insertEvent(assetId: string, ev: AssetEvent): boolean {
    const written = this.db.write(
      `INSERT OR IGNORE INTO events (id, asset_id, kind, ledger, closed_at, tx_hash, from_addr, to_addr, amount, authorized)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ev.id,
      assetId,
      ev.kind,
      ev.ledger,
      ev.closedAt,
      ev.txHash,
      ev.from ?? null,
      ev.to ?? null,
      ev.amount.toString(),
      ev.authorized === undefined ? null : ev.authorized ? 1 : 0,
    );
    return written > 0;
  }

  /** Sync if a chain source is present; a failure becomes a warning, not an abort. */
  private async trySync(asset: AssetRecord, warnings: string[]): Promise<void> {
    if (!this.networks[asset.network]?.chain) return;
    try {
      await this.sync(asset.id);
    } catch (err) {
      warnings.push(`Could not refresh from the chain: ${describeFailure(err)}`);
    }
  }

  // ── chain state ───────────────────────────────────────────────────────────

  private loadEvents(assetId: string): AssetEvent[] {
    return this.db.all("SELECT * FROM events WHERE asset_id = ? ORDER BY id", assetId).map(toEvent);
  }

  /** Freezes, authorisations and clawbacks: all the controls log reads. */
  private loadControlEvents(assetId: string): AssetEvent[] {
    return this.db
      .all("SELECT * FROM events WHERE asset_id = ? AND kind IN ('set_authorized', 'clawback') ORDER BY id", assetId)
      .map(toEvent);
  }

  private openings(assetId: string): Map<string, Opening> {
    const out = new Map<string, Opening>();
    for (const row of this.db.all("SELECT * FROM openings WHERE asset_id = ?", assetId)) {
      const opening: Opening = { amount: BigInt(String(row.amount)), asOfLedger: Number(row.as_of_ledger) };
      if (row.authorized !== null) opening.authorized = Number(row.authorized) === 1;
      out.set(String(row.address), opening);
    }
    return out;
  }

  /** Holdings from replaying events over the opening balances. Treat the result as read-only. */
  state(asset: AssetRecord, upToTime?: string, events?: AssetEvent[]): HoldingsState {
    const current = upToTime === undefined && events === undefined;
    if (current) {
      this.fresh();
      const hit = this.stateMemo.get(asset.id);
      if (hit) return hit;
    }
    const state = replay(events ?? this.loadEvents(asset.id), {
      opening: this.openings(asset.id),
      baselineLedger: asset.baselineLedger ?? 0,
      ...(upToTime ? { upToTime } : {}),
    });
    if (current) this.stateMemo.set(asset.id, state);
    return state;
  }

  holdings(ref: string, asOf?: string) {
    const asset = this.asset(ref);
    const upTo = asOf ? isoTime(asOf, "asOf") : undefined;
    const state = this.state(asset, upTo);
    const ignored = new Set(asset.ignore);
    const holders = [...state.balances]
      .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1))
      .map(([address, units]) => ({
        address,
        units: formatUnits(units, asset.decimals),
        share: state.supply > 0n ? Number((units * 1_000_000n) / state.supply) / 10_000 : 0,
        status: state.authorized.has(address) ? (state.authorized.get(address) ? "active" : "frozen") : null,
        ignored: ignored.has(address),
      }));
    return {
      asOf: upTo ?? asset.syncedAt ?? null,
      ledger: state.ledger,
      supply: formatUnits(state.supply, asset.decimals),
      holderCount: holders.length,
      incomplete: state.incomplete,
      holders,
    };
  }

  events(ref: string, filter: { kind?: string; address?: string; limit?: number; before?: string } = {}) {
    const asset = this.asset(ref);
    const where = ["asset_id = ?"];
    const params: Array<string | number> = [asset.id];
    if (filter.kind) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.address) {
      where.push("(from_addr = ? OR to_addr = ?)");
      params.push(filter.address, filter.address);
    }
    if (filter.before) {
      where.push("id < ?");
      params.push(filter.before);
    }
    const limit = Number.isFinite(filter.limit) ? Math.trunc(filter.limit!) : 100;
    params.push(Math.min(Math.max(limit, 1), 1000));
    return this.db
      .all(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, ...params)
      .map((row) => this.eventJson(toEvent(row), asset.decimals));
  }

  private eventJson(ev: AssetEvent, decimals: number) {
    return {
      id: ev.id,
      kind: ev.kind,
      ledger: ev.ledger,
      closedAt: ev.closedAt,
      txHash: ev.txHash,
      from: ev.from ?? null,
      to: ev.to ?? null,
      units: ev.kind === "set_authorized" ? null : formatUnits(ev.amount, decimals),
      authorized: ev.authorized ?? null,
    };
  }

  // ── register side ─────────────────────────────────────────────────────────

  importRegister(ref: string, input: { csv: string; asOf: string; source?: string }, actor?: Actor) {
    const asset = this.asset(ref);
    const asOf = isoTime(input.asOf, "asOf");
    let parsed;
    try {
      parsed = parseRegisterCsv(input.csv, asset.decimals);
    } catch (err) {
      throw new Invalid((err as Error).message);
    }
    if (parsed.positions.length === 0) throw new Invalid("register has no usable rows");
    const registerId = this.db.tx(() => {
      const id = this.db.run(
        "INSERT INTO registers (asset_id, as_of, source, sha256, issues, imported_by, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        asset.id,
        asOf,
        label(input.source, "source", 200) ?? "upload",
        sha256(input.csv),
        JSON.stringify(parsed.issues),
        actor?.label ?? null,
        now(),
      );
      for (const p of parsed.positions) {
        this.db.run(
          "INSERT INTO register_positions (register_id, holder_id, holder_name, account, units, status) VALUES (?, ?, ?, ?, ?, ?)",
          id,
          p.holderId,
          p.holderName ?? null,
          p.account ?? null,
          p.units.toString(),
          p.status ?? null,
        );
      }
      return id;
    });
    return { registerId, asOf, positions: parsed.positions.length, issues: parsed.issues };
  }

  registers(ref: string) {
    const asset = this.asset(ref);
    return this.db
      .all(
        `SELECT r.*, (SELECT COUNT(*) FROM register_positions p WHERE p.register_id = r.id) AS positions
         FROM registers r WHERE asset_id = ? ORDER BY as_of DESC, id DESC`,
        asset.id,
      )
      .map((r) => ({
        id: Number(r.id),
        asOf: String(r.as_of),
        source: String(r.source),
        sha256: String(r.sha256),
        positions: Number(r.positions),
        issues: JSON.parse(String(r.issues)) as Array<{ line: number; message: string }>,
        importedBy: r.imported_by ? String(r.imported_by) : null,
        importedAt: String(r.imported_at),
      }));
  }

  /** Remove a register, its holder lines and every reconciliation run against it. */
  deleteRegister(ref: string, registerId: number): void {
    const asset = this.asset(ref);
    const removed = this.db.write("DELETE FROM registers WHERE id = ? AND asset_id = ?", registerId, asset.id);
    if (removed === 0) throw new NotFound("no such register for this asset");
  }

  private registerPositions(registerId: number): RegisterPosition[] {
    return this.db.all("SELECT * FROM register_positions WHERE register_id = ?", registerId).map((r) => {
      const p: RegisterPosition = { holderId: String(r.holder_id), units: BigInt(String(r.units)) };
      if (r.holder_name) p.holderName = String(r.holder_name);
      if (r.account) p.account = String(r.account);
      if (r.status) p.status = String(r.status) as "active" | "frozen";
      return p;
    });
  }

  importJournal(ref: string, csv: string) {
    const asset = this.asset(ref);
    let parsed;
    try {
      parsed = parseJournalCsv(csv, asset.decimals);
    } catch (err) {
      throw new Invalid((err as Error).message);
    }
    this.db.tx(() => {
      for (const e of parsed.entries) {
        this.db.run(
          `INSERT OR REPLACE INTO journal (asset_id, ref, date, type, from_addr, to_addr, units, tx_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          asset.id,
          e.ref,
          e.date,
          e.type,
          e.from ?? null,
          e.to ?? null,
          e.units.toString(),
          e.txHash ?? null,
        );
      }
    });
    return { entries: parsed.entries.length, issues: parsed.issues };
  }

  private journal(assetId: string): JournalEntry[] {
    return this.db.all("SELECT * FROM journal WHERE asset_id = ?", assetId).map((r) => {
      const e: JournalEntry = {
        ref: String(r.ref),
        date: String(r.date),
        type: String(r.type) as JournalEntry["type"],
        units: BigInt(String(r.units)),
      };
      if (r.from_addr) e.from = String(r.from_addr);
      if (r.to_addr) e.to = String(r.to_addr);
      if (r.tx_hash) e.txHash = String(r.tx_hash);
      return e;
    });
  }

  importInstructions(ref: string, csv: string) {
    const asset = this.asset(ref);
    let parsed;
    try {
      parsed = parseInstructionsCsv(csv, asset.decimals);
    } catch (err) {
      throw new Invalid((err as Error).message);
    }
    this.db.tx(() => {
      for (const i of parsed.instructions) {
        this.db.run(
          `INSERT OR REPLACE INTO instructions (asset_id, ref, type, account, units, issued_at, approved_by, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          asset.id,
          i.ref,
          i.type,
          i.account,
          i.units?.toString() ?? null,
          i.issuedAt,
          i.approvedBy ?? null,
          i.reason ?? null,
        );
      }
    });
    return { instructions: parsed.instructions.length, issues: parsed.issues };
  }

  private instructions(assetId: string): Instruction[] {
    return this.db.all("SELECT * FROM instructions WHERE asset_id = ?", assetId).map((r) => {
      const i: Instruction = {
        ref: String(r.ref),
        type: String(r.type) as Instruction["type"],
        account: String(r.account),
        issuedAt: String(r.issued_at),
      };
      if (r.units) i.units = BigInt(String(r.units));
      if (r.approved_by) i.approvedBy = String(r.approved_by);
      if (r.reason) i.reason = String(r.reason);
      return i;
    });
  }

  // ── reconciliation ────────────────────────────────────────────────────────

  /** Reconcile one register (the latest by default) against chain state at its as-of time. */
  async reconcile(ref: string, registerId?: number, actor?: Actor) {
    const warnings: string[] = [];
    await this.trySync(this.asset(ref), warnings);
    const asset = this.asset(ref);
    const reg = registerId
      ? this.db.get("SELECT * FROM registers WHERE id = ? AND asset_id = ?", registerId, asset.id)
      : this.db.get("SELECT * FROM registers WHERE asset_id = ? ORDER BY as_of DESC, id DESC LIMIT 1", asset.id);
    if (!reg) throw new NotFound("no register imported for this asset");
    const asOf = String(reg.as_of);
    const fmt = (v: bigint | undefined) => (v === undefined ? null : formatUnits(v, asset.decimals));

    const chainBehind = !asset.syncedAt || asset.syncedAt < asOf;
    if (chainBehind) {
      warnings.push(
        `Chain is indexed to ${asset.syncedAt ?? "nothing"}, before the register's as-of time; later activity is not reflected`,
      );
    }
    const events = this.loadEvents(asset.id);
    const state = this.state(asset, asOf, events);
    const positions = reconcilePositions(state, this.registerPositions(Number(reg.id)), { ignore: asset.ignore });

    const breaks: StoredBreak[] = positions.breaks.map((b) => ({
      scope: "position",
      type: b.type,
      severity: b.severity,
      key: b.key,
      fingerprint: `${b.chainUnits ?? ""}|${b.registerUnits ?? ""}`,
      message: b.message,
      address: b.address ?? null,
      holderIds: b.holderIds,
      chainUnits: fmt(b.chainUnits),
      registerUnits: fmt(b.registerUnits),
      difference: fmt(b.difference),
    }));

    let movement: Record<string, unknown> | null = null;
    const journal = this.journal(asset.id);
    if (journal.length > 0) {
      const previous = this.db.get<{ as_of: string }>(
        "SELECT as_of FROM registers WHERE asset_id = ? AND as_of < ? ORDER BY as_of DESC LIMIT 1",
        asset.id,
        asOf,
      );
      const ignored = new Set(asset.ignore);
      // Movements wholly among ignored addresses are outside the register's scope.
      const scoped = events.filter((e) => ![e.from, e.to].every((a) => a === undefined || ignored.has(a)));
      const result = reconcileMovements(scoped, journal, {
        to: asOf,
        ...(previous ? { from: new Date(Date.parse(previous.as_of) + 1).toISOString() } : {}),
      });
      movement = { from: previous?.as_of ?? null, to: asOf, ...result.summary, matches: result.matches };
      for (const b of result.breaks) {
        breaks.push({
          scope: "movement",
          type: b.type,
          severity: b.severity,
          key: b.key,
          fingerprint: `${b.chainUnits ?? ""}|${b.registerUnits ?? ""}`,
          message: b.message,
          address: b.address ?? null,
          ref: b.ref ?? null,
          txHash: b.txHash ?? null,
          eventId: b.eventId ?? null,
          chainUnits: fmt(b.chainUnits),
          registerUnits: fmt(b.registerUnits),
          difference: fmt(b.difference),
        });
      }
    }

    const prior = this.db.get<{ result: string }>(
      "SELECT result FROM runs WHERE asset_id = ? AND as_of <= ? ORDER BY as_of DESC, id DESC LIMIT 1",
      asset.id,
      asOf,
    );
    const priorSeen = new Map<string, string>();
    if (prior) {
      for (const b of (JSON.parse(prior.result) as { breaks: StoredBreak[] }).breaks) {
        if (b.firstSeen) priorSeen.set(b.key, b.firstSeen);
      }
    }
    for (const b of breaks) b.firstSeen = priorSeen.get(b.key) ?? asOf;

    const s = positions.summary;
    const result: RunResult = {
      registerId: Number(reg.id),
      registerSha256: String(reg.sha256),
      asOf,
      chainLedger: state.ledger,
      chainSyncedAt: asset.syncedAt ?? null,
      chainBehind,
      warnings,
      status: breaks.length === 0 ? "clean" : "breaks",
      summary: {
        chainSupply: fmt(s.chainSupply),
        registerTotal: fmt(s.registerTotal),
        supplyDifference: fmt(s.chainSupply - s.registerTotal),
        unmappedUnits: fmt(s.unmappedUnits),
        grossDifference: fmt(s.grossDifference),
        chainHolders: s.chainHolders,
        registerHolders: s.registerHolders,
        lines: positions.lines.length,
        matchedLines: s.matchedLines,
        breakCount: breaks.length,
      },
      lines: positions.lines.map((l) => ({
        address: l.address,
        holderIds: l.holderIds,
        chainUnits: fmt(l.chainUnits),
        registerUnits: fmt(l.registerUnits),
        difference: fmt(l.difference),
        chainStatus: l.chainStatus ?? null,
        registerStatus: l.registerStatus ?? null,
        matched: l.matched,
      })),
      movement,
      breaks,
    };
    const id = this.db.run(
      "INSERT INTO runs (asset_id, register_id, as_of, created_by, created_at, result) VALUES (?, ?, ?, ?, ?, ?)",
      asset.id,
      Number(reg.id),
      asOf,
      actor?.label ?? null,
      now(),
      JSON.stringify(result),
    );
    return this.run(id);
  }

  run(id: number) {
    const row = this.db.get("SELECT * FROM runs WHERE id = ?", id);
    if (!row) throw new NotFound(`reconciliation ${id} not found`);
    const result = JSON.parse(String(row.result)) as RunResult;
    const breaks = this.annotate(String(row.asset_id), "recon", result.breaks);
    return {
      id: Number(row.id),
      assetId: String(row.asset_id),
      createdAt: String(row.created_at),
      ...result,
      breaks,
      openBreaks: breaks.filter((b) => b.status === "open").length,
    };
  }

  runs(ref: string) {
    const asset = this.asset(ref);
    return this.db
      .all<{ id: number }>("SELECT id FROM runs WHERE asset_id = ? ORDER BY id DESC LIMIT 200", asset.id)
      .map(({ id }) => {
        const r = this.run(id);
        return {
          id: r.id,
          asOf: r.asOf,
          createdAt: r.createdAt,
          status: r.status,
          chainBehind: r.chainBehind,
          summary: r.summary,
          openBreaks: r.openBreaks,
        };
      });
  }

  latestRun(assetId: string) {
    const row = this.db.get<{ id: number }>("SELECT id FROM runs WHERE asset_id = ? ORDER BY as_of DESC, id DESC LIMIT 1", assetId);
    return row ? this.run(row.id) : null;
  }

  // ── break notes ───────────────────────────────────────────────────────────

  /**
   * Overlay sign-off notes. A note only holds while the numbers it was written against are
   * unchanged; if the break moves, it reopens and the note is shown as stale.
   */
  private annotate(assetId: string, scope: string, breaks: StoredBreak[]) {
    const notes = new Map<string, Row>();
    for (const n of this.db.all("SELECT * FROM break_notes WHERE asset_id = ? AND scope = ?", assetId, scope)) {
      notes.set(String(n.key), n);
    }
    return breaks.map((b) => {
      const n = notes.get(b.key);
      const current = n !== undefined && String(n.fingerprint) === b.fingerprint;
      return {
        ...b,
        noteScope: scope,
        status: current ? String(n.status) : "open",
        note: n ? String(n.note) : null,
        noteAuthor: n?.author ? String(n.author) : null,
        noteAt: n ? String(n.updated_at) : null,
        noteStale: n !== undefined && !current,
      };
    });
  }

  /** Sign a break off, or reopen it. The author is whoever is acting, never what the caller says. */
  setNote(ref: string, scope: string, key: string, input: NoteInput, actor?: Actor) {
    const asset = this.asset(ref);
    if (!["open", "acknowledged", "resolved"].includes(input.status)) throw new Invalid("bad status");
    if (typeof input.note !== "string" && input.note !== undefined) throw new Invalid("note must be text");
    if (input.status !== "open" && !input.note?.trim()) throw new Invalid("a note is required to sign off a break");
    if ((input.note?.length ?? 0) > 4000) throw new Invalid("note is too long");
    if (typeof key !== "string" || key.length > 500 || typeof input.fingerprint !== "string" || input.fingerprint.length > 500) {
      throw new Invalid("key and fingerprint must be short text");
    }
    if (scope !== "recon" && scope !== "controls") {
      const action = /^action:(\d+)$/.exec(String(scope));
      const owned = action && this.db.get("SELECT id FROM actions WHERE id = ? AND asset_id = ?", Number(action[1]), asset.id);
      if (!owned) throw new Invalid("scope must be recon, controls or an action of this asset");
    }
    this.db.run(
      `INSERT OR REPLACE INTO break_notes (asset_id, scope, key, fingerprint, status, note, author, author_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      asset.id,
      scope,
      key,
      input.fingerprint,
      input.status,
      input.note ?? "",
      actor?.label ?? null,
      actor?.id ?? null,
      now(),
    );
    return { ok: true };
  }

  // ── corporate actions ─────────────────────────────────────────────────────

  async createAction(ref: string, input: ActionInput, actor?: Actor) {
    const asset = this.asset(ref);
    const recordTime = isoTime(String(input.recordTime ?? ""), "recordTime");
    const params: Record<string, unknown> = { exclude: addresses(input.exclude, "exclude") };
    if (input.windowTo) params.windowTo = isoTime(input.windowTo, "windowTo");
    if (input.type === "dividend") {
      if (!input.ratePerUnit || !/^\d+(\.\d+)?$/.test(input.ratePerUnit)) {
        throw new Invalid("dividend needs ratePerUnit as a decimal");
      }
      params.ratePerUnit = input.ratePerUnit;
      const pay = input.payAsset ? this.asset(String(input.payAsset)) : asset;
      if (pay.network !== asset.network) throw new Invalid("the pay asset must be on the same network");
      params.payAsset = pay.id;
      const payer = address(input.payer, "payer");
      if (payer) params.payer = payer;
      if (input.rounding !== undefined && input.rounding !== "floor" && input.rounding !== "half-up") {
        throw new Invalid("rounding must be floor or half-up");
      }
      params.rounding = input.rounding ?? "floor";
    } else if (input.type === "split" || input.type === "redemption") {
      if (!input.num || !input.den || !/^\d+$/.test(input.num) || !/^\d+$/.test(input.den)) {
        throw new Invalid(`${input.type} needs whole-number num and den`);
      }
      if (BigInt(input.num) === 0n || BigInt(input.den) === 0n) throw new Invalid("num and den must be positive");
      if (input.type === "redemption" && BigInt(input.num) > BigInt(input.den)) {
        throw new Invalid("a redemption cannot exceed the holding");
      }
      params.num = input.num;
      params.den = input.den;
    } else {
      throw new Invalid("type must be dividend, split or redemption");
    }
    const title =
      label(input.label, "label") ??
      (input.type === "dividend"
        ? `Dividend ${input.ratePerUnit} per unit`
        : input.type === "split"
          ? `Split ${input.num}:${input.den}`
          : `Redemption ${input.num}/${input.den}`);
    const id = this.db.run(
      "INSERT INTO actions (asset_id, type, label, record_time, params, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      asset.id,
      input.type,
      title,
      recordTime,
      JSON.stringify(params),
      actor?.label ?? null,
      now(),
    );
    return this.reconcileAction(id);
  }

  /** Establish where the asset's indexed history begins. */
  private historyStart(asset: AssetRecord): string | undefined {
    if (asset.historyFrom) return asset.historyFrom;
    const first = this.db.get<{ closed_at: string }>(
      "SELECT closed_at FROM events WHERE asset_id = ? ORDER BY ledger ASC, id ASC LIMIT 1",
      asset.id,
    );
    return first?.closed_at;
  }

  /** Freeze the record-date holdings once the indexed chain has passed the record time. */
  private snapshot(asset: AssetRecord, row: Row): HoldingsState | undefined {
    if (row.snapshot) {
      const stored = JSON.parse(String(row.snapshot)) as { ledger: number; holders: Record<string, string> };
      const balances = new Map(Object.entries(stored.holders).map(([a, v]) => [a, BigInt(v)]));
      let supply = 0n;
      for (const v of balances.values()) supply += v;
      return { balances, authorized: new Map(), supply, ledger: stored.ledger, eventCount: 0, incomplete: [] };
    }
    const recordTime = String(row.record_time);
    const start = this.historyStart(asset);
    if (start && recordTime < start) return undefined;
    if (!asset.syncedAt || asset.syncedAt < recordTime) return undefined;
    const state = this.state(asset, recordTime);
    const holders: Record<string, string> = {};
    for (const [address, units] of state.balances) holders[address] = units.toString();
    this.db.run(
      "UPDATE actions SET snapshot = ? WHERE id = ?",
      JSON.stringify({ ledger: state.ledger, takenAt: now(), holders }),
      Number(row.id),
    );
    return state;
  }

  async reconcileAction(id: number, options: { sync?: boolean } = {}) {
    const row = this.db.get("SELECT * FROM actions WHERE id = ?", id);
    if (!row) throw new NotFound(`corporate action ${id} not found`);
    const params = JSON.parse(String(row.params)) as Record<string, string | string[] | undefined>;
    const type = String(row.type) as ActionType;
    const warnings: string[] = [];
    const refresh = options.sync !== false;
    if (refresh) await this.trySync(this.asset(String(row.asset_id)), warnings);
    const asset = this.asset(String(row.asset_id));
    const flowAsset = type === "dividend" ? this.asset(String(params.payAsset)) : asset;
    if (refresh && flowAsset.id !== asset.id) await this.trySync(flowAsset, warnings);

    const recordTime = String(row.record_time);
    const start = this.historyStart(asset);
    if (start && recordTime < start) {
      warnings.push(`Record time (${recordTime}) is earlier than history start (${start}); cannot snapshot holdings before the asset was indexed.`);
      const result: ActionResult = {
        reconciledThrough: flowAsset.syncedAt ?? null,
        warnings,
        status: "clean",
        flowAsset: { id: flowAsset.id, code: flowAsset.code },
        summary: { holders: 0, expectedTotal: "0", observedTotal: "0", difference: "0", breakCount: 0 },
        lines: [],
        breaks: [],
      };
      this.db.run("UPDATE actions SET result = ?, reconciled_at = ? WHERE id = ?", JSON.stringify(result), now(), id);
      return this.action(id);
    }

    const snapshot = this.snapshot(asset, row);
    if (!snapshot) return this.action(id);

    const exclude = [...asset.ignore, ...((params.exclude as string[] | undefined) ?? [])];
    let expected: ExpectedFlows;
    let plus: EventKind[];
    let minus: EventKind[] = [];
    const payer = params.payer as string | undefined;
    if (type === "dividend") {
      expected = dividendEntitlements(snapshot, {
        ratePerUnit: String(params.ratePerUnit),
        baseDecimals: asset.decimals,
        payDecimals: flowAsset.decimals,
        rounding: (params.rounding as Rounding | undefined) ?? "floor",
        exclude,
      });
      // A payment made by the pay asset's own issuer surfaces as a mint, not a transfer.
      plus = payer && payer !== flowAsset.issuer ? ["transfer"] : ["mint"];
    } else {
      const ratio = { num: BigInt(String(params.num)), den: BigInt(String(params.den)) };
      if (type === "split") {
        expected = splitDeltas(snapshot, ratio, exclude);
        plus = ["mint"];
        minus = ["clawback"];
      } else {
        expected = redemptionDeltas(snapshot, ratio, exclude);
        plus = [];
        minus = ["burn", "clawback"];
      }
    }
    const windowTo = params.windowTo as string | undefined;
    const observed = observeFlows(this.loadEvents(flowAsset.id), {
      afterTime: recordTime,
      plus,
      minus,
      ...(windowTo ? { untilTime: windowTo } : {}),
      ...(payer ? { payer } : {}),
    });
    if (payer && observed.size === 0) {
      warnings.push(`Payer ${payer} has no recorded flows in the action window`);
    }
    const ignore = [...exclude, ...(payer ? [payer] : [])];
    const recon = reconcileDistribution(snapshot, expected, observed, { ignore });
    const base = (v: bigint) => formatUnits(v, asset.decimals);
    const flow = (v: bigint) => formatUnits(v, flowAsset.decimals);
    const result: ActionResult = {
      reconciledThrough: flowAsset.syncedAt ?? null,
      warnings,
      status: recon.breaks.length === 0 ? "clean" : "breaks",
      flowAsset: { id: flowAsset.id, code: flowAsset.code },
      summary: {
        holders: recon.summary.holders,
        expectedTotal: flow(recon.summary.expectedTotal),
        observedTotal: flow(recon.summary.observedTotal),
        difference: flow(recon.summary.difference),
        breakCount: recon.summary.breakCount,
      },
      lines: recon.lines.map((l) => ({
        address: l.address,
        basis: base(l.basis),
        expected: flow(l.expected),
        observed: flow(l.observed),
        difference: flow(l.difference),
        txHashes: l.txHashes,
        status: l.status,
      })),
      breaks: recon.breaks.map(
        (b): StoredBreak => ({
          scope: "distribution",
          type: b.type,
          severity: b.severity,
          key: b.key,
          fingerprint: `${b.expected}|${b.observed}`,
          message: b.message,
          address: b.address,
          expected: flow(b.expected),
          observed: flow(b.observed),
          difference: flow(b.difference),
        }),
      ),
    };
    this.db.run("UPDATE actions SET result = ?, reconciled_at = ? WHERE id = ?", JSON.stringify(result), now(), id);
    return this.action(id);
  }

  action(id: number) {
    const row = this.db.get("SELECT * FROM actions WHERE id = ?", id);
    if (!row) throw new NotFound(`corporate action ${id} not found`);
    const asset = this.asset(String(row.asset_id));
    const snapshot = row.snapshot
      ? (JSON.parse(String(row.snapshot)) as { ledger: number; takenAt: string; holders: Record<string, string> })
      : null;
    const result = row.result ? (JSON.parse(String(row.result)) as ActionResult) : null;
    const breaks = result ? this.annotate(asset.id, `action:${id}`, result.breaks) : [];
    return {
      id: Number(row.id),
      assetId: asset.id,
      type: String(row.type),
      label: String(row.label),
      recordTime: String(row.record_time),
      params: JSON.parse(String(row.params)) as Record<string, unknown>,
      createdAt: String(row.created_at),
      reconciledAt: row.reconciled_at ? String(row.reconciled_at) : null,
      state: snapshot ? (result?.status ?? "pending") : "scheduled",
      snapshot: snapshot && {
        ledger: snapshot.ledger,
        takenAt: snapshot.takenAt,
        holderCount: Object.keys(snapshot.holders).length,
        holders: Object.entries(snapshot.holders).map(([address, v]) => ({
          address,
          units: formatUnits(BigInt(v), asset.decimals),
        })),
      },
      result: result && { ...result, breaks },
      openBreaks: breaks.filter((b) => b.status === "open").length,
    };
  }

  actions(ref: string) {
    const asset = this.asset(ref);
    return this.db
      .all<{ id: number }>("SELECT id FROM actions WHERE asset_id = ? ORDER BY record_time DESC, id DESC", asset.id)
      .map(({ id }) => this.action(id));
  }

  /**
   * Reconcile the corporate actions whose record time the indexed chain has now passed. Run
   * after a sync, so a scheduled action advances without anyone pressing a button.
   */
  async reconcileDue(): Promise<number> {
    const due = this.db.all<{ id: number }>(
      `SELECT a.id FROM actions a JOIN assets s ON s.id = a.asset_id
       WHERE a.snapshot IS NULL AND s.synced_at IS NOT NULL AND s.synced_at >= a.record_time`,
    );
    let done = 0;
    for (const { id } of due) {
      try {
        await this.reconcileAction(id, { sync: false });
        done++;
      } catch (err) {
        console.error(`action ${id}: ${describeFailure(err)}`);
      }
    }
    return done;
  }

  // ── controls log ──────────────────────────────────────────────────────────

  controls(ref: string) {
    const asset = this.asset(ref);
    const initialFrozen = new Set<string>();
    for (const [address, opening] of this.openings(asset.id)) {
      if (opening.authorized === false) initialFrozen.add(address);
    }
    const log = buildControlsLog(this.loadControlEvents(asset.id), this.instructions(asset.id), {
      asOf: asset.syncedAt ?? new Date().toISOString(),
      initialFrozen,
    });
    const instructionJson = (i: Instruction) => ({
      ref: i.ref,
      type: i.type,
      account: i.account,
      units: i.units === undefined ? null : formatUnits(i.units, asset.decimals),
      issuedAt: i.issuedAt,
      approvedBy: i.approvedBy ?? null,
      reason: i.reason ?? null,
    });
    const breaks = this.annotate(
      asset.id,
      "controls",
      log.breaks.map((b) => ({
        scope: "control",
        type: b.type,
        severity: b.severity,
        key: b.key,
        fingerprint: b.key,
        message: b.message,
        address: b.address,
        ref: b.ref ?? null,
        eventId: b.eventId ?? null,
        txHash: b.txHash ?? null,
      })),
    );
    return {
      asOf: asset.syncedAt ?? null,
      summary: log.summary,
      records: log.records
        .map((r) => ({
          eventId: r.eventId,
          type: r.type,
          account: r.account,
          units: r.units === undefined ? null : formatUnits(r.units, asset.decimals),
          ledger: r.ledger,
          closedAt: r.closedAt,
          txHash: r.txHash,
          instruction: r.instruction ? instructionJson(r.instruction) : null,
        }))
        .reverse(),
      pending: log.pending.map(instructionJson),
      breaks,
      openBreaks: breaks.filter((b) => b.status === "open").length,
    };
  }

  // ── overview and export ───────────────────────────────────────────────────

  overview(network?: NetworkName) {
    return {
      networks: this.networkNames(),
      assets: this.assets(network).map((asset) => this.assetSummary(asset)),
    };
  }

  /** One asset with the headline figures the dashboard lists. */
  assetSummary(asset: AssetRecord) {
    const state = this.state(asset);
    const run = this.latestRun(asset.id);
    const controls = this.controls(asset.id);
    const actions = this.actions(asset.id);
    const events = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE asset_id = ?", asset.id)!.n;
    return {
      ...asset,
      supply: formatUnits(state.supply, asset.decimals),
      holderCount: state.balances.size,
      eventCount: events,
      incomplete: state.incomplete.length > 0,
      lastRun: run && { id: run.id, asOf: run.asOf, status: run.status, openBreaks: run.openBreaks },
      openBreaks: {
        reconciliation: run?.openBreaks ?? 0,
        controls: controls.openBreaks,
        actions: actions.reduce((n, a) => n + a.openBreaks, 0),
      },
    };
  }

  /** Everything an auditor needs for a period, with a digest over the content. */
  auditExport(ref: string, period: { from?: string; to?: string } = {}) {
    const asset = this.asset(ref);
    const to = period.to ? isoTime(period.to, "to") : (asset.syncedAt ?? now());
    const from = period.from ? isoTime(period.from, "from") : "1970-01-01T00:00:00.000Z";
    const inPeriod = (t: string) => t >= from && t <= to;
    const controls = this.controls(asset.id);
    const runs = this.db
      .all<{ id: number }>("SELECT id FROM runs WHERE asset_id = ? ORDER BY as_of, id", asset.id)
      .map(({ id }) => this.run(id))
      .filter((r) => inPeriod(r.asOf));
    const content = {
      asset: {
        id: asset.id,
        network: asset.network,
        code: asset.code,
        issuer: asset.issuer ?? null,
        name: asset.name,
        decimals: asset.decimals,
        indexedFromLedger: asset.startLedger ?? null,
        baselineLedger: asset.baselineLedger ?? null,
        historyFrom: asset.historyFrom ?? null,
        indexedToLedger: asset.syncedLedger ?? null,
        indexedTo: asset.syncedAt ?? null,
        ignoredAddresses: asset.ignore,
      },
      period: { from, to },
      holdings: this.holdings(asset.id, to),
      reconciliations: runs,
      corporateActions: this.actions(asset.id).filter((a) => inPeriod(a.recordTime)),
      controls: {
        ...controls,
        records: controls.records.filter((r) => inPeriod(r.closedAt)),
      },
      events: this.loadEvents(asset.id)
        .filter((e) => inPeriod(e.closedAt))
        .map((e) => this.eventJson(e, asset.decimals)),
    };
    return { generatedAt: now(), generator: "concord/0.1.0", sha256: sha256(JSON.stringify(content)), ...content };
  }

  /** One section of the audit pack as CSV. */
  exportCsv(ref: string, section: string, period: { from?: string; to?: string } = {}): string {
    const pack = this.auditExport(ref, period);
    switch (section) {
      case "holdings":
        return toCsv(["address", "units", "share", "status", "ignored"], pack.holdings.holders);
      case "events":
        return toCsv(["id", "ledger", "closedAt", "kind", "from", "to", "units", "authorized", "txHash"], pack.events);
      case "controls":
        return toCsv(
          ["closedAt", "ledger", "type", "account", "units", "txHash", "instructionRef", "approvedBy", "reason"],
          pack.controls.records.map((r) => ({
            ...r,
            instructionRef: r.instruction?.ref ?? "",
            approvedBy: r.instruction?.approvedBy ?? "",
            reason: r.instruction?.reason ?? "",
          })),
        );
      case "breaks": {
        const rows: Array<Record<string, unknown>> = [];
        for (const run of pack.reconciliations) {
          for (const b of run.breaks) rows.push({ source: `reconciliation ${run.id}`, asOf: run.asOf, ...b });
        }
        for (const a of pack.corporateActions) {
          for (const b of a.result?.breaks ?? []) rows.push({ source: `${a.type} ${a.id}`, asOf: a.recordTime, ...b });
        }
        for (const b of pack.controls.breaks) rows.push({ source: "controls", asOf: pack.period.to, ...b });
        return toCsv(
          [
            "source", "asOf", "scope", "type", "severity", "address", "ref", "txHash", "chainUnits",
            "registerUnits", "expected", "observed", "difference", "message", "firstSeen", "status", "note", "noteAuthor",
          ],
          rows,
        );
      }
      default:
        throw new Invalid("section must be holdings, events, controls or breaks");
    }
  }
}
