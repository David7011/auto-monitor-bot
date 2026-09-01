import { describe, expect, it } from "vitest";
import { olxHtmlCoverageIssue } from "../apps/api/src/lib/search-plan-health.js";

const NOW = new Date("2026-08-22T15:00:00.000Z");

describe("OLX search-plan health copy", () => {
  it("does not claim a fast channel is working while OLX is protected", () => {
    expect(olxHtmlCoverageIssue({
      sourceStatus: "RATE_LIMITED",
      lastHtmlCoverageAt: new Date("2026-08-10T15:00:00.000Z"),
      intervalSeconds: 60,
      now: NOW,
    })).toContain("защитной паузе");
  });

  it("reports no issue for a fresh coverage confirmation", () => {
    expect(olxHtmlCoverageIssue({
      sourceStatus: "ACTIVE",
      lastHtmlCoverageAt: new Date("2026-08-22T14:59:30.000Z"),
      intervalSeconds: 60,
      now: NOW,
    })).toBeNull();
  });
});
