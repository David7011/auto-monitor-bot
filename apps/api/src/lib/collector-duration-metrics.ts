import type { MetricSummary, SourceKind } from "@amb/shared";

export const COLLECTOR_DURATION_MIN_SAMPLE_SIZE = 30;

export type CollectorMetricLane = "REALTIME" | "BACKFILL" | "COVERAGE" | "MANUAL";

export type CollectorDurationAggregateRow = {
  source: SourceKind | null;
  lane: CollectorMetricLane;
  sampleCount: number;
  averageMs: number | null;
  minimumMs: number | null;
  maximumMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
};

export type CollectorDurationMetric = {
  lane: CollectorMetricLane;
  durationMs: MetricSummary;
};

export type CollectorSourceDurationMetric = CollectorDurationMetric & {
  source: SourceKind;
};

export function buildCollectorDurationBreakdown(rows: readonly CollectorDurationAggregateRow[]) {
  const byLane = rows
    .filter((row) => row.source == null)
    .map((row) => ({ lane: row.lane, durationMs: metricSummary(row) }));
  const bySourceLane = rows
    .filter((row): row is CollectorDurationAggregateRow & { source: SourceKind } => row.source != null)
    .map((row) => ({ source: row.source, lane: row.lane, durationMs: metricSummary(row) }));
  const realtimeDurationMs = byLane.find((row) => row.lane === "REALTIME")?.durationMs
    ?? emptyMetricSummary();

  return {
    realtimeDurationMs,
    byLane,
    bySourceLane,
    totalCount: byLane.reduce((sum, row) => sum + row.durationMs.count, 0),
  };
}

function metricSummary(row: CollectorDurationAggregateRow): MetricSummary {
  return {
    count: row.sampleCount,
    avg: row.averageMs,
    min: row.minimumMs,
    max: row.maximumMs,
    p50: row.p50Ms,
    p95: row.p95Ms,
    p99: row.p99Ms,
  };
}

function emptyMetricSummary(): MetricSummary {
  return { count: 0, avg: null, min: null, max: null, p50: null, p95: null, p99: null };
}
