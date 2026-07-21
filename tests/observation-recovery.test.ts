import { describe, expect, it } from "vitest";
import { reconstructObservationListing } from "../apps/worker/src/modules/observation-recovery.js";

describe("observation recovery", () => {
  it("rebuilds a filterable listing for every source from journal columns", () => {
    const listing = reconstructObservationListing({
      source: "AUTO_RIA",
      externalId: "123",
      url: "https://auto.ria.com/uk/auto_bmw_x5_123.html",
      canonicalUrl: null,
      title: "BMW X5",
      brand: "BMW",
      model: "X5",
      year: 2018,
      priceNormalized: 32_000,
      engineVolume: 3,
      mileage: 120_000,
      city: "Дніпро",
      region: "Дніпропетровська область",
      publishedAt: new Date("2026-07-14T10:00:00.000Z"),
      refreshedAt: null,
      timestampConfidence: "HIGH",
      skipReason: null,
      firstSeenAt: new Date("2026-07-14T10:00:10.000Z"),
    });

    expect(listing.source).toBe("AUTO_RIA");
    expect(listing.brand).toBe("BMW");
    expect(listing.priceNormalized).toBe(32_000);
    expect(listing.canonicalUrl).toContain("auto.ria.com");
    expect(listing.raw).toMatchObject({ recoveredFromObservationJournal: true });
  });
});
