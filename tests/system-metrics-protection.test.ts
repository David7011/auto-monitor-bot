import { describe, expect, it } from "vitest";
import { deriveOlxProtectionState } from "../apps/api/src/lib/olx-hot-path-state.js";

describe("OLX hot-path protection state", () => {
  const now = new Date("2026-09-12T13:00:00.000Z");

  it("treats a retained future pause as protected after stop/start changed the display status", () => {
    const result = deriveOlxProtectionState({
      status: "DISABLED",
      pausedUntil: new Date("2026-09-13T09:27:52.274Z"),
    }, now);

    expect(result.protected).toBe(true);
    expect(result.reason).toContain("2026-09-13T09:27:52.274Z");
  });

  it("does not keep an expired display-only pause protected", () => {
    expect(deriveOlxProtectionState({
      status: "DISABLED",
      pausedUntil: new Date("2026-09-12T12:59:59.999Z"),
    }, now)).toEqual({ protected: false, reason: null });
  });

  it.each(["RATE_LIMITED", "CAPTCHA_DETECTED"])("keeps %s protected without a pause timestamp", (status) => {
    expect(deriveOlxProtectionState({ status, pausedUntil: null }, now).protected).toBe(true);
  });
});
