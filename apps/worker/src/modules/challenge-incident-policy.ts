export type ActiveChallengeIncidentStatus =
  | "DETECTED"
  | "COOLDOWN"
  | "MANUAL_VERIFICATION_REQUIRED"
  | "PROBE_PENDING"
  | "RECOVERING"
  | "REPEATED";

export function nextChallengeIncidentStatus(input: {
  activeStatus?: ActiveChallengeIncidentStatus;
  manualVerificationRequired: boolean;
}): ActiveChallengeIncidentStatus {
  if (
    input.manualVerificationRequired
    || input.activeStatus === "MANUAL_VERIFICATION_REQUIRED"
  ) {
    return "MANUAL_VERIFICATION_REQUIRED";
  }
  return input.activeStatus ? "REPEATED" : "COOLDOWN";
}

export function requiresManualChallengeVerification(input: {
  captchaDetected: boolean;
  priorConsecutiveErrors: number;
}): boolean {
  // The third consecutive protected response is no longer routine cooldown.
  // Keep the source paused and make the need for human review explicit.
  return input.captchaDetected && input.priorConsecutiveErrors >= 2;
}

// A source stuck in manual verification would otherwise go silently dark
// for days (pauses escalate to 3-7 days). One reminder per day keeps the
// human in the loop without spamming.
export const MANUAL_REMINDER_INTERVAL_MS = 24 * 3_600_000;
export const MANUAL_REMINDER_KEY_TTL_SECONDS = 7 * 86_400;

export function manualReminderKey(sourceId: string): string {
  return `challenge:manual-reminder:${sourceId}`;
}

export function shouldSendManualReminder(lastReminderAt: string | null, nowMs: number): boolean {
  if (!lastReminderAt) return true;
  const lastMs = new Date(lastReminderAt).getTime();
  if (Number.isNaN(lastMs)) return true;
  return nowMs - lastMs >= MANUAL_REMINDER_INTERVAL_MS;
}
