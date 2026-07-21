import { describe, expect, it } from "vitest";
import type { Filter } from "@amb/db";
import type { NormalizedListing } from "@amb/shared";
import {
  evaluateListingFilter,
  matchFiltersDetailed,
} from "../apps/worker/src/modules/filter-engine";

const now = new Date();

function filter(overrides: Partial<Filter> = {}): Filter {
  return {
    id: "filter-1",
    name: "Боевой фильтр",
    enabled: true,
    sources: ["OLX"],
    autoRiaCategoryId: null,
    autoRiaMarkId: null,
    autoRiaModelId: null,
    brand: null,
    model: null,
    modelNames: [],
    generation: null,
    bodyTypes: [],
    fuelTypes: [],
    gearboxes: [],
    driveTypes: [],
    colors: [],
    engineVolumeFrom: null,
    engineVolumeTo: null,
    enginePowerFrom: null,
    enginePowerTo: null,
    doorsFrom: null,
    doorsTo: null,
    seatsFrom: null,
    seatsTo: null,
    conditions: [],
    customsCleared: null,
    bargainPossible: null,
    freshnessMode: "TODAY",
    yearFrom: 2000,
    yearTo: 2026,
    priceFrom: 1_000,
    priceTo: 10_000,
    mileageFrom: null,
    mileageTo: 450_000,
    regions: [],
    cities: [],
    keywords: [],
    excludeKeywords: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function listing(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    source: "OLX",
    externalId: "olx-1",
    url: "https://www.olx.ua/d/uk/obyavlenie/test-ID1.html",
    canonicalUrl: "https://www.olx.ua/d/uk/obyavlenie/test-ID1.html",
    title: "BMW X5 2010",
    brand: "BMW",
    model: "X5",
    year: 2010,
    priceNormalized: 8_500,
    mileage: 220_000,
    city: "Дніпро",
    region: "Дніпропетровська область",
    photoUrls: [],
    publishedAt: now,
    timestampConfidence: "HIGH",
    firstSeenAt: now,
    raw: {},
    ...overrides,
  };
}

describe("explainable filter engine", () => {
  it("returns no rejection reasons for a matching listing", () => {
    const result = evaluateListingFilter(listing(), filter());
    expect(result.matched).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("records every material rejection reason", () => {
    const result = evaluateListingFilter(
      listing({ source: "RST", year: 1995, priceNormalized: 14_000, mileage: undefined }),
      filter({ brand: "Audi", keywords: ["quattro"] }),
    );

    expect(result.matched).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "SOURCE",
      "BRAND",
      "YEAR",
      "PRICE",
      "MILEAGE",
      "REQUIRED_KEYWORD",
    ]));
  });

  it("explains an empty active-filter set", () => {
    const result = matchFiltersDetailed(listing(), []);
    expect(result.matched).toEqual([]);
    expect(result.rejectionReasons).toEqual(["NO_ENABLED_FILTERS"]);
  });
});
