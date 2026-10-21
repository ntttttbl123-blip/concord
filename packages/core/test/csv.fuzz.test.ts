import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseCsv, parseInstructionsCsv, parseJournalCsv, parseRegisterCsv, toCsv } from "../src/index.js";

/**
 * Registers, journals and instruction files arrive as third-party CSV exports. These properties
 * feed the parsers arbitrary text and only require that they finish, and that a throw is always a
 * plain Error carrying a message - never a hang, a non-Error throw, or a malformed result.
 */
const RUNS = 10_000;
const TIME_BUDGET_MS = 10_000;
const MAX_LENGTH = 256;

const arbitraryText = fc.string({ maxLength: MAX_LENGTH });

function assertReturnsOrThrowsError(parse: (input: string) => unknown, input: string): void {
  let result: unknown;
  try {
    result = parse(input);
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(typeof message).toBe("string");
    expect(message.length).toBeGreaterThan(0);
    return;
  }
  expect(result).toBeDefined();
}

describe("CSV parser fuzzing", () => {
  const parsers: Array<[string, (input: string) => unknown]> = [
    ["parseCsv", parseCsv],
    ["parseRegisterCsv", parseRegisterCsv],
    ["parseJournalCsv", parseJournalCsv],
    ["parseInstructionsCsv", parseInstructionsCsv],
  ];

  for (const [name, parse] of parsers) {
    it(`${name}: 10k arbitrary inputs return or throw an Error with a message`, () => {
      const started = performance.now();
      fc.assert(
        fc.property(arbitraryText, (input) => assertReturnsOrThrowsError(parse, input)),
        { numRuns: RUNS },
      );
      expect(performance.now() - started).toBeLessThan(TIME_BUDGET_MS);
    }, 30_000);
  }

  it("toCsv output round-trips through parseCsv and stays stable", () => {
    // Rows may not be entirely blank: parseCsv intentionally drops those.
    const case_ = fc
      .tuple(
        fc.array(fc.string({ maxLength: 24 }), { minLength: 1, maxLength: 5 }),
        fc.array(fc.array(fc.string({ maxLength: 24 }), { minLength: 0, maxLength: 5 }), {
          minLength: 0,
          maxLength: 5,
        }),
      )
      .map(([rawHeaders, rawRows]) => {
        // Index prefixes keep headers unique and non-blank, so records can be keyed by them.
        const headers = rawHeaders.map((h, i) => `c${i}_${h}`);
        const records = rawRows.map((row) =>
          Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""] as const)),
        );
        return { headers, records };
      })
      .filter(({ records }) =>
        records.every((record) => Object.values(record).some((value) => value.trim() !== "")),
      );

    fc.assert(
      fc.property(case_, ({ headers, records }) => {
        const csv = toCsv(headers, records);
        const parsed = parseCsv(csv);

        expect(parsed[0]).toEqual(headers);
        expect(parsed.slice(1)).toEqual(records.map((record) => headers.map((h) => record[h])));

        const rewritten = toCsv(
          parsed[0]!,
          parsed.slice(1).map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i]!] as const))),
        );
        expect(rewritten).toBe(csv);
        expect(parseCsv(rewritten)).toEqual(parsed);
      }),
      { numRuns: 5_000 },
    );
  }, 30_000);

  it("regressions: empty input and unterminated quotes stay explicit", () => {
    expect(parseCsv("")).toEqual([]);
    expect(() => parseCsv('a,"unterminated')).toThrow(Error);
    expect(() => parseCsv('a,"unterminated')).toThrow(/unterminated quoted field/);
    expect(() => parseRegisterCsv("")).toThrow(/empty CSV/);
    expect(() => parseJournalCsv("")).toThrow(/empty CSV/);
    expect(() => parseInstructionsCsv("")).toThrow(/empty CSV/);
  });
});
