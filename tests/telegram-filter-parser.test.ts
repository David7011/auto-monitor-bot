import { describe, expect, it } from "vitest";
import { parseQuickFilter } from "../apps/api/src/modules/telegram-filter-parser.js";

describe("Telegram quick filter parser", () => {
  it("treats a compact upper price as price and leaves the make empty", () => {
    const parsed = parseQuickFilter("до50000 долларов");

    expect(parsed.priceTo).toBe(50_000);
    expect(parsed.brand).toBeNull();
    expect(parsed.model).toBeNull();
    expect(parsed.vehicleQuery).toBeNull();
  });

  it("parses spaced price and geography without inventing a vehicle", () => {
    const parsed = parseQuickFilter("любая марка до 50 000 долларов Днепр");

    expect(parsed.priceTo).toBe(50_000);
    expect(parsed.brand).toBeNull();
    expect(parsed.model).toBeNull();
    expect(parsed.cities.length).toBeGreaterThan(0);
  });

  it("separates vehicle, year, price, and geography ranges", () => {
    const parsed = parseQuickFilter("BMW X5 2015-2020 10000-35000 Днепр");

    expect(parsed.brand).toBe("BMW");
    expect(parsed.model?.toLowerCase()).toBe("x5");
    expect(parsed.yearFrom).toBe(2015);
    expect(parsed.yearTo).toBe(2020);
    expect(parsed.priceFrom).toBe(10_000);
    expect(parsed.priceTo).toBe(35_000);
    expect(parsed.cities.length).toBeGreaterThan(0);
  });

  it("infers the make from a known model", () => {
    const parsed = parseQuickFilter("Camry до 18000 Киев");

    expect(parsed.brand).toBe("Toyota");
    expect(parsed.model?.toLowerCase()).toBe("camry");
    expect(parsed.priceTo).toBe(18_000);
  });

  it("supports explicit lower and upper price bounds", () => {
    const parsed = parseQuickFilter("все авто от $10000 до $50000");

    expect(parsed.priceFrom).toBe(10_000);
    expect(parsed.priceTo).toBe(50_000);
    expect(parsed.brand).toBeNull();
    expect(parsed.model).toBeNull();
  });
});
