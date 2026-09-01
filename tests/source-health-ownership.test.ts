import { describe, expect, it } from "vitest";
import { laneOwnsSourceHealth } from "../apps/worker/src/modules/source-health-ownership.js";

describe("source health ownership", () => {
  it("keeps deep backfill failures from pausing a healthy realtime source", () => {
    expect(laneOwnsSourceHealth("BACKFILL")).toBe(false);
    expect(laneOwnsSourceHealth("COVERAGE")).toBe(false);
    expect(laneOwnsSourceHealth("REALTIME")).toBe(true);
    expect(laneOwnsSourceHealth("MANUAL")).toBe(true);
  });
});
