import { describe, expect, it } from "vitest";
import {
  TELEGRAM_FLASH_RENDERED_TEXT_LIMIT,
  telegramFlashBundleText,
} from "../apps/worker/src/modules/telegram-flash-format.js";

function listing(index: number) {
  return {
    source: "OLX" as const,
    url: `https://www.olx.ua/d/auto-${index}.html?x=1&y=2`,
    title: `Volkswagen Golf ${index} <fast> & fresh`,
    brand: "Volkswagen",
    model: "Golf",
    year: 2020,
    priceNormalized: 12_000 + index,
    priceOriginal: 12_000 + index,
    currencyOriginal: "USD",
    city: "Киев",
  };
}

function renderedLength(value: string): number {
  return value
    .replace(/<a href="[^"]*">/gu, "")
    .replace(/<\/(?:a|b)>/gu, "")
    .replace(/<b>/gu, "")
    .replace(/&(?:amp|lt|gt|quot);/gu, "x")
    .length;
}

describe("Telegram flash bundle formatting", () => {
  it("puts all twenty links into one compact Telegram-safe HTML message", () => {
    const text = telegramFlashBundleText(Array.from({ length: 20 }, (_, index) => listing(index + 1)));

    expect(text.match(/<a href=/gu)).toHaveLength(20);
    expect(text).toContain("FLASH: 20 свежих объявлений");
    expect(text).toContain("&lt;fast&gt; &amp; fresh");
    expect(text).toContain("?x=1&amp;y=2");
    expect(renderedLength(text)).toBeLessThanOrEqual(TELEGRAM_FLASH_RENDERED_TEXT_LIMIT);
  });

  it("escapes Telegram HTML in both labels and URLs", () => {
    const text = telegramFlashBundleText([{ ...listing(1), url: 'https://example.test/?q="<x>&y', title: '<b>unsafe</b>' }]);

    expect(text).toContain("&quot;&lt;x&gt;&amp;y");
    expect(text).toContain("&lt;b&gt;unsafe&lt;/b&gt;");
    expect(text).not.toContain("<b>unsafe</b>");
  });
});
