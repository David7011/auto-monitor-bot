import { createHash } from "node:crypto";
import { compactSourceSearchStates, Prisma, prisma, type Filter, type ListingSource } from "@amb/db";
import {
  freshnessCutoff,
  sortListingsNewestFirst,
  type ListingDiscoveryLane,
  type NormalizedListing,
} from "@amb/shared";
import type { SourceSearchContext, SourceSearchState } from "../collectors/base.js";
import { env } from "../env.js";
import { log } from "../lib/log.js";

const MAX_CONTEXT_KNOWN_IDS = 5000;
const MAX_COVERAGE_ANCHOR_IDS = 50;

type PlannedStateReconciliation = {
  signature: string;
  fingerprints: string[];
  reconciled: boolean;
};

const plannedStateReconciliations = new Map<ListingSource, PlannedStateReconciliation>();

type FreshnessMode = SourceSearchContext["freshnessMode"];

export function planCoverageRecovery(options: {
  source: ListingSource;
  lane: ListingDiscoveryLane;
  now: Date;
  lastSuccessfulScanAt?: Date;
  currentPending: boolean;
  currentCutoffAt?: Date;
  contextCutoffAt?: Date;
  coverageGap: boolean;
  knownIdsReset: boolean;
  outageDetectionSeconds: number;
  lookbackHours: number;
  safetyOverlapSeconds: number;
}): {
  outageDetected: boolean;
  requested: boolean;
  reason: "OFFLINE_WINDOW" | "REALTIME_OVERFLOW" | "KNOWN_IDS_RESET" | null;
  persistedBoundaryAt: Date | null;
  requiredCutoffAt: Date | null;
} {
  const outageDetected = options.source === "OLX"
    && options.lane === "REALTIME"
    && Boolean(options.lastSuccessfulScanAt)
    && options.now.getTime() - options.lastSuccessfulScanAt!.getTime() >= options.outageDetectionSeconds * 1_000;
  const newRequest = outageDetected || options.coverageGap || options.knownIdsReset;
  const requested = options.currentPending || newRequest;
  if (!requested) {
    return {
      outageDetected: false,
      requested: false,
      reason: null,
      persistedBoundaryAt: null,
      requiredCutoffAt: null,
    };
  }

  const lookbackFloor = new Date(options.now.getTime() - options.lookbackHours * 60 * 60 * 1_000);
  const boundary = options.lastSuccessfulScanAt ?? options.now;
  const safetyCutoff = laterDate(
    lookbackFloor,
    new Date(boundary.getTime() - options.safetyOverlapSeconds * 1_000),
  );
  return {
    outageDetected,
    requested,
    reason: outageDetected
      ? "OFFLINE_WINDOW"
      : options.coverageGap
        ? "REALTIME_OVERFLOW"
        : options.knownIdsReset
          ? "KNOWN_IDS_RESET"
          : null,
    persistedBoundaryAt: boundary,
    requiredCutoffAt: oldestDate(
      options.currentCutoffAt,
      newRequest ? safetyCutoff : undefined,
      options.contextCutoffAt,
    ) ?? boundary,
  };
}

export async function buildSourceSearchPlan(source: ListingSource, now = new Date()): Promise<SourceSearchContext[]> {
  const filters = await prisma.filter.findMany({
    where: {
      enabled: true,
      OR: [{ sources: { has: source } }, { sources: { isEmpty: true } }],
    },
    orderBy: { updatedAt: "desc" },
  });

  if (filters.length === 0) {
    rememberPlannedContexts(source, []);
    await compactSourceSearchStates({ source, currentFingerprints: [] });
    return [];
  }

  if (source !== "AUTO_RIA") {
    const plan = [buildBroadPublicContext(source, filters, now)];
    rememberPlannedContexts(source, plan);
    return plan;
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

  const plan = [...contexts.values()];
  rememberPlannedContexts(source, plan);
  return plan;
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
      coverageAnchorExternalIds: predecessor?.coverageAnchorExternalIds ?? [],
      coverageRecoveryPending: predecessor?.coverageRecoveryPending ?? false,
      coverageRecoveryCutoffAt: predecessor?.coverageRecoveryCutoffAt ?? null,
      knownIdsResetAt: predecessor?.knownIdsResetAt ?? null,
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

  await reconcilePlannedStates(context.source, record.id);

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
    lastRegionalCoverageAt: record.lastRegionalCoverageAt ?? undefined,
    lastHtmlCoverageAt: record.lastHtmlCoverageAt ?? undefined,
    htmlCoveragePausedUntil: record.htmlCoveragePausedUntil ?? undefined,
    lastPrivateCoverageAt: record.lastPrivateCoverageAt ?? undefined,
    knownExternalIds: new Set(record.knownExternalIds),
    coverageAnchorExternalIds: new Set(record.coverageAnchorExternalIds),
    coverageRecoveryPending: record.coverageRecoveryPending,
    coverageRecoveryCutoffAt: record.coverageRecoveryCutoffAt ?? undefined,
    knownIdsResetAt: record.knownIdsResetAt ?? undefined,
  };
}

export function contextForCoverageRecovery(
  context: SourceSearchContext,
  state: SourceSearchState,
  lane: ListingDiscoveryLane,
): SourceSearchContext {
  if (
    context.source !== "OLX"
    || lane !== "BACKFILL"
    || !state.coverageRecoveryPending
    || !state.coverageRecoveryCutoffAt
  ) {
    return context;
  }
  const publishedAfter = !context.publishedAfter || state.coverageRecoveryCutoffAt < context.publishedAfter
    ? state.coverageRecoveryCutoffAt
    : context.publishedAfter;
  return { ...context, publishedAfter };
}

function rememberPlannedContexts(source: ListingSource, contexts: readonly SourceSearchContext[]): void {
  const fingerprints = contexts.map((context) => context.fingerprint).sort((a, b) => a.localeCompare(b));
  const signature = contexts
    .map((context) => `${context.fingerprint}:${uniqueSorted(context.filterIds).join(",")}`)
    .sort((a, b) => a.localeCompare(b))
    .join("|");
  const current = plannedStateReconciliations.get(source);
  if (current?.signature === signature) return;
  plannedStateReconciliations.set(source, { signature, fingerprints, reconciled: false });
}

async function reconcilePlannedStates(source: ListingSource, preserveStateId: string): Promise<void> {
  const planned = plannedStateReconciliations.get(source);
  if (!planned || planned.reconciled) return;
  const result = await compactSourceSearchStates({
    source,
    preserveStateId,
    currentFingerprints: planned.fingerprints,
  });
  if (result.planReady) planned.reconciled = true;
}

function buildBroadPublicContext(source: ListingSource, filters: Filter[], now: Date): SourceSearchContext {
  const filterContexts = filters.map((filter) => buildSearchContextFromFilter(source, filter, now));
  const widest = filterContexts.reduce((current, candidate) => {
    if (!current.publishedAfter) return current;
    if (!candidate.publishedAfter) return candidate;
    return candidate.publishedAfter < current.publishedAfter ? candidate : current;
  });

  const geography = source === "OLX" ? mergeOlxFilterGeography(filterContexts) : { regions: [], cities: [] };
  const { regions, cities } = geography;
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

/**
 * Merge filter geography without ever narrowing a wider filter.
 *
 * Empty OLX geography means all Ukraine. A region-only filter is wider than a
 * city filter and must keep region scopes because the OLX resolver deliberately
 * prefers city scopes whenever at least one city is present.
 */
export function mergeOlxFilterGeography(
  contexts: ReadonlyArray<Pick<SourceSearchContext, "regions" | "cities">>,
): { regions: string[]; cities: string[] } {
  if (contexts.some((context) => context.regions.length === 0 && context.cities.length === 0)) {
    return { regions: [], cities: [] };
  }

  const regions = uniqueSorted(contexts.flatMap((context) => context.regions));
  if (contexts.some((context) => context.regions.length > 0 && context.cities.length === 0)) {
    return { regions, cities: [] };
  }

  return {
    regions,
    cities: uniqueSorted(contexts.flatMap((context) => context.cities)),
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
    lane?: ListingDiscoveryLane;
    pageCount?: number;
    scannedExternalIds?: string[];
    coverageVerified?: boolean;
    coverageGap?: boolean;
    coverageVerificationMethod?: "KNOWN_TAIL" | "CUTOFF" | "EXHAUSTED";
    runId?: string;
    requestCount?: number;
    observedCount?: number;
    coverageStateUpdate?: {
      lastRegionalCoverageAt?: Date;
      lastHtmlCoverageAt?: Date;
      htmlCoveragePausedUntil?: Date | null;
      lastPrivateCoverageAt?: Date;
    };
  },
): Promise<{
  clearedKnownIdCount: number;
  recoveryRequired: boolean;
  outageDetected: boolean;
  recoveryWindowId: string | null;
  recoveryWindowOpened: boolean;
  recoveryVerified: boolean;
  requiredCutoffAt: Date | null;
}> {
  const now = new Date();
  const sorted = sortListingsNewestFirst(listings);
  const lane = options.lane ?? "REALTIME";

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "source_search_states" WHERE "id" = ${state.id} FOR UPDATE`;
    const current = await tx.sourceSearchState.findUnique({ where: { id: state.id } });
    if (!current) return {
      clearedKnownIdCount: 0,
      recoveryRequired: false,
      outageDetected: false,
      recoveryWindowId: null,
      recoveryWindowOpened: false,
      recoveryVerified: false,
      requiredCutoffAt: null,
    };

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
    const knownIdRotation = rotateKnownExternalIds(
      context.source,
      [...sorted.map((listing) => listing.externalId), ...(options.scannedExternalIds ?? [])],
      new Set(current.knownExternalIds),
      env.OLX_KNOWN_IDS_RESET_THRESHOLD,
    );
    const recoveryPlan = planCoverageRecovery({
      source: context.source,
      lane,
      now,
      lastSuccessfulScanAt: current.lastSuccessfulScanAt ?? undefined,
      currentPending: current.coverageRecoveryPending,
      currentCutoffAt: current.coverageRecoveryCutoffAt ?? undefined,
      contextCutoffAt: context.publishedAfter,
      coverageGap: Boolean(options.coverageGap),
      knownIdsReset: knownIdRotation.reset,
      outageDetectionSeconds: env.OLX_OUTAGE_DETECTION_SECONDS,
      lookbackHours: env.OLX_OUTAGE_RECOVERY_LOOKBACK_HOURS,
      safetyOverlapSeconds: env.OLX_OUTAGE_SAFETY_OVERLAP_SECONDS,
    });
    const { outageDetected } = recoveryPlan;
    const requestedCutoff = recoveryPlan.requiredCutoffAt ?? undefined;
    const recoveryWasRequested = recoveryPlan.requested;
    const verificationMethod = options.coverageVerificationMethod
      ?? (options.coverageVerified ? (options.cutoffReached ? "CUTOFF" : "KNOWN_TAIL") : undefined);
    const recoveryVerified = recoveryWasRequested
      && lane !== "COVERAGE"
      && Boolean(options.coverageVerified)
      && Boolean(verificationMethod);
    const recoveryRequired = recoveryWasRequested && !recoveryVerified;
    const openingRecoveryWindow = !current.coverageRecoveryPending && recoveryWasRequested;
    const frozenRecoveryAnchors = openingRecoveryWindow
      ? current.knownExternalIds.slice(0, MAX_COVERAGE_ANCHOR_IDS)
      : current.coverageAnchorExternalIds;
    const newestFirstVerifiedAt = options.newestFirstVerified
      ? current.newestFirstVerifiedAt ?? now
      : current.newestFirstVerifiedAt;

    let recoveryWindow = await tx.coverageRecoveryWindow.findFirst({
      where: { sourceSearchStateId: state.id, status: "PENDING" },
      orderBy: { detectedAt: "desc" },
    });
    let recoveryWindowOpened = false;
    if (!recoveryWindow && recoveryWasRequested) {
      const persistedBoundaryAt = recoveryPlan.persistedBoundaryAt
        ?? current.latestSeenPublishedAt
        ?? current.lastPublishedAt
        ?? now;
      const requiredCutoffAt = requestedCutoff ?? context.publishedAfter ?? persistedBoundaryAt;
      recoveryWindow = await tx.coverageRecoveryWindow.create({
        data: {
          source: context.source,
          sourceSearchStateId: state.id,
          reason: recoveryPlan.reason ?? "KNOWN_IDS_RESET",
          persistedBoundaryAt,
          requiredCutoffAt,
          latestSeenAt: batchLatestAt ?? null,
        },
      });
      recoveryWindowOpened = true;
    }

    const durableCutoff = oldestDate(
      requestedCutoff,
      recoveryWindow?.requiredCutoffAt,
    ) ?? context.publishedAfter ?? null;

    const recordsRecoveryAttempt = openingRecoveryWindow || lane === "BACKFILL" || recoveryVerified;
    if (recoveryWindow && lane !== "COVERAGE" && recordsRecoveryAttempt) {
      recoveryWindow = await tx.coverageRecoveryWindow.update({
        where: { id: recoveryWindow.id },
        data: recoveryVerified
          ? {
              status: "VERIFIED",
              requiredCutoffAt: durableCutoff ?? recoveryWindow.requiredCutoffAt,
              latestSeenAt: batchLatestAt ?? recoveryWindow.latestSeenAt,
              lastAttemptAt: now,
              lastAttemptRunId: options.runId ?? null,
              verifiedAt: now,
              verifiedRunId: options.runId ?? null,
              verificationMethod,
              oldestObservedAt: batchOldestAt ?? null,
              pageCount: options.pageCount ?? 0,
              requestCount: options.requestCount ?? 0,
              observedCount: options.observedCount ?? sorted.length,
            }
          : {
              requiredCutoffAt: durableCutoff ?? recoveryWindow.requiredCutoffAt,
              latestSeenAt: batchLatestAt ?? recoveryWindow.latestSeenAt,
              lastAttemptAt: now,
              lastAttemptRunId: options.runId ?? null,
              oldestObservedAt: batchOldestAt ?? null,
              pageCount: options.pageCount ?? 0,
              requestCount: options.requestCount ?? 0,
              observedCount: options.observedCount ?? sorted.length,
            },
      });
    }

    await tx.sourceSearchState.update({
      where: { id: state.id },
      data: {
        filterIds: context.filterIds,
        query: persistedQuery(context),
        knownExternalIds: knownIdRotation.knownExternalIds,
        coverageAnchorExternalIds: recoveryRequired
          ? frozenRecoveryAnchors.length > 0
            ? frozenRecoveryAnchors
            : knownIdRotation.coverageAnchorExternalIds
          : [],
        coverageRecoveryPending: recoveryRequired,
        coverageRecoveryCutoffAt: recoveryRequired ? durableCutoff : null,
        knownIdsResetAt: knownIdRotation.reset ? now : current.knownIdsResetAt,
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
          : lane === "COVERAGE"
            ? {}
            : {
              realtimeCursor: cursorJson("realtime", now, latestPublishedAt, latestExternalId),
            }),
        newestFirstVerifiedAt,
        ...options.coverageStateUpdate,
        ...(lane === "COVERAGE" ? {} : { lastSuccessfulScanAt: now }),
        initialSyncCompletedAt: options.initialSyncCompleted
          ? current.initialSyncCompletedAt ?? now
          : current.initialSyncCompletedAt,
      },
    });
    return {
      clearedKnownIdCount: knownIdRotation.reset ? knownIdRotation.mergedCount : 0,
      recoveryRequired,
      outageDetected,
      recoveryWindowId: recoveryWindow?.id ?? null,
      recoveryWindowOpened,
      recoveryVerified,
      requiredCutoffAt: recoveryRequired ? durableCutoff : recoveryWindow?.requiredCutoffAt ?? null,
    };
  });

  if (result.clearedKnownIdCount > 0) {
    await log.info(
      "olx-known-ids",
      `OLX known-ID cache reached ${result.clearedKnownIdCount} entries and was reset to zero; ${MAX_COVERAGE_ANCHOR_IDS} continuity anchors were preserved separately and Telegram favorites were not modified`,
    );
  }
  if (result.outageDetected) {
    await log.warn(
      "olx-coverage",
      "OLX monitoring resumed after an outage; a bounded continuity recovery was requested",
    );
  }
  return result;
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

function oldestDate(...values: Array<Date | undefined>): Date | undefined {
  return values.filter((value): value is Date => Boolean(value)).reduce<Date | undefined>(
    (oldest, value) => !oldest || value < oldest ? value : oldest,
    undefined,
  );
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

export function rotateKnownExternalIds(
  source: ListingSource,
  newestIds: string[],
  existing: Set<string>,
  olxResetThreshold = 2_000,
): { knownExternalIds: string[]; coverageAnchorExternalIds: string[]; mergedCount: number; reset: boolean } {
  const merged = mergeKnownIds(newestIds, existing);
  const reset = source === "OLX" && merged.length >= Math.max(1, Math.trunc(olxResetThreshold));
  return {
    knownExternalIds: reset ? [] : merged,
    coverageAnchorExternalIds: reset ? merged.slice(0, MAX_COVERAGE_ANCHOR_IDS) : [],
    mergedCount: merged.length,
    reset,
  };
}

function laterDate(...values: Array<Date | undefined>): Date | undefined {
  return values.filter((value): value is Date => Boolean(value)).reduce<Date | undefined>(
    (latest, value) => !latest || value > latest ? value : latest,
    undefined,
  );
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
