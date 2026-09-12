import { describe, expect, it } from "vitest";
import {
  groupCount,
  evaluateLatencyRegression,
  percentile,
  qualifyMetricSummary,
  splitSessionJournalLatencies,
  summarizeJournalLatencies,
  summarizeMetric,
} from "../packages/shared/src/utils/metrics.js";

describe("metrics summary", () => {
  it("returns an empty summary without invented values", () => {
    expect(summarizeMetric([])).toEqual({
      count: 0,
      avg: null,
      min: null,
      max: null,
      p50: null,
      p95: null,
      p99: null,
    });
  });

  it("summarizes an unsorted sample with nearest-rank percentiles", () => {
    expect(summarizeMetric([100, 10, 50, 30])).toEqual({
      count: 4,
      avg: 48,
      min: 10,
      max: 100,
      p50: 30,
      p95: 100,
      p99: 100,
    });
  });

  it("does not publish unstable p95 or p99 tails from a small sample", () => {
    const small = qualifyMetricSummary(summarizeMetric(Array.from({ length: 29 }, (_, index) => index + 1)));
    expect(small).toMatchObject({
      count: 29,
      status: "INSUFFICIENT_DATA",
      p50: 15,
      p95: null,
      p99: null,
      ready: { p50: true, p95: false, p99: false },
    });

    const p95Ready = qualifyMetricSummary(summarizeMetric(Array.from({ length: 30 }, (_, index) => index + 1)));
    expect(p95Ready).toMatchObject({ status: "READY", p95: 29, p99: null });

    const tailsReady = qualifyMetricSummary(summarizeMetric(Array.from({ length: 100 }, (_, index) => index + 1)));
    expect(tailsReady).toMatchObject({ status: "READY", p50: 50, p95: 95, p99: 99 });
  });

  it("gates deterministic p95 regressions only after both cohorts are large enough", () => {
    const summary = (count: number, tailMs: number) => summarizeMetric([
      ...Array.from({ length: Math.max(0, count - 2) }, () => 100),
      tailMs,
      tailMs,
    ]);
    expect(evaluateLatencyRegression({
      baseline: summary(29, 200), candidate: summary(30, 210), maximumGrowthRatio: 1.1,
    }).status).toBe("INSUFFICIENT_DATA");
    expect(evaluateLatencyRegression({
      baseline: summary(30, 200), candidate: summary(30, 210), maximumGrowthRatio: 1.1,
    })).toMatchObject({ status: "PASS", maximumCandidateP95Ms: 220 });
    expect(evaluateLatencyRegression({
      baseline: summary(30, 200), candidate: summary(30, 250), maximumGrowthRatio: 1.1,
    })).toMatchObject({ status: "FAIL", maximumCandidateP95Ms: 220 });
  });

  it("reads grouped Prisma-style counts", () => {
    const groups = [
      { status: "SENT", _count: { _all: 3 } },
      { status: "FAILED", _count: { _all: 1 } },
    ];
    expect(groupCount(groups, "status", "SENT")).toBe(3);
    expect(groupCount(groups, "status", "PENDING")).toBe(0);
  });

  it("keeps percentile indices inside the sample", () => {
    expect(percentile([5], 0.95)).toBe(5);
  });

  it("summarizes durable-journal stages independently and only trusts precise publication timestamps", () => {
    const summary = summarizeJournalLatencies([
      {
        source: "OLX",
        publishedAt: new Date("2026-07-22T10:00:00.000Z"),
        firstSeenAt: new Date("2026-07-22T10:00:02.000Z"),
        notifiedAt: new Date("2026-07-22T10:00:05.000Z"),
        timestampConfidence: "HIGH",
        requestStartedAt: new Date("2026-07-22T10:00:00.100Z"),
        firstByteAt: new Date("2026-07-22T10:00:00.300Z"),
        bodyReceivedAt: new Date("2026-07-22T10:00:00.320Z"),
        parsedAt: new Date("2026-07-22T10:00:00.340Z"),
        hotCandidateAt: new Date("2026-07-22T10:00:00.350Z"),
        journalPersistedAt: new Date("2026-07-22T10:00:00.400Z"),
        filterCompletedAt: new Date("2026-07-22T10:00:00.500Z"),
        dispatchAttemptedAt: new Date("2026-07-22T10:00:00.500Z"),
        telegramRequestedAt: new Date("2026-07-22T10:00:00.650Z"),
        telegramAcceptedAt: new Date("2026-07-22T10:00:00.900Z"),
      },
      {
        source: "RST",
        publishedAt: new Date("2026-07-22T10:01:00.000Z"),
        firstSeenAt: new Date("2026-07-22T10:01:01.000Z"),
        notifiedAt: new Date("2026-07-22T10:01:05.000Z"),
        timestampConfidence: "UNKNOWN",
      },
      {
        source: "OLX",
        publishedAt: new Date("2026-07-22T10:02:02.000Z"),
        firstSeenAt: new Date("2026-07-22T10:02:01.000Z"),
        notifiedAt: new Date("2026-07-22T10:02:03.000Z"),
        timestampConfidence: "MEDIUM",
      },
      {
        source: "CARS_UA",
        publishedAt: new Date("2026-07-22T10:03:00.000Z"),
        firstSeenAt: new Date("2026-07-22T10:03:06.000Z"),
        notifiedAt: null,
        timestampConfidence: "MEDIUM",
      },
    ]);

    expect(summary.publicationTimestampToFirstSeenMs).toMatchObject({ count: 2, p50: 2_000, p95: 6_000 });
    expect(summary.firstSeenToTelegramMs).toMatchObject({ count: 3, p50: 3_000, p95: 4_000 });
    expect(summary.publicationTimestampToTelegramMs).toMatchObject({ count: 1, p95: 5_000 });
    expect(summary.requestStartToFirstByteMs).toMatchObject({ count: 1, p95: 200 });
    expect(summary.firstByteToBodyReceivedMs).toMatchObject({ count: 1, p95: 20 });
    expect(summary.bodyReceivedToParsedMs).toMatchObject({ count: 1, p95: 20 });
    expect(summary.parsedToHotCandidateMs).toMatchObject({ count: 1, p95: 10 });
    expect(summary.firstByteToHotCandidateMs).toMatchObject({ count: 1, p95: 50 });
    expect(summary.hotCandidateToDurableJournalMs).toMatchObject({ count: 1, p95: 50 });
    expect(summary.hotCandidateToTelegramAcceptanceMs).toMatchObject({ count: 1, p95: 550 });
    expect(summary.durableJournalToFilterCompletedMs).toMatchObject({ count: 1, p95: 100 });
    expect(summary.durableJournalToTelegramRequestMs).toMatchObject({ count: 1, p95: 250 });
    expect(summary.filterCompletedToTelegramRequestMs).toMatchObject({ count: 1, p95: 150 });
    expect(summary.dispatchAttemptedToTelegramRequestMs).toMatchObject({ count: 1, p95: 150 });
    expect(summary.telegramRequestToTelegramAcceptanceMs).toMatchObject({ count: 1, p95: 250 });
    expect(summary.durableJournalToTelegramAcceptanceMs).toMatchObject({ count: 1, p95: 500 });
    expect(summary.requestStartToTelegramAcceptanceMs).toMatchObject({ count: 1, p95: 800 });
  });

  it("separates startup catch-up from steady-state delivery", () => {
    const startedAt = new Date("2026-07-22T10:00:00.000Z");
    const sample = (firstSeenAt: string, notifiedAt: string) => ({
      source: "OLX",
      publishedAt: new Date("2026-07-22T09:50:00.000Z"),
      firstSeenAt: new Date(firstSeenAt),
      notifiedAt: new Date(notifiedAt),
      timestampConfidence: "HIGH",
    });
    const split = splitSessionJournalLatencies([
      sample("2026-07-22T10:00:30.000Z", "2026-07-22T10:00:36.000Z"),
      sample("2026-07-22T10:03:00.000Z", "2026-07-22T10:03:01.000Z"),
      sample("2026-07-22T09:59:00.000Z", "2026-07-22T09:59:01.000Z"),
    ], startedAt);

    expect(split.catchUp).toMatchObject({ observations: 1, firstSeenToTelegramMs: { p95: 6_000 } });
    expect(split.steadyState).toMatchObject({ observations: 1, firstSeenToTelegramMs: { p95: 1_000 } });
  });
});
