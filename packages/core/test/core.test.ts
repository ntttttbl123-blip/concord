import { describe, expect, it } from "vitest";
import {
  buildControlsLog,
  controlEvents,
  dividendEntitlements,
  formatUnits,
  observeFlows,
  parseCsv,
  parseInstructionsCsv,
  parseJournalCsv,
  parseRegisterCsv,
  parseUnits,
  reconcileDistribution,
  reconcileMovements,
  reconcilePositions,
  redemptionDeltas,
  replay,
  sortEvents,
  splitDeltas,
  templateCsv,
  TEMPLATES,
  toCsv,
  type Opening,
} from "../src/index.js";
import { ev, u } from "./fixtures.js";

describe("amounts", () => {
  it("round-trips decimals", () => {
    expect(parseUnits("1,234.5")).toBe(12_345_000_000n);
    expect(formatUnits(12_345_000_000n)).toBe("1234.5");
    expect(parseUnits("-0.0000001")).toBe(-1n);
    expect(formatUnits(-1n)).toBe("-0.0000001");
    expect(parseUnits("5.10000000")).toBe(51_000_000n);
  });
  it("refuses to round", () => {
    expect(() => parseUnits("0.00000001")).toThrow(/decimal places/);
    expect(() => parseUnits("1e5")).toThrow();
  });
});

describe("csv", () => {
  it("handles quotes, embedded commas and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, ""y""",2\r\n')).toEqual([
      ["a", "b"],
      ['x, "y"', "2"],
    ]);
    expect(toCsv(["a", "b"], [{ a: 'x, "y"', b: 2 }])).toBe('a,b\n"x, ""y""",2\n');
  });
});

describe("templates", () => {
  it.each(Object.entries(TEMPLATES))("keeps the %s template header-only by default", (kind, columns) => {
    const header = `${columns.join(",")}\n`;
    expect(templateCsv(kind)).toBe(header);
    expect(templateCsv(kind, { example: false })).toBe(header);
  });

  it("parses exactly one illustrative row for every template kind", () => {
    for (const kind of Object.keys(TEMPLATES)) {
      const csv = templateCsv(kind, { example: true })!;
      expect(parseCsv(csv)).toHaveLength(2);
      if (kind === "register") {
        const { positions, issues } = parseRegisterCsv(csv);
        expect(issues).toEqual([]);
        expect(positions).toHaveLength(1);
        expect(positions[0]).toMatchObject({ units: parseUnits("100.5"), status: "active" });
      } else if (kind === "journal") {
        const { entries, issues } = parseJournalCsv(csv);
        expect(issues).toEqual([]);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ units: parseUnits("10.5"), type: "transfer", date: "2026-10-01" });
      } else {
        const { instructions, issues } = parseInstructionsCsv(csv);
        expect(issues).toEqual([]);
        expect(instructions).toHaveLength(1);
        expect(instructions[0]).toMatchObject({
          units: parseUnits("5.5"), type: "clawback", issuedAt: "2026-10-01T12:00:00.000Z",
        });
      }
    }
  });

  it.each(["unknown", "toString", "__proto__"])("returns undefined for unknown kind %s", (kind) => {
    expect(templateCsv(kind)).toBeUndefined();
    expect(templateCsv(kind, { example: true })).toBeUndefined();
  });
});

describe("replay", () => {
  const history = [
    ev("set_authorized", 1, { from: "A", authorized: true }),
    ev("mint", 2, { to: "A", amount: u(100) }),
    ev("mint", 3, { to: "B", amount: u(50) }),
    ev("transfer", 4, { from: "A", to: "B", amount: u(10) }),
    ev("burn", 5, { from: "B", amount: u(5) }),
    ev("clawback", 6, { from: "A", amount: u(20) }),
    ev("set_authorized", 7, { from: "A", authorized: false }),
  ];

  it("derives balances, supply and authorisation", () => {
    const s = replay(history);
    expect(s.balances.get("A")).toBe(u(70));
    expect(s.balances.get("B")).toBe(u(55));
    expect(s.supply).toBe(u(125));
    expect(s.authorized.get("A")).toBe(false);
    expect(s.ledger).toBe(7);
  });

  it("stops at a record ledger or time", () => {
    expect(replay(history, { upToLedger: 3 }).supply).toBe(u(150));
    expect(replay(history, { upToTime: "2026-10-01T00:04:00.000Z" }).balances.get("B")).toBe(u(60));
  });

  it("skips events a baseline already reflects, per holder", () => {
    const opening = new Map<string, Opening>([
      ["A", { amount: u(90), authorized: true, asOfLedger: 4 }],
      ["B", { amount: u(50), asOfLedger: 3 }],
    ]);
    const s = replay(history, { opening, baselineLedger: 3 });
    expect(s.balances.get("A")).toBe(u(70));
    expect(s.balances.get("B")).toBe(u(55));
  });

  it("flags holders whose history is incomplete", () => {
    const s = replay([ev("transfer", 9, { from: "X", to: "Y", amount: u(1) })]);
    expect(s.incomplete).toEqual(["X"]);
  });

  it("orders unpadded ids by number, not as strings", () => {
    const later = { ...ev("transfer", 10, { from: "A", to: "B", amount: u(1) }), id: "10-1" };
    const earlier = { ...ev("mint", 9, { to: "A", amount: u(5) }), id: "9-1" };
    expect(sortEvents([later, earlier]).map((e) => e.id)).toEqual(["9-1", "10-1"]);
    expect(replay([later, earlier], { upToLedger: 9 }).balances.get("A")).toBe(u(5));
    const rpc = ["0000000429496729600-0000000002", "0000000429496729600-0000000001"];
    expect(sortEvents(rpc.map((id) => ({ id }))).map((e) => e.id)).toEqual([rpc[1], rpc[0]]);
  });

  it("rejects ids that are not in the RPC form", () => {
    expect(() => sortEvents([{ id: "9-1" }, { id: "abc" }])).toThrow(/event id "abc"/);
    expect(() => replay([{ ...ev("mint", 1, { to: "A", amount: u(1) }), id: "1" }])).toThrow(/RPC form/);
  });
});

describe("position reconciliation", () => {
  const chain = replay([
    ev("mint", 1, { to: "A", amount: u(100) }),
    ev("mint", 1, { to: "B", amount: u(40) }),
    ev("mint", 1, { to: "C", amount: u(7) }),
    ev("set_authorized", 2, { from: "B", authorized: false }),
  ]);

  it("agrees when the books agree, including omnibus accounts", () => {
    const { positions } = parseRegisterCsv(
      "holder_id,account,units,status\nH1,A,60,\nH2,A,40,\nH3,B,40,frozen\nH4,C,7,\n",
    );
    const r = reconcilePositions(chain, positions);
    expect(r.breaks).toEqual([]);
    expect(r.summary.matchedLines).toBe(3);
    expect(r.lines[0]!.holderIds).toEqual(["H1", "H2"]);
  });

  it("flags every kind of break", () => {
    const { positions, issues } = parseRegisterCsv(
      "Holder ID,Name,Address,Shares,Status\nH1,Ann,A,90,active\nH3,Bo,B,40,active\nH5,Di,D,3,\nH6,Ed,,2,\nH7,Bad,E,x,\n",
    );
    expect(issues).toHaveLength(1);
    const r = reconcilePositions(chain, positions);
    expect(r.breaks.map((b) => b.type).sort()).toEqual([
      "MISSING_IN_REGISTER",
      "MISSING_ON_CHAIN",
      "QUANTITY_MISMATCH",
      "STATUS_MISMATCH",
      "SUPPLY_MISMATCH",
      "UNMAPPED_HOLDER",
    ]);
    const qty = r.breaks.find((b) => b.type === "QUANTITY_MISMATCH")!;
    expect(qty.difference).toBe(u(10));
    expect(r.summary.grossDifference).toBe(u(20));
  });

  it("honours tolerance and ignored addresses", () => {
    const { positions } = parseRegisterCsv("holder_id,account,units\nH1,A,100.0000001\nH3,B,40\n");
    const r = reconcilePositions(chain, positions, { tolerance: 1n, ignore: ["C"] });
    expect(r.breaks).toEqual([]);
  });
});

describe("movement reconciliation", () => {
  const events = [
    ev("mint", 10, { to: "A", amount: u(100), txHash: "aa" }),
    ev("transfer", 20, { from: "A", to: "B", amount: u(10), txHash: "bb" }),
    ev("transfer", 30, { from: "A", to: "B", amount: u(10), txHash: "cc" }),
    ev("clawback", 40, { from: "B", amount: u(5), txHash: "dd" }),
    ev("burn", 50, { from: "A", amount: u(1), txHash: "ee" }),
  ];

  it("matches by hash, then by attributes, and reports the rest", () => {
    const { entries, issues } = parseJournalCsv(
      [
        "ref,date,type,from_account,to_account,units,tx_hash",
        "J1,2026-10-01,issue,,A,99,AA",
        "J2,2026-10-01,transfer,A,B,10,",
        "J3,2026-10-01,redemption,B,,5,",
        "J4,2026-10-01,transfer,B,A,3,",
        "J5,2026-09-20,transfer,A,B,10,",
      ].join("\n"),
    );
    expect(issues).toEqual([]);
    const r = reconcileMovements(events, entries);
    expect(r.matches).toHaveLength(3);
    expect(r.breaks.map((b) => `${b.type}:${b.ref ?? b.txHash}`).sort()).toEqual([
      "MOVEMENT_AMOUNT_MISMATCH:J1",
      "UNRECORDED_MOVEMENT:cc",
      "UNRECORDED_MOVEMENT:ee",
      "UNSETTLED_ENTRY:J4",
      "UNSETTLED_ENTRY:J5",
    ]);
  });

  it("limits reporting to the period", () => {
    const r = reconcileMovements(events, [], { from: "2026-10-01T00:25:00Z", to: "2026-10-01T00:45:00Z" });
    expect(r.breaks.map((b) => b.txHash)).toEqual(["cc", "dd"]);
  });

  it("does not pair an entry citing tx_hash aa with an event from tx bb by attributes", () => {
    const evs = [
      ev("transfer", 20, { from: "A", to: "B", amount: u(10), txHash: "bb" }),
    ];
    const { entries } = parseJournalCsv(
      "ref,date,type,from_account,to_account,units,tx_hash\nJ1,2026-10-01,transfer,A,B,10,aa\n",
    );
    const r = reconcileMovements(evs, entries);
    expect(r.matches).toHaveLength(0);
    expect(r.breaks.map((b) => b.type).sort()).toEqual([
      "UNRECORDED_MOVEMENT",
      "UNSETTLED_ENTRY",
    ]);
    const unsettled = r.breaks.find((b) => b.type === "UNSETTLED_ENTRY")!;
    expect(unsettled.ref).toBe("J1");
    expect(unsettled.txHash).toBe("aa");
  });
});

describe("corporate actions", () => {
  const history = [
    ev("mint", 1, { to: "A", amount: u(100) }),
    ev("mint", 1, { to: "B", amount: u(50) }),
    ev("mint", 1, { to: "C", amount: 3n }),
    ev("mint", 1, { to: "TREASURY", amount: u(1000) }),
    ev("transfer", 9, { from: "A", to: "D", amount: u(100) }),
  ];
  const snapshot = replay(history, { upToLedger: 5 });

  it("snapshots holdings at the record ledger", () => {
    expect(snapshot.balances.get("A")).toBe(u(100));
    expect(snapshot.balances.has("D")).toBe(false);
  });

  it("reconciles a cash dividend", () => {
    const expected = dividendEntitlements(snapshot, {
      ratePerUnit: "0.0123456789",
      baseDecimals: 7,
      payDecimals: 7,
      exclude: ["TREASURY"],
    });
    expect(expected.get("A")).toBe(12_345_678n);
    expect(expected.get("B")).toBe(6_172_839n);
    expect(expected.has("C")).toBe(false);
    const cash = [
      ev("transfer", 10, { from: "PAYER", to: "A", amount: 12_345_678n }),
      ev("transfer", 10, { from: "PAYER", to: "B", amount: 6_000_000n }),
      ev("transfer", 10, { from: "PAYER", to: "D", amount: 5n }),
      ev("transfer", 10, { from: "SOMEONE", to: "A", amount: 999n }),
    ];
    const observed = observeFlows(cash, { fromLedger: 6, plus: ["transfer"], minus: [], payer: "PAYER" });
    const r = reconcileDistribution(snapshot, expected, observed);
    expect(r.breaks.map((b) => `${b.type}:${b.address}`)).toEqual(["SHORT:B", "UNEXPECTED:D"]);
    expect(r.lines.find((l) => l.address === "A")!.status).toBe("ok");
    expect(r.summary.difference).toBe(-172_834n);
  });

  it("does not count a payer's transfer to itself as a distribution", () => {
    const cash = [
      ev("transfer", 10, { from: "PAYER", to: "PAYER", amount: u(9) }),
      ev("transfer", 10, { from: "PAYER", to: "A", amount: u(1) }),
    ];
    const observed = observeFlows(cash, { fromLedger: 6, plus: ["transfer"], minus: [], payer: "PAYER" });
    expect(observed.has("PAYER")).toBe(false);
    expect(observed.get("A")!.amount).toBe(u(1));
  });

  it("reports an unpaid holder", () => {
    const expected = dividendEntitlements(snapshot, { ratePerUnit: "1", baseDecimals: 7, payDecimals: 2 });
    expect(expected.get("B")).toBe(5000n);
    const r = reconcileDistribution(snapshot, expected, new Map(), { ignore: ["TREASURY", "A"] });
    expect(r.breaks.map((b) => b.type)).toEqual(["MISSING"]);
  });

  it("reconciles a forward split", () => {
    const expected = splitDeltas(snapshot, { num: 3n, den: 2n }, ["TREASURY"]);
    expect(expected.get("A")).toBe(u(50));
    expect(expected.get("C")).toBe(1n);
    const mints = [
      ev("mint", 12, { to: "A", amount: u(50) }),
      ev("mint", 12, { to: "B", amount: u(30) }),
      ev("mint", 2, { to: "A", amount: u(7) }),
    ];
    const observed = observeFlows(mints, { fromLedger: 11, plus: ["mint"], minus: ["clawback"] });
    const r = reconcileDistribution(snapshot, expected, observed);
    expect(r.breaks.map((b) => `${b.type}:${b.address}`)).toEqual(["EXCESS:B", "MISSING:C"]);
  });

  it("reconciles a reverse split and a redemption", () => {
    const reverse = splitDeltas(snapshot, { num: 1n, den: 10n }, ["TREASURY", "C"]);
    expect(reverse.get("A")).toBe(-u(90));
    const full = redemptionDeltas(snapshot, { num: 1n, den: 1n }, ["TREASURY", "C"]);
    const flows = [ev("clawback", 20, { from: "A", amount: u(100) }), ev("burn", 21, { from: "B", amount: u(20) })];
    const observed = observeFlows(flows, { fromLedger: 15, plus: [], minus: ["burn", "clawback"] });
    const r = reconcileDistribution(snapshot, full, observed);
    expect(r.breaks.map((b) => `${b.type}:${b.address}`)).toEqual(["SHORT:B"]);
  });

  it("does not count zero/zero netted-out flows in summary.holders while keeping txHashes", () => {
    const flows = [
      ev("mint", 10, { to: "A", amount: 5n, txHash: "tx_mint" }),
      ev("clawback", 11, { from: "A", amount: 5n, txHash: "tx_clawback" }),
    ];
    const observed = observeFlows(flows, { fromLedger: 1, plus: ["mint"], minus: ["clawback"] });
    expect(observed.get("A")?.amount).toBe(0n);
    expect(observed.get("A")?.txHashes).toEqual(["tx_mint", "tx_clawback"]);

    const r = reconcileDistribution(snapshot, new Map(), observed);
    expect(r.summary.holders).toBe(0);
    expect(r.lines.length).toBe(1);
    const lineA = r.lines.find((l) => l.address === "A");
    expect(lineA).toBeDefined();
    expect(lineA!.expected).toBe(0n);
    expect(lineA!.observed).toBe(0n);
    expect(lineA!.difference).toBe(0n);
    expect(lineA!.status).toBe("ok");
    expect(lineA!.txHashes).toEqual(["tx_mint", "tx_clawback"]);
  });

  it("rates opposite-sign flow as high severity UNEXPECTED", () => {
    const expected = new Map([["A", u(100)]]);
    const observed = new Map([["A", { amount: -u(100), txHashes: ["tx1"] }]]);
    const r = reconcileDistribution(snapshot, expected, observed);
    expect(r.breaks).toHaveLength(1);
    const b = r.breaks[0]!;
    expect(b.type).toBe("UNEXPECTED");
    expect(b.severity).toBe("high");
    expect(b.address).toBe("A");
  });
});

describe("controls log", () => {
  const events = [
    ev("set_authorized", 1, { from: "A", authorized: true }),
    ev("set_authorized", 100, { from: "A", authorized: false }),
    ev("set_authorized", 200, { from: "A", authorized: true }),
    ev("clawback", 300, { from: "B", amount: u(5) }),
    ev("clawback", 400, { from: "B", amount: u(6) }),
    ev("mint", 2, { to: "A", amount: u(1) }),
  ];

  it("ties each control to its instruction and flags the rest", () => {
    const { instructions, issues } = parseInstructionsCsv(
      [
        "ref,type,account,units,issued_at,approved_by,reason",
        "I1,authorise,A,,2026-10-01T00:00:00Z,ops,KYC passed",
        "I2,freeze,A,,2026-10-01T01:00:00Z,compliance,court order",
        "I3,clawback,B,5,2026-10-01T04:00:00Z,compliance,error correction",
        "I4,freeze,C,,2026-10-01T00:00:00Z,compliance,sanctions",
        "I5,freeze,D,,2026-10-06T00:00:00Z,compliance,review",
      ].join("\n"),
    );
    expect(issues).toEqual([]);
    const log = buildControlsLog(events, instructions, { asOf: "2026-10-06T12:00:00Z" });
    expect(log.records.map((r) => r.type)).toEqual(["authorize", "freeze", "unfreeze", "clawback", "clawback"]);
    expect(log.records.map((r) => r.instruction?.ref)).toEqual(["I1", "I2", undefined, "I3", undefined]);
    expect(log.breaks.map((b) => b.type)).toEqual([
      "UNINSTRUCTED_CONTROL",
      "UNINSTRUCTED_CONTROL",
      "UNEXECUTED_INSTRUCTION",
    ]);
    expect(log.pending.map((i) => i.ref)).toEqual(["I5"]);
  });

  it("does not accept an instruction issued after the action", () => {
    const { instructions } = parseInstructionsCsv(
      "ref,type,account,issued_at\nI9,freeze,A,2026-10-02T00:00:00Z\n",
    );
    const log = buildControlsLog(events.slice(1, 2), instructions, { asOf: "2026-10-02T01:00:00Z" });
    expect(log.summary.uninstructed).toBe(1);
  });

  it("gives identical output for the same input on repeated calls", () => {
    const { instructions } = parseInstructionsCsv(
      "ref,type,account,issued_at\nI1,freeze,A,2026-10-01T00:00:00Z\n",
    );
    const options = { asOf: "2026-10-06T12:00:00Z" };
    expect(buildControlsLog(events, instructions, options)).toEqual(
      buildControlsLog(events, instructions, options),
    );
  });

  it("logs unfreeze when an initially frozen account is lifted", () => {
    const liftEvents = [ev("set_authorized", 50, { from: "FROZEN_HOLDER", authorized: true })];

    // No opening data keeps current behaviour (first lift logged as authorize)
    const defaultRecords = controlEvents(liftEvents);
    expect(defaultRecords[0].type).toBe("authorize");

    // With initial frozen set (from openings), opening frozen then lifted logs unfreeze
    const unfreezeRecords = controlEvents(liftEvents, new Set(["FROZEN_HOLDER"]));
    expect(unfreezeRecords[0].type).toBe("unfreeze");

    // Also supports Map from openings (where authorized === false)
    const openings = new Map<string, Opening>([
      ["FROZEN_HOLDER", { amount: 100n, authorized: false, asOfLedger: 1 }],
      ["ACTIVE_HOLDER", { amount: 200n, authorized: true, asOfLedger: 1 }],
    ]);
    const fromOpenings = controlEvents(liftEvents, openings);
    expect(fromOpenings[0].type).toBe("unfreeze");

    // buildControlsLog matches unfreeze instruction properly
    const { instructions } = parseInstructionsCsv(
      "ref,type,account,issued_at\nI10,unfreeze,FROZEN_HOLDER,2026-10-01T00:40:00Z\n",
    );
    const log = buildControlsLog(liftEvents, instructions, {
      asOf: "2026-10-02T00:00:00Z",
      initialFrozen: new Set(["FROZEN_HOLDER"]),
    });
    expect(log.records[0].type).toBe("unfreeze");
    expect(log.records[0].instruction?.ref).toBe("I10");
    expect(log.breaks).toEqual([]);
  });
});
