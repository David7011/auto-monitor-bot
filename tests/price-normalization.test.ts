import { describe, expect, it } from "vitest";
import { normalizeOlxAd, type OlxAd } from "../apps/worker/src/collectors/olx.js";

function ad(currencyCode: string, value: number): OlxAd {
  return {
    id: `price-${currencyCode}`,
    title: "Toyota Camry 2018",
    url: `https://www.olx.ua/d/uk/obyavlenie/${currencyCode}.html`,
    createdTime: "2026-07-10T08:00:00.000Z",
    price: { regularPrice: { value, currencyCode } },
  };
}

describe("price normalization", () => {
  it("keeps USD price as normalized price", () => {
    expect(normalizeOlxAd(ad("USD", 12000))?.priceNormalized).toBe(12000);
  });

  it("normalizes UAH price through configured static fallback rate", () => {
    expect(normalizeOlxAd(ad("UAH", 446500))?.priceNormalized).toBe(10000);
  });

  it("does not invent normalized price for unknown currencies", () => {
    expect(normalizeOlxAd(ad("GBP", 10000))?.priceNormalized).toBeUndefined();
  });
});
