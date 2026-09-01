import { describe, expect, it } from "vitest";
import {
  OLX_BACKFILL_JOB_MAX_EXECUTION_LAG_MS,
  OLX_REALTIME_JOB_MAX_EXECUTION_LAG_MS,
  scheduledOlxJobExecutionState,
} from "../apps/worker/src/modules/scheduled-job-policy.js";

describe("scheduled OLX job execution policy", () => {
  const now = new Date("2026-07-29T16:10:00.000Z");

  it("coalesces persisted realtime work after its useful cadence window", () => {
    const result = scheduledOlxJobExecutionState({
      source: "OLX",
      lane: "REALTIME",
      trigger: "SCHEDULED",
      scheduledAt: new Date(now.getTime() - OLX_REALTIME_JOB_MAX_EXECUTION_LAG_MS - 1).toISOString(),
    }, now);

    expect(result.stale).toBe(true);
    expect(result.reason).toContain("execution lag");
  });

  it("coalesces persisted backfill work instead of replaying it after reboot", () => {
    const result = scheduledOlxJobExecutionState({
      source: "OLX",
      lane: "BACKFILL",
      trigger: "BACKFILL",
      scheduledAt: new Date(now.getTime() - OLX_BACKFILL_JOB_MAX_EXECUTION_LAG_MS - 1).toISOString(),
    }, now);

    expect(result.stale).toBe(true);
    expect(result.reason).toContain("BACKFILL");
  });

  it("keeps a fresh backfill runnable at the full safety-window boundary", () => {
    const result = scheduledOlxJobExecutionState({
      source: "OLX",
      lane: "BACKFILL",
      trigger: "BACKFILL",
      scheduledAt: new Date(now.getTime() - OLX_BACKFILL_JOB_MAX_EXECUTION_LAG_MS).toISOString(),
    }, now);

    expect(result).toEqual({ stale: false, reason: null });
  });

  it("keeps event-driven recovery durable even when another depth scan delays it", () => {
    const result = scheduledOlxJobExecutionState({
      source: "OLX",
      lane: "BACKFILL",
      trigger: "RECOVERY",
      scheduledAt: new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString(),
    }, now);

    expect(result).toEqual({ stale: false, reason: null });
  });

  it("keeps coverage durable when OLX pacing delays its worker", () => {
    const result = scheduledOlxJobExecutionState({
      source: "OLX",
      lane: "COVERAGE",
      trigger: "COVERAGE",
      scheduledAt: new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString(),
    }, now);

    expect(result).toEqual({ stale: false, reason: null });
  });

  it("rejects undated scheduled OLX work because its freshness cannot be proven", () => {
    expect(scheduledOlxJobExecutionState({
      source: "OLX",
      lane: "REALTIME",
      trigger: "SCHEDULED",
    }, now)).toMatchObject({ stale: true });
  });

  it("never applies automatic age coalescing to manual or non-OLX jobs", () => {
    const old = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();

    expect(scheduledOlxJobExecutionState({
      source: "OLX",
      lane: "MANUAL",
      trigger: "MANUAL",
      scheduledAt: old,
    }, now)).toEqual({ stale: false, reason: null });
    expect(scheduledOlxJobExecutionState({
      source: "RST",
      lane: "REALTIME",
      trigger: "SCHEDULED",
      scheduledAt: old,
    }, now)).toEqual({ stale: false, reason: null });
  });
});
