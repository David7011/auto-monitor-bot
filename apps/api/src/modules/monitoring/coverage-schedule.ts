export function startupCoverageDeadline(
  now: Date,
  persisted: Date | null | undefined,
  initialDelaySeconds: number,
): Date {
  if (persisted) return persisted <= now ? now : persisted;
  return new Date(now.getTime() + Math.max(0, initialDelaySeconds) * 1_000);
}

export function nextCoverageTickAfterAttempt(now: Date, intervalSeconds: number): Date {
  return new Date(now.getTime() + Math.max(15, intervalSeconds) * 1_000);
}

export function coverageJobId(generation: number, dueAt: Date): string {
  // BullMQ custom IDs may not contain a colon. Generation plus persisted due
  // time makes a scheduler retry idempotent while a completed future cycle is
  // still free to enqueue normally.
  return `collector-coverage-OLX-${generation}-${dueAt.getTime()}`;
}
