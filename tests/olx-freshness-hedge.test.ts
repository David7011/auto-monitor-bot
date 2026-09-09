import { describe, expect, it } from "vitest";
import {
  newestOlxVisibilityAt,
  planOlxFreshnessHedge,
} from "../apps/worker/src/collectors/olx-freshness-hedge.js";

const now = new Date("2026-09-03T20:30:00.000Z");

describe("OLX freshness hedge", () => {
  it("uses the newest creation or refresh timestamp as the public visibility signal", () => {
    expect(newestOlxVisibilityAt([
      { id: 1, createdTime: "2026-09-03T20:10:00Z", lastRefreshTime: "2026-09-03T20:26:00Z" },
      { id: 2, createdTime: "2026-09-03T20:20:00Z" },
    ])?.toISOString()).toBe("2026-09-03T20:26:00.000Z");
  });

  it("runs once for an externally aged realtime response and then respects the interval", () => {
    const base = {
      enabled: true,
      lane: "REALTIME" as const,
      page: 1,
      protectionCooling: false,
      primaryAvailable: true,
      now,
      deadlineAt: new Date(now.getTime() + 8_000),
      minimumRemainingMs: 1_000,
      newestPrimaryVisibleAt: new Date(now.getTime() - 10 * 60_000),
      primaryCacheAgeSeconds: 600,
      staleAfterSeconds: 180,
      intervalSeconds: 60,
    };
    expect(planOlxFreshnessHedge(base)).toMatchObject({ run: true, reason: "DUE_STALE_INDEX", primaryAgeSeconds: 600 });
    expect(planOlxFreshnessHedge({ ...base, lastAttemptAt: new Date(now.getTime() - 30_000) }))
      .toMatchObject({ run: false, reason: "INTERVAL" });
    for (const primaryCacheAgeSeconds of [undefined, 0, 20, Number.NaN]) {
      expect(planOlxFreshnessHedge({ ...base, primaryCacheAgeSeconds }))
        .toMatchObject({ run: false, reason: "NO_STALE_RESPONSE_EVIDENCE" });
    }
  });

  it("never adds traffic during protection, backfill, a fresh index or a tight deadline", () => {
    const base = {
      enabled: true,
      lane: "REALTIME" as const,
      page: 1,
      protectionCooling: false,
      primaryAvailable: true,
      now,
      deadlineAt: new Date(now.getTime() + 8_000),
      minimumRemainingMs: 1_000,
      newestPrimaryVisibleAt: new Date(now.getTime() - 60_000),
      staleAfterSeconds: 180,
      intervalSeconds: 60,
    };
    expect(planOlxFreshnessHedge(base).reason).toBe("INDEX_FRESH");
    expect(planOlxFreshnessHedge({ ...base, protectionCooling: true }).reason).toBe("PROTECTION_COOLING");
    expect(planOlxFreshnessHedge({ ...base, lane: "BACKFILL" }).reason).toBe("NOT_REALTIME");
    expect(planOlxFreshnessHedge({ ...base, deadlineAt: new Date(now.getTime() + 500) }).reason).toBe("DEADLINE");
    expect(planOlxFreshnessHedge({ ...base, suppressedUntil: new Date(now.getTime() + 60_000) }).reason).toBe("BACKOFF");
  });
});
