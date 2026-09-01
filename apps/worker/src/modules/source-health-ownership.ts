import { isBackgroundDiscoveryLane, type ListingDiscoveryLane } from "@amb/shared";

/**
 * Source status/pauses describe the hot availability of a source. A deep
 * backfill can fail on an old offset while page 1 remains healthy, so it owns
 * only its CollectorRun diagnostics and never the source-wide health record.
 */
export function laneOwnsSourceHealth(lane: ListingDiscoveryLane): boolean {
  return !isBackgroundDiscoveryLane(lane);
}
