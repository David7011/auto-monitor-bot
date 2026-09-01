import { describe, expect, it } from "vitest";
import { OlxLaneArbiter } from "../apps/worker/src/modules/olx-lane-arbiter.js";

describe("OLX lane arbiter", () => {
  it("lets realtime run immediately and holds backfill until the quiet window", async () => {
    let now = 1_000;
    let releaseRealtime!: () => void;
    const realtimeBlocked = new Promise<void>((resolve) => {
      releaseRealtime = resolve;
    });
    const arbiter = new OlxLaneArbiter({
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
        if (now >= 1_050) releaseRealtime();
        await Promise.resolve();
      },
    });

    const realtime = arbiter.runRealtime(async () => {
      await realtimeBlocked;
      return "ok";
    });
    const backfill = arbiter.waitForBackfillWindow(new Date(2_000), 100);

    expect(await realtime).toBe("ok");
    expect(await backfill).toBe(true);
    expect(now).toBeGreaterThanOrEqual(1_150);
  });

  it("reserves only one backfill page per realtime completion", async () => {
    let now = 1_000;
    let nextRealtimeAt = 1_200;
    const arbiter = new OlxLaneArbiter({
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
        if (now >= nextRealtimeAt) {
          nextRealtimeAt = Number.POSITIVE_INFINITY;
          await arbiter.runRealtime(async () => undefined);
        }
      },
    });

    expect(await arbiter.waitForBackfillWindow(new Date(2_000), 0)).toBe(true);
    const secondPage = arbiter.waitForBackfillWindow(new Date(2_000), 0);
    expect(await secondPage).toBe(true);
    expect(now).toBeGreaterThanOrEqual(1_200);
  });
});
