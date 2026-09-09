import { marketplaceCategoryKey, QUEUE_NAMES } from "@amb/shared";
import { prisma } from "@amb/db";
import { enqueue } from "../lib/queues.js";
import { log } from "../lib/log.js";
import { runMarketPriceEstimate } from "../modules/market-price.js";
import { findPossibleDuplicate } from "../modules/duplicate-guard.js";

export type ListingEnrichJob = { listingId: string };

/**
 * Background stage after the first Telegram send.
 *
 * Keep this off the first-send path: market estimate edits the same Telegram
 * message quickly, then VIN/plate checks run as the slower enrichment layer.
 */
export async function processListingEnrich(job: ListingEnrichJob): Promise<void> {
  const listing = await prisma.listing.findUnique({
    where: { id: job.listingId },
    select: {
      categoryKey: true,
      title: true,
      year: true,
      priceNormalized: true,
      priceOriginal: true,
    },
  });
  if (!listing) return;
  await prisma.sourceSeenListing.updateMany({
    where: { listingId: job.listingId, enrichmentStartedAt: null },
    data: { enrichmentStartedAt: new Date() },
  });
  if (marketplaceCategoryKey(listing.categoryKey) !== "vehicle.car") {
    await prisma.sourceSeenListing.updateMany({
      where: { listingId: job.listingId },
      data: { enrichmentCompletedAt: new Date() },
    });
    return;
  }
  // VIN/plate checks and market research are independent. Start the slower
  // vehicle branch immediately instead of waiting for market I/O to finish.
  await enqueue(QUEUE_NAMES.VEHICLE_CHECK, "check", { listingId: job.listingId });

  // This heuristic is informational only and must never delay first delivery.
  // Run it concurrently with market analysis after Telegram acceptance.
  const annotatePossibleDuplicate = (async () => {
    const possible = await findPossibleDuplicate({
      ...listing,
      categoryKey: marketplaceCategoryKey(listing.categoryKey),
    }, job.listingId);
    if (!possible) return;
    await prisma.listing.update({
      where: { id: job.listingId },
      data: {
        possibleDuplicateOfId: possible.matchedListingId ?? null,
        duplicateConfidence: possible.confidence,
        duplicateReasons: possible.reasons,
      },
    });
  })().catch((err) => log.warn(
    "possible-duplicate",
    "Possible duplicate annotation failed",
    err instanceof Error ? err.message : String(err),
  ));

  try {
    await runMarketPriceEstimate(job.listingId);
    await enqueue(QUEUE_NAMES.TELEGRAM_UPDATE, "update", { listingId: job.listingId });
  } catch (err) {
    await log.warn("market-price", "Market price estimate failed", err instanceof Error ? err.message : String(err));
  }

  await annotatePossibleDuplicate;

  await prisma.sourceSeenListing.updateMany({
    where: { listingId: job.listingId },
    data: { enrichmentCompletedAt: new Date() },
  });

}
