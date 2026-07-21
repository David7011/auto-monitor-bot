import { describe, expect, it } from "vitest";
import type { Filter } from "@amb/db";
import { buildSearchContextFromFilter } from "../apps/worker/src/modules/source-search-plan.js";

describe("source search plan", () => {
  it("keeps context fingerprint stable while freshness cursor moves", () => {
    const filter = testFilter({
      autoRiaMarkId: 9,
      autoRiaModelId: 87,
      brand: "Toyota",
      model: "Camry",
      freshnessMode: "LAST_24_HOURS",
    });

    const first = buildSearchContextFromFilter("AUTO_RIA", filter, new Date("2026-07-10T08:00:00.000Z"));
    const second = buildSearchContextFromFilter("AUTO_RIA", filter, new Date("2026-07-10T09:00:00.000Z"));

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.publishedAfter?.toISOString()).not.toBe(second.publishedAfter?.toISOString());
    expect(first.filterIds).toEqual(["filter-1"]);
    expect(first.models).toEqual(["Camry"]);
  });

  it("keeps OLX geography in the public feed fingerprint", () => {
    const first = buildSearchContextFromFilter("OLX", testFilter({ id: "one", keywords: ["BMW"] }));
    const second = buildSearchContextFromFilter("OLX", testFilter({ id: "two", keywords: ["Toyota"], cities: ["Дніпро"] }));
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("does not spend a second AUTO.RIA search for local-only keyword differences", () => {
    const base = { autoRiaMarkId: 9, autoRiaModelId: 87, brand: "Toyota", model: "Camry" };
    const first = buildSearchContextFromFilter("AUTO_RIA", testFilter({ ...base, keywords: ["торг"] }));
    const second = buildSearchContextFromFilter("AUTO_RIA", testFilter({ ...base, keywords: ["власник"] }));
    expect(first.fingerprint).toBe(second.fingerprint);
  });
});

function testFilter(overrides: Partial<Filter> = {}): Filter {
  return {
    id: "filter-1",
    name: "Test filter",
    enabled: true,
    sources: ["AUTO_RIA"],
    autoRiaCategoryId: 1,
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
    yearFrom: null,
    yearTo: null,
    priceFrom: null,
    priceTo: null,
    mileageFrom: null,
    mileageTo: null,
    regions: [],
    cities: [],
    keywords: [],
    excludeKeywords: [],
    createdAt: new Date("2026-07-10T00:00:00.000Z"),
    updatedAt: new Date("2026-07-10T00:00:00.000Z"),
    ...overrides,
  };
}
