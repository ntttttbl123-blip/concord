import { describe, expect, it } from "vitest";
import { when } from "./ui";

describe("when() UTC table formatting", () => {
  it("returns never for missing timestamps", () => {
    expect(when(null)).toBe("never");
    expect(when(undefined)).toBe("never");
    expect(when("")).toBe("never");
  });

  it("formats UTC ISO timestamps to second precision", () => {
    expect(when("2026-10-06T21:00:00.000Z")).toBe("2026-10-06 21:00:00 UTC");
  });

  it("pins the current date-only double-space behavior", () => {
    // Pin existing behavior rather than silently changing the formatter.
    expect(when("2026-10-06")).toBe("2026-10-06  UTC");
  });

  it("documents that offset timestamps are not normalized", () => {
    // The current formatter labels the source-time as UTC without conversion.
    expect(when("2026-10-06T21:00:00+02:00")).toBe("2026-10-06 21:00:00 UTC");
  });

  it("does not depend on the viewer's timezone", () => {
    expect(when("2026-10-06T00:00:01.000Z")).toBe("2026-10-06 00:00:01 UTC");
  });
});
