import { describe, expect, it } from "vitest";
import { deriveOlxHotPathStates, deriveOlxProtectionState } from "../apps/api/src/lib/olx-hot-path-state.js";

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

  it("separates healthy baseline operation from insufficient canary evidence", () => {
    expect(deriveOlxHotPathStates({
      protected: false,
      sourceStatus: "ACTIVE",
      parserDegraded: false,
      p95Ready: false,
      p95Exceeded: false,
    })).toEqual({
      operationalState: "HEALTHY",
      optimizationReadiness: "INSUFFICIENT_DATA",
      compatibilityState: "INSUFFICIENT_DATA",
    });
  });

  it("blocks optimization while protection is active without calling the local runtime unhealthy", () => {
    expect(deriveOlxHotPathStates({
      protected: true,
      sourceStatus: "DISABLED",
      parserDegraded: false,
      p95Ready: true,
      p95Exceeded: false,
    })).toMatchObject({ operationalState: "PROTECTED", optimizationReadiness: "BLOCKED" });
  });
});
