import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { StrKey, nativeToScVal } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChainError, StellarSource, cursorLedger, decodeEvent, type AssetCandidate } from "../src/chain.js";
import { USAGE } from "../src/cli-usage.js";
import { Concord, Invalid, NotFound, describeFailure } from "../src/concord.js";
import { Db } from "../src/db.js";
import { Client, FakeChain, PASSPHRASE, at, harness, key, u } from "./helpers.js";

const validateAuditPack = new Ajv({ allErrors: true, strict: true }).compile(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../docs/audit-pack.schema.json", import.meta.url)), "utf8")),
);

/** Every key path in a value, with `[]` for arrays, so a renamed or dropped field changes the list. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    const here = `${prefix}[]`;
    return [here, ...value.flatMap((item) => keyPaths(item, here))];
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key));
  }
  return prefix ? [prefix] : [];
}

describe("decodeEvent", () => {
  const a = key();
  const b = key();
  const sym = (s: string) => nativeToScVal(s, { type: "symbol" }).toXDR("base64");
  const addr = (s: string) => nativeToScVal(s, { type: "address" }).toXDR("base64");
  const str = (s: string) => nativeToScVal(s).toXDR("base64");
  const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" }).toXDR("base64");
  const raw = (topic: string[], value: string) => ({
    id: "0000000429496729600-0000000001",
    ledger: 100,
    ledgerClosedAt: "2026-10-01T00:00:00Z",
    contractId: "CASSET",
    txHash: "ab",
    topic,
    value,
  });

  it("decodes the CAP-67 layouts", () => {
    expect(decodeEvent(raw([sym("transfer"), addr(a), addr(b), str(`FUND:${a}`)], i128(5n)))).toMatchObject({
      kind: "transfer",
      from: a,
      to: b,
      amount: 5n,
    });
    expect(decodeEvent(raw([sym("mint"), addr(b), str(`FUND:${a}`)], i128(7n)))).toMatchObject({ to: b, amount: 7n });
    expect(decodeEvent(raw([sym("clawback"), addr(b), str(`FUND:${a}`)], i128(7n)))).toMatchObject({ from: b });
    const authFalse = decodeEvent(raw([sym("set_authorized"), addr(b), str(`FUND:${a}`)], nativeToScVal(false).toXDR("base64")));
    expect(authFalse).toMatchObject({ kind: "set_authorized", from: b, authorized: false, amount: 0n });
    const authTrue = decodeEvent(raw([sym("set_authorized"), addr(b), str(`FUND:${a}`)], nativeToScVal(true).toXDR("base64")));
    expect(authTrue).toMatchObject({ kind: "set_authorized", from: b, authorized: true, amount: 0n });
    expect(decodeEvent(raw([sym("set_authorized"), addr(b), str(`FUND:${a}`)], str("false")))).toBeUndefined();
    expect(decodeEvent(raw([sym("set_authorized"), addr(b), str(`FUND:${a}`)], i128(1n)))).toBeUndefined();
    expect(decodeEvent(raw([sym("set_authorized"), addr(b), str(`FUND:${a}`)], nativeToScVal(undefined, { type: "void" }).toXDR("base64")))).toBeUndefined();
  });

  it("takes the subject from the last address when an admin leads, and reads muxed values", () => {
    expect(decodeEvent(raw([sym("mint"), addr(a), addr(b), str(`FUND:${a}`)], i128(7n)))).toMatchObject({ to: b });
    const muxed = nativeToScVal({ amount: 9n, to_muxed_id: 42n }, { type: { amount: ["symbol", "i128"], to_muxed_id: ["symbol", "u64"] } });
    expect(decodeEvent(raw([sym("transfer"), addr(a), addr(b)], muxed.toXDR("base64")))).toMatchObject({ amount: 9n });
  });

  it("ignores events outside the asset set", () => {
    expect(decodeEvent(raw([sym("approve"), addr(a), addr(b)], i128(1n)))).toBeUndefined();
  });

  it("returns undefined without throwing when ledgerClosedAt is unparseable", () => {
    const invalidDateRaw = {
      ...raw([sym("transfer"), addr(a), addr(b), str(`FUND:${a}`)], i128(5n)),
      ledgerClosedAt: "garbage",
    };
    expect(() => decodeEvent(invalidDateRaw)).not.toThrow();
    expect(decodeEvent(invalidDateRaw)).toBeUndefined();
  });

  it("rejects negative amounts and accepts zero amounts for transfer, mint, burn, and clawback", () => {
    // transfer
    expect(decodeEvent(raw([sym("transfer"), addr(a), addr(b), str(`FUND:${a}`)], i128(-5n)))).toBeUndefined();
    expect(decodeEvent(raw([sym("transfer"), addr(a), addr(b), str(`FUND:${a}`)], i128(0n)))).toMatchObject({
      kind: "transfer",
      amount: 0n,
    });

    // mint
    expect(decodeEvent(raw([sym("mint"), addr(b), str(`FUND:${a}`)], i128(-5n)))).toBeUndefined();
    expect(decodeEvent(raw([sym("mint"), addr(b), str(`FUND:${a}`)], i128(0n)))).toMatchObject({
      kind: "mint",
      amount: 0n,
    });

    // burn
    expect(decodeEvent(raw([sym("burn"), addr(b), str(`FUND:${a}`)], i128(-5n)))).toBeUndefined();
    expect(decodeEvent(raw([sym("burn"), addr(b), str(`FUND:${a}`)], i128(0n)))).toMatchObject({
      kind: "burn",
      amount: 0n,
    });

    // clawback
    expect(decodeEvent(raw([sym("clawback"), addr(b), str(`FUND:${a}`)], i128(-5n)))).toBeUndefined();
    expect(decodeEvent(raw([sym("clawback"), addr(b), str(`FUND:${a}`)], i128(0n)))).toMatchObject({
      kind: "clawback",
      amount: 0n,
    });
  });

  it("returns undefined without throwing when topic or value contains malformed XDR", () => {
    // Malformed topic (not valid base64 / ScVal)
    const badTopicRaw = {
      ...raw(["!!!notxdr", addr(a), addr(b), str(`FUND:${a}`)], i128(5n)),
    };
    expect(() => decodeEvent(badTopicRaw)).not.toThrow();
    expect(decodeEvent(badTopicRaw)).toBeUndefined();

    // Truncated / malformed value XDR
    const truncatedValueRaw = {
      ...raw([sym("transfer"), addr(a), addr(b), str(`FUND:${a}`)], "AAAA"),
    };
    expect(() => decodeEvent(truncatedValueRaw)).not.toThrow();
    expect(decodeEvent(truncatedValueRaw)).toBeUndefined();
  });

  it("skips malformed events and returns the remaining good events in getEvents", async () => {
    const goodRaw = raw([sym("transfer"), addr(a), addr(b), str(`FUND:${a}`)], i128(5n));
    // A kind Concord does not track is ignored, not malformed.
    const ignoredRaw = raw([sym("approve"), addr(a), addr(b), str(`FUND:${a}`)], i128(1n));
    const badRaw = {
      ...raw(["!!!notxdr", addr(a), addr(b), str(`FUND:${a}`)], i128(5n)),
      id: "0000000429496729600-0000000002",
    };
    const network = {
      name: "testnet" as const,
      passphrase: "test",
      rpc: [{ url: "https://rpc.example" }],
      horizon: [{ url: "https://horizon.example" }],
    };
    const deps = {
      fetch: async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              events: [badRaw, ignoredRaw, goodRaw],
              latestLedger: 100,
              cursor: "cursor-1",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      now: () => 0,
      sleep: async () => {},
    };
    const source = new StellarSource(network, deps);
    const page = await source.getEvents("CASSET", { startLedger: 1 }, 10);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.kind).toBe("transfer");
    expect(page.events[0]!.amount).toBe(5n);
    expect(page.skipped).toBe(1);
    expect(page.latestLedger).toBe(100);
    expect(page.cursor).toBe("cursor-1");
  });
});

describe("cursorLedger", () => {
  it("decodes valid TOID cursors with or without index", () => {
    // 100 << 32 = 429496729600n
    expect(cursorLedger("429496729600-0000000001")).toBe(100);
    expect(cursorLedger("429496729600-1")).toBe(100);
    expect(cursorLedger("429496729600")).toBe(100);
  });

  const invalidCases = [
    { label: "empty string", input: "" },
    { label: "negative number", input: "-5" },
    { label: "non-numeric string", input: "abc-1" },
    { label: "invalid characters", input: "123a-45" },
    { label: "multiple hyphens", input: "123-45-67" },
    { label: "trailing hyphen", input: "123-" },
  ];

  for (const { label, input } of invalidCases) {
    it(`throws ChainError on ${label} (${JSON.stringify(input)})`, () => {
      expect(() => cursorLedger(input)).toThrow(ChainError);
      expect(() => cursorLedger(input)).toThrow(/invalid cursor/);
    });
  }
});

describe("Concord", () => {
  let chain: FakeChain;
  let concord: Concord;
  let assetId: string;
  const issuer = key();
  const [h1, h2, h3, treasury] = [key(), key(), key(), key()];

  beforeEach(async () => {
    chain = new FakeChain();
    concord = new Concord(new Db(":memory:"), { testnet: { passphrase: PASSPHRASE, chain } });
    const asset = await concord.watchAsset({ network: "testnet", asset: `FUND:${issuer}`, fromLedger: 1, ignore: [treasury] });
    assetId = asset.id;
    chain.push(assetId, "set_authorized", 2, { from: h1, authorized: true });
    chain.push(assetId, "mint", 3, { to: h1, amount: u(100) });
    chain.push(assetId, "mint", 3, { to: h2, amount: u(50) });
    chain.push(assetId, "mint", 3, { to: treasury, amount: u(999) });
    chain.push(assetId, "transfer", 10, { from: h1, to: h2, amount: u(10) });
    chain.push(assetId, "set_authorized", 20, { from: h2, authorized: false });
    chain.push(assetId, "clawback", 30, { from: h2, amount: u(5) });
  });

  async function expectPagedSync(count: number, calls: number) {
    const code = `PAGE${count}`;
    const asset = await concord.watchAsset({ network: "testnet", asset: `${code}:${issuer}`, fromLedger: 1 });
    const pushed = Array.from({ length: count }, () =>
      chain.push(asset.id, "mint", 40, { to: h3, amount: 1n }).id,
    );

    chain.calls = 0;
    expect(await concord.sync(code)).toEqual({ added: count });
    expect(chain.calls).toBe(calls);
    const stored = concord.db
      .all<{ id: string }>("SELECT id FROM events WHERE asset_id = ? ORDER BY id", asset.id)
      .map((row) => row.id);
    expect(stored).toEqual(pushed);
    expect(await concord.sync(code)).toEqual({ added: 0 });
  }

  it("indexes in pages and is idempotent", async () => {
    for (let i = 0; i < 2500; i++) chain.push(assetId, "mint", 40, { to: h3, amount: 1n });
    expect(await concord.sync("FUND")).toEqual({ added: 2507 });
    expect(chain.calls).toBe(3);
    expect(await concord.sync("FUND")).toEqual({ added: 0 });
    const h = concord.holdings("FUND");
    expect(h.supply).toBe("1144.00025");
    expect(h.holders.find((x) => x.address === h2)).toMatchObject({ units: "55", status: "frozen" });
    expect(concord.asset("FUND").syncedLedger).toBe(100);
  });

  it("pages across a boundary that splits several events of the same ledger without losing or duplicating any", async () => {
    await expectPagedSync(999, 1);
    await expectPagedSync(1000, 2);
  });

  it("keeps paging when a ledger fills more than one full page", async () => {
    await expectPagedSync(1001, 2);
    await expectPagedSync(2000, 3);
  });

  it("rejects reconciliation when no register has been imported", async () => {
    await expect(concord.reconcile("FUND")).rejects.toThrow(new NotFound("no register imported for this asset"));
  });

  it("defaults to the latest register by as-of time rather than import order", async () => {
    const csv = `holder_id,account,units\nA,${h1},90\nB,${h2},55\n`;
    const latest = concord.importRegister("FUND", { csv, asOf: at(40) });
    const older = concord.importRegister("FUND", { csv, asOf: at(10) });

    expect(latest.registerId).toBe(1);
    expect(older.registerId).toBeGreaterThan(latest.registerId);
    expect(await concord.reconcile("FUND")).toMatchObject({ registerId: latest.registerId, asOf: at(40) });
  });

  it("accepts current register times but rejects times beyond the clock skew", () => {
    const csv = `holder_id,account,units\nA,${h1},90\n`;
    const current = new Date().toISOString();
    const withinSkew = new Date(Date.now() + 4 * 60_000).toISOString();
    const tooFarAhead = new Date(Date.now() + 6 * 60_000).toISOString();

    expect(() => concord.importRegister("FUND", { csv, asOf: current })).not.toThrow();
    expect(() => concord.importRegister("FUND", { csv, asOf: withinSkew })).not.toThrow();
    expect(() => concord.importRegister("FUND", { csv, asOf: tooFarAhead })).toThrow(
      new Invalid("asOf cannot be more than 5 minutes in the future"),
    );
    expect(() => concord.importRegister("FUND", { csv, asOf: "2099-01-01" })).toThrow(Invalid);
    expect(concord.registers("FUND")).toHaveLength(2);
  });

  it("treats the same file at the same as-of time as one register, and a different as-of time as a new one", async () => {
    const csv = `holder_id,account,units\nA,${h1},90\n`;
    const first = concord.importRegister("FUND", { csv, asOf: at(40) });
    expect(first.duplicate).toBe(false);
    await concord.reconcile("FUND", first.registerId);
    const again = concord.importRegister("FUND", { csv, asOf: at(40) });
    expect(again).toMatchObject({ registerId: first.registerId, duplicate: true });
    expect(concord.registers("FUND")).toHaveLength(1);
    expect(concord.latestRunForRegister(first.registerId)).not.toBeNull();
    const later = concord.importRegister("FUND", { csv, asOf: at(41) });
    expect(later).toMatchObject({ duplicate: false });
    expect(later.registerId).not.toBe(first.registerId);
    expect(concord.registers("FUND")).toHaveLength(2);
  });

  it("rounds holder shares half up to four decimals so two thirds and one third add to 100", async () => {
    const asset = await concord.watchAsset({ network: "testnet", asset: `THIRDS:${key()}`, fromLedger: 1 });
    chain.push(asset.id, "mint", 3, { to: h1, amount: u(2) });
    chain.push(asset.id, "mint", 3, { to: h2, amount: u(1) });
    await concord.sync("THIRDS");
    const shares = concord.holdings("THIRDS").holders.map((h) => h.share);
    expect(shares).toEqual([66.6667, 33.3333]);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 4);
    expect(concord.auditExport("THIRDS").holdings.holders.map((h) => h.share)).toEqual(shares);
  });

  it("refuses a sign-off for a break that is not in the current results", async () => {
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(40) });
    const run = await concord.reconcile("FUND", reg.registerId);
    const note = { fingerprint: "f", status: "resolved" as const, note: "x" };
    expect(() => concord.setNote("FUND", "recon", "NOT_A_BREAK:xyz", note)).toThrow(/no break NOT_A_BREAK:xyz/);
    expect(() => concord.setNote("FUND", "controls", run.breaks[0]!.key, note)).toThrow(/no break/);
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM break_notes")!.n).toBe(0);
    concord.setNote("FUND", "recon", run.breaks[0]!.key, { ...note, fingerprint: run.breaks[0]!.fingerprint });
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM break_notes")!.n).toBe(1);
  });

  it("reopens a control sign-off when the instruction behind it is replaced by a changed row", async () => {
    concord.importInstructions("FUND", `ref,type,account,units,issued_at\nI7,freeze,${h3},,${at(19)}\n`);
    chain.latest = 6000; // past the 72h execution window
    await concord.sync("FUND");
    const brk = concord.controls("FUND").breaks.find((b) => b.key === "UNEXECUTED_INSTRUCTION:I7")!;
    expect(brk.status).toBe("open");
    concord.setNote("FUND", "controls", brk.key, { fingerprint: brk.fingerprint, status: "resolved", note: "cancelled off-chain" });
    expect(concord.controls("FUND").breaks.find((b) => b.key === brk.key)).toMatchObject({ status: "resolved", noteStale: false });
    // The same ref is re-imported for a different account: a different instruction, so open again.
    concord.importInstructions("FUND", `ref,type,account,units,issued_at\nI7,freeze,${h1},,${at(19)}\n`);
    expect(concord.controls("FUND").breaks.find((b) => b.key === brk.key)).toMatchObject({ status: "open", noteStale: true });
  });

  it("keeps every sign-off change, with who and when, and puts it in the audit pack", async () => {
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(40) });
    const run = await concord.reconcile("FUND", reg.registerId);
    const brk = run.breaks[0]!;
    const sign = (status: "open" | "acknowledged" | "resolved", note: string, label: string) =>
      concord.setNote("FUND", "recon", brk.key, { fingerprint: brk.fingerprint, status, note }, { id: label, label });
    sign("acknowledged", "T+1 timing", "alice");
    sign("resolved", "register corrected", "bob");
    sign("open", "reopened: file was wrong", "alice");

    // The current state is the last change; the trail keeps all three.
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM break_notes")!.n).toBe(1);
    const history = concord.noteHistory("FUND", "recon", brk.key);
    expect(history.map((h) => [h.author, h.status, h.note])).toEqual([
      ["alice", "acknowledged", "T+1 timing"],
      ["bob", "resolved", "register corrected"],
      ["alice", "open", "reopened: file was wrong"],
    ]);
    expect(history.every((h) => h.at && h.fingerprint === brk.fingerprint)).toBe(true);
    expect(concord.noteHistory("FUND", "recon", "SOMETHING_ELSE")).toEqual([]);
    expect(concord.auditExport("FUND").signoffHistory).toEqual(history);
    // Sign-offs are wall-clock events, so the period (chain time) does not narrow the trail.
    expect(concord.auditExport("FUND", { from: "2020-01-01", to: "2020-01-02" }).signoffHistory).toEqual(history);
  });

  it("narrows the whole controls section of an audit pack to the period, not just its records", async () => {
    await concord.sync("FUND");
    const all = concord.auditExport("FUND").controls;
    expect(all.records.map((r) => r.type).sort()).toEqual(["authorize", "clawback", "freeze"]);

    // Ledgers 15-25 hold only the freeze of h2; the pack must not still count the clawback.
    const freezeOnly = concord.auditExport("FUND", { from: at(15), to: at(25) }).controls;
    expect(freezeOnly.records.map((r) => r.type)).toEqual(["freeze"]);
    expect(freezeOnly.asOf).toBe(at(25));
    expect(freezeOnly.summary).toMatchObject({ controls: 1, uninstructed: 1 });
    expect(freezeOnly.breaks.map((b) => b.type)).toEqual(["UNINSTRUCTED_CONTROL"]);

    // A period with no control in it says so everywhere.
    const none = concord.auditExport("FUND", { from: at(50), to: at(60) }).controls;
    expect(none.records).toEqual([]);
    expect(none.summary).toMatchObject({ controls: 0, instructed: 0, uninstructed: 0, unexecuted: 0, pending: 0 });
    expect(none.breaks).toEqual([]);
    expect(none.openBreaks).toBe(0);
  });

  it("lets the watch route replay from a named ledger, and still rejects a bad one", async () => {
    const h = harness();
    h.chain.baselineResult = { ledger: 50, openings: new Map() };
    const client = await new Client(h.app).signUp("replay@example.test", "Replay");
    const named = await client.call("/api/assets", {
      body: { network: "testnet", asset: `NAMED:${issuer}`, fromLedger: 5 },
    });
    expect(named.status).toBe(201);
    const ws = h.tenants.forOrg(client.orgId);
    await ws.sync("NAMED");
    expect(ws.asset("NAMED")).toMatchObject({ startMode: "ledger", startLedger: 5, state: "ready" });
    const bad = await client.call("/api/assets", {
      body: { network: "testnet", asset: `BAD:${issuer}`, fromLedger: 0 },
    });
    expect(bad.status).toBe(400);
  });

  it("refuses a fromLedger that is not a ledger sequence without leaving a row, and accepts ledger 1", async () => {
    const asset = `LEDG:${key()}`;
    const assetRows = () => concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM assets")!.n;
    const before = assetRows();

    for (const fromLedger of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      // Deferred as well as blocking: a deferred watch never rolls back, so a row written ahead of
      // the check would still be there afterwards.
      for (const options of [{}, { defer: true }]) {
        const refused = await concord
          .watchAsset({ network: "testnet", asset, fromLedger }, options)
          .catch((err: unknown) => err);
        expect(refused, `fromLedger ${fromLedger}`).toBeInstanceOf(Invalid);
        expect((refused as Error).message, `fromLedger ${fromLedger}`).toBe("fromLedger must be a ledger sequence");
        expect(assetRows(), `asset rows after fromLedger ${fromLedger}`).toBe(before);
      }
    }
    expect(concord.db.get("SELECT id FROM assets WHERE code = 'LEDG'")).toBeUndefined();

    // Ledger 1 is the lowest sequence there is. The same asset is free to watch, as no refusal kept it.
    const watched = await concord.watchAsset({ network: "testnet", asset, fromLedger: 1 });
    expect(watched).toMatchObject({ code: "LEDG", startMode: "ledger", startLedger: 1, state: "ready" });
    const row = concord.db.get<{ start_mode: string; start_ledger: number }>(
      "SELECT start_mode, start_ledger FROM assets WHERE id = ?",
      watched.id,
    );
    expect(row).toMatchObject({ start_mode: "ledger", start_ledger: 1 });
    expect(assetRows()).toBe(before + 1);
  });

  it("rejects a register from another asset and an unknown register id", async () => {
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(40) });
    await concord.watchAsset({ network: "testnet", asset: `OTHER:${issuer}`, fromLedger: 1 });

    await expect(concord.reconcile("OTHER", reg.registerId)).rejects.toThrow(new NotFound("no register imported for this asset"));
    await expect(concord.reconcile("FUND", 999)).rejects.toThrow(new NotFound("no register imported for this asset"));
  });

  it("reconciles a register at its as-of time and ages breaks", async () => {
    const csv = `holder_id,account,units,status\nA,${h1},100,active\nB,${h2},50,active\n`;
    const day1 = concord.importRegister("FUND", { csv, asOf: at(5) });
    const clean = await concord.reconcile("FUND", day1.registerId);
    expect(clean.status).toBe("clean");
    expect(clean.summary).toMatchObject({ chainSupply: "150", registerTotal: "150", matchedLines: 2 });

    const day2 = concord.importRegister("FUND", { csv, asOf: at(25) });
    const run2 = await concord.reconcile("FUND", day2.registerId);
    expect(run2.breaks.map((b) => b.type).sort()).toEqual(["QUANTITY_MISMATCH", "QUANTITY_MISMATCH", "STATUS_MISMATCH"]);
    const b1 = run2.breaks.find((b) => b.address === h1)!;
    expect(b1).toMatchObject({ chainUnits: "90", registerUnits: "100", difference: "-10", firstSeen: at(25), status: "open" });

    // Signed off, the break stays signed off while the numbers hold…
    concord.setNote("FUND", "recon", b1.key, { fingerprint: b1.fingerprint, status: "acknowledged", note: "T+1 timing" }, { id: "u1", label: "ops" });
    const day3 = concord.importRegister("FUND", { csv, asOf: at(26) });
    const run3 = await concord.reconcile("FUND", day3.registerId);
    expect(run3.breaks.find((b) => b.address === h1)).toMatchObject({ status: "acknowledged", firstSeen: at(25), note: "T+1 timing", noteAuthor: "ops" });
    expect(run3.openBreaks).toBe(2);

    // …and reopens when they move.
    const day4 = concord.importRegister("FUND", { csv, asOf: at(40) });
    const run4 = await concord.reconcile("FUND", day4.registerId);
    expect(run4.breaks.find((b) => b.address === h2 && b.type === "QUANTITY_MISMATCH")).toMatchObject({ chainUnits: "55", firstSeen: at(25) });
    chain.latest = 200;
    chain.push(assetId, "transfer", 150, { from: h1, to: h2, amount: u(1) });
    const day5 = concord.importRegister("FUND", { csv, asOf: at(160) });
    const run5 = await concord.reconcile("FUND", day5.registerId);
    expect(run5.breaks.find((b) => b.address === h1)).toMatchObject({ status: "open", noteStale: true });
  });

  it("warns when the register is ahead of the indexed chain", async () => {
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(500) });
    const run = await concord.reconcile("FUND", reg.registerId);
    expect(run.chainBehind).toBe(true);
    expect(run.warnings).toHaveLength(1);
  });

  it("reconciles movements only once a journal exists, skipping ignored-only flows", async () => {
    const csv = `holder_id,account,units\nA,${h1},90\nB,${h2},55\n`;
    concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},100\nJ2,${at(3)},issue,,${h2},50\nJ3,${at(10)},transfer,${h1},${h2},10\n`,
    );
    const reg = concord.importRegister("FUND", { csv, asOf: at(40) });
    const run = await concord.reconcile("FUND", reg.registerId);
    expect(run.movement).toMatchObject({ events: 4, matched: 3 });
    expect(run.breaks.map((b) => b.type)).toEqual(["UNRECORDED_MOVEMENT"]);
    expect(run.breaks[0]).toMatchObject({ scope: "movement", address: h2, chainUnits: "5" });
  });

  it("leaves journal entries wholly among ignored addresses out of movement matching", async () => {
    chain.push(assetId, "transfer", 15, { from: h2, to: treasury, amount: u(1) });
    concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},100\nJ2,${at(3)},issue,,${h2},50\nJ3,${at(3)},issue,,${treasury},999\nJ4,${at(10)},transfer,${h1},${h2},10\nJ5,${at(15)},transfer,${h2},${treasury},1\n`,
    );
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(40) });
    const run = await concord.reconcile("FUND", reg.registerId);
    const unsettled = run.breaks.filter((b) => b.type === "UNSETTLED_ENTRY");
    // J3 is wholly ignored and raises nothing; J5 touches one non-ignored party and still matches.
    expect(unsettled).toEqual([]);
    expect(run.movement).toMatchObject({ matched: 4 });
  });

  it("starts from a baseline and only applies later events", async () => {
    const other = key();
    chain.latest = 200;
    chain.baselineResult = {
      ledger: 150,
      openings: new Map([
        [h1, { amount: u(70), authorized: true, asOfLedger: 150 }],
        [h2, { amount: u(30), asOfLedger: 152 }],
      ]),
    };
    const asset = await concord.watchAsset({ network: "testnet", asset: `OLD:${other}` });
    expect(asset).toMatchObject({ startMode: "baseline", state: "ready", baselineLedger: 150 });
    expect(asset.startLedger).toBe(151);
    chain.push(asset.id, "transfer", 151, { from: h1, to: h2, amount: u(5) });
    chain.push(asset.id, "transfer", 160, { from: h2, to: h1, amount: u(1) });
    await concord.sync("OLD");
    const h = concord.holdings("OLD");
    expect(h.holders.map((x) => [x.address, x.units])).toEqual([
      [h1, "66"],
      [h2, "29"],
    ]);
  });

  it("refuses opening balances for a contract token before any row is written, and lets a classic asset opt out", async () => {
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 9));
    const watch = { network: "testnet" as const, asset: contractId, baseline: true, decimals: 7 };
    const assetRows = () => concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM assets")!.n;
    const before = assetRows();

    // Deferred as well as blocking: a deferred watch never rolls back, so a row written ahead of
    // the refusal would still be there afterwards.
    for (const options of [{}, { defer: true }]) {
      const refused = await concord.watchAsset(watch, options).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(Invalid);
      expect((refused as Error).message).toBe("opening balances are only available for classic assets");
      expect(concord.db.get("SELECT id FROM assets WHERE id = ?", contractId)).toBeUndefined();
      expect(assetRows()).toBe(before);
    }
    // It is the request for opening balances that is refused, not the token.
    expect(await concord.watchAsset({ ...watch, baseline: false })).toMatchObject({ id: contractId, startMode: "window" });

    // The suite sets no baselineResult, so an opt-out that still asked for opening balances would
    // fail with "no baseline" instead of landing in window mode.
    const classic = await concord.watchAsset({ network: "testnet", asset: `NB:${issuer}`, baseline: false });
    expect(classic).toMatchObject({ startMode: "window", state: "ready", startLedger: 21 });
    expect(classic.baselineLedger).toBeUndefined();
    expect(concord.db.get("SELECT 1 FROM openings WHERE asset_id = ?", classic.id)).toBeUndefined();
  });

  it("does not flag an instruction from before a baseline asset's indexed history as never executed", async () => {
    const other = key();
    chain.latest = 200;
    chain.baselineResult = { ledger: 150, openings: new Map([[h1, { amount: u(70), authorized: true, asOfLedger: 150 }]]) };
    await concord.watchAsset({ network: "testnet", asset: `OLD:${other}` });
    // Issued long before the watch started: its window ended before Concord could have seen it.
    concord.importInstructions("OLD", `ref,type,account,issued_at\nI-OLD,freeze,${h1},2025-01-01T00:00:00Z\n`);
    const controls = concord.controls("OLD");
    expect(controls.breaks).toEqual([]);
    expect(controls.unverifiable.map((i) => i.ref)).toEqual(["I-OLD"]);
    // The same instruction against an asset watched from a ledger the caller named is still checked.
    chain.baselineResult = undefined;
    await concord.watchAsset({ network: "testnet", asset: `NAMED:${key()}`, fromLedger: 1 });
    concord.importInstructions("NAMED", `ref,type,account,issued_at\nI-OLD,freeze,${h1},2025-01-01T00:00:00Z\n`);
    expect(concord.controls("NAMED").breaks.map((b) => b.key)).toEqual(["UNEXECUTED_INSTRUCTION:I-OLD"]);
  });

  it("snapshots at the record time and reconciles a dividend paid in another asset", async () => {
    const bank = key();
    const cash = await concord.watchAsset({ network: "testnet", asset: `USDX:${bank}`, fromLedger: 1 });
    chain.push(cash.id, "transfer", 12, { from: treasury, to: h1, amount: u(9) });
    chain.push(cash.id, "transfer", 12, { from: treasury, to: h2, amount: u(5) });
    chain.push(cash.id, "transfer", 90, { from: treasury, to: h2, amount: u(1) });
    const action = await concord.createAction("FUND", {
      type: "dividend",
      recordTime: at(5),
      windowTo: at(60),
      ratePerUnit: "0.1",
      payAsset: "USDX",
      payer: treasury,
    });
    expect(action.snapshot).toMatchObject({ ledger: 3, holderCount: 3 });
    expect(action.result!.summary).toMatchObject({ expectedTotal: "15", observedTotal: "14", breakCount: 1 });
    expect(action.result!.breaks[0]).toMatchObject({ type: "SHORT", address: h1, expected: "10", observed: "9" });

    const split = await concord.createAction("FUND", { type: "split", recordTime: at(35), num: "2", den: "1" });
    expect(split.result!.breaks.map((b) => b.type)).toEqual(["MISSING", "MISSING"]);
    chain.latest = 200;
    chain.push(assetId, "mint", 170, { to: h1, amount: u(90) });
    chain.push(assetId, "mint", 170, { to: h2, amount: u(55) });
    expect((await concord.reconcileAction(split.id)).state).toBe("clean");
  });

  it("reports a pay asset's read-through time from its sync in the same pass", async () => {
    const cash = await concord.watchAsset({ network: "testnet", asset: `USDX:${key()}`, fromLedger: 1 });
    expect(cash.syncedAt ?? null).toBeNull();
    const action = await concord.createAction("FUND", {
      type: "dividend",
      recordTime: at(5),
      ratePerUnit: "0.1",
      payAsset: "USDX",
      payer: treasury,
    });
    expect(action.result!.reconciledThrough).not.toBeNull();
    expect(action.result!.reconciledThrough).toBe(concord.asset("USDX").syncedAt);
  });

  it("reconciles reverse splits executed as burns rather than clawbacks", async () => {
    chain.push(assetId, "burn", 7, { from: h1, amount: u(50) });
    chain.push(assetId, "burn", 7, { from: h2, amount: u(25) });
    const split = await concord.createAction("FUND", {
      type: "split",
      recordTime: at(5),
      windowTo: at(9),
      num: "1",
      den: "2",
    });
    expect(split.state).toBe("clean");
    expect(split.result?.summary).toMatchObject({
      expectedTotal: "-75",
      observedTotal: "-75",
      breakCount: 0,
    });
  });

  it("rejects non-address payer and warns on a silent payer", async () => {
    await expect(
      concord.createAction("FUND", {
        type: "dividend",
        recordTime: at(5),
        ratePerUnit: "0.1",
        payer: "bogus payer",
      }),
    ).rejects.toThrow("payer must be a valid Stellar address");

    const silentPayer = key();
    const action = await concord.createAction("FUND", {
      type: "dividend",
      recordTime: at(5),
      ratePerUnit: "0.1",
      payer: silentPayer,
    });
    expect(action.result!.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining(`Payer ${silentPayer} has no recorded flows in the action window`)]),
    );
  });

  it("holds an action as scheduled until the chain passes its record time", async () => {
    const action = await concord.createAction("FUND", { type: "redemption", recordTime: at(150), num: "1", den: "1" });
    expect(action.state).toBe("scheduled");
    chain.latest = 200;
    chain.push(assetId, "clawback", 160, { from: h1, amount: u(90) });
    const later = await concord.reconcileAction(action.id);
    expect(later.snapshot!.holderCount).toBe(3);
    expect(later.result!.breaks.map((b) => [b.type, b.address])).toEqual([["MISSING", h2]]);
  });

  it("refuses to snapshot when record time is earlier than history start on a baseline asset", async () => {
    const other = key();
    chain.latest = 200;
    chain.baselineResult = {
      ledger: 150,
      openings: new Map([
        [h1, { amount: u(70), authorized: true, asOfLedger: 150 }],
        [h2, { amount: u(30), asOfLedger: 150 }],
      ]),
    };
    const asset = await concord.watchAsset({ network: "testnet", asset: `OLD:${other}` });
    chain.push(asset.id, "transfer", 151, { from: h1, to: h2, amount: u(5) });
    await concord.sync("OLD");

    const action = await concord.createAction("OLD", {
      type: "dividend",
      recordTime: at(100),
      ratePerUnit: "1",
    });
    expect(action.snapshot).toBeNull();
    expect(action.state).toBe("scheduled");
    expect(action.result).not.toBeNull();
    expect(action.result!.warnings).toEqual([
      expect.stringContaining("earlier than history start"),
    ]);

    // reconcile() on OLD with asOf earlier than history start (e.g. at(5)) carries warning
    const regEarly = concord.importRegister("OLD", {
      csv: `holder_id,account,units\nA,${h1},70\n`,
      asOf: at(5),
    });
    const runEarly = await concord.reconcile("OLD", regEarly.registerId);
    expect(runEarly.warnings).toEqual([
      expect.stringContaining("earlier than history start"),
    ]);

    // holdings() on OLD with asOf earlier than history start carries beforeHistory flag and warning
    const holdingsEarly = concord.holdings("OLD", at(5));
    expect(holdingsEarly.beforeHistory).toBe(true);
    expect(holdingsEarly.warnings).toEqual([
      expect.stringContaining("earlier than history start"),
    ]);

    // holdings() with asOf after history start has beforeHistory: false and empty warnings
    const holdingsNormal = concord.holdings("OLD", at(160));
    expect(holdingsNormal.beforeHistory).toBe(false);
    expect(holdingsNormal.warnings).toEqual([]);
  });

  it("builds the controls log and the audit pack", async () => {
    await concord.sync("FUND");
    concord.importInstructions(
      "FUND",
      `ref,type,account,units,issued_at,approved_by,reason\nI1,authorise,${h1},,${at(1)},ops,KYC\nI2,freeze,${h2},,${at(19)},compliance,order\n`,
    );
    const log = concord.controls("FUND");
    expect(log.summary).toMatchObject({ controls: 3, instructed: 2, uninstructed: 1 });
    expect(log.breaks[0]).toMatchObject({ type: "UNINSTRUCTED_CONTROL", address: h2, status: "open" });
    expect(log.records[0]).toMatchObject({ type: "clawback", units: "5", instruction: null });

    const pack = concord.auditExport("FUND");
    expect(pack.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.events).toHaveLength(7);
    expect(concord.auditExport("FUND").sha256).toBe(pack.sha256);
    expect(concord.exportCsv("FUND", "controls").split("\n")[0]).toContain("instructionRef");
    expect(concord.exportCsv("FUND", "breaks")).toContain("UNINSTRUCTED_CONTROL");
  });

  it("keeps the audit pack inside the published schema", async () => {
    await concord.sync("FUND");
    concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},100\nJ2,${at(3)},issue,,${h2},50\n`,
    );
    // I1 and I2 cover the authorisation and freeze; I3 is issued a minute before the controls log's
    // as-of time (the asset's synced time), so it is still pending, and the clawback has no
    // instruction, so every controls branch appears in the pack.
    const pendingIssuedAt = new Date(Date.parse(concord.asset("FUND").syncedAt!) - 60_000).toISOString();
    concord.importInstructions(
      "FUND",
      `ref,type,account,units,issued_at,approved_by,reason\nI1,authorise,${h1},,${at(1)},ops,KYC\nI2,freeze,${h2},,${at(19)},compliance,order\nI3,freeze,${h3},,${pendingIssuedAt},ops,review\n`,
    );
    const reg = concord.importRegister("FUND", {
      csv: `holder_id,account,units,status\nA,${h1},90,active\nB,${h2},50,active\n`,
      asOf: at(5),
    });
    const run = await concord.reconcile("FUND", reg.registerId);
    const first = run.breaks[0]!;
    concord.setNote(
      "FUND",
      "recon",
      first.key,
      { fingerprint: first.fingerprint, status: "resolved", note: "register corrected" },
      { id: "u1", label: "ops <ops@example.test>" },
    );
    await concord.createAction("FUND", { type: "split", recordTime: at(5), num: "2", den: "1" });

    const pack = concord.auditExport("FUND");
    expect(validateAuditPack(pack), JSON.stringify(validateAuditPack.errors, null, 2)).toBe(true);

    // The schema rejects added fields and misses required ones. This list catches a field that
    // disappears from the fixture, including the optional per-break figures the schema cannot
    // require for every scope.
    expect([...new Set(keyPaths(pack))].sort()).toMatchInlineSnapshot(`
      [
        "asset.baselineLedger",
        "asset.code",
        "asset.decimals",
        "asset.historyFrom",
        "asset.id",
        "asset.ignoredAddresses[]",
        "asset.indexedFromLedger",
        "asset.indexedTo",
        "asset.indexedToLedger",
        "asset.issuer",
        "asset.name",
        "asset.network",
        "controls.asOf",
        "controls.breaks[]",
        "controls.breaks[].address",
        "controls.breaks[].eventId",
        "controls.breaks[].fingerprint",
        "controls.breaks[].key",
        "controls.breaks[].message",
        "controls.breaks[].note",
        "controls.breaks[].noteAt",
        "controls.breaks[].noteAuthor",
        "controls.breaks[].noteScope",
        "controls.breaks[].noteStale",
        "controls.breaks[].ref",
        "controls.breaks[].scope",
        "controls.breaks[].severity",
        "controls.breaks[].status",
        "controls.breaks[].txHash",
        "controls.breaks[].type",
        "controls.openBreaks",
        "controls.pending[]",
        "controls.pending[].account",
        "controls.pending[].approvedBy",
        "controls.pending[].issuedAt",
        "controls.pending[].reason",
        "controls.pending[].ref",
        "controls.pending[].type",
        "controls.pending[].units",
        "controls.records[]",
        "controls.records[].account",
        "controls.records[].closedAt",
        "controls.records[].eventId",
        "controls.records[].instruction",
        "controls.records[].instruction.account",
        "controls.records[].instruction.approvedBy",
        "controls.records[].instruction.issuedAt",
        "controls.records[].instruction.reason",
        "controls.records[].instruction.ref",
        "controls.records[].instruction.type",
        "controls.records[].instruction.units",
        "controls.records[].ledger",
        "controls.records[].txHash",
        "controls.records[].type",
        "controls.records[].units",
        "controls.summary.controls",
        "controls.summary.instructed",
        "controls.summary.pending",
        "controls.summary.unexecuted",
        "controls.summary.uninstructed",
        "controls.unverifiable[]",
        "corporateActions[]",
        "corporateActions[].assetId",
        "corporateActions[].createdAt",
        "corporateActions[].id",
        "corporateActions[].label",
        "corporateActions[].openBreaks",
        "corporateActions[].params.den",
        "corporateActions[].params.exclude[]",
        "corporateActions[].params.num",
        "corporateActions[].reconciledAt",
        "corporateActions[].recordTime",
        "corporateActions[].result.breaks[]",
        "corporateActions[].result.breaks[].address",
        "corporateActions[].result.breaks[].difference",
        "corporateActions[].result.breaks[].expected",
        "corporateActions[].result.breaks[].fingerprint",
        "corporateActions[].result.breaks[].key",
        "corporateActions[].result.breaks[].message",
        "corporateActions[].result.breaks[].note",
        "corporateActions[].result.breaks[].noteAt",
        "corporateActions[].result.breaks[].noteAuthor",
        "corporateActions[].result.breaks[].noteScope",
        "corporateActions[].result.breaks[].noteStale",
        "corporateActions[].result.breaks[].observed",
        "corporateActions[].result.breaks[].scope",
        "corporateActions[].result.breaks[].severity",
        "corporateActions[].result.breaks[].status",
        "corporateActions[].result.breaks[].type",
        "corporateActions[].result.flowAsset.code",
        "corporateActions[].result.flowAsset.id",
        "corporateActions[].result.lines[]",
        "corporateActions[].result.lines[].address",
        "corporateActions[].result.lines[].basis",
        "corporateActions[].result.lines[].difference",
        "corporateActions[].result.lines[].expected",
        "corporateActions[].result.lines[].observed",
        "corporateActions[].result.lines[].status",
        "corporateActions[].result.lines[].txHashes[]",
        "corporateActions[].result.reconciledThrough",
        "corporateActions[].result.status",
        "corporateActions[].result.summary.breakCount",
        "corporateActions[].result.summary.difference",
        "corporateActions[].result.summary.expectedTotal",
        "corporateActions[].result.summary.holders",
        "corporateActions[].result.summary.observedTotal",
        "corporateActions[].result.warnings[]",
        "corporateActions[].snapshot.holderCount",
        "corporateActions[].snapshot.holders[]",
        "corporateActions[].snapshot.holders[].address",
        "corporateActions[].snapshot.holders[].units",
        "corporateActions[].snapshot.ledger",
        "corporateActions[].snapshot.takenAt",
        "corporateActions[].state",
        "corporateActions[].type",
        "events[]",
        "events[].authorized",
        "events[].closedAt",
        "events[].from",
        "events[].id",
        "events[].kind",
        "events[].ledger",
        "events[].to",
        "events[].txHash",
        "events[].units",
        "generatedAt",
        "generator",
        "holdings.asOf",
        "holdings.holderCount",
        "holdings.holders[]",
        "holdings.holders[].address",
        "holdings.holders[].ignored",
        "holdings.holders[].share",
        "holdings.holders[].status",
        "holdings.holders[].units",
        "holdings.incomplete[]",
        "holdings.ledger",
        "holdings.supply",
        "period.from",
        "period.to",
        "reconciliations[]",
        "reconciliations[].asOf",
        "reconciliations[].assetId",
        "reconciliations[].breaks[]",
        "reconciliations[].breaks[].address",
        "reconciliations[].breaks[].chainUnits",
        "reconciliations[].breaks[].difference",
        "reconciliations[].breaks[].fingerprint",
        "reconciliations[].breaks[].firstSeen",
        "reconciliations[].breaks[].holderIds[]",
        "reconciliations[].breaks[].key",
        "reconciliations[].breaks[].message",
        "reconciliations[].breaks[].note",
        "reconciliations[].breaks[].noteAt",
        "reconciliations[].breaks[].noteAuthor",
        "reconciliations[].breaks[].noteScope",
        "reconciliations[].breaks[].noteStale",
        "reconciliations[].breaks[].registerUnits",
        "reconciliations[].breaks[].scope",
        "reconciliations[].breaks[].severity",
        "reconciliations[].breaks[].status",
        "reconciliations[].breaks[].type",
        "reconciliations[].chainBehind",
        "reconciliations[].chainLedger",
        "reconciliations[].chainSyncedAt",
        "reconciliations[].createdAt",
        "reconciliations[].id",
        "reconciliations[].lines[]",
        "reconciliations[].lines[].address",
        "reconciliations[].lines[].chainStatus",
        "reconciliations[].lines[].chainUnits",
        "reconciliations[].lines[].difference",
        "reconciliations[].lines[].holderIds[]",
        "reconciliations[].lines[].matched",
        "reconciliations[].lines[].registerStatus",
        "reconciliations[].lines[].registerUnits",
        "reconciliations[].movement.breakCount",
        "reconciliations[].movement.entries",
        "reconciliations[].movement.events",
        "reconciliations[].movement.from",
        "reconciliations[].movement.matched",
        "reconciliations[].movement.matches[]",
        "reconciliations[].movement.matches[].by",
        "reconciliations[].movement.matches[].eventId",
        "reconciliations[].movement.matches[].ref",
        "reconciliations[].movement.matches[].txHash",
        "reconciliations[].movement.to",
        "reconciliations[].openBreaks",
        "reconciliations[].registerId",
        "reconciliations[].registerSha256",
        "reconciliations[].status",
        "reconciliations[].summary.breakCount",
        "reconciliations[].summary.chainHolders",
        "reconciliations[].summary.chainSupply",
        "reconciliations[].summary.grossDifference",
        "reconciliations[].summary.lines",
        "reconciliations[].summary.matchedLines",
        "reconciliations[].summary.registerHolders",
        "reconciliations[].summary.registerTotal",
        "reconciliations[].summary.supplyDifference",
        "reconciliations[].summary.unmappedUnits",
        "reconciliations[].warnings[]",
        "registers[]",
        "registers[].asOf",
        "registers[].id",
        "registers[].importedAt",
        "registers[].importedBy",
        "registers[].issues[]",
        "registers[].positions",
        "registers[].sha256",
        "registers[].source",
        "sha256",
        "signoffHistory[]",
        "signoffHistory[].at",
        "signoffHistory[].author",
        "signoffHistory[].fingerprint",
        "signoffHistory[].key",
        "signoffHistory[].note",
        "signoffHistory[].scope",
        "signoffHistory[].status",
      ]
    `);
  });

  it("includes register provenance in the audit pack covering every reconciled register", async () => {
    await concord.sync("FUND");
    const reg1 = concord.importRegister(
      "FUND",
      {
        csv: `holder_id,account,units,status\nA,${h1},100,active\n`,
        asOf: at(2),
      },
      { id: "u1", label: "alice <alice@example.test>" },
    );
    const reg2 = concord.importRegister(
      "FUND",
      {
        csv: `holder_id,account,units,status\nA,${h1},90,active\n`,
        asOf: at(5),
      },
      { id: "u2", label: "bob <bob@example.test>" },
    );

    const run = await concord.reconcile("FUND", reg2.registerId);
    expect(run.registerId).toBe(reg2.registerId);

    const pack = concord.auditExport("FUND");
    expect(pack.registers.length).toBeGreaterThanOrEqual(2);

    // Every registerId in reconciliations appears in registers
    const registerIdsInRecon = pack.reconciliations.map((r) => r.registerId);
    const registerIds = pack.registers.map((r) => r.id);
    for (const rid of registerIdsInRecon) {
      expect(registerIds).toContain(rid);
    }

    // Provenance details are present
    const r2 = pack.registers.find((r) => r.id === reg2.registerId)!;
    expect(r2).toBeDefined();
    expect(r2.asOf).toBe(at(5));
    expect(r2.source).toBe("upload");
    expect(r2.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r2.positions).toBe(1);
    expect(r2.issues).toEqual([]);
    expect(r2.importedBy).toBe("bob <bob@example.test>");
    expect(r2.importedAt).toBeDefined();

    // Digest covers registers: modifying a register breaks the digest
    const originalDigest = pack.sha256;
    const tampered = { ...pack, registers: [{ ...r2, source: "tampered" }] };
    const { generatedAt: _g, generator: _gen, sha256: _s, ...content } = tampered;
    const { createHash } = await import("node:crypto");
    const tamperedDigest = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    expect(tamperedDigest).not.toBe(originalDigest);
  });

  it("holds the indexed-to mark still when a pass dies part-way", async () => {
    await concord.sync("FUND");
    const before = concord.asset("FUND");
    expect(before.syncedLedger).toBe(100);
    for (let i = 0; i < 1500; i++) chain.push(assetId, "mint", 150, { to: h3, amount: 1n });
    chain.latest = 200;
    chain.failOnCall = chain.calls + 2;
    await expect(concord.sync("FUND")).rejects.toThrow("connection reset");
    const stalled = concord.asset("FUND");
    // The first page is kept, but the asset does not claim to be indexed to ledger 200.
    expect(stalled).toMatchObject({ syncedLedger: 100, syncedAt: before.syncedAt });
    expect(stalled.syncError).toBe("[internal] Indexing stopped on an unexpected error.");
    expect(await concord.sync("FUND")).toEqual({ added: 500 });
    const healed = concord.asset("FUND");
    expect(healed.syncedLedger).toBe(200);
    expect(healed.syncError).toBeUndefined();
  });

  it("maps SQLite busy and full errors to distinct user-facing messages (#534)", () => {
    const errBusyCode = Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" });
    const errBusyNum = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5, errstr: "busy" });
    const errLocked = Object.assign(new Error("database table is locked"), { code: "ERR_SQLITE_ERROR", errcode: 6, errstr: "database table is locked" });
    const errFullCode = Object.assign(new Error("SQLITE_FULL: database or disk is full"), { code: "SQLITE_FULL" });
    const errFullNum = Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR", errcode: 13, errstr: "database or disk is full" });
    const errEnospc = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    const errGeneric = new Error("something unexpected failed");

    const logged: unknown[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args[0]); };
    try {
      expect(describeFailure(errBusyCode)).toBe("[db_locked] Database is locked.");
      expect(describeFailure(errBusyNum)).toBe("[db_locked] Database is locked.");
      expect(describeFailure(errLocked)).toBe("[db_locked] Database is locked.");
      expect(describeFailure(errFullCode)).toBe("[disk_full] Database or disk is full.");
      expect(describeFailure(errFullNum)).toBe("[disk_full] Database or disk is full.");
      expect(describeFailure(errEnospc)).toBe("[disk_full] Database or disk is full.");
      expect(describeFailure(errGeneric)).toBe("[internal] Indexing stopped on an unexpected error.");
      expect(logged).toHaveLength(7);
      expect(logged[0]).toBe(errBusyCode);
      expect(logged[6]).toBe(errGeneric);
    } finally {
      console.error = origError;
    }
  });

  it("reports an unreadable saved cursor instead of a parse error or a skipped gap check", async () => {
    const db = new Db(":memory:");
    const damaged = new Concord(db, { testnet: { passphrase: PASSPHRASE, chain } });
    const watched = await damaged.watchAsset({ network: "testnet", asset: `DMG:${issuer}`, fromLedger: 1 });
    await damaged.sync(watched.id);
    // An empty cursor reads as "no cursor", so only non-empty junk counts as damage.
    for (const cursor of ["-5", "abc-1", "123-"]) {
      db.write("UPDATE assets SET cursor = ? WHERE id = ?", cursor, watched.id);
      await expect(damaged.sync(watched.id)).rejects.toThrow(/saved indexing position is unreadable/);
      expect(damaged.asset(watched.id).syncError).toMatch(/Rebuild this asset/);
    }
  });

  it("reports a gap instead of indexing across it", async () => {
    await concord.sync("FUND");
    chain.latest = 500_000;
    chain.oldest = 400_000;
    await expect(concord.sync("FUND")).rejects.toThrow(/longer than the network keeps events/);
    expect(concord.asset("FUND").syncError).toMatch(/Rebuild this asset/);
  });

  it("rejects watching an asset outside known when known is set (#509)", async () => {
    chain.known = new Set();
    const badIssuer = key();
    await expect(
      concord.watchAsset({ network: "testnet", asset: `FUND:${badIssuer}`, fromLedger: 1 }),
    ).rejects.toThrow("testnet has no asset FUND from that issuer");
    chain.known = undefined;
  });

  it("lookup returns candidates for a code from search (#509)", async () => {
    const candidate: AssetCandidate = {
      asset: `CAND:${key()}`,
      code: "CAND",
      issuer: key(),
      contractId: "C123",
      trustlines: 10,
      authorizedUnits: "100",
      authRequired: false,
      authRevocable: false,
      clawbackEnabled: false,
    };
    chain.candidates = [candidate];
    expect(await concord.lookup("testnet", "CAND")).toEqual([candidate]);
    expect(await concord.lookup("testnet", "NONE")).toEqual([]);
    chain.candidates = [];
  });

  it("advances chain past retention yielding the rebuild gap error (#509)", async () => {
    const issuer = key();
    const watched = await concord.watchAsset({ network: "testnet", asset: `ADV:${issuer}`, fromLedger: 1 });
    await concord.sync(watched.id);
    chain.advance(100, { retain: 50 });
    await expect(concord.sync(watched.id)).rejects.toThrow(/longer than the network keeps events/);
    expect(concord.asset(watched.id).syncError).toMatch(/Rebuild this asset/);
  });

  it("stops watching and takes every dependent row with it", async () => {
    const csv = `holder_id,account,units\nA,${h1},90\n`;
    const reg = concord.importRegister("FUND", { csv, asOf: at(40) });
    const run = await concord.reconcile("FUND", reg.registerId);
    concord.importJournal("FUND", `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},100\n`);
    concord.importInstructions("FUND", `ref,type,account,units,issued_at\nI1,freeze,${h2},,${at(19)}\n`);
    const action = await concord.createAction("FUND", { type: "split", recordTime: at(35), num: "2", den: "1" });
    concord.setNote("FUND", "recon", run.breaks[0]!.key, { fingerprint: run.breaks[0]!.fingerprint, status: "resolved", note: "x" });
    const actionBreak = action.result!.breaks[0]!;
    concord.setNote("FUND", `action:${action.id}`, actionBreak.key, { fingerprint: actionBreak.fingerprint, status: "resolved", note: "x" });
    expect(() => concord.setNote("FUND", "action:999", "k", { fingerprint: "f", status: "resolved", note: "x" })).toThrow(/scope/);

    concord.deleteRegister("FUND", reg.registerId);
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM register_positions")!.n).toBe(0);
    expect(concord.runs("FUND")).toHaveLength(0);

    await concord.unwatchAsset("FUND");
    const tables = concord.db
      .all<{ name: string }>("SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) c ON c.name = 'asset_id' WHERE m.type = 'table'")
      .map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["events", "openings", "registers", "journal", "instructions", "runs", "actions", "break_notes"]));
    for (const table of tables) {
      expect(concord.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE asset_id = ?`, assetId)!.n, table).toBe(0);
    }
    expect(() => concord.asset("FUND")).toThrow(/not watched/);
    // The same asset can be watched again from scratch.
    await concord.watchAsset({ network: "testnet", asset: `FUND:${issuer}`, fromLedger: 1 });
    expect(concord.holdings("FUND").holderCount).toBe(0);
  });

  it("prevents sync from racing an in-flight unwatchAsset and throws NotFound", async () => {
    let releaseGate: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    let syncStarted: () => void;
    const whenSyncStarted = new Promise<void>((resolve) => {
      syncStarted = resolve;
    });

    chain.onGetEvents = () => {
      syncStarted();
    };
    chain.gate = gate;

    // Start a sync pass that pauses inside getEvents
    const syncPromise = concord.sync("FUND");
    await whenSyncStarted;

    // Start unwatching FUND while sync is in flight
    const unwatchPromise = concord.unwatchAsset("FUND");

    // Concurrently calling sync for the asset being removed throws NotFound
    expect(() => concord.sync("FUND")).toThrow(NotFound);

    // Release the gate so the in-flight sync pass finishes
    releaseGate!();
    await syncPromise;
    await unwatchPromise;

    // Asset is deleted
    expect(() => concord.asset("FUND")).toThrow(NotFound);
  });

  it("rebuilds from fresh opening balances and keeps the books", async () => {
    await concord.sync("FUND");
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(40) });
    chain.latest = 300;
    chain.baselineResult = { ledger: 250, openings: new Map([[h1, { amount: u(42), asOfLedger: 250 }]]) };
    const rebuilt = await concord.rebuild("FUND");
    expect(rebuilt).toMatchObject({ startMode: "baseline", baselineLedger: 250, startLedger: 251, state: "ready" });
    expect(concord.holdings("FUND").holders).toEqual([expect.objectContaining({ address: h1, units: "42" })]);
    expect(concord.registers("FUND").map((r) => r.id)).toEqual([reg.registerId]);
  });

  /** How an asset's history begins, as stored. */
  const startColumns = (id: string) => ({
    ...concord.db.get("SELECT start_mode, start_ledger, baseline_ledger, state FROM assets WHERE id = ?", id),
  });

  it("rebuild moves an asset watched from a named ledger over to opening balances", async () => {
    expect(startColumns(assetId)).toEqual({ start_mode: "ledger", start_ledger: 1, baseline_ledger: null, state: "ready" });
    chain.latest = 300;
    chain.baselineResult = { ledger: 250, openings: new Map([[h1, { amount: u(42), asOfLedger: 250 }]]) };
    await concord.rebuild("FUND");
    expect(startColumns(assetId)).toEqual({
      start_mode: "baseline",
      start_ledger: 251,
      baseline_ledger: 250,
      state: "ready",
    });
  });

  it("rebuild gives a contract token a fresh window, and never opening balances", async () => {
    const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    await concord.watchAsset({ network: "testnet", asset: contractId, decimals: 7, fromLedger: 5 });
    expect(startColumns(contractId)).toEqual({ start_mode: "ledger", start_ledger: 5, baseline_ledger: null, state: "ready" });
    // Opening balances are on offer, and are not for this asset: it has no issuer to ask about.
    chain.baselineResult = { ledger: 250, openings: new Map([[h1, { amount: u(42), asOfLedger: 250 }]]) };
    chain.oldest = 100;
    chain.latest = 500;
    await concord.rebuild(contractId);
    // Twenty ledgers in from the oldest the RPC holds, as when a window asset is first watched.
    expect(startColumns(contractId)).toEqual({
      start_mode: "window",
      start_ledger: 120,
      baseline_ledger: null,
      state: "ready",
    });
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM openings WHERE asset_id = ?", contractId)!.n).toBe(0);
  });

  it("a deferred rebuild clears the indexed history and its error at once, and keeps every book", async () => {
    // FUND on opening balances taken at ledger 250, then a movement once the chain has moved on.
    chain.latest = 300;
    chain.baselineResult = { ledger: 250, openings: new Map([[h1, { amount: u(42), asOfLedger: 250 }]]) };
    await concord.rebuild("FUND");
    chain.latest = 320;
    chain.push(assetId, "transfer", 310, { from: h1, to: h2, amount: u(2) });
    // Every kind of book against it (reconciling indexes the transfer), and a failure on record.
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(315) });
    const run = await concord.reconcile("FUND", reg.registerId);
    concord.importJournal("FUND", `ref,date,type,from_account,to_account,units\nJ1,${at(310)},transfer,${h1},${h2},2\n`);
    concord.importInstructions("FUND", `ref,type,account,units,issued_at\nI1,freeze,${h2},,${at(312)}\n`);
    await concord.createAction("FUND", { type: "split", recordTime: at(312), num: "2", den: "1" });
    const brk = run.breaks[0]!;
    concord.setNote("FUND", "recon", brk.key, { fingerprint: brk.fingerprint, status: "resolved", note: "x" });
    concord.db.write("UPDATE assets SET sync_error = ?, sync_error_at = ? WHERE id = ?", "connection reset", at(316), assetId);

    const rows = (table: string) => concord.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
    const books = ["registers", "register_positions", "journal", "instructions", "runs", "actions", "break_notes", "break_note_history"];
    const bookRows = () => Object.fromEntries(books.map((table) => [table, rows(table)]));
    const before = bookRows();
    expect(Object.values(before).every((n) => n > 0), JSON.stringify(before)).toBe(true);
    expect([rows("events"), rows("openings")]).toEqual([1, 1]);
    expect(concord.asset("FUND")).toMatchObject({
      cursor: expect.any(String),
      syncError: "connection reset",
      syncedLedger: 320,
      baselineLedger: 250,
    });

    // A blocking rebuild re-reads the chain before it returns, so what it cleared is never seen.
    // Hold the chain instead: the deferred pass cannot start, and the cleared row stays put.
    chain.baselineResult = {
      ledger: 318,
      openings: new Map([
        [h1, { amount: u(40), asOfLedger: 318 }],
        [h2, { amount: u(2), asOfLedger: 318 }],
      ]),
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const latestLedger = chain.latestLedger.bind(chain);
    chain.latestLedger = async () => {
      await held;
      return latestLedger();
    };

    const cleared = await concord.rebuild("FUND", { defer: true });
    expect(cleared).toMatchObject({ state: "indexing", startMode: "baseline" });
    expect(cleared.cursor).toBeUndefined();
    expect(cleared.syncError).toBeUndefined();
    const row = concord.db.get(
      `SELECT state, start_mode, start_ledger, baseline_ledger, history_from, cursor, synced_ledger, synced_at,
         sync_error, sync_error_at FROM assets WHERE id = ?`,
      assetId,
    );
    expect({ ...row }).toEqual({
      state: "indexing",
      start_mode: "baseline",
      start_ledger: null,
      baseline_ledger: null,
      history_from: null,
      cursor: null,
      synced_ledger: null,
      synced_at: null,
      sync_error: null,
      sync_error_at: null,
    });
    expect([rows("events"), rows("openings")]).toEqual([0, 0]);
    expect(bookRows()).toEqual(before);

    // Let the deferred pass go and wait for it: sync() hands back the pass already in flight.
    release();
    await concord.sync("FUND");
    expect(startColumns(assetId)).toEqual({ start_mode: "baseline", start_ledger: 319, baseline_ledger: 318, state: "ready" });
    expect(concord.asset("FUND")).toMatchObject({ syncedLedger: 320, cursor: expect.any(String) });
    expect(concord.asset("FUND").syncError).toBeUndefined();
    expect([rows("events"), rows("openings")]).toEqual([0, 2]);
    expect(bookRows()).toEqual(before);
  });

  it("advances a scheduled action once the chain passes its record time", async () => {
    const action = await concord.createAction("FUND", { type: "redemption", recordTime: at(150), num: "1", den: "1" });
    expect(action.state).toBe("scheduled");
    expect(await concord.reconcileDue()).toBe(0);
    chain.latest = 200;
    await concord.syncAll();
    expect(await concord.reconcileDue()).toBe(1);
    expect(concord.action(action.id).state).not.toBe("scheduled");
  });

  it("re-runs a reconciled action while its window is open, and stops once the window is read through", async () => {
    const cash = await concord.watchAsset({ network: "testnet", asset: `USDX:${key()}`, fromLedger: 1 });
    chain.push(cash.id, "transfer", 12, { from: treasury, to: h1, amount: u(9) });
    chain.push(cash.id, "transfer", 12, { from: treasury, to: h2, amount: u(5) });
    const action = await concord.createAction("FUND", {
      type: "dividend",
      recordTime: at(5),
      windowTo: at(150),
      ratePerUnit: "0.1",
      payAsset: "USDX",
      payer: treasury,
    });
    expect(action.result!.breaks).toMatchObject([{ type: "SHORT", address: h1, expected: "10", observed: "9" }]);
    expect(await concord.reconcileDue()).toBe(0);

    // The missing unit is paid late, inside the window.
    chain.latest = 120;
    chain.push(cash.id, "transfer", 110, { from: treasury, to: h1, amount: u(1) });
    await concord.syncAll();
    expect(await concord.reconcileDue()).toBe(1);
    expect(concord.action(action.id).result).toMatchObject({ status: "clean", breaks: [] });

    // One more pass once the chain is read past the end of the window, then it is left alone.
    chain.latest = 200;
    await concord.syncAll();
    expect(await concord.reconcileDue()).toBe(1);
    await concord.syncAll();
    expect(await concord.reconcileDue()).toBe(0);
  });

  it("filters events outside the ledger window and respects both time and ledger bounds together", async () => {
    const bank = key();
    const cash = await concord.watchAsset({ network: "testnet", asset: `USDX:${bank}`, fromLedger: 1 });
    // ledger 12: inside both ledger and time window
    chain.push(cash.id, "transfer", 12, { from: treasury, to: h1, amount: u(10) });
    // ledger 5: before windowFromLedger=10, should be ignored
    chain.push(cash.id, "transfer", 5, { from: treasury, to: h2, amount: u(50) });
    // ledger 80: after windowToLedger=70, should be ignored
    chain.push(cash.id, "transfer", 80, { from: treasury, to: h1, amount: u(99) });

    // Only ledger 12 is in [10, 70] AND after recordTime (ledger 3 / at(3))
    const action = await concord.createAction("FUND", {
      type: "dividend",
      recordTime: at(3),
      windowFromLedger: 10,
      windowToLedger: 70,
      ratePerUnit: "0.1",
      payAsset: "USDX",
      payer: treasury,
    });
    // h1 is entitled to 10 (100 units * 0.1) and received exactly 10 at ledger 12
    // h2 received 50 at ledger 5, which is outside the ledger window
    expect(action.result!.breaks.map((b) => b.address)).toContain(h2);
    expect(action.result!.breaks.find((b) => b.address === h2)).toMatchObject({ type: "MISSING" });
    expect(action.result!.breaks.find((b) => b.address === h1)).toBeUndefined();
    // Params are stored and surfaced
    expect(action.params).toMatchObject({ windowFromLedger: 10, windowToLedger: 70 });
  });

  it("validates windowFromLedger and windowToLedger as positive integers", async () => {
    await expect(
      concord.createAction("FUND", { type: "split", recordTime: at(5), num: "2", den: "1", windowFromLedger: 0 }),
    ).rejects.toThrow(new Invalid("windowFromLedger must be a positive ledger sequence number"));
    await expect(
      concord.createAction("FUND", { type: "split", recordTime: at(5), num: "2", den: "1", windowFromLedger: -5 }),
    ).rejects.toThrow(new Invalid("windowFromLedger must be a positive ledger sequence number"));
    await expect(
      concord.createAction("FUND", { type: "split", recordTime: at(5), num: "2", den: "1", windowToLedger: 0 }),
    ).rejects.toThrow(new Invalid("windowToLedger must be a positive ledger sequence number"));
    await expect(
      concord.createAction("FUND", { type: "split", recordTime: at(5), num: "2", den: "1", windowToLedger: 1.5 }),
    ).rejects.toThrow(new Invalid("windowToLedger must be a positive ledger sequence number"));
  });

  it("refuses a code shared by two watched assets and a pay asset from another network", async () => {
    await concord.watchAsset({ network: "testnet", asset: `FUND:${key()}`, fromLedger: 1 });
    expect(() => concord.asset("FUND")).toThrow(/more than one/);
    expect(concord.asset(assetId).id).toBe(assetId);
  });

  it("looks an asset up by contract id or by code in any case, and names an ambiguous or unknown reference", async () => {
    const thrown = (lookup: () => unknown): unknown => {
      try {
        lookup();
      } catch (err) {
        return err;
      }
      return undefined;
    };

    const fund = concord.asset(assetId);
    expect(fund).toMatchObject({ id: assetId, code: "FUND", issuer });
    expect(concord.asset("FUND")).toEqual(fund);
    expect(concord.asset("fund")).toEqual(fund);

    // A second FUND from another issuer makes the code ambiguous in any case, but neither id.
    const other = await concord.watchAsset({ network: "testnet", asset: `FUND:${key()}`, fromLedger: 1 });
    expect(other.id).not.toBe(assetId);
    for (const code of ["FUND", "fund"]) {
      const ambiguous = thrown(() => concord.asset(code));
      expect(ambiguous).toBeInstanceOf(Invalid);
      expect((ambiguous as Error).message).toBe(`more than one watched asset is called ${code}; use its contract id`);
    }
    expect(concord.asset(assetId)).toEqual(fund);
    expect(concord.asset(other.id)).toEqual(other);

    const unknown = thrown(() => concord.asset("NOPE"));
    expect(unknown).toBeInstanceOf(NotFound);
    expect((unknown as Error).message).toBe("asset NOPE is not watched");
  });

  it("handles concurrent watchAsset calls gracefully without UNIQUE constraint failure", async () => {
    const assetCode = `CONC:${key()}`;
    const origDescribe = chain.describe?.bind(chain);
    chain.describe = async (candidate) => {
      await new Promise((r) => setTimeout(r, 25));
      return origDescribe ? origDescribe(candidate) : { decimals: 7, name: "Concurrent Test" };
    };

    const [r1, r2] = await Promise.allSettled([
      concord.watchAsset({ network: "testnet", asset: assetCode, fromLedger: 1 }),
      concord.watchAsset({ network: "testnet", asset: assetCode, fromLedger: 1 }),
    ]);

    const successes = [r1, r2].filter((r) => r.status === "fulfilled");
    const rejections = [r1, r2].filter((r) => r.status === "rejected");

    expect(successes).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    expect((rejections[0] as PromiseRejectedResult).reason).toBeInstanceOf(Invalid);
    expect((rejections[0] as PromiseRejectedResult).reason.message).toContain("is already watched");
  });

  it("validates decimals for classic and contract assets", async () => {
    const classicIssuer = key();
    // Classic asset rejects decimals !== 7
    await expect(
      concord.watchAsset({ network: "testnet", asset: `FAIL:${classicIssuer}`, decimals: 3, fromLedger: 1 }),
    ).rejects.toThrow(new Invalid("classic assets always carry 7 decimals"));

    // Classic asset accepts decimals === 7 and undefined
    const c1 = await concord.watchAsset({ network: "testnet", asset: `OK1:${classicIssuer}`, decimals: 7, fromLedger: 1 });
    expect(c1.decimals).toBe(7);
    const c2 = await concord.watchAsset({ network: "testnet", asset: `OK2:${classicIssuer}`, fromLedger: 1 });
    expect(c2.decimals).toBe(7);

    // Contract token keeps existing 0 to 18 range check
    const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    await expect(
      concord.watchAsset({ network: "testnet", asset: contractId, decimals: -1, fromLedger: 1 }),
    ).rejects.toThrow(new Invalid("decimals must be 0 to 18"));
    await expect(
      concord.watchAsset({ network: "testnet", asset: contractId, decimals: 19, fromLedger: 1 }),
    ).rejects.toThrow(new Invalid("decimals must be 0 to 18"));
  });

  // What the ledger states about the asset, what the caller gives, and what is stored or why not.
  const NOT_STATED = "this token does not state its decimals; give them when watching it";
  const OUT_OF_RANGE = "decimals must be 0 to 18";
  const CLASSIC_SEVEN = "classic assets always carry 7 decimals";
  const decimalsCases: Array<{
    kind: "contract token" | "classic asset";
    stated?: number;
    given?: number;
    stored?: number;
    refused?: string;
  }> = [
    { kind: "contract token", given: undefined, refused: NOT_STATED },
    { kind: "contract token", given: 0, stored: 0 },
    { kind: "contract token", given: 18, stored: 18 },
    { kind: "contract token", given: 19, refused: OUT_OF_RANGE },
    { kind: "contract token", given: -1, refused: OUT_OF_RANGE },
    { kind: "contract token", given: 1.5, refused: OUT_OF_RANGE },
    { kind: "contract token", given: Number.NaN, refused: OUT_OF_RANGE },
    // A token that states its decimals needs none given, and is held to the same range.
    { kind: "contract token", stated: 6, stored: 6 },
    { kind: "contract token", stated: 19, refused: OUT_OF_RANGE },
    // A classic asset carries seven by protocol. The caller may say so, but may not override it.
    { kind: "classic asset", given: undefined, stored: 7 },
    { kind: "classic asset", given: 7, stored: 7 },
    { kind: "classic asset", given: 3, refused: CLASSIC_SEVEN },
  ];

  for (const { kind, stated, given, stored, refused } of decimalsCases) {
    const subject = kind === "classic asset" ? kind : `${kind} that states ${stated ?? "no"} decimals`;
    const outcome = refused === undefined ? `stores ${stored}` : `is refused: ${refused}`;
    it(`watching a ${subject}, given ${given ?? "none"}, ${outcome}`, async () => {
      const asset = kind === "classic asset" ? `DEC:${key()}` : StrKey.encodeContract(Buffer.alloc(32, 5));
      chain.describe = async () => (stated === undefined ? { name: "Token" } : { name: "Token", decimals: stated });
      const assetRows = () => concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM assets")!.n;
      const before = assetRows();
      const watch = () => concord.watchAsset({ network: "testnet", asset, decimals: given, fromLedger: 1 });

      if (refused === undefined) {
        const watched = await watch();
        expect(watched.decimals).toBe(stored);
        const row = concord.db.get<{ decimals: number }>("SELECT decimals FROM assets WHERE id = ?", watched.id);
        expect(row!.decimals).toBe(stored);
      } else {
        const error = await watch().catch((err: unknown) => err);
        expect(error).toBeInstanceOf(Invalid);
        expect((error as Error).message).toBe(refused);
        // A refused watch leaves no row behind.
        expect(assetRows()).toBe(before);
      }
    });
  }

  it("validates Stellar addresses in ignore and exclude lists", async () => {
    const validG = key();
    const validC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const validM = "MAAAAAAAAAAAJRU2"; // valid med25519 or test med25519
    const invalidAddr = "not-an-address";

    // watchAsset rejects invalid address and names it
    await expect(
      concord.watchAsset({ network: "testnet", asset: `BAD1:${key()}`, fromLedger: 1, ignore: [invalidAddr] }),
    ).rejects.toThrow(`ignore contains an invalid Stellar address: "${invalidAddr}"`);

    // watchAsset accepts valid G and C addresses
    const watched = await concord.watchAsset({ network: "testnet", asset: `GOOD:${key()}`, fromLedger: 1, ignore: [validG, validC] });
    expect(watched.ignore).toEqual([validG, validC]);

    // updateAsset rejects invalid address and names it
    expect(() => concord.updateAsset(watched.id, { ignore: [invalidAddr] })).toThrow(
      `ignore contains an invalid Stellar address: "${invalidAddr}"`,
    );

    // createAction rejects invalid address in exclude and names it
    await expect(
      concord.createAction(watched.id, {
        type: "split",
        recordTime: at(10),
        num: "2",
        den: "1",
        exclude: [invalidAddr],
      }),
    ).rejects.toThrow(`exclude contains an invalid Stellar address: "${invalidAddr}"`);
  });

  it("trims and caps a new asset name, keeps the old one for a blank, and dedupes and caps the ignore list", () => {
    type Patch = { name?: string; ignore?: string[] };
    const stored = () => concord.asset(assetId);
    const refuses = (patch: Patch, message: string) => {
      let thrown: unknown;
      try {
        concord.updateAsset(assetId, patch);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Invalid);
      expect((thrown as Error).message).toBe(message);
    };
    expect(stored()).toMatchObject({ name: "FUND", ignore: [treasury] });

    // A name is trimmed, and a patch that names no ignore list leaves the stored one alone.
    expect(concord.updateAsset(assetId, { name: "  New  " }).name).toBe("New");
    expect(stored()).toMatchObject({ name: "New", ignore: [treasury] });

    // A blank name keeps the old one.
    for (const blank of ["", "   "]) {
      concord.updateAsset(assetId, { name: blank });
      expect(stored().name).toBe("New");
    }

    // 120 characters is the longest a name can be. 121 is refused and the stored name stays.
    const longest = "n".repeat(120);
    concord.updateAsset(assetId, { name: longest });
    expect(stored().name).toBe(longest);
    refuses({ name: "n".repeat(121) }, "name must be text of at most 120 characters");
    expect(stored().name).toBe(longest);

    // Duplicates and blanks are dropped, in the order first given, and the name is left alone.
    concord.updateAsset(assetId, { ignore: [h1, h1, h2, ""] });
    expect(stored()).toMatchObject({ name: longest, ignore: [h1, h2] });

    // 500 entries is the longest list. One more, an entry over 80 characters and a bare string are
    // each refused, and the stored list stays.
    const most = Array.from({ length: 500 }, () => key());
    concord.updateAsset(assetId, { ignore: most });
    expect(stored().ignore).toEqual(most);
    for (const bad of [[...most, key()], [h1, "G".repeat(81)], h1 as unknown as string[]]) {
      refuses({ ignore: bad }, "ignore must be a list of addresses");
      expect(stored().ignore).toEqual(most);
    }
    // At exactly 80 characters an entry is read as an address, and refused as a bad one instead.
    refuses({ ignore: ["G".repeat(80)] }, `ignore contains an invalid Stellar address: "${"G".repeat(80)}"`);
    expect(stored().ignore).toEqual(most);
  });

  it("serves the same operations over HTTP, to a signed-in user", async () => {
    const h = harness();
    h.chain.baselineResult = { ledger: 50, openings: new Map() };
    const client = await new Client(h.app).signUp("ops@example.test", "Ops");
    expect((await h.app.request("/api/overview")).status).toBe(401);

    const watched = await client.call("/api/assets", {
      body: { network: "testnet", asset: `FUND:${issuer}`, ignore: [treasury], baseline: false },
    });
    expect(watched.status).toBe(201);
    const ws = h.tenants.forOrg(client.orgId);
    // The route ignores baseline: a classic asset takes opening balances unless a start ledger is given.
    expect(ws.asset("FUND").startMode).toBe("baseline");
    await ws.sync("FUND");
    expect(ws.asset("FUND")).toMatchObject({ state: "ready", baselineLedger: 50 });
    await ws.unwatchAsset("FUND");
    const asset = await ws.watchAsset({ network: "testnet", asset: `FUND:${issuer}`, fromLedger: 1, ignore: [treasury] });
    h.chain.push(asset.id, "mint", 3, { to: h1, amount: u(100) });
    h.chain.push(asset.id, "mint", 3, { to: h2, amount: u(50) });

    const created = await client.call("/api/assets/FUND/registers", {
      body: { csv: `holder_id,account,units\nA,${h1},90\nB,${h2},50\nC,${h3},oops\n`, asOf: at(40) },
    });
    expect(created.status).toBe(201);
    const { run, issues } = (await created.json()) as {
      run: { id: number; breaks: Array<{ key: string; fingerprint: string }> };
      issues: Array<{ line: number; message: string }>;
    };
    // Holder A is ten short on the register, and so the totals disagree too.
    expect(run.breaks).toHaveLength(2);
    expect(issues).toEqual([expect.objectContaining({ line: 4 })]);

    const noted = await client.call("/api/assets/FUND/notes", {
      method: "PUT",
      body: { scope: "recon", key: run.breaks[0]!.key, fingerprint: run.breaks[0]!.fingerprint, status: "resolved", note: "register corrected", author: "CEO" },
    });
    expect(noted.status).toBe(200);
    const trail = await client.json<Array<{ key: string; status: string; note: string }>>(
      `/api/assets/FUND/notes/history?scope=recon&key=${encodeURIComponent(run.breaks[0]!.key)}`,
    );
    expect(trail).toMatchObject([{ key: run.breaks[0]!.key, status: "resolved", note: "register corrected" }]);
    const again = await client.json<{ breaks: Array<{ noteAuthor: string }> }>(`/api/reconciliations/${run.id}`);
    expect(again.breaks[0]!.noteAuthor).toBe("Test User <ops@example.test>");
    const overview = await client.json<{ networks: string[]; assets: Array<{ code: string; openBreaks: { reconciliation: number } }> }>("/api/overview");
    expect(overview.networks).toEqual(["testnet"]);
    expect(overview.assets[0]).toMatchObject({ code: "FUND", openBreaks: { reconciliation: 1 } });

    expect((await client.call("/api/assets/NOPE/holdings")).status).toBe(404);
    expect((await client.call("/api/assets/FUND/registers", { body: { csv: "x", asOf: "y" } })).status).toBe(400);
    const future = new Date(Date.now() + 6 * 60_000).toISOString();
    const futureRegister = await client.call("/api/assets/FUND/registers", {
      body: { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: future, reconcile: false },
    });
    expect(futureRegister.status).toBe(400);
    expect(await futureRegister.text()).toContain("asOf cannot be more than 5 minutes in the future");
    const csv = await client.call("/api/assets/FUND/export?section=holdings");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain(h1);
    const template = await client.call("/api/templates/register.csv");
    expect(await template.text()).toBe("holder_id,holder_name,account,units,status\n");
  });

  it("imports journal in merge mode by default, updating and adding entries (#540)", () => {
    // Initial import: J1, J2
    const res1 = concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},100\nJ2,${at(3)},issue,,${h2},50\n`,
    );
    expect(res1).toMatchObject({ entries: 2, added: 2, replaced: 0, removed: 0 });

    // Second import in merge mode: J2 (updated units), J3 (new)
    const res2 = concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ2,${at(4)},issue,,${h2},70\nJ3,${at(5)},issue,,${h1},20\n`,
      { mode: "merge" },
    );
    expect(res2).toMatchObject({ entries: 2, added: 1, replaced: 1, removed: 0 });

    const rows = concord.db.all<{ ref: string; units: string }>("SELECT ref, units FROM journal WHERE asset_id = ? ORDER BY ref", assetId);
    expect(rows).toEqual([
      { ref: "J1", units: "1000000000" },
      { ref: "J2", units: "700000000" },
      { ref: "J3", units: "200000000" },
    ]);
  });

  it("imports journal in replace mode, atomically swapping entries and removing absent ones (#540)", () => {
    // Seed initial rows: J1, J2, J3
    concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},100\nJ2,${at(3)},issue,,${h2},50\nJ3,${at(5)},issue,,${h1},20\n`,
    );

    // Replace with: J2 (different units), J4 (new). J1 and J3 should be removed.
    const res = concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ2,${at(4)},issue,,${h2},80\nJ4,${at(6)},issue,,${h2},30\n`,
      { mode: "replace" },
    );
    expect(res).toMatchObject({ entries: 2, added: 1, replaced: 1, removed: 2 });

    const rows = concord.db.all<{ ref: string; units: string }>("SELECT ref, units FROM journal WHERE asset_id = ? ORDER BY ref", assetId);
    expect(rows).toEqual([
      { ref: "J2", units: "800000000" },
      { ref: "J4", units: "300000000" },
    ]);
  });

  it("refuses replace when journal has parse errors unless allowPartial is set (#540)", () => {
    // Seed initial rows: J2, J4
    concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ2,${at(4)},issue,,${h2},80\nJ4,${at(6)},issue,,${h2},30\n`,
    );

    const badCsv = `ref,date,type,from_account,to_account,units\nJ5,${at(7)},unknown_type,,${h1},10\nJ2,${at(4)},issue,,${h2},99\n`;

    // Without allowPartial: throws and does NOT wipe existing rows
    expect(() => concord.importJournal("FUND", badCsv, { mode: "replace" })).toThrow(/parse error/i);

    const rowsAfterFail = concord.db.all<{ ref: string; units: string }>("SELECT ref, units FROM journal WHERE asset_id = ? ORDER BY ref", assetId);
    expect(rowsAfterFail).toEqual([
      { ref: "J2", units: "800000000" },
      { ref: "J4", units: "300000000" },
    ]);

    // With allowPartial: true: imports valid rows (J2) and removes absent rows (J4), reporting issues
    const resPartial = concord.importJournal("FUND", badCsv, { mode: "replace", allowPartial: true });
    expect(resPartial.issues).toHaveLength(1);
    expect(resPartial.added).toBe(0);
    expect(resPartial.replaced).toBe(1);
    expect(resPartial.removed).toBe(1);

    const rowsAfterPartial = concord.db.all<{ ref: string; units: string }>("SELECT ref, units FROM journal WHERE asset_id = ? ORDER BY ref", assetId);
    expect(rowsAfterPartial).toEqual([
      { ref: "J2", units: "990000000" },
    ]);
  });

  it("handles replace via API endpoint /assets/:id/journal (#540)", async () => {
    const client = await new Client(harness().app).signUp("journal_ops@example.test", "JournalOps");
    const asset = await client.json<{ id: string }>("/api/assets", {
      body: { network: "testnet", asset: `REPLACE:${key()}`, fromLedger: 1 },
    });
    const id = asset.id;

    // Initial import
    const res1 = await client.json<{ entries: number; added: number; replaced: number; removed: number }>(`/api/assets/${id}/journal`, {
      body: {
        csv: `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},10\nJ2,${at(3)},issue,,${h2},20\n`,
      },
    });
    expect(res1).toMatchObject({ entries: 2, added: 2, replaced: 0, removed: 0 });

    // Replace via API
    const res2 = await client.json<{ entries: number; added: number; replaced: number; removed: number }>(`/api/assets/${id}/journal`, {
      body: {
        csv: `ref,date,type,from_account,to_account,units\nJ2,${at(3)},issue,,${h2},25\nJ3,${at(4)},issue,,${h1},30\n`,
        mode: "replace",
      },
    });
    expect(res2).toMatchObject({ entries: 2, added: 1, replaced: 1, removed: 1 });
  });

  it("does not let a failed deferred watch in indexing state consume maxAssetsPerOrg", async () => {
    const h = harness({ maxAssetsPerOrg: 1 });
    h.chain.baselineResult = undefined;
    const client = await new Client(h.app).signUp("cap@example.test", "Quota Test");
    const issuer = key();

    const first = await client.call("/api/assets", {
      body: { network: "testnet", asset: `BAD:${issuer}` },
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string; state: string };
    expect(firstBody.state).toBe("indexing");

    await vi.waitFor(async () => {
      const detail = await client.json<{ state: string; syncError?: string }>(`/api/assets/${firstBody.id}`);
      expect(detail.state).toBe("indexing");
      expect(detail.syncError).toBeTruthy();
    });

    const second = await client.call("/api/assets", {
      body: { network: "testnet", asset: `GOOD:${issuer}`, fromLedger: 1 },
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { id: string };

    await vi.waitFor(async () => {
      const detail = await client.json<{ state: string }>(`/api/assets/${secondBody.id}`);
      expect(detail.state).toBe("ready");
    });

    const third = await client.call("/api/assets", {
      body: { network: "testnet", asset: `THIRD:${issuer}`, fromLedger: 1 },
    });
    expect(third.status).toBe(400);
    expect(await third.text()).toContain("A workspace can watch 1 assets");
  });
});

describe("documented input files", () => {
  const readme = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");

  it("serves optional example rows and rejects unknown templates", async () => {
    const client = await new Client(harness().app).signUp("templates@example.test", "Templates");
    for (const kind of ["register", "journal", "instructions"]) {
      const blank = await (await client.call(`/api/templates/${kind}.csv`)).text();
      for (const example of ["1", "true"]) {
        const res = await client.call(`/api/templates/${kind}?example=${example}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/csv");
        expect(res.headers.get("content-disposition")).toContain(`concord-${kind}-template.csv`);
        const csv = await res.text();
        expect(csv.startsWith(blank)).toBe(true);
        expect(csv.trimEnd().split("\n")).toHaveLength(2);
      }
      const disabled = await client.call(`/api/templates/${kind}.csv?example=false`);
      expect(await disabled.text()).toBe(blank);
    }
    for (const kind of ["unknown", "toString", "__proto__"]) {
      expect((await client.call(`/api/templates/${kind}?example=1`)).status).toBe(404);
    }
  });

  /** The column names in one README Input-files row. Parenthesised value enumerations go. */
  function documentedColumns(row: string): string[] {
    const columnWords = row.replace(/\([^)]*\)/g, "");
    return [...new Set([...columnWords.matchAll(/`([A-Za-z_]+)`/g)].map((m) => m[1]!))].sort();
  }

  it("lists the same columns as the CSV templates the API serves", async () => {
    const client = await new Client(harness().app).signUp("docs@example.test", "Docs");
    const rows = readme.split("\n").filter((line) => line.startsWith("| "));
    const files = [
      ["register", "Register"],
      ["journal", "Journal"],
      ["instructions", "Instructions"],
    ] as const;
    for (const [kind, file] of files) {
      const res = await client.call(`/api/templates/${kind}.csv`);
      expect(res.status, `${kind} template`).toBe(200);
      const headers = (await res.text())
        .trim()
        .split(/\r?\n/)[0]!
        .split(",")
        .map((h) => h.trim())
        .sort();
      const row = rows.find((line) => line.startsWith(`| ${file} |`));
      expect(row, `the README has no ${file} row in its Input files table`).toBeTruthy();
      expect(documentedColumns(row!), `${kind} template vs the README ${file} row`).toEqual(headers);
    }
  });
});

describe("README CLI examples", () => {
  // Guards the README against drift: a command renamed or removed from the usage text,
  // or a flag named in a README example but not in it, fails here.
  const readme = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");
  const examples = [...readme.matchAll(/```sh\n([\s\S]*?)```/g)]
    .flatMap((b) => b[1].split("\n"))
    .filter((line) => line.startsWith("pnpm concord"))
    .map((line) => line.replace(/\s+$/, ""));

  const usageCommands = new Set(
    USAGE.split("\n")
      .filter((line) => /^ {2}\S/.test(line))
      .map((line) => line.slice(2).split(/\s+/)[0]!),
  );
  const usageFlags = new Set(USAGE.match(/--[\w-]+/g));

  it("mentions every command the README examples run", () => {
    expect(examples.length).toBeGreaterThan(0);
    for (const line of examples) {
      const command = line.split(/\s+/)[2];
      if (command && !command.startsWith("--")) {
        expect(usageCommands.has(command), `README runs "${command}", but it is not in the CLI usage text`).toBe(true);
      }
    }
  });

  it("names every flag the README examples pass", () => {
    for (const line of examples) {
      for (const flag of line.match(/--[\w-]+/g) ?? []) {
        expect(usageFlags.has(flag), `README example passes "${flag}", but the CLI usage text does not name it`).toBe(true);
      }
    }
  });
});
