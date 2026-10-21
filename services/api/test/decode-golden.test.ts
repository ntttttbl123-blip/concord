import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeEvent, type RawEvent } from "../src/chain.js";

interface GoldenFixture {
  label: string;
  network: "mainnet" | "testnet";
  raw: RawEvent;
  expected: Record<string, unknown> & { amount: string };
}

const fixturePath = resolve(import.meta.dirname, "fixtures/rpc/get-events-golden.json");
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")).fixtures as GoldenFixture[];

describe("decodeEvent against recorded Stellar RPC getEvents payloads", () => {
  it("covers every event kind on mainnet and testnet, including muxed and SEP-41 transfers", () => {
    expect(fixtures).toHaveLength(14);
    for (const network of ["mainnet", "testnet"] as const) {
      const samples = fixtures.filter((fixture) => fixture.network === network);
      for (const kind of ["transfer", "mint", "burn", "clawback", "set_authorized"]) {
        expect(samples.some((fixture) => fixture.expected.kind === kind), `${network} ${kind}`).toBe(true);
      }
      expect(samples.some((fixture) => fixture.label.includes("SEP-41"))).toBe(true);
      expect(samples.some((fixture) => fixture.label.includes("muxed"))).toBe(true);
    }

    for (const fixture of fixtures) {
      const decoded = decodeEvent(fixture.raw);
      expect(decoded, fixture.label).toBeDefined();
      expect({ ...decoded, amount: decoded!.amount.toString() }, fixture.label).toEqual(fixture.expected);
    }
  });
});
