import type { ListingSource } from "@amb/db";

export type BackfillProfile = "FULL" | "LIGHT";

// Coverage is deliberately absent: a shallow reconciliation run must never
// refresh the last real depth-recovery boundary or influence adaptive policy.
export const BACKFILL_EVIDENCE_TRIGGERS = ["BACKFILL", "RECOVERY"] as const;

export type BackfillRunEvidence = {
  startedAt: Date;
  status: string;
  recoveredCount: number;
  errorMessage?: string | null;
  profile: BackfillProfile;
};

export type AdaptiveBackfillEvidence = {
  runs: BackfillRunEvidence[];
  unresolvedObservationCount: number;
  realtimeAnomalyAt?: Date;
  adverseAuditAt?: Date;
};

export type AdaptiveBackfillDecision = {
  mode: "RECOVERY" | "EVIDENCE" | "LEAN" | "PERIODIC_FULL" | "PROTECTION";
  profile: BackfillProfile;
  intervalSeconds: number;
  reason: string;
};

const CLEAN_RUNS_REQUIRED = 8;
const RECOVERY_CONFIRMATION_RUNS = 2;
const LEAN_INTERVAL_MULTIPLIER = 5;
const MAX_LEAN_INTERVAL_SECONDS = 15 * 60;
const PERIODIC_FULL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PROTECTION_LOOKBACK_MS = 30 * 60 * 1000;
const PROTECTION_INTERVAL_SECONDS = 30 * 60;
const PROTECTION_PROBE_INTERVAL_SECONDS = 10 * 60;
const PROTECTION_CLEAN_RUNS_REQUIRED = 2;
const PROTECTION_OBSERVATION_MS = 6 * 60 * 60 * 1000;

/**
 * Converts the active filter selections into sources that have useful work.
 * An empty source array intentionally means "all sources"; no filters means
 * there is no search context and therefore nothing should be scheduled.
 */
export function targetedSources(
  filters: ReadonlyArray<{ sources: readonly ListingSource[] }>,
  candidates: readonly ListingSource[],
): Set<ListingSource> {
  if (filters.length === 0) return new Set();
  if (filters.some((filter) => filter.sources.length === 0)) return new Set(candidates);

  const available = new Set(candidates);
  const targets = new Set<ListingSource>();
  for (const filter of filters) {
    for (const source of filter.sources) {
      if (available.has(source)) targets.add(source);
    }
  }
  return targets;
}

/**
 * Keep the expensive OLX safety lane aggressive whenever there is evidence of
 * a gap. Only a consecutive, recent zero-recovery history may enter lean mode.
 */
export function decideAdaptiveBackfill(
  evidence: AdaptiveBackfillEvidence,
  baseIntervalSeconds: number,
  now = new Date(),
): AdaptiveBackfillDecision {
  const baseInterval = Math.max(1, Math.floor(baseIntervalSeconds));
  const latestRun = evidence.runs[0];

  const protectedRun = evidence.runs.find((run) =>
    run.status === "RATE_LIMITED" || run.status === "CAPTCHA_DETECTED"
  );
  if (protectedRun) {
    const protectionAgeMs = now.getTime() - protectedRun.startedAt.getTime();
    const newerRuns = evidence.runs.filter((run) => run.startedAt > protectedRun.startedAt);
    const newerRecoveredRun = newerRuns.find((run) => run.recoveredCount > 0);
    if (newerRecoveredRun) {
      return {
        mode: "RECOVERY",
        profile: "FULL",
        intervalSeconds: Math.max(baseInterval, PROTECTION_PROBE_INTERVAL_SECONDS),
        reason: `post-protection probe recovered ${newerRecoveredRun.recoveredCount} advert(s)`,
      };
    }

    const cleanAfterProtection = consecutiveCleanRuns(newerRuns);
    if (protectionAgeMs < PROTECTION_LOOKBACK_MS || cleanAfterProtection < PROTECTION_CLEAN_RUNS_REQUIRED) {
      const intervalSeconds = protectionAgeMs < PROTECTION_LOOKBACK_MS
        ? PROTECTION_INTERVAL_SECONDS
        : PROTECTION_PROBE_INTERVAL_SECONDS;
      return {
        mode: "PROTECTION",
        profile: "LIGHT",
        intervalSeconds: Math.max(intervalSeconds, baseInterval),
        reason: `backfill protection event ${protectedRun.status}; clean probes ${cleanAfterProtection}/${PROTECTION_CLEAN_RUNS_REQUIRED}`,
      };
    }
    if (protectionAgeMs < PROTECTION_OBSERVATION_MS) {
      return {
        mode: "LEAN",
        profile: "LIGHT",
        intervalSeconds: leanIntervalSeconds(baseInterval),
        reason: `${cleanAfterProtection} clean probes after protection; full depth remains deferred until the 6h audit`,
      };
    }
  }

  if (!latestRun || now.getTime() - latestRun.startedAt.getTime() > 15 * 60 * 1000) {
    return recoveryDecision(baseInterval, "recent backfill evidence is missing or stale");
  }

  if (evidence.unresolvedObservationCount > 0) {
    return recoveryDecision(baseInterval, `${evidence.unresolvedObservationCount} unresolved OLX observation(s)`);
  }
  if (eventStillNeedsRecovery(evidence.realtimeAnomalyAt, evidence.runs)) {
    return recoveryDecision(baseInterval, `recent OLX realtime anomaly at ${evidence.realtimeAnomalyAt.toISOString()}`);
  }
  if (eventStillNeedsRecovery(evidence.adverseAuditAt, evidence.runs)) {
    return recoveryDecision(baseInterval, `recent completeness recovery at ${evidence.adverseAuditAt.toISOString()}`);
  }
  if (latestRun.status !== "SUCCESS" || latestRun.errorMessage) {
    return recoveryDecision(
      baseInterval,
      `latest backfill status is ${latestRun.status}${latestRun.errorMessage ? `: ${latestRun.errorMessage}` : ""}`,
    );
  }

  const recoveredRun = evidence.runs.find((run) => run.recoveredCount > 0);
  if (recoveredRun && eventStillNeedsRecovery(recoveredRun.startedAt, evidence.runs)) {
    return recoveryDecision(
      baseInterval,
      `backfill recovered ${recoveredRun.recoveredCount} advert(s) at ${recoveredRun.startedAt.toISOString()}`,
    );
  }

  const cleanStreak = consecutiveCleanRuns(evidence.runs);
  if (cleanStreak < CLEAN_RUNS_REQUIRED) {
    return {
      mode: "EVIDENCE",
      profile: "LIGHT",
      intervalSeconds: baseInterval,
      reason: `collecting clean zero-recovery evidence (${cleanStreak}/${CLEAN_RUNS_REQUIRED})`,
    };
  }

  const lastFullRun = evidence.runs.find((run) => run.profile === "FULL");
  if (!lastFullRun || now.getTime() - lastFullRun.startedAt.getTime() >= PERIODIC_FULL_INTERVAL_MS) {
    return {
      mode: "PERIODIC_FULL",
      profile: "FULL",
      intervalSeconds: leanIntervalSeconds(baseInterval),
      reason: "periodic full-depth completeness audit is due",
    };
  }

  return {
    mode: "LEAN",
    profile: "LIGHT",
    intervalSeconds: leanIntervalSeconds(baseInterval),
    reason: `${cleanStreak} consecutive clean zero-recovery backfills; full audit remains scheduled every 6h`,
  };
}

export function backfillDue(
  lastRunAt: Date | undefined,
  decision: Pick<AdaptiveBackfillDecision, "intervalSeconds">,
  now = new Date(),
): boolean {
  if (!lastRunAt) return true;
  return now.getTime() - lastRunAt.getTime() >= decision.intervalSeconds * 1000;
}

export function backfillProfileFromMetrics(value: unknown): BackfillProfile {
  if (!Array.isArray(value)) return "FULL";
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.kind !== "backfill-policy") continue;
    if (record.profile === "LIGHT") return "LIGHT";
    if (record.profile === "FULL") return "FULL";
  }
  // Runs created before adaptive scheduling were full-depth runs.
  return "FULL";
}

function consecutiveCleanRuns(runs: readonly BackfillRunEvidence[]): number {
  let count = 0;
  for (const run of runs) {
    if (run.status !== "SUCCESS" || run.recoveredCount > 0 || run.errorMessage) break;
    count += 1;
  }
  return count;
}

function eventStillNeedsRecovery(
  eventAt: Date | undefined,
  runs: readonly BackfillRunEvidence[],
): eventAt is Date {
  if (!eventAt) return false;
  const confirmationRuns = runs.slice(0, RECOVERY_CONFIRMATION_RUNS);
  if (confirmationRuns.length < RECOVERY_CONFIRMATION_RUNS) return true;
  return !confirmationRuns.every((run) =>
      run.startedAt > eventAt
      && run.status === "SUCCESS"
      && run.recoveredCount === 0
      && !run.errorMessage
  );
}

function recoveryDecision(baseInterval: number, reason: string): AdaptiveBackfillDecision {
  return {
    mode: "RECOVERY",
    profile: "FULL",
    intervalSeconds: baseInterval,
    reason,
  };
}

function leanIntervalSeconds(baseInterval: number): number {
  return Math.max(baseInterval, Math.min(MAX_LEAN_INTERVAL_SECONDS, baseInterval * LEAN_INTERVAL_MULTIPLIER));
}
