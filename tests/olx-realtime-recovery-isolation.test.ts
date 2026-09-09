import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceSearchContext } from "../apps/worker/src/collectors/base.js";
import * as feed from "../apps/worker/src/collectors/olx-feed.js";
import { OlxCollector, selectOlxCandidates } from "../apps/worker/src/collectors/olx.js";

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
