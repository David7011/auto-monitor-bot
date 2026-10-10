import { describe, expect, it } from "vitest";
import { olxFeedTargets, savedOlxSearchUrls } from "../apps/worker/src/collectors/olx-feed.js";

describe("saved OLX searches", () => {
  it("returns no targets without configuration", () => {
    expect(savedOlxSearchUrls("")).toEqual([]);
    expect(savedOlxSearchUrls("  , not-a-url,")).toEqual([]);
  });

  it("parses comma-separated URLs and strips volatile continuation params", () => {
    expect(
      savedOlxSearchUrls(
        "https://www.olx.ua/uk/a/?min_id=937189013&reason=observed_search&search%5Bdist%5D=75,junk,https://www.olx.ua/uk/b/?view=grid",
      ),
    ).toEqual([
      "https://www.olx.ua/uk/a/?search%5Bdist%5D=75",
      "https://www.olx.ua/uk/b/?view=grid",
    ]);
  });

  it("keeps stable filter params intact", () => {
    const url = "https://www.olx.ua/uk/transport/legkovye-avtomobili/dnepr/?search%5Bdist%5D=75&search%5Border%5D=created_at:desc";
    expect(savedOlxSearchUrls(url)).toEqual([url]);
  });

  it("honors explicitly passed location scopes instead of recomputing them", () => {
    const context = {
      source: "OLX",
      sourceCategoryId: 1,
      models: [], bodyTypes: [], fuelTypes: [], gearboxes: [], driveTypes: [], colors: [],
    } as never;
    const targets = olxFeedTargets(context, 1, [{ regionId: 99, cityId: 88, htmlPath: "custom-city" }]);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.apiUrl).toContain("region_id=99");
      expect(target.apiUrl).toContain("city_id=88");
      expect(target.htmlUrl).toContain("custom-city");
    }
  });
});
