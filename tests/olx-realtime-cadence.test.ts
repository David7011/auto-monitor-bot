import { describe, expect, it } from "vitest";
import { decideOlxRealtimeCadence } from "../apps/api/src/modules/monitoring/olx-realtime-cadence.js";

const recoveredAt = new Date("2026-08-29T10:00:00.000Z");

describe("OLX realtime cadence", () => {
  it("uses the fast measured cadence when there is no protection history", () => {
    expect(decideOlxRealtimeCadence({
      configuredIntervalSeconds: 20,
      configuredJitterSeconds: 4,
      recoveryRampSeconds: 1_800,
    })).toMatchObject({ mode: "HEALTHY", intervalSeconds: 20, jitterSeconds: 4 });
  });

  it("holds unresolved protection incidents at the safest cadence", () => {
    expect(decideOlxRealtimeCadence({
      configuredIntervalSeconds: 20,
      configuredJitterSeconds: 4,
      recoveryRampSeconds: 1_800,
      now: new Date("2026-08-29T12:00:00.000Z"),
      incident: {
        status: "PROBE_PENDING",
        detectedAt: new Date("2026-08-29T09:00:00.000Z"),
        cooldownUntil: new Date("2026-08-29T10:00:00.000Z"),
        recoveredAt: null,
      },
    })).toMatchObject({ mode: "RECOVERY_INITIAL", intervalSeconds: 60, jitterSeconds: 10 });
  });

  it("ramps from 60 to 30 seconds before restoring healthy cadence", () => {
    const incident = {
      status: "RESOLVED",
      detectedAt: new Date("2026-08-29T09:00:00.000Z"),
      cooldownUntil: recoveredAt,
      recoveredAt,
    };
    const decideAt = (now: string) => decideOlxRealtimeCadence({
      configuredIntervalSeconds: 20,
      configuredJitterSeconds: 4,
      recoveryRampSeconds: 1_800,
      incident,
      now: new Date(now),
    });

    expect(decideAt("2026-08-29T10:10:00.000Z")).toMatchObject({
      mode: "RECOVERY_INITIAL",
      intervalSeconds: 60,
      jitterSeconds: 10,
    });
    expect(decideAt("2026-08-29T10:20:00.000Z")).toMatchObject({
      mode: "RECOVERY_RAMP",
      intervalSeconds: 30,
      jitterSeconds: 6,
    });
    expect(decideAt("2026-08-29T10:30:00.000Z")).toMatchObject({
      mode: "HEALTHY",
      intervalSeconds: 20,
      jitterSeconds: 4,
    });
  });

  it("never accelerates past an intentionally slower configured cadence", () => {
    expect(decideOlxRealtimeCadence({
      configuredIntervalSeconds: 90,
      configuredJitterSeconds: 12,
      recoveryRampSeconds: 1_800,
      incident: {
        status: "RESOLVED",
        detectedAt: new Date("2026-08-29T09:00:00.000Z"),
        cooldownUntil: recoveredAt,
        recoveredAt,
      },
      now: new Date("2026-08-29T10:05:00.000Z"),
    })).toMatchObject({ intervalSeconds: 90, jitterSeconds: 12 });
  });
});
