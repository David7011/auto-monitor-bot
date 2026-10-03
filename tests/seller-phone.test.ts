import { describe, expect, it } from "vitest";
import { telegramListingKeyboard } from "../packages/shared/src/constants/telegram.js";
import {
  extractPhonesFromHtml,
  extractPhonesFromText,
  normalizePhoneNumber,
  parseAutoRiaPhones,
  parseOlxLimitedPhones,
  splitStoredPhones,
} from "../apps/worker/src/modules/seller-phone.js";
import {
  initialMessageText,
  type TelegramListingSnapshot,
} from "../apps/worker/src/modules/telegram-listing-format.js";

const baseListing: TelegramListingSnapshot = {
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
  sellerPhone: null,
  matches: [{ filter: { name: "Golf" } }],
  rawData: {},
};

describe("seller phone normalization", () => {
  it("normalizes Ukrainian formats to +380", () => {
    expect(normalizePhoneNumber("+380671234567")).toBe("+380671234567");
    expect(normalizePhoneNumber("380671234567")).toBe("+380671234567");
    expect(normalizePhoneNumber("067 123 45 67")).toBe("+380671234567");
    expect(normalizePhoneNumber("+380 (67) 123-45-67")).toBe("+380671234567");
  });

  it("rejects non-phone garbage", () => {
    expect(normalizePhoneNumber("")).toBeNull();
    expect(normalizePhoneNumber("позвоните вечером")).toBeNull();
    expect(normalizePhoneNumber("123")).toBeNull();
  });

  it("splits stored multi-phone values and dedupes", () => {
    expect(splitStoredPhones("+380671234567, 0671234567, +380671234567")).toEqual(["+380671234567"]);
    expect(splitStoredPhones(null)).toEqual([]);
  });
});

describe("seller phone extraction", () => {
  it("finds phones written in description text", () => {
    const phones = extractPhonesFromText("Продам авто, звоните 067 123 45 67 или +380931234567");
    expect(phones).toContain("+380671234567");
    expect(phones).toContain("+380931234567");
  });

  it("finds tel: links and JSON phone fields in HTML", () => {
    const phones = extractPhonesFromHtml(
      `<a href="tel:+380671234567">позвонить</a> {"phoneFormatted":"+380 93 123 45 67"}`,
    );
    expect(phones).toContain("+380671234567");
    expect(phones).toContain("+380931234567");
  });

  it("parses OLX limited-phones payload shapes", () => {
    expect(parseOlxLimitedPhones({ data: { phones: ["+380671234567"] } })).toEqual(["+380671234567"]);
    expect(parseOlxLimitedPhones({ data: [{ phone: "0671234567" }] })).toEqual(["+380671234567"]);
    expect(parseOlxLimitedPhones({ unexpected: true })).toEqual([]);
  });

  it("parses AUTO.RIA phones payload shapes", () => {
    expect(parseAutoRiaPhones({ phones: [{ phoneFormatted: "+380671234567" }] })).toEqual([
      "+380671234567",
    ]);
    expect(parseAutoRiaPhones({})).toEqual([]);
  });
});

describe("seller phone in Telegram", () => {
  it("shows the phone line in the card when present", () => {
    const text = initialMessageText({ ...baseListing, sellerPhone: "+380671234567" });
    expect(text).toContain("Телефон: +380671234567");
  });

  it("omits the phone line when absent", () => {
    expect(initialMessageText(baseListing)).not.toContain("Телефон:");
  });

  it("adds a one-tap copy button without breaking the legacy keyboard", () => {
    const legacy = telegramListingKeyboard("https://example.com", "id-1");
    expect(legacy.inline_keyboard).toHaveLength(2);

    const withPhone = telegramListingKeyboard("https://example.com", "id-1", null, 10, "+380671234567");
    expect(withPhone.inline_keyboard).toHaveLength(3);
    expect(withPhone.inline_keyboard[1]?.[0]).toEqual({
      text: "📋 +380671234567",
      copy_text: { text: "+380671234567" },
    });
  });
});
