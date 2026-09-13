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
  it.each([
    ["engineVolume", "engineVolumeFrom", 2],
    ["enginePower", "enginePowerFrom", 100],
    ["doors", "doorsFrom", 4],
    ["seats", "seatsFrom", 4],
    ["mileage", "mileageFrom", 100],
    ["year", "yearFrom", 2000],
    ["priceNormalized", "priceFrom", 1000],
  ] as const)("distinguishes missing, mismatching and matching %s", (field, constraint, threshold) => {
    const configured = filter({ [constraint]: threshold });
    expect(evaluateListingFilter(listing({ [field]: undefined }), configured)).toMatchObject({ outcome: "UNKNOWN", matched: false, provisional: true });
    expect(evaluateListingFilter(listing({ [field]: threshold - 1 }), configured).outcome).toBe("NO_MATCH");
    expect(evaluateListingFilter(listing({ [field]: threshold }), configured).outcome).toBe("MATCH");
  });

  it.each(["STRICT", "MAX_COVERAGE"] as const)("does not authorize a vehicle with unknown attributes under %s", (unknownPolicy) => {
    expect(evaluateListingFilter(listing(), filter({ unknownPolicy, engineVolumeFrom: 2 }))).toMatchObject({ outcome: "UNKNOWN", matched: false });
  });

  it.each([
    ["customsCleared", true], ["bargainPossible", false],
  ] as const)("does not confuse missing %s with false", (field, expected) => {
    expect(evaluateListingFilter(listing({ [field]: undefined }), filter({ [field]: expected })).outcome).toBe("UNKNOWN");
    expect(evaluateListingFilter(listing({ [field]: !expected }), filter({ [field]: expected })).outcome).toBe("NO_MATCH");
    expect(evaluateListingFilter(listing({ [field]: expected }), filter({ [field]: expected })).outcome).toBe("MATCH");
  });

  it("defers unknown currency instead of comparing the raw price against USD bounds", () => {
    expect(evaluateListingFilter(listing({ priceNormalized: undefined, priceOriginal: 8500, currencyOriginal: "UAH" }), filter()).outcome).toBe("UNKNOWN");
    expect(evaluateListingFilter(listing({ priceNormalized: undefined, priceOriginal: 8500, currencyOriginal: "USD" }), filter()).outcome).toBe("MATCH");
  });

  it("defers absent vehicle enums but rejects a proven contradiction", () => {
    expect(evaluateListingFilter(listing(), filter({ fuelTypes: ["diesel"] })).outcome).toBe("UNKNOWN");
    expect(evaluateListingFilter(listing({ fuelType: "Бензин" }), filter({ fuelTypes: ["diesel"] })).outcome).toBe("NO_MATCH");
    expect(evaluateListingFilter(listing({ fuelType: "Дизель" }), filter({ fuelTypes: ["diesel"] })).outcome).toBe("MATCH");
  });

  it("distinguishes absent geography from a proven different city", () => {
    expect(evaluateListingFilter(listing({ city: undefined, region: undefined }), filter({ cities: ["Київ"] })).outcome).toBe("UNKNOWN");
    expect(evaluateListingFilter(listing(), filter({ cities: ["Київ"] })).outcome).toBe("NO_MATCH");
  });

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
      "REQUIRED_KEYWORD",
    ]));
    expect(result.unknownReasons.join(" ")).toContain("MILEAGE");
  });

  it("explains an empty active-filter set", () => {
    const result = matchFiltersDetailed(listing(), []);
    expect(result.matched).toEqual([]);
    expect(result.rejectionReasons).toEqual(["NO_ENABLED_FILTERS"]);
  });
});
