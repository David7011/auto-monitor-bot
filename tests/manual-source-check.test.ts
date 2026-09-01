import { describe, expect, it } from "vitest";
import {
  manualSourceCheckBlocked,
  safeSourceEnableTransition,
} from "../apps/api/src/lib/manual-source-check.js";

describe("manual source checks", () => {
  it("cannot bypass a source protection state", () => {
    expect(manualSourceCheckBlocked({ status: "RATE_LIMITED" })).toBe(true);
    expect(manualSourceCheckBlocked({ status: "CAPTCHA_DETECTED" })).toBe(true);
  });

  it("allows a healthy source without an active pause", () => {
    expect(manualSourceCheckBlocked({
      status: "ACTIVE",
      pausedUntil: new Date("2026-08-22T10:00:00Z"),
      now: new Date("2026-08-22T11:00:00Z"),
    })).toBe(false);
  });

  it("preserves an active cooldown when a disabled source is re-enabled", () => {
    const pausedUntil = new Date("2026-08-23T15:00:00Z");
    expect(safeSourceEnableTransition({
      pausedUntil,
      now: new Date("2026-08-22T15:00:00Z"),
    })).toEqual({
      status: "PAUSED",
      pausedUntil,
      nextCheckAt: pausedUntil,
      resetErrors: false,
    });
  });
});
