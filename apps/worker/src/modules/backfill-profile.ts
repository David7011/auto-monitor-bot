import type { ListingDiscoveryLane, ListingSource } from "@amb/shared";

export type BackfillProfile = "FULL" | "LIGHT";

export type BackfillBudgetLimits = {
  defaultPages: number;
  olxFullPages: number;
  maxCandidates: number;
  maxDurationMs: number;
};

export type BackfillScanBudget = {
  maxPages: number;
  maxCandidates: number;
  maxDurationMs: number;
  profile: BackfillProfile;
};

const LIGHT_OLX_MAX_PAGES = 4;
const LIGHT_MAX_CANDIDATES = 250;
const LIGHT_MAX_DURATION_MS = 30_000;

/**
 * A light OLX audit is still multi-page and runs alongside the independent
 * realtime/API/HTML/private coverage lanes. Full depth is restored by the
 * scheduler on any recovery signal and at least once every six hours.
 */
export function backfillScanBudget(
  source: ListingSource,
  lane: ListingDiscoveryLane,
  requestedProfile: BackfillProfile | undefined,
  limits: BackfillBudgetLimits,
): BackfillScanBudget {
  const profile = lane === "BACKFILL" ? requestedProfile ?? "FULL" : "FULL";
  const fullPages = source === "OLX"
    ? Math.max(1, limits.defaultPages, limits.olxFullPages)
    : Math.max(1, limits.defaultPages);
  const fullCandidates = Math.max(1, limits.maxCandidates);
  const fullDurationMs = Math.max(1_000, limits.maxDurationMs);

  if (lane !== "BACKFILL" || profile === "FULL") {
    return {
      maxPages: fullPages,
      maxCandidates: fullCandidates,
      maxDurationMs: fullDurationMs,
      profile: "FULL",
    };
  }

  return {
    maxPages: Math.min(fullPages, source === "OLX" ? LIGHT_OLX_MAX_PAGES : limits.defaultPages),
    maxCandidates: Math.min(fullCandidates, LIGHT_MAX_CANDIDATES),
    maxDurationMs: Math.min(fullDurationMs, LIGHT_MAX_DURATION_MS),
    profile: "LIGHT",
  };
}
