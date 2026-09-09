export const OLX_RECOVERY_CAPABILITY_VERSION = 1;

export type OlxRecoveryUnresolvedReason =
  | "PUBLIC_OFFSET_CAP"
  | "UNSTABLE_PAGINATION"
  | "NON_PARTITIONABLE_RANGE"
  | "SOURCE_EXHAUSTED_BEFORE_BOUNDARY";

/**
 * Changes only when the source capability or the recovery algorithm changes.
 * Realtime events and monitoring restarts are deliberately excluded so they
 * cannot re-arm an expensive historical scan by themselves.
 */
export function olxRecoveryAttemptGeneration(input: {
  pageSize: number;
  maxOffset: number;
}): string {
  const pageSize = Math.max(1, Math.trunc(input.pageSize));
  const maxOffset = Math.max(0, Math.trunc(input.maxOffset));
  return `olx-public-depth-v${OLX_RECOVERY_CAPABILITY_VERSION}:page=${pageSize}:offset=${maxOffset}`;
}

export function olxRecoveryRetryEligible(input: {
  attemptedGeneration?: string | null;
  currentGeneration: string;
  forced?: boolean;
}): boolean {
  return Boolean(input.forced) || input.attemptedGeneration !== input.currentGeneration;
}
