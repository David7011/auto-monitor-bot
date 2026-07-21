import { describe, expect, it } from "vitest";
import { olxCoverageSchedule } from "../apps/worker/src/collectors/olx-coverage.js";

const now = new Date("2026-07-22T00:00:00.000Z");

describe("OLX coverage scheduling", () => {
  it("schedules every lane for a new search fingerprint", () => {
    expect(olxCoverageSchedule({
      now,
      state: {},
      isBackfill: false,
      hasRegionalFilters: true,
      regionalIntervalSeconds: 60,
      htmlIntervalSeconds: 60,
      privateIntervalSeconds: 90,
    })).toEqual({ regionalDue: true, htmlDue: true, privateDue: true });
  });

  it("keeps intervals independent per persisted fingerprint state", () => {
    expect(olxCoverageSchedule({
      now,
      state: {
        lastRegionalCoverageAt: new Date(now.getTime() - 61_000),
        lastHtmlCoverageAt: new Date(now.getTime() - 15_000),
        lastPrivateCoverageAt: new Date(now.getTime() - 91_000),
      },
      isBackfill: false,
      hasRegionalFilters: true,
      regionalIntervalSeconds: 60,
      htmlIntervalSeconds: 60,
      privateIntervalSeconds: 90,
    })).toEqual({ regionalDue: true, htmlDue: false, privateDue: true });
  });

  it("honours the HTML protection pause without stopping API coverage", () => {
    expect(olxCoverageSchedule({
      now,
      state: {
        lastRegionalCoverageAt: new Date(now.getTime() - 120_000),
        lastHtmlCoverageAt: new Date(now.getTime() - 120_000),
        htmlCoveragePausedUntil: new Date(now.getTime() + 60_000),
        lastPrivateCoverageAt: new Date(now.getTime() - 120_000),
      },
      isBackfill: false,
      hasRegionalFilters: true,
      regionalIntervalSeconds: 60,
      htmlIntervalSeconds: 60,
      privateIntervalSeconds: 90,
    })).toEqual({ regionalDue: true, htmlDue: false, privateDue: true });
  });

  it("does not spend coverage requests during deep backfill", () => {
    expect(olxCoverageSchedule({
      now,
      state: {},
      isBackfill: true,
      hasRegionalFilters: true,
      regionalIntervalSeconds: 60,
      htmlIntervalSeconds: 60,
      privateIntervalSeconds: 90,
    })).toEqual({ regionalDue: false, htmlDue: false, privateDue: false });
  });
});
