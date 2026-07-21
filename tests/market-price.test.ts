import { describe, expect, it } from "vitest";
import { calculateMarketPriceStats } from "../apps/worker/src/modules/market-price";

describe("market price estimate", () => {
  it("classifies a fair listing around the local median", () => {
    const stats = calculateMarketPriceStats(10_500, [
      { price: 9_500, source: "OLX" },
      { price: 10_000, source: "AUTO_RIA" },
      { price: 10_500, source: "CARS_UA" },
      { price: 11_000, source: "OLX" },
      { price: 12_000, source: "RST" },
    ]);

    expect(stats.status).toBe("READY");
    expect(stats.verdict).toBe("FAIR");
    expect(stats.medianPrice).toBe(10_500);
    expect(stats.sampleSize).toBe(5);
  });

  it("flags a very cheap listing as high-risk bargain", () => {
    const stats = calculateMarketPriceStats(6_500, [
      { price: 10_000, source: "OLX" },
      { price: 10_500, source: "OLX" },
      { price: 11_000, source: "AUTO_RIA" },
      { price: 11_500, source: "RST" },
      { price: 12_000, source: "CARS_UA" },
    ]);

    expect(stats.status).toBe("READY");
    expect(stats.verdict).toBe("HIGH_RISK_BARGAIN");
  });

  it("keeps low-sample estimates as insufficient data", () => {
    const stats = calculateMarketPriceStats(10_000, [{ price: 10_500, source: "OLX" }]);

    expect(stats.status).toBe("INSUFFICIENT_DATA");
    expect(stats.verdict).toBe("UNKNOWN");
  });

  it("removes extreme price noise from a sufficiently large market sample", () => {
    const stats = calculateMarketPriceStats(20_000, [
      18_000,
      18_500,
      19_000,
      19_500,
      20_000,
      20_500,
      21_000,
      200_000,
    ].map((price) => ({ price, source: "OLX" as const })));

    expect(stats.sampleSize).toBe(7);
    expect(stats.discardedOutliers).toBe(1);
    expect(stats.maxPrice).toBe(21_000);
  });
});
