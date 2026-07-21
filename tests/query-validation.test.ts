import { describe, expect, it } from "vitest";
import { boundedIntegerQuery, cursorQuery } from "../apps/api/src/lib/query-validation.js";

describe("bounded integer query validation", () => {
  it("applies the default and accepts a bounded integer", () => {
    expect(boundedIntegerQuery(undefined, { fallback: 50, max: 200 })).toBe(50);
    expect(boundedIntegerQuery("200", { fallback: 50, max: 200 })).toBe(200);
  });

  it("rejects NaN, decimals, negative, zero and excessive values", () => {
    for (const value of ["abc", "1.5", "-1", "0", "201", "Infinity"]) {
      expect(boundedIntegerQuery(value, { fallback: 50, max: 200 })).toBeUndefined();
    }
  });

  it("accepts opaque cursor ids and rejects malformed cursor text", () => {
    expect(cursorQuery(undefined)).toBeUndefined();
    expect(cursorQuery("  cm123_test-id  ")).toBe("cm123_test-id");
    expect(cursorQuery("bad cursor")).toBeNull();
    expect(cursorQuery("x".repeat(201))).toBeNull();
  });
});
