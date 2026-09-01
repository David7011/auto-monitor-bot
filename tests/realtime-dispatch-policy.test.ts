import { describe, expect, it } from "vitest";
import {
  planRealtimeDispatch,
  realtimeHotHandoffEnabled,
} from "../apps/worker/src/modules/realtime-dispatch-policy.js";

describe("realtime dispatch policy", () => {
  it("keeps only the newest match inline and queues the rest", () => {
    expect(planRealtimeDispatch(["newest", "middle", "oldest"], 1)).toEqual({
      inline: ["newest"],
      queued: ["middle", "oldest"],
    });
  });

  it("queues the entire batch when the run-wide inline budget is exhausted", () => {
    expect(planRealtimeDispatch(["first", "second"], 0)).toEqual({
      inline: [],
      queued: ["first", "second"],
    });
  });

  it("never allocates more inline slots than available items", () => {
    expect(planRealtimeDispatch(["only"], 10)).toEqual({
      inline: ["only"],
      queued: [],
    });
  });
});

describe("realtime hot handoff", () => {
  it("enables the shortest path for every initialized realtime source", () => {
    const initializedAt = new Date("2026-08-16T00:00:00.000Z");
    expect(realtimeHotHandoffEnabled("REALTIME", initializedAt)).toBe(true);
    expect(realtimeHotHandoffEnabled("BACKFILL", initializedAt)).toBe(false);
    expect(realtimeHotHandoffEnabled("REALTIME", undefined)).toBe(false);
  });
});
