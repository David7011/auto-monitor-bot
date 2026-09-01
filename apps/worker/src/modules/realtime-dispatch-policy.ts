import type { ListingDiscoveryLane } from "@amb/shared";

export type RealtimeDispatchPlan<T> = {
  inline: T[];
  queued: T[];
};

/**
 * Only a short prefix stays on the collector's critical path. Telegram limits
 * messages to the same chat, so awaiting an entire burst here would hold the
 * source lock and delay the next realtime scan.
 */
export function planRealtimeDispatch<T>(
  items: readonly T[],
  availableInlineSlots: number,
): RealtimeDispatchPlan<T> {
  const inlineCount = Math.max(0, Math.min(items.length, Math.floor(availableInlineSlots)));
  return {
    inline: items.slice(0, inlineCount),
    queued: items.slice(inlineCount),
  };
}

export function realtimeHotHandoffEnabled(
  lane: ListingDiscoveryLane,
  initialSyncCompletedAt: Date | undefined,
): boolean {
  return lane === "REALTIME" && Boolean(initialSyncCompletedAt);
}
