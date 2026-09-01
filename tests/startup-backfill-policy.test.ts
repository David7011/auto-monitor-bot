import { describe, expect, it } from "vitest";
import {
  DEFERRED_BACKFILL_RETRY_SECONDS,
  deferOlxBackfillAfterRealtime,
  MIN_STARTUP_BACKFILL_DELAY_SECONDS,
  nextBackfillTickAfterAttempt,
  startupBackfillDeadline,
} from "../apps/api/src/modules/monitoring/startup-backfill-policy.js";

describe("startup backfill policy", () => {
  it("rebases an overdue backfill at least sixty seconds after resume", () => {
    const now = new Date("2026-07-29T14:32:18.000Z");
    const deadline = startupBackfillDeadline(
      now,
      new Date("2026-07-29T14:30:00.000Z"),
      15,
    );

    expect(deadline.getTime() - now.getTime()).toBe(MIN_STARTUP_BACKFILL_DELAY_SECONDS * 1_000);
  });

  it("does not shorten an already safe future deadline", () => {
    const now = new Date("2026-07-29T14:32:18.000Z");
    const existing = new Date("2026-07-29T14:35:00.000Z");
    expect(startupBackfillDeadline(now, existing, 15)).toEqual(existing);
  });

  it("defers only OLX backfill when OLX realtime was enqueued in the same tick", () => {
    const realtime = new Set(["OLX"] as const);
    expect(deferOlxBackfillAfterRealtime("OLX", realtime)).toBe(true);
    expect(deferOlxBackfillAfterRealtime("RST", realtime)).toBe(false);
  });

  it("re-arms a deferred cycle after a short safe delay instead of consuming it", () => {
    const now = new Date("2026-07-29T14:32:18.000Z");
    const retry = nextBackfillTickAfterAttempt(now, 120, true);
    const normal = nextBackfillTickAfterAttempt(now, 120, false);

    expect(retry.getTime() - now.getTime()).toBe(DEFERRED_BACKFILL_RETRY_SECONDS * 1_000);
    expect(normal.getTime() - now.getTime()).toBe(120_000);
  });
});
