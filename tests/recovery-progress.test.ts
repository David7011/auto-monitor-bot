import { describe, expect, it } from "vitest";
import { decideRecoveryProgress } from "../apps/worker/src/modules/recovery-progress.js";
import { OlxLaneArbiter } from "../apps/worker/src/modules/olx-lane-arbiter.js";

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
        noProgressReason: "INCOMPLETE_PAGE_FEEDS",
      });
      consecutive = decision.consecutiveNoProgress;
      delays.push(decision.retryDelayMs);
      expect(decision.noProgressReason).toBe("INCOMPLETE_PAGE_FEEDS");
    }
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
  });

  it("finds a free realtime slot after repeated scheduling deferrals without origin requests", async () => {
    let now = 100_000;
    const arbiter = new OlxLaneArbiter({ now: () => now });
    let finishRealtime!: () => void;
    const realtime = arbiter.runRealtime(() => new Promise<void>((resolve) => { finishRealtime = resolve; }));
    const deadline = new Date(now + 90_000);
    let consecutive = 6;
    let requests = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (await arbiter.waitForBackfillWindow(deadline, 250)) requests += 1;
      const decision = decideRecoveryProgress({
        currentProgressPage: 2,
        attemptedProgressPage: 2,
        currentConsecutiveNoProgress: consecutive,
        noProgressReason: "BACKGROUND_SLOT_UNAVAILABLE",
      });
      expect(decision.retryDelayMs).toBe(5_000);
      consecutive = decision.consecutiveNoProgress;
      now += decision.retryDelayMs;
    }
    expect(requests).toBe(0);
    finishRealtime();
    await realtime;
    now += 5_000;
    expect(await arbiter.waitForBackfillWindow(deadline, 250)).toBe(true);
    expect(await arbiter.waitForBackfillWindow(deadline, 250)).toBe(false);
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
