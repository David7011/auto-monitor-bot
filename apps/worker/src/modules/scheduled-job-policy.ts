export type ScheduledOlxJobLane = "REALTIME" | "BACKFILL" | "COVERAGE" | "MANUAL";
export type ScheduledOlxJobTrigger = "SCHEDULED" | "MANUAL" | "BACKFILL" | "RECOVERY" | "COVERAGE";

export type ScheduledJobExecutionState = {
  stale: boolean;
  reason: string | null;
};

export const OLX_REALTIME_JOB_MAX_EXECUTION_LAG_MS = 8_000;
export const OLX_BACKFILL_JOB_MAX_EXECUTION_LAG_MS = 30_000;

type ScheduledJobInput = {
  source: string;
  lane?: ScheduledOlxJobLane;
  trigger?: ScheduledOlxJobTrigger;
  scheduledAt?: string;
  manual?: boolean;
};

/**
 * Rejects persisted OLX queue entries which are no longer useful by the time a
 * worker gets them. Replaying such jobs after a reboot compresses old realtime
 * and backfill traffic into the first live cadence window.
 *
 * Manual work is intentionally exempt. Fresh backfill gets a wider window than
 * realtime so a normal high-priority page-one scan cannot starve depth recovery.
 */
export function scheduledOlxJobExecutionState(
  job: ScheduledJobInput,
  executedAt: Date = new Date(),
): ScheduledJobExecutionState {
  const trigger = job.trigger ?? (job.manual ? "MANUAL" : "SCHEDULED");
  const lane = job.lane
    ?? (
      trigger === "COVERAGE"
        ? "COVERAGE"
        : trigger === "BACKFILL" || trigger === "RECOVERY"
          ? "BACKFILL"
          : trigger === "MANUAL"
            ? "MANUAL"
            : "REALTIME"
    );

  // Recovery and reconciliation work is durable. It remains subject to
  // monitoring status/generation checks in the processor, but must not be
  // discarded merely because another OLX request delayed it.
  if (
    job.source !== "OLX"
    || trigger === "MANUAL"
    || trigger === "RECOVERY"
    || trigger === "COVERAGE"
    || lane === "MANUAL"
  ) {
    return { stale: false, reason: null };
  }

  const scheduledAtMs = job.scheduledAt ? Date.parse(job.scheduledAt) : Number.NaN;
  if (!Number.isFinite(scheduledAtMs)) {
    return {
      stale: true,
      reason: `OLX ${lane} scheduled job coalesced: scheduledAt is missing or invalid`,
    };
  }

  const executionLagMs = Math.max(0, executedAt.getTime() - scheduledAtMs);
  const maxExecutionLagMs = lane === "BACKFILL"
    ? OLX_BACKFILL_JOB_MAX_EXECUTION_LAG_MS
    : OLX_REALTIME_JOB_MAX_EXECUTION_LAG_MS;
  if (executionLagMs <= maxExecutionLagMs) return { stale: false, reason: null };

  return {
    stale: true,
    reason: `OLX ${lane} scheduled job coalesced: execution lag ${executionLagMs}ms exceeds ${maxExecutionLagMs}ms`,
  };
}
