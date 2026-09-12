import { olxProtectionCoolingState } from "./olx-protection-cooling.js";

export function olxParityPermission(input: {
  sourceStatus: string;
  pausedUntil?: Date | null;
  incidentDetectedAt?: Date | null;
  incidentCooldownUntil?: Date | null;
  coolingSeconds: number;
  now?: Date;
}): { allowed: boolean; reason: string | null } {
  const now = input.now ?? new Date();
  if (input.sourceStatus === "RATE_LIMITED" || input.sourceStatus === "CAPTCHA_DETECTED") {
    return { allowed: false, reason: `source status is ${input.sourceStatus}` };
  }
  if (input.pausedUntil && input.pausedUntil > now) {
    return { allowed: false, reason: `source pause is active until ${input.pausedUntil.toISOString()}` };
  }
  const cooling = olxProtectionCoolingState({
    detectedAt: input.incidentDetectedAt ?? undefined,
    cooldownUntil: input.incidentCooldownUntil ?? undefined,
    coolingSeconds: input.coolingSeconds,
    now,
  });
  return cooling.active
    ? { allowed: false, reason: `protection cooling is active until ${cooling.until?.toISOString() ?? "unknown"}` }
    : { allowed: true, reason: null };
}
