import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAutoRiaPublicSearchUrl,
  parseAutoRiaPublicCards,
  savedAutoRiaSearchUrls,
  AutoRiaPublicCollector,
} from "../apps/worker/src/collectors/auto-ria-public.js";
import { sourceHttpClient } from "../apps/worker/src/collectors/source-http-client.js";
import { env } from "../apps/worker/src/env.js";
import type { SourceSearchContext } from "../apps/worker/src/collectors/base.js";

const context = {
  source: "AUTO_RIA",
  categoryKey: "vehicle.car",
  categorySchemaVersion: 1,
  plannerVersion: 1,
  categoryCriteria: {},
  unknownPolicy: "MAX_COVERAGE",
  shadowMode: false,
  fingerprint: "public-test",
  filterIds: ["filter-1"],
  models: [], bodyTypes: [], fuelTypes: [], gearboxes: [], driveTypes: [], colors: [],
  yearFrom: 1990,
  priceTo: 10_000,
  regions: ["dnipropetrovska"],
  cities: [], keywords: [], excludeKeywords: [],
  freshnessMode: "LAST_24_HOURS",
  initialWindowBehavior: "SKIP_EXISTING",
  maxInitialWindowNotifications: 50,
} satisfies SourceSearchContext;

describe("AUTO.RIA public search", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    env.AUTO_RIA_SAVED_SEARCH_URLS = "";
  });

  it("continues bounded backfill past known promoted cards and keeps realtime to one page", async () => {
    const body = (id: number) => '"advertisementCard":' + JSON.stringify({ data: {
      id, type: "Auto", link: `/auto_test_${id}.html`, title: { content: "Toyota Camry 2018" },
    } });
    const request = vi.spyOn(sourceHttpClient, "text").mockImplementation(async (url) => ({
      requestId: "test", status: 200, classification: "SUCCESS", contentType: "text/html",
      body: body(Number(new URL(url).searchParams.get("page")) === 0 ? 123 : 456),
    }));
    const state = { id: "test", fingerprint: "test", knownExternalIds: new Set(["123"]) };
    const collector = new AutoRiaPublicCollector();
    const result = await collector.collect(context, state, {
      lane: "BACKFILL", maxPages: 2, maxCandidates: 50, deadlineAt: new Date(Date.now() + 20_000),
    });
    expect(result.listings.map((listing) => listing.externalId)).toEqual(["456"]);
    expect(result.pageCount).toBe(2);
    expect(result.limited).toBe(true);
    request.mockClear();
    await collector.collect(context, state, {
      lane: "REALTIME", maxPages: 3, maxCandidates: 50, deadlineAt: new Date(Date.now() + 20_000),
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("uses a bounded newest-first public query without a credential", () => {
    const url = new URL(buildAutoRiaPublicSearchUrl(context));
    expect(url.origin + url.pathname).toBe("https://auto.ria.com/uk/search/");
    expect(url.searchParams.get("sort[0].order")).toBe("dates.created.desc");
    expect(url.searchParams.get("year[0].gte")).toBe("1990");
    expect(url.searchParams.get("price.USD.lte")).toBe("10000");
    expect(url.searchParams.get("region.id[0]")).toBe("11");
    expect(url.search).not.toContain("api_key");
  });

  it("extracts query cards, excludes recommendation widgets, and deduplicates IDs", () => {
    const auto = { data: { id: 123, type: "Auto", link: "/auto_test_123.html", title: { content: "Toyota Camry 2018" } } };
    const widget = { data: { id: 999, type: "UsedAuto", link: "/auto_widget_999.html", title: { content: "Widget" } } };
    const html = [auto, widget, auto]
      .map((card) => `"advertisementCard":${JSON.stringify(card)}`)
      .join("\n");
    expect(parseAutoRiaPublicCards(html)).toEqual({ cards: [auto.data], malformedCount: 0 });
  });

  it("reports malformed card state rather than treating it as a valid empty feed", () => {
    expect(parseAutoRiaPublicCards('"advertisementCard":{"data":{"id":1,"type":"Auto"}}')).toEqual({
      cards: [],
      malformedCount: 1,
    });
  });

  it("parses user-saved search URLs, ignoring junk", () => {
    expect(savedAutoRiaSearchUrls("")).toEqual([]);
    expect(savedAutoRiaSearchUrls("  , not-a-url,")).toEqual([]);
    expect(
      savedAutoRiaSearchUrls("https://auto.ria.com/uk/search/?a=1, https://auto.ria.com/uk/search/?b=2 ,junk"),
    ).toEqual(["https://auto.ria.com/uk/search/?a=1", "https://auto.ria.com/uk/search/?b=2"]);
  });

  it("unions built and saved searches with cross-page dedup", async () => {
    env.AUTO_RIA_SAVED_SEARCH_URLS = "https://saved.test/sedan,https://saved.test/wagon";
    const card = (id: number) => '"advertisementCard":' + JSON.stringify({ data: {
      id, type: "Auto", link: `/auto_test_${id}.html`, title: { content: `Car ${id} 2010` },
    } });
    const request = vi.spyOn(sourceHttpClient, "text").mockImplementation(async (url) => ({
      requestId: "test", status: 200, classification: "SUCCESS", contentType: "text/html",
      body: url.includes("saved.test/sedan") ? `${card(111)}\n${card(222)}`
        : url.includes("saved.test/wagon") ? `${card(222)}\n${card(333)}`
        : card(111),
    }));
    const state = { id: "test", fingerprint: "test", knownExternalIds: new Set<string>() };
    const collector = new AutoRiaPublicCollector();
    const result = await collector.collect(context, state, {
      lane: "REALTIME", maxPages: 1, maxCandidates: 50, deadlineAt: new Date(Date.now() + 20_000),
    });
    expect(result.listings.map((listing) => listing.externalId)).toEqual(["111", "222", "333"]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(result.pageCount).toBe(3);
    expect(result.requestCount).toBe(3);
  });

  it("stops saved pages once the candidate budget is spent", async () => {
    env.AUTO_RIA_SAVED_SEARCH_URLS = "https://saved.test/sedan,https://saved.test/wagon";
    const card = (id: number) => '"advertisementCard":' + JSON.stringify({ data: {
      id, type: "Auto", link: `/auto_test_${id}.html`, title: { content: `Car ${id} 2010` },
    } });
    const request = vi.spyOn(sourceHttpClient, "text").mockImplementation(async (url) => ({
      requestId: "test", status: 200, classification: "SUCCESS", contentType: "text/html",
      body: url.includes("saved.test") ? `${card(222)}\n${card(333)}` : card(111),
    }));
    const state = { id: "test", fingerprint: "test", knownExternalIds: new Set<string>() };
    const collector = new AutoRiaPublicCollector();
    const result = await collector.collect(context, state, {
      lane: "REALTIME", maxPages: 1, maxCandidates: 2, deadlineAt: new Date(Date.now() + 20_000),
    });
    expect(result.listings.map((listing) => listing.externalId)).toEqual(["111", "222"]);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
