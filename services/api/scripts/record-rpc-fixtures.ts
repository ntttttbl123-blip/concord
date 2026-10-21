import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { decodeEvent, type RawEvent } from "../src/chain.js";

const OUTPUT = resolve(import.meta.dirname, "../test/fixtures/rpc/get-events-golden.json");
const SOURCES = [
  {
    network: "mainnet",
    rpc: process.env.CONCORD_MAINNET_RPC_URL ?? "https://mainnet.sorobanrpc.com",
    sac: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  },
  {
    network: "testnet",
    rpc: process.env.CONCORD_TESTNET_RPC_URL ?? "https://soroban-testnet.stellar.org",
    sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  },
] as const;
const KINDS = ["transfer", "mint", "burn", "clawback", "set_authorized"] as const;

interface RpcPage {
  events: RawEvent[];
  cursor?: string;
  latestLedger: number;
  latestLedgerCloseTime?: string;
}

interface RpcReply<T> {
  result?: T;
  error?: { code: number; message: string };
}

function symbol(value: string): string {
  return nativeToScVal(value, { type: "symbol" }).toXDR("base64");
}

async function rpc<T>(url: string, method: string, params?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const body = (await response.json()) as RpcReply<T>;
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  if (!body.result) throw new Error(`${method} returned no result`);
  return body.result;
}

function rawFields(event: RawEvent): RawEvent {
  // Keep only fields decodeEvent reads; RPC response metadata can contain unrelated data.
  return {
    id: event.id,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId: event.contractId,
    txHash: event.txHash,
    topic: event.topic,
    value: event.value,
  };
}

async function firstEvent(
  rpcUrl: string,
  startLedger: number,
  topic: string,
  lengths: number[],
  contractId?: string,
): Promise<RawEvent | undefined> {
  const filters = lengths.map((length) => ({
    type: "contract",
    ...(contractId ? { contractIds: [contractId] } : {}),
    topics: [[topic, ...Array.from({ length: length - 1 }, () => "*")]],
  }));
  const page = await rpc<RpcPage>(rpcUrl, "getEvents", {
    startLedger,
    filters,
    pagination: { limit: 20 },
  });
  return page.events[0];
}

async function muxedTransfer(rpcUrl: string, startLedger: number, sac: string): Promise<RawEvent | undefined> {
  const topic = symbol("transfer");
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    const page = await rpc<RpcPage>(rpcUrl, "getEvents", {
      startLedger,
      filters: [{ type: "contract", contractIds: [sac], topics: [[topic, "*", "*", "*"]] }],
      pagination: { limit: 1000, ...(cursor ? { cursor } : {}) },
    });
    const found = page.events.find((event) => {
      const value = Buffer.from(event.value, "base64");
      return value.length >= 4 && value.readUInt32BE(0) === 17; // ScVal map: amount + to_muxed_id.
    });
    if (found) return found;
    if (!page.cursor || page.cursor === cursor || page.events.length === 0) break;
    cursor = page.cursor;
  }
  return undefined;
}

async function main(): Promise<void> {
  const fixtures: Array<{
    label: string;
    network: string;
    raw: RawEvent;
    expected: Record<string, unknown>;
  }> = [];

  for (const source of SOURCES) {
    const health = await rpc<{ latestLedger: number; oldestLedger: number }>(source.rpc, "getHealth");
    const startLedger = Math.max(health.oldestLedger + 1, health.latestLedger - 5_000);

    for (const kind of KINDS) {
      const lengths = kind === "transfer" ? [3, 4] : [2, 3, 4];
      const event = await firstEvent(source.rpc, startLedger, symbol(kind), lengths);
      if (!event) throw new Error(`No ${source.network} ${kind} event found in the latest 5,000 ledgers.`);
      const raw = rawFields(event);
      const expected = decodeEvent(raw);
      if (!expected) throw new Error(`Could not decode recorded ${source.network} ${kind} event ${raw.id}.`);
      fixtures.push({ label: `${source.network} ${kind}`, network: source.network, raw, expected: { ...expected, amount: expected.amount.toString() } });
    }

    const sep41 = await firstEvent(source.rpc, startLedger, symbol("transfer"), [3]);
    if (!sep41) throw new Error(`No ${source.network} three-topic SEP-41 transfer found in the latest 5,000 ledgers.`);
    const sep41Raw = rawFields(sep41);
    const sep41Expected = decodeEvent(sep41Raw);
    if (!sep41Expected) throw new Error(`Could not decode recorded ${source.network} SEP-41 transfer ${sep41Raw.id}.`);
    fixtures.push({ label: `${source.network} SEP-41 transfer`, network: source.network, raw: sep41Raw, expected: { ...sep41Expected, amount: sep41Expected.amount.toString() } });

    const muxed = await muxedTransfer(source.rpc, Math.max(health.oldestLedger + 1, health.latestLedger - 50_000), source.sac);
    if (!muxed) throw new Error(`No ${source.network} muxed SAC transfer found in the retained ledger window.`);
    const muxedRaw = rawFields(muxed);
    const muxedExpected = decodeEvent(muxedRaw);
    if (!muxedExpected) throw new Error(`Could not decode recorded ${source.network} muxed transfer ${muxedRaw.id}.`);
    fixtures.push({ label: `${source.network} muxed SAC transfer`, network: source.network, raw: muxedRaw, expected: { ...muxedExpected, amount: muxedExpected.amount.toString() } });
  }

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify({ recordedFrom: "public Stellar RPC getEvents; decoder fields only", fixtures }, null, 2)}\n`);
  console.log(`Recorded ${fixtures.length} sanitized getEvents fixtures at ${OUTPUT}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
