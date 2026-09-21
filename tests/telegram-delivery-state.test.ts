import { describe, expect, it } from "vitest";
import {
  classifyTelegramDeliveryFailure,
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
});
