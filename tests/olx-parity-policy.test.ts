import { describe, expect, it } from "vitest";
import { olxParityPermission } from "../apps/worker/src/modules/olx-parity-policy.js";

const now = new Date("2026-09-12T09:00:00Z");

describe("OLX parity protection gate", () => {
  it.each(["RATE_LIMITED", "CAPTCHA_DETECTED"])("refuses %s before any sample request", (sourceStatus) => {
    expect(olxParityPermission({ sourceStatus, coolingSeconds: 1_800, now })).toMatchObject({ allowed: false });
  });

  it("refuses an active pause or post-incident cooling window", () => {
    expect(olxParityPermission({
      sourceStatus: "ACTIVE", pausedUntil: new Date("2026-09-12T09:01:00Z"), coolingSeconds: 1_800, now,
    }).allowed).toBe(false);
    expect(olxParityPermission({
      sourceStatus: "ACTIVE", incidentDetectedAt: new Date("2026-09-12T08:45:00Z"), coolingSeconds: 1_800, now,
    }).allowed).toBe(false);
  });

  it("allows parity only after all protection windows expire", () => {
    expect(olxParityPermission({
      sourceStatus: "ACTIVE",
      pausedUntil: new Date("2026-09-12T08:00:00Z"),
      incidentDetectedAt: new Date("2026-09-12T08:00:00Z"),
      coolingSeconds: 1_800,
      now,
    })).toEqual({ allowed: true, reason: null });
  });
});
