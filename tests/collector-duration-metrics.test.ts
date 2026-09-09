import { describe, expect, it } from "vitest";
import {
  buildCollectorDurationBreakdown,
  type CollectorDurationAggregateRow,
} from "../apps/api/src/lib/collector-duration-metrics.js";

describe("collector duration metrics", () => {
  it("keeps realtime, backfill and coverage percentiles semantically separate", () => {
    const rows: CollectorDurationAggregateRow[] = [
      row(null, "REALTIME", 100, 1_900),
      row(null, "BACKFILL", 4, 90_000),
      row(null, "COVERAGE", 20, 14_000),
      row("OLX", "REALTIME", 80, 2_100),
      row("CARS_UA", "REALTIME", 20, 900),
      row("OLX", "BACKFILL", 4, 90_000),
    ];

    const metrics = buildCollectorDurationBreakdown(rows);

    expect(metrics.realtimeDurationMs).toMatchObject({ count: 100, p95: 1_900 });
    expect(metrics.byLane.find((item) => item.lane === "BACKFILL")?.durationMs.p95).toBe(90_000);
    expect(metrics.bySourceLane.find((item) =>
      item.source === "OLX" && item.lane === "REALTIME")?.durationMs.p95).toBe(2_100);
    expect(metrics.totalCount).toBe(124);
  });

  it("returns an explicit empty realtime summary when the 24-hour window has no hot runs", () => {
    const metrics = buildCollectorDurationBreakdown([row(null, "BACKFILL", 1, 50_000)]);
    expect(metrics.realtimeDurationMs).toEqual({
      count: 0,
      avg: null,
      min: null,
      max: null,
      p50: null,
      p95: null,
    });
  });
});

function row(
  source: CollectorDurationAggregateRow["source"],
  lane: CollectorDurationAggregateRow["lane"],
  sampleCount: number,
  p95Ms: number,
): CollectorDurationAggregateRow {
  return {
    source,
    lane,
    sampleCount,
    averageMs: p95Ms,
    minimumMs: p95Ms,
    maximumMs: p95Ms,
    p50Ms: p95Ms,
    p95Ms,
  };
}
