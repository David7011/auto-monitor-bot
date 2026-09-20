import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceSearchContext } from "../apps/worker/src/collectors/base.js";
import * as feed from "../apps/worker/src/collectors/olx-feed.js";
import { OlxCollector, selectOlxCandidates } from "../apps/worker/src/collectors/olx.js";
import { olxLaneArbiter } from "../apps/worker/src/modules/olx-lane-arbiter.js";

afterEach(() => vi.restoreAllMocks());

const context: SourceSearchContext = {
  source: "OLX",
  categoryKey: "vehicle.car",
  categorySchemaVersion: 1,
  sourceCategoryId: 108,
  plannerVersion: 6,
  categoryCriteria: {},
  unknownPolicy: "MAX_COVERAGE",
  shadowMode: false,
  fingerprint: "recovery-isolation",
  filterIds: ["test-filter"],
  models: [], bodyTypes: [], fuelTypes: [], gearboxes: [], driveTypes: [], colors: [],
  regions: [], cities: [], keywords: [], excludeKeywords: [],
  freshnessMode: "ALL_TIME",
  initialWindowBehavior: "SKIP_EXISTING",
  maxInitialWindowNotifications: 0,
};

describe("OLX realtime isolation from historical recovery", () => {
  it("persists page 1→2→3 progress when each realtime cycle grants one deep-page slot", async () => {
    const requestedPages: number[] = [];
    const boundaryIds = new Set(Array.from({ length: 50 }, (_, index) => `3-${index}`));
    vi.spyOn(feed, "fetchOlxFeed").mockImplementation(async (_api, url, primary, _channel, observationTarget) => {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      requestedPages.push(page);
      return {
        primary, url, observationTarget, requestCount: 1, channel: "OLX_PUBLIC_HTML" as const,
        ads: Array.from({ length: 50 }, (_, index) => ({
          id: `${page}-${index}`,
          url: `https://www.olx.ua/d/test-ID${page}-${index}.html`,
          createdTime: "2026-09-20T10:00:00Z",
        })),
      };
    });

    let progressPage = 1;
    for (const expectedPage of [1, 2, 3]) {
      const slotSpy = vi.spyOn(olxLaneArbiter, "waitForBackfillWindow")
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const result = await new OlxCollector().collect(context, {
        id: "state", fingerprint: context.fingerprint,
        coverageRecoveryPending: true,
        coverageRecoveryCutoffAt: new Date("2026-09-01T00:00:00Z"),
        recoveryProgressPage: progressPage,
        knownExternalIds: new Set(),
        coverageAnchorExternalIds: boundaryIds,
      }, {
        lane: "BACKFILL", recovery: true, maxPages: 20, maxCandidates: 1_000,
        deadlineAt: new Date(Date.now() + 90_000),
      });
      expect(result.coverageVerified).toBe(expectedPage === 3);
      expect(result.recoveryProgressPage).toBe(expectedPage + 1);
      expect(result.recoveryOverlapPage).toBe(expectedPage);
      expect(result.recoveryOverlapExternalIds).toContain(`${expectedPage}-0`);
      progressPage = result.recoveryProgressPage!;
      slotSpy.mockRestore();
    }
    expect(requestedPages).toEqual([1, 2, 3]);
  });

  it("stops realtime at the current known tail while historical anchors remain outside the current page", async () => {
    const ids = Array.from({ length: 50 }, (_, index) => String(index + 100));
    const fetch = vi.spyOn(feed, "fetchOlxFeed").mockImplementation(async (_api, url, primary, _channel, observationTarget) => ({
      primary, url, observationTarget, requestCount: 1, channel: "OLX_PUBLIC_HTML",
      ads: ids.map((id) => ({ id, url: `https://www.olx.ua/d/test-ID${id}.html`, createdTime: "2026-09-01T10:00:00Z" })),
    }));
    const hotHandoff = vi.fn(async () => {});
    const result = await new OlxCollector().collect(context, {
      id: "state", fingerprint: context.fingerprint,
      coverageRecoveryPending: true,
      knownExternalIds: new Set(ids),
      coverageAnchorExternalIds: new Set(["old-offline-anchor"]),
    }, {
      lane: "REALTIME", maxPages: 3, maxCandidates: 100,
      deadlineAt: new Date(Date.now() + 30_000), onHotCandidates: hotHandoff,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ pageCount: 1, listings: [], coverageGap: false, coverageVerificationMethod: "KNOWN_TAIL" });
    expect(hotHandoff).not.toHaveBeenCalled();
    expect(result.coverageMetrics?.freshnessHedgeRequests).toBe(0);
  });

  it("skips normalization of journaled recovery items without mistaking them for frozen historical proof", () => {
    const result = selectOlxCandidates([
      { id: "recent-known", url: "https://www.olx.ua/d/test-ID1.html", createdTime: "2026-09-01T10:00:00Z" },
    ], {
      now: new Date("2026-09-01T11:00:00Z"),
      knownExternalIds: new Set(["recent-known"]),
      continuityKnownExternalIds: new Set(["old-offline-anchor"]),
      maxCandidates: 100,
    });
    expect(result).toMatchObject({ listings: [], allKnown: false, knownTailStreak: 0, knownEncountered: false });
    expect(result.scannedExternalIds).toEqual(["recent-known"]);
  });

  it("accepts a genuine frozen anchor even when newer journaled IDs are also present", () => {
    const result = selectOlxCandidates([
      { id: "recent-known", url: "https://www.olx.ua/d/test-ID1.html", createdTime: "2026-09-01T10:00:00Z" },
      { id: "old-offline-anchor", url: "https://www.olx.ua/d/test-ID2.html", createdTime: "2026-08-01T10:00:00Z" },
    ], {
      now: new Date("2026-09-01T11:00:00Z"),
      knownExternalIds: new Set(["recent-known", "old-offline-anchor"]),
      continuityKnownExternalIds: new Set(["old-offline-anchor"]),
      maxCandidates: 100,
    });
    expect(result).toMatchObject({ listings: [], allKnown: false, knownTailStreak: 1, knownEncountered: true });
  });
});
