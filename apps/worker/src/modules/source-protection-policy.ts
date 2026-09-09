import type { ListingSource } from "@amb/db";
import { protectionPauseSeconds } from "@amb/shared";

const RST_REPEATED_CAPTCHA_THRESHOLD = 3;
const RST_REPEATED_CAPTCHA_PAUSE_SECONDS = 24 * 60 * 60;
const RST_PERSISTENT_CAPTCHA_THRESHOLD = 6;
const RST_PERSISTENT_CAPTCHA_PAUSE_SECONDS = 3 * 24 * 60 * 60;
const RST_LONG_LIVED_CAPTCHA_THRESHOLD = 10;
const RST_LONG_LIVED_CAPTCHA_PAUSE_SECONDS = 7 * 24 * 60 * 60;
const OLX_ACCESS_DENIED_BASE_PAUSE_SECONDS = 6 * 60 * 60;
const OLX_ACCESS_DENIED_MAX_PAUSE_SECONDS = 24 * 60 * 60;

export function captchaPauseSeconds(input: {
  source: ListingSource;
  consecutiveErrors: number;
  priorProbeAttempts?: number;
  baseSeconds: number;
  maxSeconds: number;
}): number {
  const repeatedAttempts = Math.max(
    input.consecutiveErrors,
    input.priorProbeAttempts ?? 0,
  );
  if (input.source === "RST") {
    if (repeatedAttempts >= RST_LONG_LIVED_CAPTCHA_THRESHOLD) {
      return RST_LONG_LIVED_CAPTCHA_PAUSE_SECONDS;
    }
    if (repeatedAttempts >= RST_PERSISTENT_CAPTCHA_THRESHOLD) {
      return RST_PERSISTENT_CAPTCHA_PAUSE_SECONDS;
    }
    if (repeatedAttempts >= RST_REPEATED_CAPTCHA_THRESHOLD) {
      return RST_REPEATED_CAPTCHA_PAUSE_SECONDS;
    }
  }

  return protectionPauseSeconds({
    consecutiveErrors: input.consecutiveErrors,
    baseSeconds: input.baseSeconds,
    maxSeconds: input.maxSeconds,
  });
}

export function rateLimitPauseSeconds(input: {
  source: ListingSource;
  responseStatus?: number;
  retryAfterSeconds?: number;
  consecutiveErrors: number;
  baseSeconds: number;
  maxSeconds: number;
}): number {
  if (input.source === "OLX" && input.responseStatus === 403) {
    const multiplier = Math.min(4, 2 ** Math.max(0, input.consecutiveErrors));
    return Math.min(
      OLX_ACCESS_DENIED_BASE_PAUSE_SECONDS * multiplier,
      OLX_ACCESS_DENIED_MAX_PAUSE_SECONDS,
    );
  }

  return protectionPauseSeconds({
    retryAfterSeconds: input.retryAfterSeconds,
    consecutiveErrors: input.consecutiveErrors,
    baseSeconds: input.baseSeconds,
    maxSeconds: input.maxSeconds,
  });
}
