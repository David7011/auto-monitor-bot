import { describe, expect, it } from "vitest";
import { resolveRegionId } from "../packages/shared/src/data/ukraine-regions.js";
import { geoCitiesKeyboard, geoRegionsKeyboard } from "../apps/api/src/modules/telegram-control-bot.js";

const FILTER_ID = "cm12345678901234567890123";

describe("Telegram geography keyboard", () => {
  it("keeps every callback within Telegram's 64-byte limit", () => {
    const regionId = resolveRegionId("Днепропетровская область");
    expect(regionId).toBeTruthy();
    const keyboards = [
      ...Array.from({ length: 4 }, (_, page) => geoRegionsKeyboard(FILTER_ID, page)),
      ...Array.from({ length: 10 }, (_, page) => geoCitiesKeyboard(FILTER_ID, regionId!, page)),
    ];
    for (const keyboard of keyboards) {
      for (const button of keyboard.inline_keyboard.flat()) {
        expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
      }
    }
  });

  it("offers Samar in Dnipropetrovsk region city pages", () => {
    const regionId = resolveRegionId("Днепропетровская область");
    const labels = Array.from({ length: 10 }, (_, page) => geoCitiesKeyboard(FILTER_ID, regionId!, page))
      .flatMap((keyboard) => keyboard.inline_keyboard.flat())
      .map((button) => button.text);
    expect(labels).toContain("Самар");
  });
});
