import { describe, expect, it } from "vitest";
import {
  groupCount,
  percentile,
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
    });
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
        hotCandidateAt: new Date("2026-07-22T10:00:00.350Z"),
        journalPersistedAt: new Date("2026-07-22T10:00:00.400Z"),
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
    expect(summary.firstByteToHotCandidateMs).toMatchObject({ count: 1, p95: 50 });
    expect(summary.hotCandidateToDurableJournalMs).toMatchObject({ count: 1, p95: 50 });
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
