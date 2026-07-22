import { describe, expect, it } from "vitest";
import type { NormalizedListing } from "@amb/shared";
import {
  deserializeNormalizedListing,
  serializeNormalizedListing,
} from "../apps/worker/src/modules/observation-journal";

describe("observation journal serialization", () => {
  it("round-trips normalized data and excludes the large raw source payload", () => {
    const publishedAt = new Date("2026-07-14T08:00:00.000Z");
    const listing: NormalizedListing = {
      source: "OLX",
      externalId: "123",
      url: "https://www.olx.ua/d/uk/obyavlenie/test-ID123.html",
      canonicalUrl: "https://www.olx.ua/d/uk/obyavlenie/test-ID123.html",
      title: "BMW X5",
      brand: "BMW",
      model: "X5",
      year: 2015,
      priceOriginal: 420_000,
      currencyOriginal: "UAH",
      priceNormalized: 9_400,
      city: "Самар",
      region: "Дніпропетровська область",
      photoUrls: ["https://example.test/photo.jpg"],
      publishedAt,
      timestampConfidence: "HIGH",
      firstSeenAt: new Date("2026-07-14T08:00:05.000Z"),
      observationChannel: "OLX_HTML_COVERAGE",
      observationTarget: "region:21;city:121;page:1;owner:all",
      raw: { huge: "source payload" },
    };

    const serialized = serializeNormalizedListing(listing);
    expect(JSON.stringify(serialized)).not.toContain("source payload");

    const restored = deserializeNormalizedListing(serialized);
    expect(restored).not.toBeNull();
    expect(restored).toMatchObject({
      source: "OLX",
      externalId: "123",
      brand: "BMW",
      model: "X5",
      year: 2015,
      priceNormalized: 9_400,
      city: "Самар",
      observationChannel: "OLX_HTML_COVERAGE",
      observationTarget: "region:21;city:121;page:1;owner:all",
    });
    expect(restored?.publishedAt?.toISOString()).toBe(publishedAt.toISOString());
  });
});
