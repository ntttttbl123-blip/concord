/**
 * Against a real Stellar network: the `stellar/quickstart` image in local mode, with RPC and
 * Horizon. Everything else in the suite runs on FakeChain, so a change in the event topic layout
 * or a Horizon response shape would only show on mainnet. This runs a regulated asset's life
 * cycle on a fresh network and checks what a real StellarSource makes of it.
 *
 * Needs QUICKSTART_URL (default http://localhost:8000). Run with `pnpm test:integration`;
 * .github/workflows/integration.yml starts the container nightly.
 */
import {
  Asset,
  AuthClawbackEnabledFlag,
  AuthRequiredFlag,
  AuthRevocableFlag,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  type xdr,
} from "@stellar/stellar-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { StellarSource } from "../../src/chain.js";
import { Concord } from "../../src/concord.js";
import type { NetworkConfig } from "../../src/config.js";
import { Db } from "../../src/db.js";
import { ORG_MIGRATIONS } from "../../src/schema.js";

const BASE = (process.env.QUICKSTART_URL ?? "http://localhost:8000").replace(/\/+$/, "");
const PASSPHRASE = Networks.STANDALONE;
// Concord knows two network names. The local network stands in for testnet, with its own passphrase.
const LOCAL: NetworkConfig = {
  name: "testnet",
  passphrase: PASSPHRASE,
  rpc: [{ url: `${BASE}/rpc` }],
  horizon: [{ url: BASE }],
};
const server = new rpc.Server(`${BASE}/rpc`, { allowHttp: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fund(kp: Keypair): Promise<void> {
  for (let i = 1; ; i++) {
    const res = await fetch(`${BASE}/friendbot?addr=${kp.publicKey()}`).catch(() => undefined);
    if (res?.ok) return;
    // Friendbot comes up a little after RPC and Horizon.
    if (i >= 30) throw new Error(`friendbot: ${res ? `HTTP ${res.status} ${await res.text()}` : "unreachable"}`);
    await sleep(2000);
  }
}

interface Settled {
  hash: string;
  ledger: number;
  closedAt: string;
}

async function submit(label: string, source: Keypair, ops: xdr.Operation[], signers: Keypair[] = []): Promise<Settled> {
  const account = await server.getAccount(source.publicKey());
  const builder = new TransactionBuilder(account, { fee: String(Number(BASE_FEE) * 100), networkPassphrase: PASSPHRASE });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(60).build();
  tx.sign(source, ...signers);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`${label} rejected: ${JSON.stringify(sent.errorResult ?? sent)}`);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const got = await server.getTransaction(sent.hash);
    if (got.status === "NOT_FOUND") continue;
    if (got.status !== "SUCCESS") throw new Error(`${label} failed on-chain (${sent.hash})`);
    return { hash: sent.hash, ledger: got.ledger, closedAt: new Date(Number(got.createdAt) * 1000).toISOString() };
  }
  throw new Error(`${label} did not settle`);
}

/** Index until the asset has reached `ledger`; the RPC can lag the transaction by a ledger or two. */
async function syncTo(ws: Concord, assetId: string, ledger: number): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await ws.sync(assetId);
    if ((ws.asset(assetId).syncedLedger ?? 0) >= ledger) return;
    await sleep(1000);
  }
  throw new Error(`asset not indexed to ledger ${ledger}`);
}

function workspace(): Concord {
  return new Concord(new Db(":memory:", ORG_MIGRATIONS), {
    testnet: { passphrase: PASSPHRASE, chain: new StellarSource(LOCAL) },
  });
}

const issuer = Keypair.random();
const holders = Array.from({ length: 4 }, () => Keypair.random());
const [h1, h2, h3, h4] = holders.map((k) => k.publicKey()) as [string, string, string, string];
const share = new Asset("QSFUND", issuer.publicKey());
const spec = `${share.getCode()}:${share.getIssuer()}`;
const pay = (destination: string, amount: string) => Operation.payment({ destination, asset: share, amount });

/** Opening balances (Horizon) for one workspace, events from the first ledger (RPC) for the other. */
let fromBaseline: Concord;
let fromEvents: Concord;
let baselineId: string;
let eventsId: string;
let freeze: Settled;
let clawback: Settled;

describe("a regulated asset on a local Stellar network", () => {
  beforeAll(async () => {
    await fund(issuer);
    const setup = await submit("accounts and regulated flags", issuer, [
      ...holders.map((k) => Operation.createAccount({ destination: k.publicKey(), startingBalance: "100" })),
      Operation.setOptions({ setFlags: (AuthRequiredFlag | AuthRevocableFlag | AuthClawbackEnabledFlag) as 11 }),
    ]);
    await submit(
      "trustlines and authorisations",
      issuer,
      holders.flatMap((k) => [
        Operation.changeTrust({ asset: share, source: k.publicKey() }),
        Operation.setTrustLineFlags({ trustor: k.publicKey(), asset: share, flags: { authorized: true } }),
      ]),
      holders,
    );
    await submit("mints before watching", issuer, [pay(h1, "1000"), pay(h3, "300"), pay(h4, "100")]);

    fromBaseline = workspace();
    baselineId = (await fromBaseline.watchAsset({ network: "testnet", asset: spec })).id;
    fromEvents = workspace();
    eventsId = (await fromEvents.watchAsset({ network: "testnet", asset: spec, fromLedger: setup.ledger })).id;

    await submit("mint after watching", issuer, [pay(h2, "500")]);
    await submit("transfer", holders[0]!, [pay(h2, "200")]);
    freeze = await submit("freeze", issuer, [
      Operation.setTrustLineFlags({ trustor: h3, asset: share, flags: { authorized: false } }),
    ]);
    clawback = await submit("clawback", issuer, [Operation.clawback({ asset: share, from: h4, amount: "50" })]);

    await syncTo(fromBaseline, baselineId, clawback.ledger);
    await syncTo(fromEvents, eventsId, clawback.ledger);
  });

  it("describes the asset from Horizon and takes opening balances from it", () => {
    const asset = fromBaseline.asset(baselineId);
    expect(asset).toMatchObject({ code: "QSFUND", issuer: issuer.publicKey(), decimals: 7, startMode: "baseline", state: "ready" });
    expect(asset.baselineLedger).toBeGreaterThan(0);
    expect(asset.syncError).toBeUndefined();
  });

  for (const [label, ws, id] of [
    ["from opening balances", () => fromBaseline, () => baselineId],
    ["from events alone", () => fromEvents, () => eventsId],
  ] as const) {
    it(`holds what the ledger holds, ${label}`, () => {
      const h = ws().holdings(id());
      expect(h.supply).toBe("1850");
      expect(h.incomplete).toEqual([]);
      const byAddress = Object.fromEntries(h.holders.map((x) => [x.address, { units: x.units, status: x.status }]));
      expect(byAddress).toEqual({
        [h1]: { units: "800", status: "active" },
        [h2]: { units: "700", status: "active" },
        [h3]: { units: "300", status: "frozen" },
        [h4]: { units: "50", status: "active" },
      });
    });
  }

  it("logs the freeze and the clawback, and matches the freeze to its instruction", () => {
    const issuedAt = new Date(Date.parse(freeze.closedAt) - 60_000).toISOString();
    fromBaseline.importInstructions(baselineId, `ref,type,account,issued_at\nI-1,freeze,${h3},${issuedAt}\n`);
    const log = fromBaseline.controls(baselineId);
    expect(log.records.map((r) => ({ type: r.type, account: r.account, units: r.units, ledger: r.ledger }))).toEqual([
      { type: "clawback", account: h4, units: "50", ledger: clawback.ledger },
      { type: "freeze", account: h3, units: null, ledger: freeze.ledger },
    ]);
    expect(log.records[1]!.instruction?.ref).toBe("I-1");
    expect(log.breaks.map((b) => ({ type: b.type, address: b.address }))).toEqual([{ type: "UNINSTRUCTED_CONTROL", address: h4 }]);
  });

  it("sees every authorisation when replaying from the first ledger", () => {
    const types = fromEvents.controls(eventsId).records.map((r) => `${r.type} ${r.account}`);
    expect(types.sort()).toEqual(
      [...holders.map((k) => `authorize ${k.publicKey()}`), `freeze ${h3}`, `clawback ${h4}`].sort(),
    );
  });
});
