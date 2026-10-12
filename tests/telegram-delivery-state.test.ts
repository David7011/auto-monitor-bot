import { describe, expect, it } from "vitest";
import {
  albumExtraGateDelayMs,
  classifyTelegramDeliveryFailure,
  isPermanentTelegramEditError,
  isTelegramMessageGoneError,
  shouldQuarantineDelivery,
  TELEGRAM_MAX_DELIVERY_ATTEMPTS,
  telegramDeliveryRetryDelayMs,
} from "../apps/worker/src/modules/telegram-service.js";

describe("Telegram durable delivery state machine", () => {
  it("keeps transient failures retryable after more than ten attempts with capped jittered backoff", () => {
    expect(classifyTelegramDeliveryFailure({
      message: "connect ECONNREFUSED",
      requestStarted: false,
      acceptancePersisted: false,
    })).toBe("TRANSIENT");
    expect(telegramDeliveryRetryDelayMs(11, undefined, () => 0.5)).toBe(1_800_000);
    expect(telegramDeliveryRetryDelayMs(100, undefined, () => 1)).toBe(1_800_000);
  });

  it("honors retry_after when it exceeds local exponential backoff", () => {
    expect(telegramDeliveryRetryDelayMs(1, 120, () => 0)).toBe(120_000);
  });

  it("preserves uncertainty after an HTTP send starts but no receipt is durable", () => {
    expect(classifyTelegramDeliveryFailure({
      message: "socket hang up",
      requestStarted: true,
      acceptancePersisted: false,
    })).toBe("AMBIGUOUS");
  });

  it("does not retry a confirmed permanent chat failure", () => {
    expect(classifyTelegramDeliveryFailure({
      message: "Bad Request: chat not found",
      requestStarted: true,
      acceptancePersisted: false,
    })).toBe("PERMANENT");
  });

  it("parks definitively-undelivered cards after the attempt ceiling", () => {
    expect(TELEGRAM_MAX_DELIVERY_ATTEMPTS).toBe(30);
    for (const status of ["TRANSIENT", "FAILED", "RETRY_PENDING"]) {
      expect(shouldQuarantineDelivery(status, 29)).toBe(false);
      expect(shouldQuarantineDelivery(status, 30)).toBe(true);
      expect(shouldQuarantineDelivery(status, 140)).toBe(true);
    }
  });

  it("never quarantines uncertain (AMBIGUOUS) deliveries", () => {
    // A duplicate card is always better than a missed listing.
    for (const status of ["AMBIGUOUS", "SENDING", "PROCESSING", "PENDING"]) {
      expect(shouldQuarantineDelivery(status, 1_000)).toBe(false);
    }
  });

  it("treats ghost messages as terminal for card updates", () => {
    // Retention cleanup or the user deleted the message: retrying the edit
    // forever only burns API calls and fills the failed queue.
    expect(isTelegramMessageGoneError(
      "Call to 'editMessageCaption' failed! (400: Bad Request: message to edit not found)",
    )).toBe(true);
    expect(isTelegramMessageGoneError("Bad Request: message to delete not found")).toBe(true);
    expect(isTelegramMessageGoneError("Bad Request: message not found")).toBe(true);
    expect(isTelegramMessageGoneError("Too Many Requests: retry after 5")).toBe(false);
    expect(isTelegramMessageGoneError("Bad Request: message is not modified")).toBe(false);
  });

  it("treats permanently uneditable cards as terminal for updates", () => {
    expect(isPermanentTelegramEditError("Bad Request: message can't be edited")).toBe(true);
    expect(isPermanentTelegramEditError("Bad Request: message cannot be edited")).toBe(true);
    expect(isPermanentTelegramEditError("Bad Request: message to edit not found")).toBe(false);
    expect(isPermanentTelegramEditError("Too Many Requests: retry after 5")).toBe(false);
  });

  it("charges one gate slot per album photo beyond the first", () => {
    // Telegram paces every album photo, not every message: an uncharged
    // 10-photo album trips 429s even at 1.1s message spacing.
    expect(albumExtraGateDelayMs(0)).toBe(0);
    expect(albumExtraGateDelayMs(1)).toBe(0);
    expect(albumExtraGateDelayMs(2)).toBe(1_100);
    expect(albumExtraGateDelayMs(10)).toBe(9_900);
    expect(albumExtraGateDelayMs(25)).toBe(9_900);
  });
});
