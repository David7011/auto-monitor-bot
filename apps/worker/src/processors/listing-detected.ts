import { Prisma, prisma, type Filter } from "@amb/db";
import {
  BACKFILL_TELEGRAM_PRIORITY,
  QUEUE_NAMES,
  TELEGRAM_SEND_PRIORITY,
  type ListingDiscoveryLane,
  type NormalizedListing,
} from "@amb/shared";
import { matchFiltersDetailed } from "../modules/filter-engine.js";
import { checkDuplicate } from "../modules/duplicate-guard.js";
import { enqueue } from "../lib/queues.js";
import { log } from "../lib/log.js";
import { env } from "../env.js";
import { sendListingLink, type TelegramListingSnapshot } from "../modules/telegram-service.js";
import { claimHotListing, releaseHotListingClaim } from "../modules/hot-duplicate-guard.js";
import {
  buildFilterSetRevision,
  markObservationOutcome,
  recordObservationEvaluation,
} from "../modules/observation-journal.js";

const FILTER_CACHE_MS = 2_000;
let filterCache: { expiresAt: number; filters: Filter[] } | null = null;
let filterCachePromise: Promise<Filter[]> | null = null;

export type ListingDetectedJob = {
  listing: NormalizedListing;
  filterIds?: string[];
  forceSourceMatch?: boolean;
  discoveryLane?: ListingDiscoveryLane;
  bypassHotClaim?: boolean;
};

export type ListingProcessingResult = {
  outcome: "REJECTED" | "DUPLICATE" | "DISPATCHED" | "HOT_DUPLICATE";
  listingId?: string;
  matchedFilterIds: string[];
  rejectionReasons: string[];
};

/**
 * listing.detected processor.
 *
 * new listing → filter → duplicate guard → telegram.send (immediately).
 * The telegram.send processor enqueues listing.enrich only after the first
 * notification is persisted, so telegram.update always has a message target.
 */
export async function processListingDetected(job: ListingDetectedJob): Promise<ListingProcessingResult> {
  if (job.bypassHotClaim) {
    try {
      return await processClaimedListing(job);
    } catch (error) {
      await markObservationOutcome(job.listing.source, job.listing.externalId, { decision: "FAILED" }).catch(() => undefined);
      throw error;
    }
  }

  const claimKey = await claimHotListing(job.listing);
  if (!claimKey) {
    return { outcome: "HOT_DUPLICATE", matchedFilterIds: [], rejectionReasons: [] };
  }

  try {
    const result = await processClaimedListing(job);
    if (result.outcome === "REJECTED") await releaseHotListingClaim(claimKey);
    return result;
  } catch (error) {
    await releaseHotListingClaim(claimKey);
    await markObservationOutcome(job.listing.source, job.listing.externalId, { decision: "FAILED" }).catch(() => undefined);
    throw error;
  }
}

async function processClaimedListing(job: ListingDetectedJob): Promise<ListingProcessingResult> {
  const { listing, filterIds = [], forceSourceMatch = false } = job;
  const discoveryLane = job.discoveryLane ?? "REALTIME";

  // 1. Filter engine — source-agnostic, works only with NormalizedListing
  const filters = await loadEnabledFilters(filterIds);
  const filterInput = forceSourceMatch ? filters.map((filter) => ({ ...filter, sources: [] })) : filters;
  const evaluation = matchFiltersDetailed(listing, filterInput);
  const matched = evaluation.matched;
  const matchedFilterIds = matched.map((filter) => filter.id);
  const filterRevision = buildFilterSetRevision(filters);
  await recordObservationEvaluation(listing, discoveryLane, {
    decision: matched.length > 0 ? "MATCHED" : "REJECTED",
    matchedFilterIds,
    rejectionReasons: evaluation.rejectionReasons,
    filterRevision,
    dispatchAttempted: matched.length > 0,
  });
  // A rejected candidate was not persisted, so it must be replayable after a
  // filter or normalizer change. Keeping the hot claim here hides valid ads.
  if (matched.length === 0) {
    return {
      outcome: "REJECTED",
      matchedFilterIds,
      rejectionReasons: evaluation.rejectionReasons,
    };
  }

  // 2. Duplicate guard — never send the same listing twice
  const dup = await checkDuplicate(listing);
  if (dup.type === "STRONG") {
    if (dup.matchedListingId) {
      await prisma.listing.update({
        where: { id: dup.matchedListingId },
        data: { lastSeenAt: new Date() },
      });
      await ensureFirstNotification(dup.matchedListingId, undefined, discoveryLane);
    }
    await markObservationOutcome(listing.source, listing.externalId, {
      decision: "DUPLICATE",
      listingId: dup.matchedListingId,
    });
    return {
      outcome: "DUPLICATE",
      listingId: dup.matchedListingId,
      matchedFilterIds,
      rejectionReasons: [],
    };
  }

  // 3. Persist listing + matches
  const createData = {
    source: listing.source,
    externalId: listing.externalId,
    url: listing.url,
    canonicalUrl: listing.canonicalUrl,
    title: listing.title ?? null,
    brand: listing.brand ?? null,
    model: listing.model ?? null,
    bodyType: listing.bodyType ?? null,
    fuelType: listing.fuelType ?? null,
    gearbox: listing.gearbox ?? null,
    driveType: listing.driveType ?? null,
    color: listing.color ?? null,
    engineVolume: listing.engineVolume ?? null,
    enginePower: listing.enginePower ?? null,
    doors: listing.doors ?? null,
    seats: listing.seats ?? null,
    condition: listing.condition ?? null,
    customsCleared: listing.customsCleared ?? null,
    bargainPossible: listing.bargainPossible ?? null,
    year: listing.year ?? null,
    priceOriginal: listing.priceOriginal ?? null,
    currencyOriginal: listing.currencyOriginal ?? null,
    priceNormalized: listing.priceNormalized ?? null,
    exchangeRateUsed: listing.exchangeRateUsed ?? null,
    exchangeRateDate: listing.exchangeRateDate ?? null,
    mileage: listing.mileage ?? null,
    city: listing.city ?? null,
    region: listing.region ?? null,
    sellerPhone: listing.sellerPhone ?? null,
    vin: listing.vin ?? null,
    plateNormalized: listing.plateNormalized ?? null,
    description: listing.description ?? null,
    photoUrls: listing.photoUrls,
    publishedAt: listing.publishedAt ?? null,
    refreshedAt: listing.refreshedAt ?? null,
    timestampConfidence: listing.timestampConfidence ?? "UNKNOWN",
    skipReason: listing.skipReason ?? null,
    possibleDuplicateOfId: dup.type === "POSSIBLE" ? dup.matchedListingId ?? null : null,
    duplicateConfidence: dup.type === "POSSIBLE" ? dup.confidence : null,
    duplicateReasons: dup.reasons,
    firstSeenAt: new Date(listing.firstSeenAt),
    discoveryLane,
    rawData: listing.raw as object,
    status: "MATCHED",
    matches: {
      create: matched.map((f) => ({ filterId: f.id })),
    },
  } satisfies Prisma.ListingCreateInput;

  let saved;
  try {
    saved = await prisma.listing.create({ data: createData });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await prisma.listing.findFirst({
        where: {
          OR: [
            { source: listing.source, externalId: listing.externalId },
            ...(listing.canonicalUrl.trim() ? [{ canonicalUrl: listing.canonicalUrl }] : []),
          ],
        },
        select: { id: true },
      });
      if (existing) {
        await prisma.listing.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } });
        await ensureFirstNotification(existing.id, undefined, discoveryLane);
        await markObservationOutcome(listing.source, listing.externalId, {
          decision: "DUPLICATE",
          listingId: existing.id,
        });
        return {
          outcome: "DUPLICATE",
          listingId: existing.id,
          matchedFilterIds,
          rejectionReasons: [],
        };
      }
    }
    throw err;
  }

  // 4. Send the Telegram link on the fastest path.
  const snapshot: TelegramListingSnapshot = {
    ...saved,
    matches: matched.map((filter) => ({ filter: { name: filter.name } })),
  };
  await markObservationOutcome(listing.source, listing.externalId, {
    decision: "DISPATCHED",
    listingId: saved.id,
  });
  await ensureFirstNotification(saved.id, snapshot, discoveryLane);
  void log.info("pipeline", `New matched listing: ${saved.url}`).catch(() => undefined);
  return {
    outcome: "DISPATCHED",
    listingId: saved.id,
    matchedFilterIds,
    rejectionReasons: [],
  };
}

async function ensureFirstNotification(
  listingId: string,
  snapshot?: TelegramListingSnapshot,
  discoveryLane: ListingDiscoveryLane = "REALTIME",
): Promise<void> {
  if (discoveryLane !== "BACKFILL" && env.FAST_INLINE_TELEGRAM_SEND_ENABLED) {
    try {
      await sendListingLink(listingId, snapshot);
      await enqueue(QUEUE_NAMES.LISTING_ENRICH, "enrich", { listingId });
      return;
    } catch (err) {
      await log.warn("telegram", "Inline Telegram send failed, queued fallback send", err instanceof Error ? err.message : String(err));
    }
  }

  await enqueue(
    QUEUE_NAMES.TELEGRAM_SEND,
    "send",
    { listingId },
    {
      priority: discoveryLane === "BACKFILL" ? BACKFILL_TELEGRAM_PRIORITY : TELEGRAM_SEND_PRIORITY,
      jobId: `telegram-send-${listingId}`,
    },
  );
}

async function loadEnabledFilters(filterIds: string[]): Promise<Filter[]> {
  const now = Date.now();
  if (filterCache && filterCache.expiresAt > now) return selectFilters(filterCache.filters, filterIds);
  if (!filterCachePromise) {
    filterCachePromise = prisma.filter
      .findMany({ where: { enabled: true } })
      .then((filters) => {
        filterCache = { expiresAt: Date.now() + FILTER_CACHE_MS, filters };
        return filters;
      })
      .finally(() => {
        filterCachePromise = null;
      });
  }
  return selectFilters(await filterCachePromise, filterIds);
}

function selectFilters(filters: Filter[], filterIds: string[]): Filter[] {
  if (filterIds.length === 0) return filters;
  const selected = new Set(filterIds);
  return filters.filter((filter) => selected.has(filter.id));
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
