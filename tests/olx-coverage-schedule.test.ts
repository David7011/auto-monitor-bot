import { describe, expect, it } from "vitest";
import {
  olxCoverageExecutionSchedule,
  olxCoverageSchedule,
} from "../apps/worker/src/collectors/olx-coverage.js";
import { partitionOlxExecutionTargets } from "../apps/worker/src/collectors/olx.js";

const now = new Date("2026-07-22T00:00:00.000Z");

describe("OLX coverage scheduling", () => {
  it("never attaches regional, HTML or private reconciliation to realtime", () => {
    expect(olxCoverageExecutionSchedule({
      coverageOnly: false,
      suppressBackground: false,
      now,
      state: {},
      hasRegionalFilters: true,
      regionalIntervalSeconds: 60,
      htmlIntervalSeconds: 60,
      privateIntervalSeconds: 90,
    })).toEqual({ regionalDue: false, htmlDue: false, privateDue: false });
  });

  it("runs due reconciliation in the dedicated coverage execution", () => {
    expect(olxCoverageExecutionSchedule({
      coverageOnly: true,
      suppressBackground: false,
      now,
      state: {},
      hasRegionalFilters: true,
      regionalIntervalSeconds: 60,
      htmlIntervalSeconds: 60,
      privateIntervalSeconds: 90,
    })).toEqual({ regionalDue: true, htmlDue: true, privateDue: true });
  });

  it("keeps exact realtime targets out of a coverage-only execution", () => {
    const targets = [
      { observationTarget: "city:121" },
      { observationTarget: "region:21" },
    ];
    const directKeys = new Set(["city:121"]);

    expect(partitionOlxExecutionTargets(targets, directKeys, false)).toEqual({
      directTargets: [targets[0]],
      regionalTargets: [targets[1]],
    });
    expect(partitionOlxExecutionTargets(targets, directKeys, true)).toEqual({
      directTargets: [],
      regionalTargets: [targets[1]],
    });
  });
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
