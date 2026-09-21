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
  it.each([1, 10, 49, 50, 51])(
    "does not advance durable recovery beyond an only partially ingested page (budget %i)",
    async (maxCandidates) => {
      vi.spyOn(olxLaneArbiter, "waitForBackfillWindow").mockResolvedValue(true);
      vi.spyOn(feed, "fetchOlxFeed").mockImplementation(async (_api, url, primary, _channel, observationTarget) => ({
        primary, url, observationTarget, requestCount: 1, channel: "OLX_PUBLIC_HTML" as const,
        ads: Array.from({ length: 50 }, (_, index) => ({
          id: `budget-${index}`,
          url: `https://www.olx.ua/d/test-IDbudget-${index}.html`,
          createdTime: "2026-09-20T10:00:00Z",
        })),
      }));

      const result = await new OlxCollector().collect(context, {
        id: "state", fingerprint: context.fingerprint,
        coverageRecoveryPending: true,
        coverageRecoveryCutoffAt: new Date("2026-09-01T00:00:00Z"),
        recoveryProgressPage: 1,
        knownExternalIds: new Set(),
        coverageAnchorExternalIds: new Set(),
      }, {
        lane: "BACKFILL", recovery: true, maxPages: 1, maxCandidates,
        deadlineAt: new Date(Date.now() + 90_000),
      });

      expect(result.listings).toHaveLength(Math.min(50, maxCandidates));
      expect(result.coverageVerified).toBe(false);
      if (maxCandidates < 50) {
        expect(result.recoveryProgressPage).toBe(1);
        expect(result.recoveryOverlapPage).toBeUndefined();
        expect(result.recoveryNoProgressReason).toBe("CANDIDATE_BUDGET_EXHAUSTED");
      } else {
        expect(result.recoveryProgressPage).toBe(2);
        expect(result.recoveryOverlapPage).toBe(1);
      }
    },
  );

  it("replays a partially journaled page after crashes without omitting its remaining candidates", async () => {
    vi.spyOn(olxLaneArbiter, "waitForBackfillWindow").mockResolvedValue(true);
    vi.spyOn(feed, "fetchOlxFeed").mockImplementation(async (_api, url, primary, _channel, observationTarget) => ({
      primary, url, observationTarget, requestCount: 1, channel: "OLX_PUBLIC_HTML" as const,
      ads: Array.from({ length: 50 }, (_, index) => ({
        id: `crash-${index}`,
        url: `https://www.olx.ua/d/test-IDcrash-${index}.html`,
        createdTime: "2026-09-20T10:00:00Z",
      })),
    }));
    const known = new Set<string>();
    const collect = () => new OlxCollector().collect(context, {
      id: "state", fingerprint: context.fingerprint,
      coverageRecoveryPending: true,
      coverageRecoveryCutoffAt: new Date("2026-09-01T00:00:00Z"),
      recoveryProgressPage: 1,
      knownExternalIds: known,
      coverageAnchorExternalIds: new Set(),
    }, {
      lane: "BACKFILL" as const, recovery: true, maxPages: 1, maxCandidates: 10,
      deadlineAt: new Date(Date.now() + 90_000),
    });

    const beforeJournalCrash = await collect();
    const replayBeforeJournal = await collect();
    expect(replayBeforeJournal.listings.map((item) => item.externalId))
      .toEqual(beforeJournalCrash.listings.map((item) => item.externalId));
    expect(replayBeforeJournal.recoveryProgressPage).toBe(1);

    for (const item of beforeJournalCrash.listings) known.add(item.externalId);
    let last = beforeJournalCrash;
    while (known.size < 50) {
      last = await collect();
      for (const item of last.listings) known.add(item.externalId);
      if (known.size < 50) expect(last.recoveryProgressPage).toBe(1);
    }
    expect([...known]).toHaveLength(50);
    expect(last.recoveryProgressPage).toBe(2);
    expect(last.recoveryOverlapPage).toBe(1);
  });

  it.each([
    ["insertion", (ids: string[]) => ["new-head", ...ids]],
    ["deletion", (ids: string[]) => ids.filter((id) => id !== "1")],
    ["reorder", (ids: string[]) => {
      const changed = [...ids];
      [changed[50], changed[51]] = [changed[51]!, changed[50]!];
      return changed;
    }],
    ["promoted relocation", (ids: string[]) => ["150", ...ids.filter((id) => id !== "150")]],
  ] as const)("refuses VERIFIED when a %s changes mutable offset continuity", async (_case, mutate) => {
    let upstreamIds = Array.from({ length: 151 }, (_, index) => String(index + 1));
    const requestedPages: number[] = [];
    vi.spyOn(olxLaneArbiter, "waitForBackfillWindow").mockResolvedValue(true);
    vi.spyOn(feed, "fetchOlxFeed").mockImplementation(async (_api, url, primary, _channel, observationTarget) => {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      requestedPages.push(page);
      const offset = (page - 1) * 50;
      return {
        primary, url, observationTarget, requestCount: 1, channel: "OLX_PUBLIC_HTML" as const,
        ads: upstreamIds.slice(offset, offset + 50).map((id) => ({
          id,
          url: `https://www.olx.ua/d/test-ID${id}.html`,
          createdTime: "2026-09-20T10:00:00Z",
        })),
      };
    });
    const anchors = new Set(Array.from({ length: 10 }, (_, index) => String(142 + index)));
    const run = (state: { progress: number; overlapPage?: number; overlap?: string[] }) => new OlxCollector().collect(context, {
      id: "state", fingerprint: context.fingerprint,
      coverageRecoveryPending: true,
      coverageRecoveryCutoffAt: new Date("2026-09-01T00:00:00Z"),
      recoveryProgressPage: state.progress,
      recoveryOverlapPage: state.overlapPage,
      recoveryOverlapExternalIds: new Set(state.overlap ?? []),
      knownExternalIds: new Set(),
      coverageAnchorExternalIds: anchors,
    }, {
      lane: "BACKFILL" as const, recovery: true, maxPages: 1, maxCandidates: 1_000,
      deadlineAt: new Date(Date.now() + 90_000),
    });

    const first = await run({ progress: 1 });
    const second = await run({
      progress: first.recoveryProgressPage!,
      overlapPage: first.recoveryOverlapPage,
      overlap: first.recoveryOverlapExternalIds,
    });
    upstreamIds = mutate(upstreamIds);
    const third = await run({
      progress: second.recoveryProgressPage!,
      overlapPage: second.recoveryOverlapPage,
      overlap: second.recoveryOverlapExternalIds,
    });

    expect(requestedPages).toEqual([1, 2, 1, 3, 2]);
    expect(third.coverageVerified).toBe(false);
    expect(third.coverageUnresolvedReason).toBe("UNSTABLE_PAGINATION");
    expect(third.recoveryProgressPage).toBe(3);
  });

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
    let overlapPage: number | undefined;
    let overlapEvidence: string[] | undefined;
    for (const expectedPage of [1, 2, 3]) {
      const slotSpy = vi.spyOn(olxLaneArbiter, "waitForBackfillWindow")
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const result = await new OlxCollector().collect(context, {
        id: "state", fingerprint: context.fingerprint,
        coverageRecoveryPending: true,
        coverageRecoveryCutoffAt: new Date("2026-09-01T00:00:00Z"),
        recoveryProgressPage: progressPage,
        recoveryOverlapPage: overlapPage,
        recoveryOverlapExternalIds: new Set(overlapEvidence ?? []),
        knownExternalIds: new Set(),
        coverageAnchorExternalIds: boundaryIds,
      }, {
        lane: "BACKFILL", recovery: true, maxPages: 20, maxCandidates: 1_000,
        deadlineAt: new Date(Date.now() + 90_000),
      });
      expect(result.coverageVerified).toBe(expectedPage === 3);
      expect(result.recoveryProgressPage).toBe(expectedPage + 1);
      expect(result.recoveryOverlapPage).toBe(expectedPage);
      expect(result.recoveryOverlapExternalIds?.join("\n")).toContain(`${expectedPage}-0`);
      progressPage = result.recoveryProgressPage!;
      overlapPage = result.recoveryOverlapPage;
      overlapEvidence = result.recoveryOverlapExternalIds;
      slotSpy.mockRestore();
    }
    expect(requestedPages).toEqual([1, 2, 1, 3, 2]);
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
