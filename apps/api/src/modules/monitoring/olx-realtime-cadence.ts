export type OlxRealtimeCadenceMode = "HEALTHY" | "RECOVERY_INITIAL" | "RECOVERY_RAMP";

export type OlxRealtimeCadenceDecision = {
  mode: OlxRealtimeCadenceMode;
  intervalSeconds: number;
  jitterSeconds: number;
  reason: string;
};

type ProtectionIncidentTiming = {
  status: string;
  detectedAt: Date;
  cooldownUntil: Date | null;
  recoveredAt: Date | null;
};

const RECOVERY_INITIAL_INTERVAL_SECONDS = 60;
const RECOVERY_INITIAL_JITTER_SECONDS = 10;
const RECOVERY_RAMP_INTERVAL_SECONDS = 30;
const RECOVERY_RAMP_JITTER_SECONDS = 6;

/**
 * Keeps the normal OLX hot path fast, but never jumps directly from a
 * protection probe to full cadence. Active incidents remain at the initial
 * recovery cadence until the worker has explicitly resolved them.
 */
export function decideOlxRealtimeCadence(input: {
  configuredIntervalSeconds: number;
  configuredJitterSeconds: number;
  recoveryRampSeconds: number;
  incident?: ProtectionIncidentTiming | null;
  now?: Date;
}): OlxRealtimeCadenceDecision {
  const intervalSeconds = positiveInteger(input.configuredIntervalSeconds, 20);
  const jitterSeconds = nonNegativeInteger(input.configuredJitterSeconds, 4);
  const healthy: OlxRealtimeCadenceDecision = {
    mode: "HEALTHY",
    intervalSeconds,
    jitterSeconds,
    reason: "no recent OLX protection recovery",
  };
  const incident = input.incident;
  if (!incident) return healthy;

  const recoveredAt = incident.recoveredAt;
  const unresolved = incident.status !== "RESOLVED" || !recoveredAt;
  if (unresolved) {
    return recoveryInitial(intervalSeconds, jitterSeconds, "OLX protection incident is not resolved");
  }

  const rampSeconds = Math.max(0, nonNegativeInteger(input.recoveryRampSeconds, 0));
  if (rampSeconds === 0) return healthy;
  const now = input.now ?? new Date();
  const elapsedSeconds = Math.max(0, (now.getTime() - recoveredAt.getTime()) / 1_000);
  if (elapsedSeconds < rampSeconds / 2) {
    return recoveryInitial(
      intervalSeconds,
      jitterSeconds,
      `OLX protection recovery age ${Math.floor(elapsedSeconds)}s is in the initial ramp stage`,
    );
  }
  if (elapsedSeconds < rampSeconds) {
    return {
      mode: "RECOVERY_RAMP",
      intervalSeconds: Math.max(intervalSeconds, RECOVERY_RAMP_INTERVAL_SECONDS),
      jitterSeconds: Math.max(jitterSeconds, RECOVERY_RAMP_JITTER_SECONDS),
      reason: `OLX protection recovery age ${Math.floor(elapsedSeconds)}s is in the final ramp stage`,
    };
  }
  return healthy;
}

function recoveryInitial(
  intervalSeconds: number,
  jitterSeconds: number,
  reason: string,
): OlxRealtimeCadenceDecision {
  return {
    mode: "RECOVERY_INITIAL",
    intervalSeconds: Math.max(intervalSeconds, RECOVERY_INITIAL_INTERVAL_SECONDS),
    jitterSeconds: Math.max(jitterSeconds, RECOVERY_INITIAL_JITTER_SECONDS),
    reason,
  };
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.trunc(value)) : fallback;
}

function nonNegativeInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.max(0, Math.trunc(value)) : fallback;
}
