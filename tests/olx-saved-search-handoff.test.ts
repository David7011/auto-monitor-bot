import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedListing } from "@amb/shared";
import type { SourceSearchContext } from "../apps/worker/src/collectors/base.js";
import * as feed from "../apps/worker/src/collectors/olx-feed.js";
import { OlxCollector } from "../apps/worker/src/collectors/olx.js";
import { env } from "../apps/worker/src/env.js";

vi.mock("../apps/worker/src/lib/log.js", () => ({ log: { info: vi.fn(async () => {}), warn: vi.fn(async () => {}) } }));

const context: SourceSearchContext = {
  source: "OLX", categoryKey: "vehicle.car", categorySchemaVersion: 1,
  sourceCategoryId: 108, plannerVersion: 6, categoryCriteria: {}, unknownPolicy: "MAX_COVERAGE",
  shadowMode: false, fingerprint: "handoff", filterIds: ["filter"], models: [], bodyTypes: [],
  fuelTypes: [], gearboxes: [], driveTypes: [], colors: [], regions: [], cities: [], keywords: [],
  excludeKeywords: [], freshnessMode: "ALL_TIME", initialWindowBehavior: "SKIP_EXISTING",
  maxInitialWindowNotifications: 0,
};

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("OLX saved search progressive handoff", () => {
  it.each([false, true])("hands off before the next page waits or fails (blocked=%s), preserving dedupe and budget", async (blocked) => {
    vi.useFakeTimers();
    const scanAt = new Date("2026-10-12T21:00:00Z");
    vi.setSystemTime(scanAt);
    vi.spyOn(feed, "savedOlxSearchUrls").mockReturnValue(["https://www.olx.ua/first/", "https://www.olx.ua/second/"]);
    vi.spyOn(env, "OLX_FRESHNESS_HEDGE_ENABLED", "get").mockReturnValue(false);
    const ad = (id: string) => ({ id, url: `https://www.olx.ua/d/test-ID${id}.html`, createdTime: scanAt.toISOString() });
    vi.spyOn(feed, "fetchOlxFeed").mockImplementation(async (_api, url, primary, _channel, observationTarget) => ({
      primary, url, observationTarget, channel: "OLX_PUBLIC_HTML", requestCount: 1, ads: [ad("known")], parsedAt: new Date(),
    }));
    const handedOff: NormalizedListing[] = [];
    vi.spyOn(feed, "fetchOlxHtmlFeed").mockImplementation(async (url, primary, channel, observationTarget) => {
      const metadata = { url, primary, channel: channel!, observationTarget: observationTarget!, requestCount: 1 };
      if (url.endsWith("first/")) {
        vi.setSystemTime(new Date(scanAt.getTime() + 100));
        return { ...metadata, parsedAt: new Date(), ads: [ad("1"), ad("1")] };
      }
      // A later page must not delay durable admission of a ready first page.
      expect(handedOff.map(item => item.externalId)).toEqual(["1"]);
      vi.setSystemTime(new Date(scanAt.getTime() + 5_100));
      return blocked
        ? { ...metadata, blocked: { rateLimited: true } }
        : { ...metadata, parsedAt: new Date(), ads: [ad("1"), ad("2"), ad("3")] };
    });
    const result = await new OlxCollector().collect(context, {
      id: "state", fingerprint: "handoff", knownExternalIds: new Set(["known"]),
    }, {
      lane: "REALTIME", maxPages: 1, maxCandidates: 2, deadlineAt: new Date(scanAt.getTime() + 30_000),
      onHotCandidates: async (items) => { handedOff.push(...items); },
    });
    expect(handedOff.map(item => item.externalId)).toEqual(blocked ? ["1"] : ["1", "2"]);
    expect(result.listings.map(item => item.externalId).sort()).toEqual(blocked ? ["1"] : ["1", "2"]);
    expect(handedOff[0]!.hotCandidateAt!.getTime() - handedOff[0]!.parsedAt!.getTime()).toBe(0);
    expect(handedOff[0]!.firstSeenAt).toEqual(scanAt);
    expect(result.requestCount).toBe(3);
  });
});
