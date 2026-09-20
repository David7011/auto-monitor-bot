import { describe, expect, it } from "vitest";
import { OlxLaneArbiter } from "../apps/worker/src/modules/olx-lane-arbiter.js";

describe("OLX lane arbiter", () => {
  it("defers immediately while realtime owns the slot instead of waiting", async () => {
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
    expect(await arbiter.waitForBackfillWindow(new Date(2_000), 100)).toBe(false);
    releaseRealtime();
    expect(await realtime).toBe("ok");
    now += 100;
    expect(await arbiter.waitForBackfillWindow(new Date(2_000), 100)).toBe(true);
  });

  it("reserves only one backfill page per realtime completion", async () => {
    let now = 1_000;
    const arbiter = new OlxLaneArbiter({
      now: () => now,
    });

    expect(await arbiter.waitForBackfillWindow(new Date(2_000), 0)).toBe(true);
    expect(await arbiter.waitForBackfillWindow(new Date(2_000), 0)).toBe(false);
    now = 1_200;
    await arbiter.runRealtime(async () => undefined);
    expect(await arbiter.waitForBackfillWindow(new Date(2_000), 0)).toBe(true);
  });
});
