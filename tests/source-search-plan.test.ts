import { describe, expect, it } from "vitest";
import type { Filter } from "@amb/db";
import {
  buildSearchContextFromFilter,
  contextForCoverageRecovery,
  coverageVerificationHasDurableEvidence,
  mergeOlxFilterGeography,
  planCoverageRecovery,
  rotateKnownExternalIds,
  sameDiscoveryScope,
} from "../apps/worker/src/modules/source-search-plan.js";

describe("source search plan", () => {
  it("inherits only an equivalent legacy car scope, never a different category or AUTO.RIA mark", () => {
    const car = buildSearchContextFromFilter("OLX", testFilter({}));
    const legacy = { source: "OLX", regions: car.regions, cities: car.cities };
    expect(sameDiscoveryScope(legacy, car)).toBe(true);
    expect(sameDiscoveryScope(legacy, { ...car, categoryKey: "electronics.laptop", sourceCategoryId: undefined, sourceCategoryPath: "/uk/elektronika/" })).toBe(false);
    const ria = buildSearchContextFromFilter("AUTO_RIA", testFilter({ autoRiaMarkId: 9 }));
    const riaQuery = JSON.parse(JSON.stringify(ria));
    expect(sameDiscoveryScope(riaQuery, ria)).toBe(true);
    expect(sameDiscoveryScope({ ...riaQuery, autoRiaMarkId: 79 }, ria)).toBe(false);
  });
  it("accepts cutoff recovery only when a durable observed timestamp reaches the boundary", () => {
    const cutoff = new Date("2026-09-01T08:00:00.000Z");

    expect(coverageVerificationHasDurableEvidence(
      "CUTOFF",
      new Date("2026-09-01T07:59:59.000Z"),
      cutoff,
    )).toBe(true);
    expect(coverageVerificationHasDurableEvidence(
      "CUTOFF",
      new Date("2026-09-01T08:00:01.000Z"),
      cutoff,
    )).toBe(false);
    expect(coverageVerificationHasDurableEvidence("CUTOFF", undefined, cutoff)).toBe(false);
    expect(coverageVerificationHasDurableEvidence("KNOWN_TAIL", undefined, cutoff)).toBe(true);
    expect(coverageVerificationHasDurableEvidence("EXHAUSTED", undefined, cutoff)).toBe(false);
  });

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

  it("does not close a historical pending window from a recent realtime overlap", () => {
    const cutoff = new Date("2026-09-01T08:00:00.000Z");
    expect(coverageVerificationHasDurableEvidence("KNOWN_TAIL", undefined, cutoff, {
      lane: "REALTIME", existingRecoveryPending: true,
    })).toBe(false);
    expect(coverageVerificationHasDurableEvidence("KNOWN_TAIL", undefined, cutoff, {
      lane: "BACKFILL", existingRecoveryPending: true,
    })).toBe(true);
    expect(coverageVerificationHasDurableEvidence("KNOWN_TAIL", undefined, cutoff, {
      lane: "REALTIME", existingRecoveryPending: false,
    })).toBe(true);
  });

  it("does not reopen the full freshness history after every known-ID rotation", () => {
    const options = {
      source: "OLX" as const, lane: "REALTIME" as const,
      now: new Date("2026-09-01T10:00:00.000Z"),
      lastSuccessfulScanAt: new Date("2026-09-01T09:59:30.000Z"),
      currentPending: false, coverageGap: false, knownIdsReset: true,
      contextCutoffAt: new Date("2026-08-31T10:00:00.000Z"),
      outageDetectionSeconds: 120, lookbackHours: 24, safetyOverlapSeconds: 300,
    };
    expect(planCoverageRecovery(options).requiredCutoffAt)
      .toEqual(new Date("2026-09-01T09:54:30.000Z"));
    expect(planCoverageRecovery({ ...options, currentPending: true,
      currentCutoffAt: new Date("2026-08-31T09:00:00.000Z"),
    }).requiredCutoffAt).toEqual(new Date("2026-08-31T09:00:00.000Z"));
    expect(planCoverageRecovery({ ...options, lastSuccessfulScanAt: undefined }).requiredCutoffAt)
      .toEqual(options.contextCutoffAt);
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

  it("keeps an all-Ukraine OLX filter wider than a city filter", () => {
    expect(mergeOlxFilterGeography([
      { regions: [], cities: [] },
      { regions: ["dnipropetrovska"], cities: ["dnipro"] },
    ])).toEqual({ regions: [], cities: [] });
  });

  it("keeps a region-wide OLX filter wider than another city filter", () => {
    expect(mergeOlxFilterGeography([
      { regions: ["dnipropetrovska"], cities: [] },
      { regions: ["kyivska"], cities: ["kyiv"] },
    ])).toEqual({
      regions: ["dnipropetrovska", "kyivska"],
      cities: [],
    });
  });

  it("merges city scopes when every OLX filter is city-specific", () => {
    expect(mergeOlxFilterGeography([
      { regions: ["dnipropetrovska"], cities: ["dnipro"] },
      { regions: ["kyivska"], cities: ["kyiv"] },
    ])).toEqual({
      regions: ["dnipropetrovska", "kyivska"],
      cities: ["dnipro", "kyiv"],
    });
  });

  it("resets the OLX known-ID cache exactly when it reaches 2000 unique entries", () => {
    const existing = new Set(Array.from({ length: 1_999 }, (_, index) => `olx-${index}`));

    const belowThreshold = rotateKnownExternalIds("OLX", ["olx-1998"], existing, 2_000);
    expect(belowThreshold.reset).toBe(false);
    expect(belowThreshold.knownExternalIds).toHaveLength(1_999);

    const atThreshold = rotateKnownExternalIds("OLX", ["olx-1999"], existing, 2_000);
    expect(atThreshold).toEqual({
      knownExternalIds: [],
      coverageAnchorExternalIds: ["olx-1999", ...Array.from({ length: 49 }, (_, index) => `olx-${index}`)],
      mergedCount: 2_000,
      reset: true,
    });
  });

  it("does not apply the OLX cache reset policy to another source", () => {
    const existing = new Set(Array.from({ length: 1_999 }, (_, index) => `rst-${index}`));
    const result = rotateKnownExternalIds("RST", ["rst-1999"], existing, 2_000);

    expect(result.reset).toBe(false);
    expect(result.knownExternalIds).toHaveLength(2_000);
    expect(result.coverageAnchorExternalIds).toEqual([]);
  });

  it("widens only OLX backfill to a pending outage-recovery cutoff", () => {
    const userCutoff = new Date("2026-07-27T00:00:00.000Z");
    const outageCutoff = new Date("2026-07-26T19:25:00.000Z");
    const context = {
      ...buildSearchContextFromFilter(
        "OLX",
        testFilter({ sources: ["OLX"], freshnessMode: "TODAY" }),
        new Date("2026-07-27T09:00:00.000Z"),
      ),
      publishedAfter: userCutoff,
    };
    const state = {
      id: "state-1",
      fingerprint: context.fingerprint,
      knownExternalIds: new Set<string>(),
      coverageRecoveryPending: true,
      coverageRecoveryCutoffAt: outageCutoff,
    };

    expect(contextForCoverageRecovery(context, state, "REALTIME").publishedAfter).toEqual(userCutoff);
    expect(contextForCoverageRecovery(context, state, "BACKFILL").publishedAfter).toEqual(outageCutoff);
  });

  it("opens an offline window from the persisted pre-shutdown boundary with a safety overlap", () => {
    const boundary = new Date("2026-09-01T01:00:00.000Z");
    const plan = planCoverageRecovery({
      source: "OLX",
      lane: "REALTIME",
      now: new Date("2026-09-01T10:00:00.000Z"),
      lastSuccessfulScanAt: boundary,
      currentPending: false,
      coverageGap: false,
      knownIdsReset: false,
      outageDetectionSeconds: 120,
      lookbackHours: 24,
      safetyOverlapSeconds: 300,
    });

    expect(plan).toEqual({
      outageDetected: true,
      requested: true,
      reason: "OFFLINE_WINDOW",
      persistedBoundaryAt: boundary,
      requiredCutoffAt: new Date("2026-09-01T00:55:00.000Z"),
    });
  });

  it("durably requests recovery for realtime overflow even without an outage", () => {
    const boundary = new Date("2026-09-01T09:59:30.000Z");
    const plan = planCoverageRecovery({
      source: "OLX",
      lane: "REALTIME",
      now: new Date("2026-09-01T10:00:00.000Z"),
      lastSuccessfulScanAt: boundary,
      currentPending: false,
      coverageGap: true,
      knownIdsReset: false,
      outageDetectionSeconds: 120,
      lookbackHours: 24,
      safetyOverlapSeconds: 300,
    });

    expect(plan.reason).toBe("REALTIME_OVERFLOW");
    expect(plan.requested).toBe(true);
    expect(plan.requiredCutoffAt).toEqual(new Date("2026-09-01T09:54:30.000Z"));
  });

  it("never narrows an already pending recovery cutoff", () => {
    const existingCutoff = new Date("2026-09-01T00:30:00.000Z");
    const plan = planCoverageRecovery({
      source: "OLX",
      lane: "BACKFILL",
      now: new Date("2026-09-01T10:00:00.000Z"),
      lastSuccessfulScanAt: new Date("2026-09-01T09:59:30.000Z"),
      currentPending: true,
      currentCutoffAt: existingCutoff,
      coverageGap: false,
      knownIdsReset: false,
      outageDetectionSeconds: 120,
      lookbackHours: 24,
      safetyOverlapSeconds: 300,
    });

    expect(plan.outageDetected).toBe(false);
    expect(plan.requiredCutoffAt).toEqual(existingCutoff);
  });

  it("does not invent an offline window on the first scan", () => {
    const plan = planCoverageRecovery({
      source: "OLX",
      lane: "REALTIME",
      now: new Date("2026-09-01T10:00:00.000Z"),
      currentPending: false,
      coverageGap: false,
      knownIdsReset: false,
      outageDetectionSeconds: 120,
      lookbackHours: 24,
      safetyOverlapSeconds: 300,
    });

    expect(plan.requested).toBe(false);
    expect(plan.persistedBoundaryAt).toBeNull();
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
