export const SCHEDULED_SOURCES = ["OLX", "AUTO_RIA", "RST", "CARS_UA", "AUTOMOTO", "MOCK"] as const;

export const OLX_REALTIME_COLLECTOR_PRIORITY = 1;

const SOURCE_ORDER = new Map<string, number>(
  SCHEDULED_SOURCES.map((source, index) => [source, index]),
);

/**
 * Database reads do not guarantee array order. Keep OLX first explicitly so
 * unrelated source preparation can never delay its due realtime job.
 */
export function prioritizeRealtimeSources<T extends { source: string }>(sources: readonly T[]): T[] {
  return [...sources].sort((left, right) =>
    (SOURCE_ORDER.get(left.source) ?? Number.MAX_SAFE_INTEGER)
    - (SOURCE_ORDER.get(right.source) ?? Number.MAX_SAFE_INTEGER));
}

export function realtimeCollectorPriority(source: string): number | undefined {
  return source === "OLX" ? OLX_REALTIME_COLLECTOR_PRIORITY : undefined;
}
