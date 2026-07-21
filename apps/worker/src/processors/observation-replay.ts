import { Prisma, prisma, type ListingSource } from "@amb/db";
import { redisConnection } from "../lib/queues.js";
import { log } from "../lib/log.js";
import {
  buildFilterSetRevision,
  deserializeNormalizedListing,
  markObservationOutcome,
  releaseIncompleteObservationIds,
} from "../modules/observation-journal.js";
import { processListingDetected } from "./listing-detected.js";
import { fetchOlxDetailListing } from "../collectors/olx.js";
import { reconstructObservationListing } from "../modules/observation-recovery.js";

const REPLAY_LOCK_KEY = "observation-replay:lock";
const REPLAY_LOCK_TTL_MS = 4 * 60 * 1000;
const DETAIL_HYDRATION_CONCURRENCY = 4;

export type ObservationReplayJob = {
  trigger?: "FILTER_CHANGED" | "PERIODIC" | "MANUAL" | "STARTUP";
  lookbackHours?: number;
  limit?: number;
};

export async function processObservationReplay(job: ObservationReplayJob): Promise<void> {
  const lockValue = `${process.pid}:${Date.now()}`;
  const lock = await redisConnection.set(REPLAY_LOCK_KEY, lockValue, "PX", REPLAY_LOCK_TTL_MS, "NX");
  if (lock !== "OK") return;

  const trigger = job.trigger ?? "PERIODIC";
  const lookbackHours = clampInteger(job.lookbackHours, 1, 24 * 8, 48);
  const limit = clampInteger(job.limit, 1, 2_000, 500);
  const startedAt = new Date();
  const filters = await prisma.filter.findMany({ where: { enabled: true }, orderBy: { id: "asc" } });
  const filterRevision = buildFilterSetRevision(filters);
  let auditId: string | null = null;

  const counts = {
    observed: 0,
    evaluated: 0,
    matched: 0,
    rejected: 0,
    dispatched: 0,
    alreadyHandled: 0,
    failed: 0,
  };
  const sourceCounts = new Map<ListingSource, number>();

  try {
    const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
    const hydrated = await hydrateIncompleteObservations(cutoff);
    const repairedStates = await releaseIncompleteObservationIds(lookbackHours);
    if (repairedStates > 0) {
      await log.info("completeness", `Released incomplete fresh observation IDs from ${repairedStates} search state(s)`);
    }
    const observations = await prisma.sourceSeenListing.findMany({
      where: {
        // Complete rows have a real snapshot; incomplete ones are SQL NULL
        // (hydrate selects them via equals: DbNull), so the complement is DbNull.
        normalizedData: { not: Prisma.DbNull },
        listingId: null,
        AND: [
          { OR: [{ publishedAt: { gte: cutoff } }, { firstSeenAt: { gte: cutoff } }] },
          {
            OR: [
              { filterRevision: null },
              { filterRevision: { not: filterRevision } },
              { decision: { in: ["PENDING", "FAILED", "MATCHED"] } },
            ],
          },
        ],
      },
      orderBy: [{ publishedAt: "desc" }, { firstSeenAt: "desc" }],
      take: limit,
      select: {
        source: true,
        externalId: true,
        normalizedData: true,
      },
    });

    if (observations.length === 0 && hydrated.length === 0 && trigger === "PERIODIC") return;
    const audit = await prisma.completenessAudit.create({
      data: { trigger, filterRevision, lookbackHours, startedAt },
    });
    auditId = audit.id;

    const replayItems = [
      ...hydrated.map((item) => ({ source: item.source, externalId: item.externalId, listing: item.listing })),
      ...observations.map((observation) => ({
        source: observation.source,
        externalId: observation.externalId,
        listing: observation.normalizedData ? deserializeNormalizedListing(observation.normalizedData) : null,
      })),
    ];
    counts.observed = replayItems.length;
    for (const observation of replayItems) {
      const listing = observation.listing;
      if (!listing) {
        counts.failed += 1;
        await markObservationOutcome(observation.source, observation.externalId, { decision: "FAILED" });
        continue;
      }

      sourceCounts.set(observation.source, (sourceCounts.get(observation.source) ?? 0) + 1);
      try {
        const result = await processListingDetected({
          listing,
          discoveryLane: "BACKFILL",
          bypassHotClaim: true,
        });
        counts.evaluated += 1;
        if (result.outcome === "REJECTED") counts.rejected += 1;
        if (result.outcome === "DISPATCHED") {
          counts.matched += 1;
          counts.dispatched += 1;
        }
        if (result.outcome === "DUPLICATE" || result.outcome === "HOT_DUPLICATE") {
          counts.alreadyHandled += 1;
        }
      } catch (error) {
        counts.failed += 1;
        await log.warn(
          "completeness",
          `Replay failed for ${observation.source}:${observation.externalId}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const pendingCount = await prisma.sourceSeenListing.count({
      where: {
        normalizedData: { not: Prisma.DbNull },
        listingId: null,
        OR: [
          { filterRevision: null },
          { filterRevision: { not: filterRevision } },
          { decision: { in: ["PENDING", "FAILED", "MATCHED"] } },
        ],
        AND: [{ OR: [{ publishedAt: { gte: cutoff } }, { firstSeenAt: { gte: cutoff } }] }],
      },
    });

    await prisma.completenessAudit.update({
      where: { id: auditId },
      data: {
        observedCount: counts.observed,
        evaluatedCount: counts.evaluated,
        matchedCount: counts.matched,
        rejectedCount: counts.rejected,
        dispatchedCount: counts.dispatched,
        alreadyHandledCount: counts.alreadyHandled,
        failedCount: counts.failed,
        pendingCount,
        finishedAt: new Date(),
        details: {
          sources: Object.fromEntries(sourceCounts),
          hydratedDetails: hydrated.length,
          limitReached: observations.length >= limit,
        },
      },
    });

    if (counts.dispatched > 0 || counts.failed > 0 || pendingCount > 0) {
      await log.info(
        "completeness",
        `Replay ${trigger}: observed=${counts.observed}, dispatched=${counts.dispatched}, rejected=${counts.rejected}, pending=${pendingCount}, failed=${counts.failed}`,
      );
    }
  } catch (error) {
    if (auditId) {
      await prisma.completenessAudit.update({
        where: { id: auditId },
        data: {
          observedCount: counts.observed,
          evaluatedCount: counts.evaluated,
          matchedCount: counts.matched,
          rejectedCount: counts.rejected,
          dispatchedCount: counts.dispatched,
          alreadyHandledCount: counts.alreadyHandled,
          failedCount: counts.failed + 1,
          finishedAt: new Date(),
          details: { error: error instanceof Error ? error.message : String(error) },
        },
      });
    }
    throw error;
  } finally {
    await releaseReplayLock(lockValue);
  }
}

async function hydrateIncompleteObservations(cutoff: Date): Promise<Array<{
  source: ListingSource;
  externalId: string;
  listing: ReturnType<typeof reconstructObservationListing>;
}>> {
  const retryBefore = new Date(Date.now() - 30 * 60 * 1000);
  const rows = await prisma.sourceSeenListing.findMany({
    where: {
      normalizedData: { equals: Prisma.DbNull },
      OR: [{ publishedAt: { gte: cutoff } }, { firstSeenAt: { gte: cutoff } }],
      AND: [{ OR: [{ lastEvaluatedAt: null }, { lastEvaluatedAt: { lte: retryBefore } }] }],
    },
    orderBy: [
      { publishedAt: { sort: "desc", nulls: "last" } },
      { firstSeenAt: "desc" },
    ],
    take: 50,
    select: {
      source: true,
      externalId: true,
      url: true,
      canonicalUrl: true,
      title: true,
      brand: true,
      model: true,
      year: true,
      priceNormalized: true,
      engineVolume: true,
      mileage: true,
      city: true,
      region: true,
      firstSeenAt: true,
      publishedAt: true,
      refreshedAt: true,
      timestampConfidence: true,
      skipReason: true,
    },
  });

  const hydrated: Array<{
    source: ListingSource;
    externalId: string;
    listing: ReturnType<typeof reconstructObservationListing>;
  }> = [];
  for (let index = 0; index < rows.length; index += DETAIL_HYDRATION_CONCURRENCY) {
    const batch = rows.slice(index, index + DETAIL_HYDRATION_CONCURRENCY);
    const results = await Promise.all(batch.map(async (row) => {
      try {
        const detailedListing = row.source === "OLX" ? await fetchOlxDetailListing(row.url) : undefined;
        const listing = detailedListing ?? reconstructObservationListing(row);
        if (listing) {
          listing.firstSeenAt = row.firstSeenAt;
          listing.publishedAt ??= row.publishedAt ?? undefined;
          listing.refreshedAt ??= row.refreshedAt ?? undefined;
          if (listing.publishedAt && listing.timestampConfidence === "UNKNOWN") {
            listing.timestampConfidence = row.timestampConfidence;
            listing.skipReason = undefined;
          }
          return { source: row.source, externalId: row.externalId, listing };
        }
      } catch (error) {
        const listing = reconstructObservationListing(row);
        await log.warn(
          "completeness",
          `${row.source} detail hydration failed for ${row.externalId}; journal snapshot will be used`,
          error instanceof Error ? error.message : String(error),
        );
        return { source: row.source, externalId: row.externalId, listing };
      }
      return null;
    }));
    hydrated.push(...results.filter((result): result is NonNullable<typeof result> => result !== null));
  }
  return hydrated;
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value as number)));
}

async function releaseReplayLock(lockValue: string): Promise<void> {
  try {
    await redisConnection.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      REPLAY_LOCK_KEY,
      lockValue,
    );
  } catch {
    // The lock expires automatically; shutdown must not fail on Redis loss.
  }
}
