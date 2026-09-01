import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../apps/worker/src/modules/bounded-parallel.js";

describe("bounded parallel mapper", () => {
  it("preserves result order and never exceeds the concurrency limit", async () => {
    let active = 0;
    let maximumActive = 0;
    const result = await mapWithConcurrency([30, 5, 20, 1], 2, async (delay, index) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return index;
    });

    expect(result).toEqual([0, 1, 2, 3]);
    expect(maximumActive).toBe(2);
  });

  it("propagates a processing error after in-flight work settles", async () => {
    await expect(mapWithConcurrency([1, 2, 3], 2, async (value) => {
      if (value === 2) throw new Error("dispatch failed");
      return value;
    })).rejects.toThrow("dispatch failed");
  });
});
