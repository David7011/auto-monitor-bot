import { describe, expect, it } from "vitest";
import { decideRecoveryProgress } from "../apps/worker/src/modules/recovery-progress.js";

describe("durable OLX recovery progress", () => {
  it("moves monotonically through one deep page per cycle", () => {
    let progressPage = 1;
    for (const scannedPage of [1, 2, 3, 4]) {
      const decision = decideRecoveryProgress({
        currentProgressPage: progressPage,
        attemptedProgressPage: scannedPage + 1,
        currentConsecutiveNoProgress: 0,
      });
      expect(decision.progressed).toBe(true);
      expect(decision.progressPage).toBe(scannedPage + 1);
      progressPage = decision.progressPage;
    }
    expect(progressPage).toBe(5);
  });

  it("records consecutive NO_PROGRESS and applies bounded exponential backoff", () => {
    let consecutive = 0;
    const delays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const decision = decideRecoveryProgress({
        currentProgressPage: 3,
        attemptedProgressPage: 3,
        currentConsecutiveNoProgress: consecutive,
        noProgressReason: "BACKGROUND_SLOT_UNAVAILABLE",
      });
      consecutive = decision.consecutiveNoProgress;
      delays.push(decision.retryDelayMs);
      expect(decision.noProgressReason).toBe("BACKGROUND_SLOT_UNAVAILABLE");
    }
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000]);
  });

  it("never regresses after crash/restart with stale attempted progress", () => {
    expect(decideRecoveryProgress({
      currentProgressPage: 7,
      attemptedProgressPage: 2,
      currentConsecutiveNoProgress: 0,
      noProgressReason: "STALE_REPLAY",
    })).toMatchObject({ progressPage: 7, progressed: false, consecutiveNoProgress: 1 });
  });
});
