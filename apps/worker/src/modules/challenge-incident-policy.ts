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
