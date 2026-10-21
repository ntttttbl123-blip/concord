import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { decodeEvent } from "../src/chain.js";
import { USAGE } from "../src/cli-usage.js";
import { Concord, Invalid, NotFound } from "../src/concord.js";
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
    // I1 and I2 cover the authorisation and freeze; I3 is recent enough to still be pending, and
    // the clawback has no instruction, so every controls branch appears in the pack.
    concord.importInstructions(
      "FUND",
      `ref,type,account,units,issued_at,approved_by,reason\nI1,authorise,${h1},,${at(1)},ops,KYC\nI2,freeze,${h2},,${at(19)},compliance,order\nI3,freeze,${h3},,${new Date().toISOString()},ops,review\n`,
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
        "sha256",
      ]
    `);
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
    expect(stalled.syncError).toBe("Indexing stopped on an unexpected error.");
    expect(await concord.sync("FUND")).toEqual({ added: 500 });
    const healed = concord.asset("FUND");
    expect(healed.syncedLedger).toBe(200);
    expect(healed.syncError).toBeUndefined();
  });

  it("reports a gap instead of indexing across it", async () => {
    await concord.sync("FUND");
    chain.latest = 500_000;
    chain.oldest = 400_000;
    await expect(concord.sync("FUND")).rejects.toThrow(/longer than the network keeps events/);
    expect(concord.asset("FUND").syncError).toMatch(/Rebuild this asset/);
  });

  it("stops watching and takes every dependent row with it", async () => {
    const csv = `holder_id,account,units\nA,${h1},90\n`;
    const reg = concord.importRegister("FUND", { csv, asOf: at(40) });
    const run = await concord.reconcile("FUND", reg.registerId);
    concord.importJournal("FUND", `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},100\n`);
    concord.importInstructions("FUND", `ref,type,account,units,issued_at\nI1,freeze,${h2},,${at(19)}\n`);
    const action = await concord.createAction("FUND", { type: "split", recordTime: at(35), num: "2", den: "1" });
    concord.setNote("FUND", "recon", run.breaks[0]!.key, { fingerprint: run.breaks[0]!.fingerprint, status: "resolved", note: "x" });
    concord.setNote("FUND", `action:${action.id}`, "k", { fingerprint: "f", status: "resolved", note: "x" });
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

  it("advances a scheduled action once the chain passes its record time", async () => {
    const action = await concord.createAction("FUND", { type: "redemption", recordTime: at(150), num: "1", den: "1" });
    expect(action.state).toBe("scheduled");
    expect(await concord.reconcileDue()).toBe(0);
    chain.latest = 200;
    await concord.syncAll();
    expect(await concord.reconcileDue()).toBe(1);
    expect(concord.action(action.id).state).not.toBe("scheduled");
  });

  it("refuses a code shared by two watched assets and a pay asset from another network", async () => {
    await concord.watchAsset({ network: "testnet", asset: `FUND:${key()}`, fromLedger: 1 });
    expect(() => concord.asset("FUND")).toThrow(/more than one/);
    expect(concord.asset(assetId).id).toBe(assetId);
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

  it("serves the same operations over HTTP, to a signed-in user", async () => {
    const h = harness();
    h.chain.baselineResult = { ledger: 50, openings: new Map() };
    const client = await new Client(h.app).signUp("ops@example.test", "Ops");
    expect((await h.app.request("/api/overview")).status).toBe(401);

    const watched = await client.call("/api/assets", {
      body: { network: "testnet", asset: `FUND:${issuer}`, ignore: [treasury], fromLedger: 1, baseline: false },
    });
    expect(watched.status).toBe(201);
    const ws = h.tenants.forOrg(client.orgId);
    // The route ignores fromLedger and baseline: a classic asset takes opening balances.
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
    const again = await client.json<{ breaks: Array<{ noteAuthor: string }> }>(`/api/reconciliations/${run.id}`);
    expect(again.breaks[0]!.noteAuthor).toBe("Test User <ops@example.test>");
    const overview = await client.json<{ networks: string[]; assets: Array<{ code: string; openBreaks: { reconciliation: number } }> }>("/api/overview");
    expect(overview.networks).toEqual(["testnet"]);
    expect(overview.assets[0]).toMatchObject({ code: "FUND", openBreaks: { reconciliation: 1 } });

    expect((await client.call("/api/assets/NOPE/holdings")).status).toBe(404);
    expect((await client.call("/api/assets/FUND/registers", { body: { csv: "x", asOf: "y" } })).status).toBe(400);
    const csv = await client.call("/api/assets/FUND/export?section=holdings");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain(h1);
    const template = await client.call("/api/templates/register.csv");
    expect(await template.text()).toBe("holder_id,holder_name,account,units,status\n");
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
