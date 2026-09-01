import type { ListingSource } from "@amb/db";

export const MIN_STARTUP_BACKFILL_DELAY_SECONDS = 60;
export const DEFERRED_BACKFILL_RETRY_SECONDS = 10;

export function startupBackfillDeadline(
  now: Date,
  existing: Date | null | undefined,
  configuredDelaySeconds: number,
): Date {
  const delaySeconds = Math.max(
    MIN_STARTUP_BACKFILL_DELAY_SECONDS,
    Number.isFinite(configuredDelaySeconds) ? configuredDelaySeconds : 0,
  );
  const floor = new Date(now.getTime() + delaySeconds * 1_000);
  return existing && existing > floor ? existing : floor;
}

export function deferOlxBackfillAfterRealtime(
  source: ListingSource,
  realtimeEnqueued: ReadonlySet<ListingSource>,
): boolean {
  return source === "OLX" && realtimeEnqueued.has("OLX");
}

export function nextBackfillTickAfterAttempt(
  now: Date,
  normalIntervalSeconds: number,
  deferred: boolean,
): Date {
  const seconds = deferred
    ? DEFERRED_BACKFILL_RETRY_SECONDS
    : Math.max(1, Number.isFinite(normalIntervalSeconds) ? normalIntervalSeconds : 1);
  return new Date(now.getTime() + seconds * 1_000);
}
