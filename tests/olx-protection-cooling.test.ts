import { describe, expect, it } from "vitest";
import { olxProtectionCoolingState } from "../apps/worker/src/modules/olx-protection-cooling.js";
const detectedAt = new Date("2026-09-11T08:30:00Z");
const cooldownUntil = new Date("2026-09-14T13:05:00Z");
const recoveredAt = new Date("2026-09-13T17:54:00Z");
const base = { detectedAt, cooldownUntil, recoveredAt, coolingSeconds: 1800 };
describe("OLX incident recovery cooling", () => {
  it("expires resolved incident cooling 30 minutes after confirmed recovery", () => {
    expect(olxProtectionCoolingState({ ...base, status: "RESOLVED", now: new Date("2026-09-13T18:25:00Z") })).toMatchObject({ active: false, until: new Date("2026-09-13T18:24:00Z") });
  });
  it("retains quiet time immediately after recovery", () => {
    expect(olxProtectionCoolingState({ ...base, status: "RESOLVED", now: new Date("2026-09-13T18:00:00Z") })).toMatchObject({ active: true, remainingSeconds: 1440 });
  });
  it.each(["OPEN", "PAUSED", undefined])("preserves an unresolved incident pause (%s)", (status) => {
    expect(olxProtectionCoolingState({ ...base, status, now: new Date("2026-09-13T18:25:00Z") })).toMatchObject({ active: true, until: cooldownUntil });
  });
  it("fails closed if resolution has no recovery evidence", () => {
    expect(olxProtectionCoolingState({ ...base, status: "RESOLVED", recoveredAt: null, now: new Date("2026-09-13T18:25:00Z") }).active).toBe(true);
  });
});
