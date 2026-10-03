import { describe, expect, it } from "vitest";
import {
  clampTelegramText,
  initialMessageText,
  type TelegramListingSnapshot,
} from "../apps/worker/src/modules/telegram-listing-format.js";

const listing: TelegramListingSnapshot = {
  id: "listing-1",
  source: "OLX",
  url: "https://www.olx.ua/d/example.html",
  title: "Volkswagen Golf 2018",
  brand: "Volkswagen",
  model: "Golf",
  bodyType: "hatchback",
  fuelType: "diesel",
  gearbox: "manual",
  driveType: "fwd",
  engineVolume: 2,
  year: 2018,
  priceNormalized: 12_000,
  priceOriginal: 12_000,
  currencyOriginal: "USD",
  mileage: 120_000,
  city: "Киев",
  region: "Киевская область",
  publishedAt: new Date("2026-07-22T10:00:00.000Z"),
  firstSeenAt: new Date("2026-07-22T10:00:05.000Z"),
  timestampConfidence: "HIGH",
  discoveryLane: "REALTIME",
  vin: null,
  plateNormalized: null,
  matches: [{ filter: { name: "Golf" } }],
  rawData: {},
};

describe("Telegram listing formatting", () => {
  it("keeps the fast first message complete and deterministic", () => {
    const text = initialMessageText(listing);
    expect(text).toContain("🔥 НОВОЕ ОБЪЯВЛЕНИЕ 🔥");
    expect(text).toContain("Источник: OLX");
    expect(text).toContain("Автомобиль: Volkswagen Golf 2018");
    expect(text).toContain("Цена: 12000 $");
    expect(text).toContain("Год/пробег: 2018 / 120000 км");
    expect(text).toContain("Место: Киев, Киевская область");
    expect(text).toContain(listing.url);
  });

  it("keeps the card compact without market and filter noise", () => {
    const text = initialMessageText({ ...listing, sellerPhone: "+380671234567" });
    expect(text).toContain("Телефон: +380671234567");
    expect(text).not.toContain("Фильтры:");
    expect(text).not.toContain("Рынок:");
    expect(text).not.toContain("Медиана");
    expect(text).not.toContain("Проверка авто");
    expect(text).not.toContain("Скорость обнаружения");
    expect(text).not.toContain("Опубликовано:");
  });

  it("clamps oversized Telegram messages below the API limit", () => {
    const text = clampTelegramText(["x".repeat(5_000)]);
    expect(text.length).toBeLessThanOrEqual(3_900);
    expect(text).toMatch(/\.\.\.обрезано$/u);
  });

  it("labels coverage discoveries separately from true backfill recovery", () => {
    expect(initialMessageText({ ...listing, discoveryLane: "COVERAGE" }))
      .toContain("НАЙДЕНО ПРИ СВЕРКЕ ИСТОЧНИКА");
    expect(initialMessageText({ ...listing, discoveryLane: "BACKFILL" }))
      .toContain("НАЙДЕНО ПРИ ФОНОВОЙ СВЕРКЕ");
  });
});
