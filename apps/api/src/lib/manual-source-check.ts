import type { SourceStatus } from "@amb/db";

const PROTECTED_STATUSES: SourceStatus[] = ["RATE_LIMITED", "CAPTCHA_DETECTED", "PAUSED"];

export function manualSourceCheckBlocked(input: {
  status: SourceStatus;
  pausedUntil?: Date | null;
  now?: Date;
}): boolean {
  const now = input.now ?? new Date();
  return PROTECTED_STATUSES.includes(input.status)
    || Boolean(input.pausedUntil && input.pausedUntil > now);
}

export function safeSourceEnableTransition(input: {
  pausedUntil?: Date | null;
  now?: Date;
}): {
  status: "ACTIVE" | "PAUSED";
  pausedUntil: Date | null;
  nextCheckAt: Date;
  resetErrors: boolean;
} {
  const now = input.now ?? new Date();
  if (input.pausedUntil && input.pausedUntil > now) {
    return {
      status: "PAUSED",
      pausedUntil: input.pausedUntil,
      nextCheckAt: input.pausedUntil,
      resetErrors: false,
    };
  }
  return {
    status: "ACTIVE",
    pausedUntil: null,
    nextCheckAt: now,
    resetErrors: true,
  };
}
