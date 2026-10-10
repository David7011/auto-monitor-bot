import { describe, expect, it } from "vitest";
import {
  autoRiaGeoParamsForSelection,
  listingMatchesGeoSelection,
  normalizeCityIds,
  normalizeGeoText,
  normalizeRegionIds,
  UKRAINE_CITIES_DATA_VERSION,
  UKRAINE_REGIONS,
} from "../packages/shared/src/data/ukraine-regions.js";

describe("region/city filtering", () => {
  it("treats empty region and city selection as all Ukraine", () => {
    expect(listingMatchesGeoSelection({ region: "Одеська область", city: "Одеса" }, [], [])).toBe(true);
  });

  it("normalizes Ukrainian, Russian and id aliases to stable ids", () => {
    expect(normalizeRegionIds(["Днепропетровская область", "dnipro"])).toEqual(["dnipropetrovska"]);
    expect(normalizeCityIds(["Днепр", "Дніпро", "dnipro"])).toEqual(["dnipro"]);
  });

  it("matches the whole selected region when no cities are selected", () => {
    expect(listingMatchesGeoSelection({ region: "Днепропетровская область", city: "Кривой Рог" }, ["dnipropetrovska"], [])).toBe(true);
    expect(listingMatchesGeoSelection({ region: "Киевская область", city: "Бровары" }, ["dnipropetrovska"], [])).toBe(false);
  });

  it("limits matching to selected cities when city ids are present", () => {
    expect(listingMatchesGeoSelection({ region: "Дніпропетровська область", city: "Дніпро" }, ["dnipropetrovska"], ["dnipro"])).toBe(true);
    expect(listingMatchesGeoSelection({ region: "Дніпропетровська область", city: "Кривий Ріг" }, ["dnipropetrovska"], ["dnipro"])).toBe(false);
  });

  it("matches AUTO.RIA legacy city labels and suffixless region names", () => {
    expect(normalizeGeoText("Дніпропетровська область")).toBe("дніпропетровська");
    expect(normalizeGeoText("Дніпропетровська")).toBe("дніпропетровська");
    expect(normalizeGeoText("Дніпро (Дніпропетровськ)")).toBe("дніпро");
    expect(
      listingMatchesGeoSelection(
        { region: "Дніпропетровська", city: "Дніпро (Дніпропетровськ)" },
        ["dnipropetrovska"],
        ["dnipro"],
      ),
    ).toBe(true);
  });

  it("drops cities outside selected regions during normalization", () => {
    expect(normalizeCityIds(["Дніпро", "Одеса"], ["dnipropetrovska"])).toEqual(["dnipro"]);
  });

  it("uses exact AUTO.RIA city id for Dnipro instead of region-wide fallback", () => {
    expect(autoRiaGeoParamsForSelection([], ["Днепр"])).toEqual([
      {
        regionId: "dnipropetrovska",
        cityId: "dnipro",
        stateId: 11,
        cityIdValue: 11,
        apiCityBacked: true,
      },
    ]);
  });

  it("bundles the official 2026 KATOTTG city set including Samar", () => {
    const cityCount = UKRAINE_REGIONS.reduce((sum, region) => sum + region.cities.length, 0);
    expect(UKRAINE_CITIES_DATA_VERSION).toBe("KATOTTG-2026-04-09");
    expect(cityCount).toBeGreaterThanOrEqual(461);
    expect(normalizeCityIds(["Самар", "Новомосковск"], ["dnipropetrovska"])).toEqual([
      "katottg-ua12100070010038698",
    ]);
  });

  it("supports one whole region together with a city-only region", () => {
    const regions = ["dnipropetrovska", "odeska"];
    const cities = ["dnipro"];
    expect(listingMatchesGeoSelection({ region: "Днепропетровская область", city: "Днепр" }, regions, cities)).toBe(true);
    expect(listingMatchesGeoSelection({ region: "Днепропетровская область", city: "Самар" }, regions, cities)).toBe(false);
    expect(listingMatchesGeoSelection({ region: "Одесская область", city: "Измаил" }, regions, cities)).toBe(true);
    expect(autoRiaGeoParamsForSelection(regions, cities)).toEqual([
      {
        regionId: "dnipropetrovska",
        cityId: "dnipro",
        stateId: 11,
        cityIdValue: 11,
        apiCityBacked: true,
      },
      {
        regionId: "odeska",
        cityId: null,
        stateId: 12,
        cityIdValue: 0,
        apiCityBacked: false,
      },
    ]);
  });

  it("vetoes a known city outside the selected regions even when the region field claims otherwise", () => {
    // Real case: OLX listing with region "Дніпропетровська область" but city
    // "Львів" must not match a Dnipropetrovsk filter.
    expect(listingMatchesGeoSelection({ region: "Дніпропетровська область", city: "Львів" }, ["dnipropetrovska"], [])).toBe(false);
    expect(listingMatchesGeoSelection({ region: "Дніпропетровська область", city: "Львів" }, ["dnipropetrovska"], ["dnipro"])).toBe(false);
    expect(listingMatchesGeoSelection({ region: "Дніпропетровська область", city: "Одеса" }, ["dnipropetrovska"], [])).toBe(false);
    // In-region cities keep matching.
    expect(listingMatchesGeoSelection({ region: "Дніпропетровська область", city: "Дніпро" }, ["dnipropetrovska"], [])).toBe(true);
  });

  it("keeps region-based behavior for ambiguous same-named settlements", () => {
    // "Миколаїв" exists both in Lviv and Mykolaiv oblasts: the region field
    // decides, the city must not veto.
    expect(listingMatchesGeoSelection({ region: "Миколаївська область", city: "Миколаїв" }, ["mykolaivska"], [])).toBe(true);
    expect(listingMatchesGeoSelection({ region: "Львівська область", city: "Миколаїв" }, ["lvivska"], [])).toBe(true);
    expect(listingMatchesGeoSelection({ region: "Одеська область", city: "Миколаїв" }, ["mykolaivska"], [])).toBe(false);
  });
});
