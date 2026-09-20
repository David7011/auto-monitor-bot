import type { EffectiveCadenceMode, ListingDiscoveryLane } from "@amb/shared";

export type OlxOutageSchedule = {
  mode: EffectiveCadenceMode;
  nextExpectedRunAt: Date;
  jitterSeconds: number;
  schedulerToleranceSeconds: number;
};

export type OlxOutageDecision = {
  outageDetected: boolean;
  deadlineAt: Date | null;
  reason: string;
};

/**
 * A missed OLX run is measured from the exact deadline persisted by the
 * scheduler, never from a cadence-independent age threshold. Missing or
 * inconsistent scheduling evidence fails open to avoid false recovery load.
 */
export function detectOlxScheduledOutage(input: {
  source: string;
  lane: ListingDiscoveryLane;
  now: Date;
  lastSuccessfulScanAt?: Date;
  schedule?: OlxOutageSchedule;
}): OlxOutageDecision {
  if (input.source !== "OLX" || input.lane !== "REALTIME") {
    return noOutage("outage detection applies only to OLX realtime");
  }
  if (!input.lastSuccessfulScanAt) {
    return noOutage("no durable success boundary exists yet");
  }
  if (!input.schedule || !Number.isFinite(input.schedule.nextExpectedRunAt.getTime())) {
    return noOutage("no scheduler deadline evidence is available");
  }
  if (input.schedule.nextExpectedRunAt <= input.lastSuccessfulScanAt) {
    return noOutage("scheduler deadline does not follow the durable success boundary");
  }

  const graceMs = (
    Math.max(0, input.schedule.jitterSeconds)
    + Math.max(0, input.schedule.schedulerToleranceSeconds)
  ) * 1_000;
  const deadlineAt = new Date(input.schedule.nextExpectedRunAt.getTime() + graceMs);
  return {
    outageDetected: input.now > deadlineAt,
    deadlineAt,
    reason: input.now > deadlineAt
      ? `${input.schedule.mode} expected run missed beyond jitter and scheduler tolerance`
      : `${input.schedule.mode} run remains within its scheduler deadline`,
  };
}

function noOutage(reason: string): OlxOutageDecision {
  return { outageDetected: false, deadlineAt: null, reason };
}
