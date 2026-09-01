import { describe, expect, it } from "vitest";
import {
  TelegramApiTimeoutError,
  telegramPollingFailurePolicy,
} from "../apps/api/src/lib/telegram-polling-policy.js";

describe("telegram polling failure policy", () => {
  it("treats the client watchdog as a warning with a short retry", () => {
    const result = telegramPollingFailurePolicy(
      new TelegramApiTimeoutError("getUpdates", 40_000),
      4,
      3000,
      60_000,
    );

    expect(result).toEqual({ severity: "WARN", retryDelayMs: 1000, timedOut: true });
  });

  it("keeps exponential backoff and error severity for real failures", () => {
    expect(telegramPollingFailurePolicy(new Error("fetch failed"), 1, 3000, 60_000)).toEqual({
      severity: "ERROR",
      retryDelayMs: 3000,
      timedOut: false,
    });
    expect(telegramPollingFailurePolicy(new Error("fetch failed"), 7, 3000, 60_000)).toEqual({
      severity: "ERROR",
      retryDelayMs: 60_000,
      timedOut: false,
    });
  });
});
