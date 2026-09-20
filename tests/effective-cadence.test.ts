import { describe, expect, it } from "vitest";
import {
  effectiveCadenceIdentityChanged,
  resolveOlxEffectiveCadence,
} from "../apps/api/src/modules/monitoring/effective-cadence.js";

const base = {
  persistedIntervalSeconds: 20,
  persistedJitterSeconds: 4,
  liveIntervalSeconds: 20,
  liveJitterSeconds: 4,
  standardIntervalSeconds: 120,
  standardJitterSeconds: 20,
  protectionActive: false,
  canary: { mode: "BASELINE" as const, intervalSeconds: 20, jitterSeconds: 4, reason: "baseline cadence" },
  recovery: { mode: "HEALTHY" as const, intervalSeconds: 20, jitterSeconds: 4, reason: "healthy" },
};

describe("effective OLX cadence", () => {
  it("reports the exact LIVE baseline", () => {
    expect(resolveOlxEffectiveCadence(base)).toMatchObject({
      mode: "LIVE", intervalSeconds: 20, jitterSeconds: 4,
      valueSource: "environment.live-baseline",
    });
  });

  it("explains the persisted STANDARD cadence without changing it", () => {
    expect(resolveOlxEffectiveCadence({
      ...base,
      persistedIntervalSeconds: 120,
      persistedJitterSeconds: 20,
      canary: { ...base.canary, intervalSeconds: 120, jitterSeconds: 20 },
      recovery: { ...base.recovery, intervalSeconds: 120, jitterSeconds: 20 },
    })).toMatchObject({
      mode: "STANDARD", intervalSeconds: 120, jitterSeconds: 20,
      valueSource: "monitoring-state.standard",
    });
  });

  it("gives CANARY precedence over a LIVE baseline", () => {
    expect(resolveOlxEffectiveCadence({
      ...base,
      canary: { mode: "CANARY", intervalSeconds: 18, jitterSeconds: 3, reason: "qualified" },
      recovery: { mode: "HEALTHY", intervalSeconds: 18, jitterSeconds: 3, reason: "healthy" },
    })).toMatchObject({ mode: "CANARY", intervalSeconds: 18, jitterSeconds: 3, valueSource: "canary.policy" });
  });

  it("gives recovery ramp precedence over CANARY", () => {
    expect(resolveOlxEffectiveCadence({
      ...base,
      canary: { mode: "CANARY", intervalSeconds: 18, jitterSeconds: 3, reason: "qualified" },
      recovery: { mode: "RECOVERY_RAMP", intervalSeconds: 30, jitterSeconds: 6, reason: "post-protection ramp" },
    })).toMatchObject({ mode: "RECOVERY", intervalSeconds: 30, jitterSeconds: 6, valueSource: "protection.recovery-ramp" });
  });

  it("gives active protection absolute precedence", () => {
    expect(resolveOlxEffectiveCadence({
      ...base,
      protectionActive: true,
      canary: { mode: "CANARY", intervalSeconds: 18, jitterSeconds: 3, reason: "qualified" },
      recovery: { mode: "RECOVERY_INITIAL", intervalSeconds: 60, jitterSeconds: 10, reason: "incident unresolved" },
    })).toMatchObject({ mode: "PROTECTED", intervalSeconds: 60, jitterSeconds: 10, valueSource: "protection.active-incident" });
  });

  it("adds history only when effective identity changes", () => {
    const current = { mode: "LIVE" as const, intervalSeconds: 20, jitterSeconds: 4, valueSource: "environment.live-baseline" };
    expect(effectiveCadenceIdentityChanged(current, current)).toBe(false);
    expect(effectiveCadenceIdentityChanged(current, { ...current, intervalSeconds: 18 })).toBe(true);
    expect(effectiveCadenceIdentityChanged(current, { ...current, valueSource: "canary.policy" })).toBe(true);
  });
});
