import type { ListingDiscoveryLane } from "@amb/shared";
import type { OlxAd } from "./olx-normalization.js";

export type OlxFreshnessHedgeDecision = {
  run: boolean;
  reason:
    | "DUE_STALE_INDEX"
    | "DISABLED"
    | "NOT_REALTIME"
    | "NOT_FIRST_PAGE"
    | "PROTECTION_COOLING"
    | "PRIMARY_UNAVAILABLE"
    | "DEADLINE"
    | "BACKOFF"
    | "INTERVAL"
    | "INDEX_FRESH"
    | "NO_STALE_RESPONSE_EVIDENCE";
  primaryAgeSeconds: number | null;
};

export function newestOlxVisibilityAt(ads: readonly OlxAd[]): Date | undefined {
  let newest: Date | undefined;
  for (const ad of ads) {
    for (const value of [ad.createdTime, ad.lastRefreshTime]) {
      if (!value) continue;
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) continue;
      if (!newest || parsed > newest) newest = parsed;
    }
  }
  return newest;
}

export function planOlxFreshnessHedge(input: {
  enabled: boolean;
  lane: ListingDiscoveryLane;
  page: number;
  protectionCooling: boolean;
  primaryAvailable: boolean;
  now: Date;
  deadlineAt: Date;
  minimumRemainingMs: number;
  newestPrimaryVisibleAt?: Date;
  /** HTTP Age from the primary response, independent of advert publication age. */
  primaryCacheAgeSeconds?: number;
  staleAfterSeconds: number;
  intervalSeconds: number;
  lastAttemptAt?: Date;
  suppressedUntil?: Date;
}): OlxFreshnessHedgeDecision {
  const primaryAgeSeconds = input.newestPrimaryVisibleAt
    ? Math.max(0, Math.floor((input.now.getTime() - input.newestPrimaryVisibleAt.getTime()) / 1_000))
    : null;
  const decision = (run: boolean, reason: OlxFreshnessHedgeDecision["reason"]): OlxFreshnessHedgeDecision => ({
    run,
    reason,
    primaryAgeSeconds,
  });

  if (!input.enabled) return decision(false, "DISABLED");
  if (input.lane !== "REALTIME") return decision(false, "NOT_REALTIME");
  if (input.page !== 1) return decision(false, "NOT_FIRST_PAGE");
  if (input.protectionCooling) return decision(false, "PROTECTION_COOLING");
  if (!input.primaryAvailable) return decision(false, "PRIMARY_UNAVAILABLE");
  if (input.deadlineAt.getTime() - input.now.getTime() < Math.max(0, input.minimumRemainingMs)) {
    return decision(false, "DEADLINE");
  }
  if (input.suppressedUntil && input.suppressedUntil > input.now) return decision(false, "BACKOFF");
  if (
    input.lastAttemptAt
    && input.now.getTime() - input.lastAttemptAt.getTime() < Math.max(1, input.intervalSeconds) * 1_000
  ) {
    return decision(false, "INTERVAL");
  }
  if (
    input.newestPrimaryVisibleAt
    && primaryAgeSeconds != null
    && primaryAgeSeconds < Math.max(1, input.staleAfterSeconds)
  ) {
    return decision(false, "INDEX_FRESH");
  }
  // An old newest advert is normal for a quiet/narrow search. Only external
  // evidence of an aged response justifies spending an additional request on
  // a second index; unchanged IDs alone cannot establish cache staleness.
  if (
    input.primaryCacheAgeSeconds == null
    || !Number.isFinite(input.primaryCacheAgeSeconds)
    || input.primaryCacheAgeSeconds < Math.max(1, input.staleAfterSeconds)
  ) {
    return decision(false, "NO_STALE_RESPONSE_EVIDENCE");
  }
  return decision(true, "DUE_STALE_INDEX");
}
