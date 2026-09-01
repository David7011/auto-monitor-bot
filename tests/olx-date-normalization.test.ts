import { describe, expect, it } from "vitest";
import { isFreshListing } from "../packages/shared/src/utils/freshness.js";
import { protectionPauseSeconds } from "../packages/shared/src/utils/jitter.js";
import {
  buildOlxFeedTargets,
  extractRenderedOlxCards,
  normalizeOlxAd,
  olxApiFeedUrls,
  parseRenderedCardDate,
  selectOlxCandidates,
  shouldStopOlxRealtimePage,
  type OlxAd,
} from "../apps/worker/src/collectors/olx.js";
import type { SourceSearchContext } from "../apps/worker/src/collectors/base.js";

function searchContext(overrides: Partial<SourceSearchContext> = {}): SourceSearchContext {
  return {
    source: "OLX",
    fingerprint: "test",
    filterIds: ["filter-1"],
    models: [],
    bodyTypes: [],
    fuelTypes: [],
    gearboxes: [],
    driveTypes: [],
    colors: [],
    regions: [],
    cities: [],
    keywords: [],
    excludeKeywords: [],
    freshnessMode: "TODAY",
    initialWindowBehavior: "NOTIFY_MATCHING_IN_WINDOW",
    maxInitialWindowNotifications: 25,
    ...overrides,
  };
}

function ad(overrides: Partial<OlxAd>): OlxAd {
  return {
    id: "olx-1",
    title: "Volkswagen Golf 2016",
    url: "https://www.olx.ua/d/uk/obyavlenie/test-ID123.html",
    createdTime: "2026-07-10T08:00:00.000Z",
    lastRefreshTime: "2026-07-10T09:00:00.000Z",
    price: { regularPrice: { value: 8000, currencyCode: "USD" } },
    ...overrides,
  };
}

describe("OLX date normalization", () => {
  const now = new Date("2026-07-10T10:00:00.000Z");

  it("uses createdTime as publishedAt and accepts a listing created today", () => {
    const listing = normalizeOlxAd(ad({}), now);
    expect(listing?.publishedAt?.toISOString()).toBe("2026-07-10T08:00:00.000Z");
    expect(listing?.refreshedAt?.toISOString()).toBe("2026-07-10T09:00:00.000Z");
    expect(listing?.timestampConfidence).toBe("HIGH");
    expect(isFreshListing(listing?.publishedAt, "TODAY", now)).toBe(true);
  });

  it("does not treat an old listing refreshed today as fresh", () => {
    const listing = normalizeOlxAd(
      ad({
        createdTime: "2026-06-10T08:00:00.000Z",
        lastRefreshTime: "2026-07-10T09:00:00.000Z",
      }),
      now,
    );
    expect(listing?.publishedAt?.toISOString()).toBe("2026-06-10T08:00:00.000Z");
    expect(listing?.refreshedAt?.toISOString()).toBe("2026-07-10T09:00:00.000Z");
    expect(isFreshListing(listing?.publishedAt, "TODAY", now)).toBe(false);
  });

  it("marks missing createdTime as unknown and not fresh", () => {
    const listing = normalizeOlxAd(ad({ createdTime: undefined }), now);
    expect(listing?.publishedAt).toBeUndefined();
    expect(listing?.timestampConfidence).toBe("UNKNOWN");
    expect(listing?.skipReason).toBe("UNKNOWN_PUBLICATION_DATE");
    expect(isFreshListing(listing?.publishedAt, "TODAY", now)).toBe(false);
  });

  it("marks invalid createdTime as invalid and not fresh", () => {
    const listing = normalizeOlxAd(ad({ createdTime: "broken-date" }), now);
    expect(listing?.publishedAt).toBeUndefined();
    expect(listing?.timestampConfidence).toBe("UNKNOWN");
    expect(listing?.skipReason).toBe("INVALID_PUBLICATION_DATE");
    expect(isFreshListing(listing?.publishedAt, "TODAY", now)).toBe(false);
  });

  it("reads the explicit OLX customs flag instead of guessing from description text", () => {
    const listing = normalizeOlxAd(ad({ params: [{ key: "cleared_customs", normalizedValue: "yes" }] }), now);
    expect(listing?.customsCleared).toBe(true);
  });
});

describe("OLX fast feed URLs", () => {
  it("extracts cards rendered by the website but missing from the JSON index", () => {
    const cards = extractRenderedOlxCards(`
      <div data-cy="l-card" id="929999999" class="card">
        <a href="/d/uk/obyavlenie/test-ID123.html?search_reason=search&amp;page=1">
          <h4>Renault &amp; Dacia</h4>
        </a>
        <p data-testid="ad-price">320 000 грн.</p>
        <p data-testid="location-date">Дніпро, Центральний - 05 серпня 2026 р.</p>
        <span>2016 120 тис.км.</span><span>1.6 л.</span><span>Механічна</span><span>Бензин</span>
        <img src="https://example.test/car.jpg" alt="car">
      </div>
    `);

    expect(cards).toEqual([expect.objectContaining({
      id: "929999999",
      title: "Renault & Dacia",
      url: "https://www.olx.ua/d/uk/obyavlenie/test-ID123.html?search_reason=search&page=1",
      createdTime: "2026-08-05T09:00:00.000Z",
      location: { cityName: "Дніпро" },
      price: { regularPrice: { value: 320000, currencyCode: "UAH" } },
      photos: ["https://example.test/car.jpg"],
      htmlCardOnly: true,
    })]);
    expect(cards[0]?.params).toEqual(expect.arrayContaining([
      { key: "motor_year", value: "2016" },
      { key: "motor_mileage_thou", value: "120" },
      { key: "engine_size", value: "1.6" },
    ]));
  });

  it("normalizes Ukrainian relative card dates in the Kyiv timezone", () => {
    const now = new Date("2026-08-19T17:30:00.000Z");
    expect(parseRenderedCardDate("Сьогодні о 16:20", now)?.toISOString()).toBe("2026-08-19T13:20:00.000Z");
    expect(parseRenderedCardDate("Вчора о 23:05", now)?.toISOString()).toBe("2026-08-18T20:05:00.000Z");
  });

  it("builds separate fast API feeds for Dnipro and Samar", () => {
    const urls = olxApiFeedUrls(
      searchContext({
        regions: ["dnipropetrovska"],
        cities: ["dnipro", "katottg-ua12100070010038698"],
      }),
      2,
      { pageSize: 40, includePrivateFeed: false },
    );

    expect(urls).toHaveLength(2);
    expect(urls.map((value) => new URL(value).searchParams.get("city_id"))).toEqual(["121", "316"]);
    expect(urls.every((value) => new URL(value).searchParams.get("offset") === "40")).toBe(true);
  });

  it("computes the page offset from the configured page size", () => {
    const urls = olxApiFeedUrls(searchContext(), 3, { pageSize: 50, includePrivateFeed: false });

    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).searchParams.get("offset")).toBe("100");
    expect(new URL(urls[0]!).searchParams.get("limit")).toBe("50");
  });

  it("adds an exact vehicle query when a source context is unambiguous", () => {
    const urls = olxApiFeedUrls(
      searchContext({ fingerprint: "test-query", brand: "BMW", models: ["X5"] }),
      1,
      { pageSize: 40, includePrivateFeed: false },
    );

    expect(new URL(urls[0]!).searchParams.get("query")).toBe("BMW X5");
  });

  it("adds a private-sellers feed variant when the private feed is enabled", () => {
    const targets = buildOlxFeedTargets(searchContext(), 1, [{}], {
      pageSize: 50,
      includePrivateFeed: true,
    });

    expect(targets).toHaveLength(2);
    expect(new URL(targets[0]!.apiUrl).searchParams.get("owner_type")).toBeNull();
    expect(targets[0]!.privateOnly).toBe(false);
    expect(new URL(targets[1]!.apiUrl).searchParams.get("owner_type")).toBe("private");
    expect(new URL(targets[1]!.htmlUrl).searchParams.get("search[private_business]")).toBe("private");
    expect(targets[1]!.privateOnly).toBe(true);
  });
});

describe("OLX mixed promoted feed", () => {
  it("continues past an old promoted advert and keeps fresh adverts below it", () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    const result = selectOlxCandidates([
      ad({ id: "old-top", createdTime: "2026-06-10T08:00:00.000Z" }),
      ad({ id: "fresh", createdTime: "2026-07-10T09:59:00.000Z" }),
    ], {
      now,
      publishedAfter: new Date("2026-07-10T00:00:00.000Z"),
      knownExternalIds: new Set(),
      maxCandidates: 10,
    });

    expect(result.observedCount).toBe(2);
    expect(result.cutoffEncountered).toBe(true);
    expect(result.fullyBeforeCutoff).toBe(false);
    expect(shouldStopOlxRealtimePage(false, result.fullyBeforeCutoff)).toBe(false);
    expect(result.knownTailStreak).toBe(0);
    expect(result.knownEncountered).toBe(false);
    expect(result.listings.map((listing) => listing.externalId)).toEqual(["fresh"]);
    expect(result.scannedExternalIds).toEqual(["old-top", "fresh"]);
  });

  it("reports overlap with already-known adverts so pagination can stop", () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    const result = selectOlxCandidates([
      ad({ id: "new-1", createdTime: "2026-07-10T09:59:00.000Z" }),
      ad({ id: "known-1", createdTime: "2026-07-10T09:00:00.000Z" }),
    ], {
      now,
      knownExternalIds: new Set(["known-1"]),
      maxCandidates: 10,
      observationChannel: "OLX_HTML_COVERAGE",
      observationTarget: "region:21;city:121;page:1;owner:all",
      requestStartedAt: new Date("2026-07-10T09:59:58.000Z"),
      firstByteAt: new Date("2026-07-10T09:59:58.200Z"),
      hotCandidateAt: new Date("2026-07-10T09:59:58.250Z"),
    });

    expect(result.knownEncountered).toBe(true);
    expect(result.knownTailStreak).toBe(1);
    expect(result.allKnown).toBe(false);
    expect(result.observedCount).toBe(2);
    expect(result.listings.map((listing) => listing.externalId)).toEqual(["new-1"]);
    expect(result.listings[0]).toMatchObject({
      observationChannel: "OLX_HTML_COVERAGE",
      observationTarget: "region:21;city:121;page:1;owner:all",
      requestStartedAt: new Date("2026-07-10T09:59:58.000Z"),
      firstByteAt: new Date("2026-07-10T09:59:58.200Z"),
      hotCandidateAt: new Date("2026-07-10T09:59:58.250Z"),
    });
  });

  it("does not report overlap when every advert is new (window overflow)", () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    const result = selectOlxCandidates([
      ad({ id: "new-1", createdTime: "2026-07-10T09:59:00.000Z" }),
      ad({ id: "new-2", createdTime: "2026-07-10T09:58:00.000Z" }),
    ], {
      now,
      knownExternalIds: new Set(["known-1"]),
      maxCandidates: 10,
    });

    expect(result.knownEncountered).toBe(false);
    expect(result.listings).toHaveLength(2);
  });

  it("marks the cutoff complete only when the whole identifiable page is older", () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    const result = selectOlxCandidates([
      ad({ id: "old-1", createdTime: "2026-07-09T23:59:00.000Z" }),
      ad({ id: "old-2", createdTime: "2026-07-09T20:00:00.000Z" }),
    ], {
      now,
      publishedAfter: new Date("2026-07-10T00:00:00.000Z"),
      knownExternalIds: new Set(),
      maxCandidates: 10,
    });

    expect(result.cutoffEncountered).toBe(true);
    expect(result.fullyBeforeCutoff).toBe(true);
    expect(shouldStopOlxRealtimePage(false, result.fullyBeforeCutoff)).toBe(true);
    expect(result.listings).toEqual([]);
    expect(result.scannedExternalIds).toEqual(["old-1", "old-2"]);
  });

  it("does not hide fresh overflow when the candidate limit is reached", () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    const result = selectOlxCandidates([
      ad({ id: "fresh-1", createdTime: "2026-07-10T09:59:00.000Z" }),
      ad({ id: "fresh-2", createdTime: "2026-07-10T09:58:00.000Z" }),
    ], {
      now,
      publishedAfter: new Date("2026-07-10T00:00:00.000Z"),
      knownExternalIds: new Set(),
      maxCandidates: 1,
    });

    expect(result.listings.map((listing) => listing.externalId)).toEqual(["fresh-1"]);
    expect(result.candidateLimitReached).toBe(true);
    expect(result.fullyBeforeCutoff).toBe(false);
    expect(result.scannedExternalIds).toEqual(["fresh-1"]);
  });
});

describe("source protection pauses", () => {
  it("honors the Retry-After hint and clamps it to at least 30 seconds", () => {
    expect(protectionPauseSeconds({ retryAfterSeconds: 12, consecutiveErrors: 0, baseSeconds: 90, maxSeconds: 900 })).toBe(30);
    expect(protectionPauseSeconds({ retryAfterSeconds: 240, consecutiveErrors: 5, baseSeconds: 90, maxSeconds: 900 })).toBe(240);
    expect(protectionPauseSeconds({ retryAfterSeconds: 5000, consecutiveErrors: 0, baseSeconds: 90, maxSeconds: 900 })).toBe(900);
  });

  it("grows exponentially with consecutive protection incidents", () => {
    expect(protectionPauseSeconds({ consecutiveErrors: 0, baseSeconds: 90, maxSeconds: 900 })).toBe(90);
    expect(protectionPauseSeconds({ consecutiveErrors: 1, baseSeconds: 90, maxSeconds: 900 })).toBe(180);
    expect(protectionPauseSeconds({ consecutiveErrors: 2, baseSeconds: 90, maxSeconds: 900 })).toBe(360);
    expect(protectionPauseSeconds({ consecutiveErrors: 6, baseSeconds: 90, maxSeconds: 900 })).toBe(900);
    expect(protectionPauseSeconds({ consecutiveErrors: 6, baseSeconds: 90, maxSeconds: 600 })).toBe(600);
  });
});
