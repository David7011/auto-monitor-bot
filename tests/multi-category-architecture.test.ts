import { describe, expect, it } from "vitest";
import type { Filter } from "../packages/db/src/generated/prisma/client.js";
import {
  CATEGORY_PROFILES,
  MARKETPLACE_CATEGORY_KEYS,
  sourceSupportsCategory,
  validateCategoryAttributes,
  effectiveFilterSignature,
  filtersMateriallyOverlap,
} from "../packages/shared/src/index.js";
import { normalizeOlxAd } from "../apps/worker/src/collectors/olx-normalization.js";
import { assessOlxParserHealth, buildOlxFeedTargets } from "../apps/worker/src/collectors/olx-feed.js";
import { evaluateListingFilter } from "../apps/worker/src/modules/filter-engine.js";
import { compileSourceSearchPlan } from "../apps/worker/src/modules/source-search-plan.js";
import { initialMessageText } from "../apps/worker/src/modules/telegram-listing-format.js";
import { countProcessingResult } from "../apps/worker/src/processors/collector-run-helpers.js";

const now = new Date("2026-09-04T09:00:00.000Z");

describe("multi-category architecture", () => {
  it("registers every required category with a versioned profile", () => {
    expect(Object.keys(CATEGORY_PROFILES).sort()).toEqual([...MARKETPLACE_CATEGORY_KEYS].sort());
    for (const profile of Object.values(CATEGORY_PROFILES)) {
      expect(profile.schemaVersion).toBe(1);
      expect(profile.supportedSources.length).toBeGreaterThan(0);
    }
  });

  it("validates and strips untrusted category JSON", () => {
    const valid = validateCategoryAttributes("electronics.laptop", {
      cpu: "Ryzen 5 6600U",
      ramGb: 16,
      arbitraryUrl: "https://attacker.invalid",
    });
    expect(valid).toEqual({
      success: true,
      attributes: { cpu: "Ryzen 5 6600U", ramGb: 16 },
      errors: [],
    });
    const invalid = validateCategoryAttributes("electronics.laptop", { ramGb: "sixteen" });
    expect(invalid.success).toBe(false);
    expect(invalid.attributes).toEqual({});
  });

  it("does not route electronics filters to vehicle-only sources", () => {
    expect(sourceSupportsCategory("OLX", "electronics.laptop")).toBe(true);
    expect(sourceSupportsCategory("AUTO_RIA", "electronics.laptop")).toBe(false);
    expect(sourceSupportsCategory("RST", "electronics.phone")).toBe(false);
    expect(sourceSupportsCategory("AUTO_RIA", "vehicle.car")).toBe(true);
  });

  it("keeps filter hygiene category-aware", () => {
    const car = makeFilter("car", "vehicle.car");
    const laptop = makeFilter("laptop", "electronics.laptop");
    expect(effectiveFilterSignature(car)).not.toBe(effectiveFilterSignature(laptop));
    expect(filtersMateriallyOverlap(car, laptop)).toBe(false);
  });

  it("normalizes laptop and phone fast attributes without detail HTTP", () => {
    const laptop = normalizeOlxAd(ad("HP EliteBook 845 G9 Ryzen 5 6600U 16GB RAM SSD 512GB"), now, "electronics.laptop");
    expect(laptop?.categoryKey).toBe("electronics.laptop");
    expect(laptop?.brand).toBe("HP");
    expect(laptop?.enginePower).toBeUndefined();
    expect(laptop?.priceNormalized).toBeUndefined();
    expect(laptop?.categoryAttributes).toMatchObject({ ramGb: 16, storageGb: 512 });
    expect(String(laptop?.categoryAttributes?.cpu)).toMatch(/Ryzen 5 6600U/i);

    const phone = normalizeOlxAd(ad("Apple iPhone 13 128GB АКБ 87%"), now, "electronics.phone");
    expect(phone?.categoryAttributes).toMatchObject({ storageGb: 128, batteryHealthPercent: 87 });
    const generic = normalizeOlxAd(ad("Редкий товар"), now, "generic");
    expect(generic?.categoryAttributes).toEqual({});
  });

  it("keeps missing electronics attributes as UNKNOWN instead of a silent reject", () => {
    const filter = makeFilter("laptop", "electronics.laptop", { minRamGb: 16 });
    const listing = normalizeOlxAd(ad("HP EliteBook 845 G9"), now, "electronics.laptop")!;
    const evaluation = evaluateListingFilter(listing, filter);
    expect(evaluation.outcome).toBe("UNKNOWN");
    expect(evaluation.matched).toBe(true);
    expect(evaluation.provisional).toBe(true);
    expect(evaluation.unknownReasons.join(" ")).toMatch(/RAM unavailable/);
  });

  it("compares electronics budgets in UAH without changing the automotive USD contract", () => {
    const listing = normalizeOlxAd(ad("HP EliteBook"), now, "electronics.laptop")!;
    listing.priceNormalized = 450;
    expect(evaluateListingFilter(listing, makeFilter("laptop", "electronics.laptop", {}, { priceTo: 1000 })).outcome).toBe("NO_MATCH");
    expect(evaluateListingFilter(listing, makeFilter("laptop", "electronics.laptop", {}, { priceTo: 20000 })).outcome).toBe("MATCH");
    expect(evaluateListingFilter({ ...listing, currencyOriginal: "EUR" }, makeFilter("laptop", "electronics.laptop", {}, { priceTo: 20000 })).outcome).toBe("UNKNOWN");
    expect(evaluateListingFilter({ ...listing, categoryKey: "vehicle.car" }, makeFilter("car", "vehicle.car", {}, { priceTo: 1000 })).outcome).toBe("MATCH");
  });

  it("keeps contradictory RAM and malformed battery/storage attributes unknown", () => {
    const listing = normalizeOlxAd(ad("HP EliteBook 8GB RAM; upgraded RAM 16GB"), now, "electronics.laptop")!;
    expect(listing.categoryAttributes?.ramGb).toBeUndefined();
    expect(evaluateListingFilter(listing, makeFilter("laptop", "electronics.laptop", { minRamGb: 16 })).outcome).toBe("UNKNOWN");
    expect(validateCategoryAttributes("electronics.phone", { batteryHealthPercent: 120 }).success).toBe(false);
    expect(validateCategoryAttributes("electronics.laptop", { storageType: "invalid" }).success).toBe(false);
    expect(validateCategoryAttributes("electronics.laptop", []).success).toBe(false);
  });

  it("matches GPU criteria against the GPU profile model field", () => {
    const listing = normalizeOlxAd(ad("RTX 3060 12GB"), now, "electronics.component.gpu")!;
    expect(evaluateListingFilter(listing, makeFilter("gpu", "electronics.component.gpu", { gpuIncludes: ["RTX 3060"], minVramGb: 12 })).outcome).toBe("MATCH");
  });

  it("rejects a proven category mismatch but not a malformed unknown value", () => {
    const filter = makeFilter("laptop", "electronics.laptop", { minRamGb: 16 });
    const tooSmall = normalizeOlxAd(ad("HP EliteBook 8GB RAM SSD 256GB"), now, "electronics.laptop")!;
    expect(evaluateListingFilter(tooSmall, filter).outcome).toBe("NO_MATCH");
    const phone = normalizeOlxAd(ad("iPhone 13 128GB"), now, "electronics.phone")!;
    expect(evaluateListingFilter(phone, filter).reasons).toContain("CATEGORY");
  });

  it("compiles N filters into one deterministic discovery per category", () => {
    const laptops = Array.from({ length: 10 }, (_, index) => makeFilter(`laptop-${index}`, "electronics.laptop"));
    const car = makeFilter("car", "vehicle.car");
    const forward = compileSourceSearchPlan("OLX", [...laptops, car], now);
    const reversed = compileSourceSearchPlan("OLX", [car, ...laptops].reverse(), now);
    expect(forward).toHaveLength(2);
    expect(forward[0]?.categoryKey).toBe("vehicle.car");
    expect(forward.map((item) => item.fingerprint)).toEqual(reversed.map((item) => item.fingerprint));
    expect(forward.find((item) => item.categoryKey === "electronics.laptop")?.filterIds).toHaveLength(10);
    expect(compileSourceSearchPlan("AUTO_RIA", laptops, now)).toEqual([]);
  });

  it("keeps the vehicle shard first under a synthetic multi-category filter load", () => {
    const olxCategories = MARKETPLACE_CATEGORY_KEYS.filter((categoryKey) =>
      sourceSupportsCategory("OLX", categoryKey));
    const filters = olxCategories.flatMap((categoryKey) =>
      Array.from({ length: 100 }, (_, index) => makeFilter(`${categoryKey}-${index}`, categoryKey)));
    const plan = compileSourceSearchPlan("OLX", filters, now);

    expect(plan).toHaveLength(olxCategories.length);
    expect(plan[0]?.categoryKey).toBe("vehicle.car");
    expect(new Set(plan.map((context) => context.categoryKey)).size).toBe(plan.length);
    for (const context of plan) expect(context.filterIds).toHaveLength(100);
  });

  it("isolates category fingerprints and preserves nationwide geography", () => {
    const nationwide = makeFilter("all-laptops", "electronics.laptop");
    const city = makeFilter("city-laptops", "electronics.laptop", {}, { regions: ["dnipropetrovska"], cities: ["dnipro"] });
    const car = makeFilter("all-cars", "vehicle.car");
    const plan = compileSourceSearchPlan("OLX", [city, nationwide, car], now);
    const laptop = plan.find((item) => item.categoryKey === "electronics.laptop")!;
    const vehicle = plan.find((item) => item.categoryKey === "vehicle.car")!;
    expect(laptop.regions).toEqual([]);
    expect(laptop.cities).toEqual([]);
    expect(laptop.fingerprint).not.toBe(vehicle.fingerprint);
  });

  it("builds category-owned OLX HTML targets and never falls back to the car category", () => {
    const context = compileSourceSearchPlan("OLX", [makeFilter("laptop", "electronics.laptop")], now)[0]!;
    const [target] = buildOlxFeedTargets(context, 1, [{}], { pageSize: 50, includePrivateFeed: false });
    expect(target?.htmlUrl).toContain("/elektronika/noutbuki-i-aksesuary/noutbuki/");
    expect(target?.apiUrl).not.toContain("category_id=108");
    expect(target?.observationTarget).toContain("category:electronics.laptop");
  });

  it("does not certify coverage when a HTTP 200 body has lost OLX structure", () => {
    expect(assessOlxParserHealth("<html><body>ok</body></html>", []).status).toBe("DEGRADED");
    const healthy = assessOlxParserHealth(
      '<div data-cy="l-card" id="123"><a href="/d/uk/obyavlenie/test-ID123.html">item</a></div>',
      [{ id: "123", url: "https://www.olx.ua/d/uk/obyavlenie/test-ID123.html" }],
    );
    expect(healthy.status).toBe("HEALTHY");
  });

  it("formats electronics without vehicle-only placeholders", () => {
    const message = initialMessageText({
      id: "laptop-1",
      source: "OLX",
      categoryKey: "electronics.laptop",
      categorySchemaVersion: 1,
      categoryAttributes: { cpu: "Ryzen 5 6600U", ramGb: 16, storageGb: 512 },
      url: "https://www.olx.ua/d/uk/obyavlenie/laptop-ID1.html",
      title: "HP EliteBook 845 G9",
      brand: "HP",
      model: "EliteBook 845 G9",
      bodyType: null,
      fuelType: null,
      gearbox: null,
      driveType: null,
      engineVolume: null,
      year: null,
      priceNormalized: null,
      priceOriginal: 18_000,
      currencyOriginal: "UAH",
      mileage: null,
      city: "Дніпро",
      region: null,
      publishedAt: now,
      firstSeenAt: now,
      timestampConfidence: "EXACT",
      discoveryLane: "REALTIME",
      vin: null,
      plateNormalized: null,
      rawData: {},
    });
    expect(message).toContain("НОВОЕ — НОУТБУК");
    expect(message).toContain("RAM: 16 ГБ");
    expect(message).not.toMatch(/VIN|Проверка авто/);
  });

  it("counts shadow matches as accepted evidence without a Telegram dispatch", () => {
    expect(countProcessingResult({
      outcome: "SHADOWED",
      listingId: "listing-1",
      matchedFilterIds: ["laptop"],
      rejectionReasons: [],
    })).toEqual({ matched: 1, rejected: 0, duplicate: 0, dispatched: 0, accepted: 1 });
  });
});

function ad(title: string) {
  return {
    id: title,
    title,
    url: `https://www.olx.ua/d/uk/obyavlenie/test-${encodeURIComponent(title)}.html`,
    createdTime: now.toISOString(),
    price: { regularPrice: { value: 18_000, currencyCode: "UAH" } },
    photos: [],
  };
}

function makeFilter(
  id: string,
  categoryKey: string,
  categoryCriteria: Record<string, unknown> = {},
  overrides: Partial<Filter> = {},
): Filter {
  return {
    id,
    name: id,
    enabled: true,
    categoryKey,
    categorySchemaVersion: 1,
    categoryCriteria,
    unknownPolicy: "MAX_COVERAGE",
    shadowMode: false,
    sources: [],
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
    freshnessMode: "ALL_TIME",
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
