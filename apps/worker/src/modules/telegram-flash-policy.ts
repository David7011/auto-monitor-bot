import type { ListingDiscoveryLane } from "@amb/shared";

export type TelegramFlashPlan<T> = {
  enabled: boolean;
  flash: T[];
  remainder: T[];
};

export function planTelegramFlashBundle<T>(input: {
  listings: readonly T[];
  lane: ListingDiscoveryLane;
  enabled: boolean;
  minItems: number;
  maxItems: number;
}): TelegramFlashPlan<T> {
  const minItems = Math.max(2, Math.trunc(input.minItems));
  const maxItems = Math.max(minItems, Math.trunc(input.maxItems));
  if (!input.enabled || input.lane !== "REALTIME" || input.listings.length < minItems) {
    return { enabled: false, flash: [], remainder: [...input.listings] };
  }
  return {
    enabled: true,
    flash: input.listings.slice(0, maxItems),
    remainder: input.listings.slice(maxItems),
  };
}
