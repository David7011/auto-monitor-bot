import { describe, expect, it } from "vitest";
import {
  TELEGRAM_FAVORITE_CALLBACK_PREFIX,
  telegramRetentionClaimIsActive,
  telegramFavoriteCallbackData,
  telegramListingKeyboard,
} from "../packages/shared/src/index.js";
import {
  listingRetentionCutoffs,
  notificationStillDue,
} from "../apps/worker/src/modules/listing-retention.js";
import {
  isTelegramDeleteTooOldError,
  isTelegramMessageGoneError,
} from "../apps/worker/src/modules/telegram-service.js";

describe("Telegram listing retention", () => {
  it("blocks a favorite race only while a cleanup claim is fresh", () => {
    const now = new Date("2026-07-22T12:00:00.000Z");
    expect(telegramRetentionClaimIsActive(new Date("2026-07-22T11:59:00.000Z"), now)).toBe(true);
    expect(telegramRetentionClaimIsActive(new Date("2026-07-22T11:54:59.000Z"), now)).toBe(false);
    expect(telegramRetentionClaimIsActive(null, now)).toBe(false);
  });
  it("builds a URL button plus a compact favorite callback", () => {
    const listingId = "cm12345678901234567890123";
    const keyboard = telegramListingKeyboard("https://www.olx.ua/d/uk/obyavlenie/test-ID1.html", listingId);
    expect(keyboard.inline_keyboard).toHaveLength(2);
    expect(keyboard.inline_keyboard[0]?.[0]).toMatchObject({ text: "Открыть объявление" });
    expect(keyboard.inline_keyboard[1]?.[0]).toMatchObject({
      callback_data: telegramFavoriteCallbackData(listingId),
    });
    expect(Buffer.byteLength(telegramFavoriteCallbackData(listingId), "utf8")).toBeLessThanOrEqual(64);
    expect(telegramFavoriteCallbackData(listingId).startsWith(TELEGRAM_FAVORITE_CALLBACK_PREFIX)).toBe(true);
  });

  it("shows the saved state without changing callback identity", () => {
    const listingId = "cm12345678901234567890123";
    const keyboard = telegramListingKeyboard("https://example.com/listing", listingId, new Date(), 10);
    expect(keyboard.inline_keyboard[1]?.[0]).toMatchObject({
      text: "❤️ Сохранено на 10 дней",
      callback_data: telegramFavoriteCallbackData(listingId),
    });
  });

  it("calculates regular and favorite cutoffs deterministically", () => {
    const now = new Date("2026-07-22T12:00:00.000Z");
    expect(listingRetentionCutoffs(now, 12, 10)).toEqual({
      regular: new Date("2026-07-22T00:00:00.000Z"),
      favorite: new Date("2026-07-12T12:00:00.000Z"),
    });
  });

  it("recognizes Telegram's expected cleanup outcomes", () => {
    expect(isTelegramDeleteTooOldError("Bad Request: message can't be deleted for everyone")).toBe(true);
    expect(isTelegramDeleteTooOldError("Too Many Requests: retry after 10")).toBe(false);
    expect(isTelegramMessageGoneError("Bad Request: message to delete not found")).toBe(true);
  });

  it("cancels a claimed cleanup when the listing was favorited again", () => {
    const now = new Date("2026-07-22T12:00:00.000Z");
    const regular = new Date("2026-07-22T00:00:00.000Z");
    expect(notificationStillDue({
      cleanupAttemptedAt: now,
      favoritedAt: new Date("2026-07-22T11:59:00.000Z"),
      retainUntil: new Date("2026-08-01T11:59:00.000Z"),
      retentionPolicyAppliedAt: now,
      deleteAfter: new Date("2026-07-22T00:00:00.000Z"),
      status: "UPDATED",
      messageId: "123",
      sentAt: new Date("2026-07-21T23:00:00.000Z"),
    }, now, regular)).toBe(false);
  });
});
