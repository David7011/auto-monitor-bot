/** Returns intervalSeconds +/- random jitter, in milliseconds. */
export function intervalWithJitterMs(intervalSeconds: number, jitterSeconds: number): number {
  const jitter = (Math.random() * 2 - 1) * jitterSeconds;
  return Math.max(1, intervalSeconds + jitter) * 1000;
}

/** Exponential backoff delay in ms given the number of consecutive errors. */
export function backoffDelayMs(consecutiveErrors: number, baseSeconds = 30): number {
  const multiplier = Math.min(2 ** Math.max(0, consecutiveErrors - 1), 16);
  return baseSeconds * multiplier * 1000;
}

/**
 * Pause (seconds) before retrying a rate-limited source.
 * A server-provided Retry-After hint wins (clamped to [30s, max]); otherwise
 * the pause grows exponentially with prior consecutive protection incidents.
 */
export function protectionPauseSeconds(input: {
  retryAfterSeconds?: number;
  consecutiveErrors?: number;
  baseSeconds: number;
  maxSeconds: number;
}): number {
  const maxSeconds = Math.max(1, input.maxSeconds);
  const retryAfter = input.retryAfterSeconds;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(Math.max(Math.ceil(retryAfter), 30), maxSeconds);
  }
  const requiredMultiplier = Math.max(1, Math.ceil(maxSeconds / Math.max(1, input.baseSeconds)));
  const multiplier = Math.min(2 ** Math.max(0, input.consecutiveErrors ?? 0), requiredMultiplier);
  return Math.min(Math.max(1, input.baseSeconds) * multiplier, maxSeconds);
}
