import { describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "../packages/shared/src/constants/queues.js";
import {
  collectorLockScope,
  collectorQueueForJob,
  resolveLane,
  resolveTrigger,
  scanOptions,
  type CollectorRunJob,
} from "../apps/worker/src/processors/collector-run-helpers.js";
import {
  coverageJobId,
  nextCoverageTickAfterAttempt,
  startupCoverageDeadline,
} from "../apps/api/src/modules/monitoring/coverage-schedule.js";

describe("durable collector.coverage queue", () => {
  const job: CollectorRunJob = { source: "OLX", trigger: "COVERAGE" };

  it("uses an independent queue and lock while retaining low-priority dispatch semantics", () => {
    const lane = resolveLane(job);
    expect(lane).toBe("COVERAGE");
    expect(resolveTrigger(job)).toBe("COVERAGE");
    expect(collectorQueueForJob(job, lane)).toBe(QUEUE_NAMES.COLLECTOR_COVERAGE);
    expect(collectorLockScope(job, lane)).toBe("COVERAGE");
    expect(collectorLockScope({ source: "OLX", trigger: "BACKFILL" }, "BACKFILL")).toBe("BACKFILL");
  });

  it("bounds coverage to one shallow cycle and identifies it explicitly", () => {
    const scan = scanOptions(job, "COVERAGE");
    expect(scan).toMatchObject({
      lane: "COVERAGE",
      coverageOnly: true,
      maxPages: 1,
      backfillProfile: undefined,
      recovery: false,
    });
    expect(scan.deadlineAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("upgrades pre-deploy persisted coverage jobs instead of trusting their old BACKFILL lane", () => {
    const legacyJob: CollectorRunJob = {
      source: "OLX",
      trigger: "COVERAGE",
      lane: "BACKFILL",
    };
    expect(resolveLane(legacyJob)).toBe("COVERAGE");
    expect(collectorQueueForJob(legacyJob, resolveLane(legacyJob))).toBe(QUEUE_NAMES.COLLECTOR_COVERAGE);
  });

  it("persists startup timing and produces BullMQ-safe idempotent IDs", () => {
    const now = new Date("2026-08-30T10:00:00.000Z");
    expect(startupCoverageDeadline(now, null, 30).toISOString()).toBe("2026-08-30T10:00:30.000Z");
    expect(startupCoverageDeadline(now, new Date(now.getTime() - 1_000), 30)).toEqual(now);
    expect(nextCoverageTickAfterAttempt(now, 60).toISOString()).toBe("2026-08-30T10:01:00.000Z");
    expect(coverageJobId(7, now)).toBe("collector-coverage-OLX-7-1788084000000");
    expect(coverageJobId(7, now)).not.toContain(":");
  });
});
