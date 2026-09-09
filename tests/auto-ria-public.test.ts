import { describe, expect, it } from "vitest";
import {
  buildAutoRiaPublicSearchUrl,
  parseAutoRiaPublicCards,
} from "../apps/worker/src/collectors/auto-ria-public.js";
import type { SourceSearchContext } from "../apps/worker/src/collectors/base.js";

const context = {
  source: "AUTO_RIA",
  categoryKey: "vehicle.car",
  categorySchemaVersion: 1,
  plannerVersion: 1,
  categoryCriteria: {},
  unknownPolicy: "MAX_COVERAGE",
  shadowMode: false,
  fingerprint: "public-test",
  filterIds: ["filter-1"],
  models: [], bodyTypes: [], fuelTypes: [], gearboxes: [], driveTypes: [], colors: [],
  yearFrom: 1990,
  priceTo: 10_000,
  regions: ["dnipropetrovska"],
  cities: [], keywords: [], excludeKeywords: [],
  freshnessMode: "LAST_24_HOURS",
  initialWindowBehavior: "SKIP_EXISTING",
  maxInitialWindowNotifications: 50,
} satisfies SourceSearchContext;

describe("AUTO.RIA public search", () => {
  it("uses a bounded newest-first public query without a credential", () => {
    const url = new URL(buildAutoRiaPublicSearchUrl(context));
    expect(url.origin + url.pathname).toBe("https://auto.ria.com/uk/search/");
    expect(url.searchParams.get("sort[0].order")).toBe("dates.created.desc");
    expect(url.searchParams.get("year[0].gte")).toBe("1990");
    expect(url.searchParams.get("price.USD.lte")).toBe("10000");
    expect(url.searchParams.get("region.id[0]")).toBe("11");
    expect(url.search).not.toContain("api_key");
  });

  it("extracts query cards, excludes recommendation widgets, and deduplicates IDs", () => {
    const auto = { data: { id: 123, type: "Auto", link: "/auto_test_123.html", title: { content: "Toyota Camry 2018" } } };
    const widget = { data: { id: 999, type: "UsedAuto", link: "/auto_widget_999.html", title: { content: "Widget" } } };
    const html = [auto, widget, auto]
      .map((card) => `"advertisementCard":${JSON.stringify(card)}`)
      .join("\n");
    expect(parseAutoRiaPublicCards(html)).toEqual({ cards: [auto.data], malformedCount: 0 });
  });

  it("reports malformed card state rather than treating it as a valid empty feed", () => {
    expect(parseAutoRiaPublicCards('"advertisementCard":{"data":{"id":1,"type":"Auto"}}')).toEqual({
      cards: [],
      malformedCount: 1,
    });
  });
});
