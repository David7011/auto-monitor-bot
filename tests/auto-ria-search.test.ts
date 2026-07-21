import { describe, expect, it } from "vitest";
import { buildAutoRiaSearchUrl } from "../apps/worker/src/collectors/auto-ria.js";
import type { SourceSearchContext } from "../apps/worker/src/collectors/base.js";

describe("AUTO.RIA search URL", () => {
  it("builds a filter-scoped newest-first official API search without paid endpoints", () => {
    const context: SourceSearchContext = {
      source: "AUTO_RIA",
      fingerprint: "test",
      filterIds: ["filter-1"],
      autoRiaCategoryId: 1,
      autoRiaMarkId: 9,
      autoRiaModelId: 87,
      models: ["Camry"],
      bodyTypes: ["sedan"],
      fuelTypes: ["gasoline"],
      gearboxes: ["automatic"],
      driveTypes: [],
      colors: [],
      yearFrom: 2018,
      yearTo: 2024,
      priceFrom: 10000,
      priceTo: 30000,
      mileageTo: 150000,
      regions: ["dnipropetrovska"],
      cities: [],
      keywords: [],
      excludeKeywords: [],
      freshnessMode: "LAST_24_HOURS",
      publishedAfter: new Date("2026-07-10T08:00:00.000Z"),
      initialWindowBehavior: "SKIP_EXISTING",
      maxInitialWindowNotifications: 50,
    };

    const url = new URL(buildAutoRiaSearchUrl(context, "test-api-key"));

    expect(url.origin + url.pathname).toBe("https://developers.ria.com/auto/search");
    expect(url.searchParams.get("api_key")).toBe("test-api-key");
    expect(url.searchParams.get("searchType")).toBe("4");
    expect(url.searchParams.get("status_id")).toBe("0");
    expect(url.searchParams.get("order_by")).toBe("7");
    expect(url.searchParams.get("countpage")).toBe("100");
    expect(url.searchParams.get("marka_id[0]")).toBe("9");
    expect(url.searchParams.get("model_id[0]")).toBe("87");
    expect(url.searchParams.get("s_yers[0]")).toBe("2018");
    expect(url.searchParams.get("po_yers[0]")).toBe("2024");
    expect(url.searchParams.get("price_ot")).toBe("10000");
    expect(url.searchParams.get("price_do")).toBe("30000");
    expect(url.searchParams.get("published_after")).toBe(context.publishedAfter!.toISOString());
    expect(url.searchParams.get("created_after")).toBe(context.publishedAfter!.toISOString());
    expect(url.searchParams.get("state[0]")).toBe("11");
    expect(url.searchParams.get("city[0]")).toBe("0");
    expect(url.pathname).not.toContain("average");
    expect(url.pathname).not.toContain("vin");
  });

  it("uses AUTO.RIA city ids when they are known", () => {
    const context: SourceSearchContext = {
      source: "AUTO_RIA",
      fingerprint: "test",
      filterIds: ["filter-1"],
      models: [],
      bodyTypes: [],
      fuelTypes: [],
      gearboxes: [],
      driveTypes: [],
      colors: [],
      regions: ["vinnytska"],
      cities: ["vinnytsia"],
      keywords: [],
      excludeKeywords: [],
      freshnessMode: "LAST_HOUR",
      initialWindowBehavior: "SKIP_EXISTING",
      maxInitialWindowNotifications: 50,
    };

    const url = new URL(buildAutoRiaSearchUrl(context, "test-api-key"));

    expect(url.searchParams.get("state[0]")).toBe("1");
    expect(url.searchParams.get("city[0]")).toBe("1");
  });
});
