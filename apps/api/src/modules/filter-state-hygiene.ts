import { compactSourceSearchStates, prisma, type ListingSource } from "@amb/db";

const FILTER_SOURCES = ["AUTO_RIA", "OLX", "RST", "CARS_UA", "AUTOMOTO", "MOCK"] as const satisfies readonly ListingSource[];

/**
 * Runs after every filter mutation, regardless of whether it came from HTTP or
 * Telegram. It removes true orphans immediately and clears a source entirely
 * when no active filter targets it. Superseded live cursors are removed by the
 * worker only after their replacement state has been persisted.
 */
export async function compactFilterSearchStates(): Promise<number> {
  let deleted = (await compactSourceSearchStates()).deleted;
  const activeFilters = await prisma.filter.findMany({ where: { enabled: true }, select: { sources: true } });

  for (const source of FILTER_SOURCES) {
    const targeted = activeFilters.some((filter) => filter.sources.length === 0 || filter.sources.includes(source));
    if (!targeted) deleted += (await compactSourceSearchStates({ source, currentFingerprints: [] })).deleted;
  }
  return deleted;
}
