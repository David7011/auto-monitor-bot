import { createHash } from "node:crypto";
import { Prisma, prisma, type Filter, type ListingSource } from "@amb/db";
import { freshnessCutoff, sortListingsNewestFirst, type NormalizedListing } from "@amb/shared";
import type { SourceSearchContext, SourceSearchState } from "../collectors/base.js";
import { env } from "../env.js";

const MAX_CONTEXT_KNOWN_IDS = 5000;

type FreshnessMode = SourceSearchContext["freshnessMode"];

export async function buildSourceSearchPlan(source: ListingSource, now = new Date()): Promise<SourceSearchContext[]> {
  const filters = await prisma.filter.findMany({
    where: {
      enabled: true,
      OR: [{ sources: { has: source } }, { sources: { isEmpty: true } }],
    },
    orderBy: { updatedAt: "desc" },
  });

  if (filters.length === 0) return [];

  if (source !== "AUTO_RIA") {
    return [buildBroadPublicContext(source, filters, now)];
  }

  const contexts = new Map<string, SourceSearchContext>();

  for (const filter of filters) {
    const context = buildSearchContextFromFilter(source, filter, now);
    const existing = contexts.get(context.fingerprint);
    if (existing) {
      existing.filterIds = uniqueSorted([...existing.filterIds, filter.id]);
    } else {
      contexts.set(context.fingerprint, context);
    }
  }

  return [...contexts.values()];
}

export function buildSearchContextFromFilter(source: ListingSource, filter: Filter, now = new Date()): SourceSearchContext {
  const models = uniqueSorted([filter.model, ...filter.modelNames].filter((value): value is string => Boolean(value?.trim())));
  const query = {
    source,
    autoRiaCategoryId: nullableNumber(filter.autoRiaCategoryId),
    autoRiaMarkId: nullableNumber(filter.autoRiaMarkId),
    autoRiaModelId: nullableNumber(filter.autoRiaModelId),
    brand: nullableString(filter.brand),
    models,
    bodyTypes: uniqueSorted(filter.bodyTypes),
    fuelTypes: uniqueSorted(filter.fuelTypes),
    gearboxes: uniqueSorted(filter.gearboxes),
    driveTypes: uniqueSorted(filter.driveTypes),
    colors: uniqueSorted(filter.colors),
    yearFrom: nullableNumber(filter.yearFrom),
    yearTo: nullableNumber(filter.yearTo),
    priceFrom: nullableNumber(filter.priceFrom),
    priceTo: nullableNumber(filter.priceTo),
    mileageFrom: nullableNumber(filter.mileageFrom),
    mileageTo: nullableNumber(filter.mileageTo),
    engineVolumeFrom: nullableNumber(filter.engineVolumeFrom),
    engineVolumeTo: nullableNumber(filter.engineVolumeTo),
    enginePowerFrom: nullableNumber(filter.enginePowerFrom),
    enginePowerTo: nullableNumber(filter.enginePowerTo),
    doorsFrom: nullableNumber(filter.doorsFrom),
    doorsTo: nullableNumber(filter.doorsTo),
    seatsFrom: nullableNumber(filter.seatsFrom),
    seatsTo: nullableNumber(filter.seatsTo),
    customsCleared: nullableBoolean(filter.customsCleared),
    bargainPossible: nullableBoolean(filter.bargainPossible),
    regions: uniqueSorted(filter.regions),
    cities: uniqueSorted(filter.cities),
    keywords: uniqueSorted(filter.keywords),
    excludeKeywords: uniqueSorted(filter.excludeKeywords),
    freshnessMode: filter.freshnessMode as FreshnessMode,
  };

  const fingerprint = createSearchFingerprint(fingerprintQueryForSource(source, query));

  return {
    ...query,
    fingerprint,
    filterIds: [filter.id],
    publishedAfter: publishedAfterForFreshness(query.freshnessMode, now),
    initialWindowBehavior: env.INITIAL_WINDOW_BEHAVIOR,
    maxInitialWindowNotifications: env.MAX_INITIAL_WINDOW_NOTIFICATIONS,
  };
}

export async function loadSourceSearchState(context: SourceSearchContext): Promise<SourceSearchState> {
  const existing = await prisma.sourceSearchState.findUnique({
    where: {
      source_fingerprint: {
        source: context.source,
        fingerprint: context.fingerprint,
      },
    },
  });
  const predecessor = existing
    ? null
    : await prisma.sourceSearchState.findFirst({
        where: { source: context.source, initialSyncCompletedAt: { not: null } },
        orderBy: { lastSuccessfulScanAt: "desc" },
      });

  const record = await prisma.sourceSearchState.upsert({
    where: {
      source_fingerprint: {
        source: context.source,
        fingerprint: context.fingerprint,
      },
    },
    create: {
      source: context.source,
      fingerprint: context.fingerprint,
      filterIds: context.filterIds,
      query: persistedQuery(context),
      knownExternalIds: predecessor?.knownExternalIds ?? [],
      initialSyncCompletedAt: predecessor?.initialSyncCompletedAt ?? null,
      lastPublishedAt: predecessor?.lastPublishedAt ?? null,
      latestSeenPublishedAt: predecessor?.latestSeenPublishedAt ?? null,
      latestSeenExternalId: predecessor?.latestSeenExternalId ?? null,
      lastSuccessfulScanAt: predecessor?.lastSuccessfulScanAt ?? null,
    },
    update: {
      filterIds: context.filterIds,
      query: persistedQuery(context),
    },
  });

  return {
    id: record.id,
    fingerprint: record.fingerprint,
    initialSyncCompletedAt: record.initialSyncCompletedAt ?? undefined,
    lastCursor: record.lastCursor ?? undefined,
    lastExternalId: record.lastExternalId ?? undefined,
    lastPublishedAt: record.lastPublishedAt ?? undefined,
    latestSeenPublishedAt: record.latestSeenPublishedAt ?? undefined,
    latestSeenExternalId: record.latestSeenExternalId ?? undefined,
    oldestScannedPublishedAt: record.oldestScannedPublishedAt ?? undefined,
    lastCompletedCutoff: record.lastCompletedCutoff ?? undefined,
    lastPage: record.lastPage ?? undefined,
    newestFirstVerifiedAt: record.newestFirstVerifiedAt ?? undefined,
    lastSuccessfulScanAt: record.lastSuccessfulScanAt ?? undefined,
    nextCheckAt: record.nextCheckAt ?? undefined,
    knownExternalIds: new Set(record.knownExternalIds),
  };
}

function buildBroadPublicContext(source: ListingSource, filters: Filter[], now: Date): SourceSearchContext {
  const filterContexts = filters.map((filter) => buildSearchContextFromFilter(source, filter, now));
  const widest = filterContexts.reduce((current, candidate) => {
    if (!current.publishedAfter) return current;
    if (!candidate.publishedAfter) return candidate;
    return candidate.publishedAfter < current.publishedAfter ? candidate : current;
  });

  const regions = source === "OLX" ? uniqueSorted(filterContexts.flatMap((context) => context.regions)) : [];
  const cities = source === "OLX" ? uniqueSorted(filterContexts.flatMap((context) => context.cities)) : [];
  // Search text can use AND semantics and silently exclude spelling/model
  // variants. Non-AUTO.RIA collectors therefore scan broadly and filter here.
  const commonBrand = undefined;
  const commonModels: string[] = [];

  return {
    source,
    fingerprint: createSearchFingerprint({ source, mode: "BROAD_PUBLIC_FEED", version: 5, regions, cities }),
    filterIds: uniqueSorted(filters.map((filter) => filter.id)),
    brand: commonBrand,
    models: commonModels,
    bodyTypes: [],
    fuelTypes: [],
    gearboxes: [],
    driveTypes: [],
    colors: [],
    regions,
    cities,
    keywords: [],
    excludeKeywords: [],
    freshnessMode: widest.freshnessMode,
    publishedAfter: widest.publishedAfter,
    initialWindowBehavior: env.INITIAL_WINDOW_BEHAVIOR,
    maxInitialWindowNotifications: env.MAX_INITIAL_WINDOW_NOTIFICATIONS,
  };
}

function fingerprintQueryForSource(source: ListingSource, query: Record<string, unknown>): Record<string, unknown> {
  if (source === "OLX") {
    return { source, mode: "GEO_PUBLIC_FEED", version: 3, regions: query.regions, cities: query.cities };
  }
  if (source !== "AUTO_RIA") return { source, mode: "BROAD_PUBLIC_FEED", version: 3 };

  const keys = [
    "source",
    "autoRiaCategoryId",
    "autoRiaMarkId",
    "autoRiaModelId",
    "bodyTypes",
    "fuelTypes",
    "gearboxes",
    "yearFrom",
    "yearTo",
    "priceFrom",
    "priceTo",
    "mileageFrom",
    "mileageTo",
    "engineVolumeFrom",
    "engineVolumeTo",
    "enginePowerFrom",
    "enginePowerTo",
    "doorsFrom",
    "doorsTo",
    "seatsFrom",
    "seatsTo",
    "customsCleared",
    "regions",
    "cities",
    "freshnessMode",
  ];
  return Object.fromEntries(keys.map((key) => [key, query[key]]));
}

export async function markSourceSearchSuccess(
  context: SourceSearchContext,
  state: SourceSearchState,
  listings: NormalizedListing[],
  options: {
    initialSyncCompleted: boolean;
    newestFirstVerified?: boolean;
    cutoff?: Date;
    cutoffReached?: boolean;
    lane?: "REALTIME" | "BACKFILL" | "MANUAL";
    pageCount?: number;
    scannedExternalIds?: string[];
  },
): Promise<void> {
  const now = new Date();
  const sorted = sortListingsNewestFirst(listings);
  const lane = options.lane ?? "REALTIME";

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "source_search_states" WHERE "id" = ${state.id} FOR UPDATE`;
    const current = await tx.sourceSearchState.findUnique({ where: { id: state.id } });
    if (!current) return;

    const batchLatest = sorted[0];
    const batchLatestAt = batchLatest?.publishedAt ?? newestPublishedAt(sorted);
    const currentLatestAt = current.latestSeenPublishedAt ?? current.lastPublishedAt ?? undefined;
    const useBatchLatest = Boolean(batchLatestAt && (!currentLatestAt || batchLatestAt >= currentLatestAt));
    const latestPublishedAt = useBatchLatest ? batchLatestAt : currentLatestAt;
    const latestExternalId = useBatchLatest
      ? batchLatest?.externalId
      : current.latestSeenExternalId ?? current.lastExternalId ?? undefined;
    const batchOldestAt = oldestPublishedAt(sorted);
    const oldestScannedAt = oldestDate(current.oldestScannedPublishedAt ?? undefined, batchOldestAt);
    const knownExternalIds = mergeKnownIds(
      [...sorted.map((listing) => listing.externalId), ...(options.scannedExternalIds ?? [])],
      new Set(current.knownExternalIds),
    );
    const newestFirstVerifiedAt = options.newestFirstVerified
      ? current.newestFirstVerifiedAt ?? now
      : current.newestFirstVerifiedAt;

    await tx.sourceSearchState.update({
      where: { id: state.id },
      data: {
        filterIds: context.filterIds,
        query: persistedQuery(context),
        knownExternalIds,
        lastExternalId: latestExternalId ?? null,
        lastPublishedAt: latestPublishedAt ?? null,
        latestSeenPublishedAt: latestPublishedAt ?? null,
        latestSeenExternalId: latestExternalId ?? null,
        ...(lane === "BACKFILL"
          ? {
              oldestScannedPublishedAt: oldestScannedAt ?? null,
              ...(options.cutoffReached
                ? { lastCompletedCutoff: options.cutoff ?? context.publishedAfter ?? null }
                : {}),
              lastPage: Math.max(0, (options.pageCount ?? 1) - 1),
              backfillCursor: cursorJson(
                "backfill",
                now,
                batchOldestAt,
                sorted.at(-1)?.externalId,
                options.cutoff ?? context.publishedAfter,
              ),
            }
          : {
              realtimeCursor: cursorJson("realtime", now, latestPublishedAt, latestExternalId),
            }),
        newestFirstVerifiedAt,
        lastSuccessfulScanAt: now,
        initialSyncCompletedAt: options.initialSyncCompleted
          ? current.initialSyncCompletedAt ?? now
          : current.initialSyncCompletedAt,
      },
    });
  });
}

export function createSearchFingerprint(query: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(query)).digest("hex").slice(0, 40);
}

function persistedQuery(context: SourceSearchContext): Prisma.InputJsonValue {
  const { filterIds, fingerprint, publishedAfter, ...query } = context;
  return cleanJson({
    ...query,
    fingerprint,
    filterIds,
    publishedAfter: publishedAfter?.toISOString(),
  });
}

function publishedAfterForFreshness(mode: FreshnessMode, now: Date): Date | undefined {
  return freshnessCutoff(mode, now);
}

function newestPublishedAt(listings: NormalizedListing[]): Date | undefined {
  return listings
    .map((listing) => listing.publishedAt)
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => b.getTime() - a.getTime())[0];
}

function oldestPublishedAt(listings: NormalizedListing[]): Date | undefined {
  return listings
    .map((listing) => listing.publishedAt)
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => a.getTime() - b.getTime())[0];
}

function oldestDate(first: Date | undefined, second: Date | undefined): Date | undefined {
  if (!first) return second;
  if (!second) return first;
  return first <= second ? first : second;
}

function cursorJson(
  lane: "realtime" | "backfill",
  scannedAt: Date,
  publishedAt: Date | undefined,
  externalId: string | undefined,
  cutoff?: Date,
): Prisma.InputJsonValue {
  return cleanJson({
    lane,
    scannedAt: scannedAt.toISOString(),
    publishedAt: publishedAt?.toISOString(),
    externalId,
    cutoff: cutoff?.toISOString(),
  });
}

function mergeKnownIds(newestIds: string[], existing: Set<string>): string[] {
  const merged = new Set<string>();
  for (const id of newestIds) {
    if (id) merged.add(id);
    if (merged.size >= MAX_CONTEXT_KNOWN_IDS) return [...merged];
  }
  for (const id of existing) {
    if (id) merged.add(id);
    if (merged.size >= MAX_CONTEXT_KNOWN_IDS) break;
  }
  return [...merged];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function cleanJson(value: unknown): Prisma.InputJsonValue {
  if (Array.isArray(value)) return value.map(cleanJson) as Prisma.InputJsonArray;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, cleanJson(item)]),
    ) as Prisma.InputJsonObject;
  }
  if (value == null) return value as unknown as Prisma.InputJsonValue;
  return value as Prisma.InputJsonValue;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function nullableString(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function nullableNumber(value: number | null): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableBoolean(value: boolean | null): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
