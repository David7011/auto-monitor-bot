import { describe, expect, it } from "vitest";
import { backfillScanBudget } from "../apps/worker/src/modules/backfill-profile.js";

const limits = {
  defaultPages: 4,
  olxFullPages: 20,
  maxCandidates: 800,
  maxDurationMs: 60_000,
};

describe("backfill scan profiles", () => {
  it("keeps the configured OLX full-depth safety budget", () => {
    expect(backfillScanBudget("OLX", "BACKFILL", "FULL", limits)).toEqual({
      maxPages: 20,
      maxCandidates: 800,
      maxDurationMs: 60_000,
      profile: "FULL",
    });
  });

  it("uses a bounded multi-page OLX budget in lean mode", () => {
    expect(backfillScanBudget("OLX", "BACKFILL", "LIGHT", limits)).toEqual({
      maxPages: 4,
      maxCandidates: 250,
      maxDurationMs: 30_000,
      profile: "LIGHT",
    });
  });

  it("never applies the light profile to the realtime lane", () => {
    expect(backfillScanBudget("OLX", "REALTIME", "LIGHT", limits).profile).toBe("FULL");
  });
});
