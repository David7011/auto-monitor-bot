import { describe, expect, it } from "vitest";
import { findTitlePriceYearPossibleDuplicate } from "../apps/worker/src/modules/duplicate-guard.js";

describe("duplicate guard", () => {
  it("treats title + price + year as POSSIBLE, not STRONG", () => {
    const decision = findTitlePriceYearPossibleDuplicate(
      { title: "Volkswagen Golf 2016" },
      [{ id: "similar", title: "Volkswagen Golf 2016" }],
    );

    expect(decision).toMatchObject({
      type: "POSSIBLE",
      matchedListingId: "similar",
      reasons: ["TITLE_PRICE_YEAR"],
      confidence: 0.55,
    });
  });

  it("does not flag weak candidates with a different title", () => {
    const decision = findTitlePriceYearPossibleDuplicate(
      { title: "Volkswagen Golf 2016" },
      [{ id: "other", title: "Skoda Octavia 2016" }],
    );

    expect(decision).toBeNull();
  });
});
