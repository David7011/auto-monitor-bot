import { describe, expect, it } from "vitest";
import type { EffectiveCadenceMode } from "@amb/shared";
import { detectOlxScheduledOutage } from "../apps/worker/src/modules/olx-outage-detection.js";

const lastSuccess = new Date("2026-09-20T10:00:00.000Z");

function decision(input: {
  mode: EffectiveCadenceMode;
  expectedAfterSeconds: number;
  jitterSeconds: number;
  actualAfterSeconds: number;
  toleranceSeconds?: number;
}) {
  return detectOlxScheduledOutage({
    source: "OLX",
    lane: "REALTIME",
    now: new Date(lastSuccess.getTime() + input.actualAfterSeconds * 1_000),
    lastSuccessfulScanAt: lastSuccess,
    schedule: {
      mode: input.mode,
      nextExpectedRunAt: new Date(lastSuccess.getTime() + input.expectedAfterSeconds * 1_000),
      jitterSeconds: input.jitterSeconds,
      schedulerToleranceSeconds: input.toleranceSeconds ?? 5,
    },
  });
}

describe("OLX deadline-relative outage detection", () => {
  it("does not call a valid STANDARD 140-second interval an outage", () => {
    expect(decision({ mode: "STANDARD", expectedAfterSeconds: 140, jitterSeconds: 20, actualAfterSeconds: 140 }))
      .toMatchObject({ outageDetected: false });
  });

  it("uses the LIVE deadline instead of a fixed 120-second age", () => {
    expect(decision({ mode: "LIVE", expectedAfterSeconds: 20, jitterSeconds: 4, actualAfterSeconds: 25 }))
      .toMatchObject({ outageDetected: false });
    expect(decision({ mode: "LIVE", expectedAfterSeconds: 20, jitterSeconds: 4, actualAfterSeconds: 30 }))
      .toMatchObject({ outageDetected: true });
  });

  it("honors the RECOVERY deadline and its wider jitter", () => {
    expect(decision({ mode: "RECOVERY", expectedAfterSeconds: 60, jitterSeconds: 10, actualAfterSeconds: 74 }))
      .toMatchObject({ outageDetected: false });
    expect(decision({ mode: "RECOVERY", expectedAfterSeconds: 60, jitterSeconds: 10, actualAfterSeconds: 76 }))
      .toMatchObject({ outageDetected: true });
  });

  it("tolerates a delayed scheduler through the exact grace boundary", () => {
    const atBoundary = decision({ mode: "CANARY", expectedAfterSeconds: 18, jitterSeconds: 3, actualAfterSeconds: 26 });
    expect(atBoundary.outageDetected).toBe(false);
    expect(atBoundary.deadlineAt).toEqual(new Date(lastSuccess.getTime() + 26_000));
  });

  it("detects intentional downtime after the persisted expected run", () => {
    expect(decision({ mode: "PROTECTED", expectedAfterSeconds: 300, jitterSeconds: 30, actualAfterSeconds: 3_600 }))
      .toMatchObject({ outageDetected: true });
  });

  it("does not invent an outage without valid persisted scheduling evidence", () => {
    expect(detectOlxScheduledOutage({
      source: "OLX", lane: "REALTIME", now: new Date(lastSuccess.getTime() + 86_400_000), lastSuccessfulScanAt: lastSuccess,
    })).toEqual({ outageDetected: false, deadlineAt: null, reason: "no scheduler deadline evidence is available" });
  });
});
