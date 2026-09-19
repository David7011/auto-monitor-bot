import { describe, expect, it } from "vitest";
import { FUEL_TYPE_OPTIONS, findAttributeValue } from "../packages/shared/src/utils/vehicle-attributes.js";
import { decodeHtmlEntities, parseEngineVolume } from "../apps/worker/src/collectors/html-utils.js";
import { autoMotoListingIsInFreshnessWindow, parseDayOnlyDate } from "../apps/worker/src/collectors/automoto.js";
import { isReliableFreshListing } from "../packages/shared/src/utils/freshness.js";

describe("fuel classification", () => {
  it("classifies dual-fuel 'газ / бензин' as gas, not gasoline", () => {
    expect(findAttributeValue("газ / бензин", FUEL_TYPE_OPTIONS)).toBe("gas");
  });

  it("still classifies plain бензин as gasoline", () => {
    expect(findAttributeValue("Бензин", FUEL_TYPE_OPTIONS)).toBe("gasoline");
  });

  it("classifies ГБО as gas", () => {
    expect(findAttributeValue("ГБО", FUEL_TYPE_OPTIONS)).toBe("gas");
  });
});

describe("parseEngineVolume", () => {
  it("does not misread horsepower 'л.с.' as engine volume", () => {
    expect(parseEngineVolume("Бензин, 150 л.с.")).toBeUndefined();
  });

  it("parses a litre volume", () => {
    expect(parseEngineVolume("2.0 л")).toBe(2);
  });

  it("parses a cc volume into litres", () => {
    expect(parseEngineVolume("1998 см3")).toBe(2);
  });
});

describe("decodeHtmlEntities", () => {
  it("keeps an escaped entity intact (&amp;lt; stays &lt;)", () => {
    expect(decodeHtmlEntities("a &amp;lt; b")).toBe("a &lt; b");
  });

  it("decodes ordinary entities", () => {
    expect(decodeHtmlEntities("Toyota &amp; Lexus &lt;3")).toBe("Toyota & Lexus <3");
  });
});

describe("AutoMoto freshness traversal", () => {
  it("accepts today's day-only card before noon without inventing a future publication", () => {
    const publishedAt = parseDayOnlyDate("19.09.2026");
    expect(publishedAt?.toISOString()).toBe("2026-09-18T21:00:00.000Z");
    expect(isReliableFreshListing({ source: "AUTOMOTO", externalId: "1", publishedAt,
      timestampConfidence: "LOW" }, "TODAY", new Date("2026-09-18T21:10:00.000Z"))).toBe(true);
  });

  it("uses Kyiv winter time and rejects impossible calendar dates", () => {
    expect(parseDayOnlyDate("10.01.2026")?.toISOString()).toBe("2026-01-09T22:00:00.000Z");
    expect(parseDayOnlyDate("31.02.2026")).toBeUndefined();
    expect(parseDayOnlyDate("00.09.2026")).toBeUndefined();
  });
  it("skips an old card without treating the unordered page as exhausted", () => {
    const cutoff = new Date("2026-08-16T00:00:00.000Z");
    expect(autoMotoListingIsInFreshnessWindow(new Date("2026-08-15T12:00:00.000Z"), cutoff)).toBe(false);
    expect(autoMotoListingIsInFreshnessWindow(new Date("2026-08-16T12:00:00.000Z"), cutoff)).toBe(true);
  });
});
