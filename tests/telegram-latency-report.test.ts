import { describe, expect, it } from "vitest";
import { createTelegramLatencyReport } from "../apps/worker/src/modules/telegram-latency-report.js";

const now = new Date("2026-07-22T12:00:00.000Z");

describe("24-hour Telegram latency report", () => {
  it("waits for a complete post-baseline window", () => {
    const report = createTelegramLatencyReport({
      now,
      baselineAt: new Date("2026-07-22T11:00:00.000Z"),
      samples: [
        {
          source: "OLX",
          journalPersistedAt: new Date("2026-07-22T11:30:00.000Z"),
          telegramAcceptedAt: new Date("2026-07-22T11:30:02.000Z"),
        },
      ],
    });
    expect(report.status).toBe("COLLECTING");
    expect(report.windowHours).toBe(1);
    expect(report.latencyMs.p95).toBe(2_000);
    expect(report.target.passed).toBeNull();
  });

  it("calculates the final rolling p95 after 24 hours", () => {
    const report = createTelegramLatencyReport({
      now,
      baselineAt: new Date("2026-07-21T11:00:00.000Z"),
      minimumSampleSize: 2,
      samples: [
        {
          source: "OLX",
          journalPersistedAt: new Date("2026-07-22T10:00:00.000Z"),
          telegramAcceptedAt: new Date("2026-07-22T10:00:01.000Z"),
        },
        {
          source: "OLX",
          journalPersistedAt: new Date("2026-07-22T11:00:00.000Z"),
          telegramAcceptedAt: new Date("2026-07-22T11:00:04.000Z"),
        },
      ],
    });
    expect(report.status).toBe("READY");
    expect(report.windowComplete).toBe(true);
    expect(report.sampleSize).toBe(2);
    expect(report.remainingSamples).toBe(0);
    expect(report.latencyMs.p95).toBe(4_000);
    expect(report.bySource[0]?.source).toBe("OLX");
    expect(report.target.passed).toBe(false);
  });

  it("ignores invalid negative latency samples", () => {
    const report = createTelegramLatencyReport({
      now,
      baselineAt: new Date("2026-07-21T11:00:00.000Z"),
      samples: [{
        source: "OLX",
        journalPersistedAt: new Date("2026-07-22T11:00:00.000Z"),
        telegramAcceptedAt: new Date("2026-07-22T10:59:59.000Z"),
      }],
    });
    expect(report.status).toBe("LOW_SAMPLE");
    expect(report.sampleSize).toBe(0);
    expect(report.latencyMs.p95).toBeNull();
    expect(report.target.passed).toBeNull();
  });

  it("does not produce PASS or FAIL after 24 hours when the sample is undersized", () => {
    const report = createTelegramLatencyReport({
      now,
      baselineAt: new Date("2026-07-21T11:00:00.000Z"),
      minimumSampleSize: 3,
      samples: [
        {
          source: "OLX",
          journalPersistedAt: new Date("2026-07-22T10:00:00.000Z"),
          telegramAcceptedAt: new Date("2026-07-22T10:00:01.000Z"),
        },
        {
          source: "OLX",
          journalPersistedAt: new Date("2026-07-22T11:00:00.000Z"),
          telegramAcceptedAt: new Date("2026-07-22T11:00:02.000Z"),
        },
      ],
    });

    expect(report.status).toBe("LOW_SAMPLE");
    expect(report.windowComplete).toBe(true);
    expect(report.minimumSampleSize).toBe(3);
    expect(report.remainingSamples).toBe(1);
    expect(report.latencyMs.p95).toBe(2_000);
    expect(report.target.passed).toBeNull();
  });

  it("ignores samples outside the rolling window or with a future notification", () => {
    const report = createTelegramLatencyReport({
      now,
      baselineAt: new Date("2026-07-20T12:00:00.000Z"),
      minimumSampleSize: 1,
      samples: [
        {
          source: "OLX",
          journalPersistedAt: new Date("2026-07-21T11:59:59.999Z"),
          telegramAcceptedAt: new Date("2026-07-21T12:00:01.000Z"),
        },
        {
          source: "OLX",
          journalPersistedAt: new Date("2026-07-22T11:59:59.000Z"),
          telegramAcceptedAt: new Date("2026-07-22T12:00:01.000Z"),
        },
      ],
    });

    expect(report.status).toBe("LOW_SAMPLE");
    expect(report.sampleSize).toBe(0);
    expect(report.target.passed).toBeNull();
  });

  it("keeps collecting without a valid baseline even when enough samples exist", () => {
    const report = createTelegramLatencyReport({
      now,
      baselineAt: new Date("2026-07-23T12:00:00.000Z"),
      minimumSampleSize: 1,
      samples: [{
        source: "OLX",
        journalPersistedAt: new Date("2026-07-22T11:00:00.000Z"),
        telegramAcceptedAt: new Date("2026-07-22T11:00:01.000Z"),
      }],
    });

    expect(report.baselineAt).toBeNull();
    expect(report.status).toBe("COLLECTING");
    expect(report.target.passed).toBeNull();
  });
});
