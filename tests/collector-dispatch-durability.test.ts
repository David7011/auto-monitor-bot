import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedListing } from "@amb/shared";

const mocks = vi.hoisted(() => ({
  persistBatch: vi.fn(),
  processListing: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("../packages/db/src/index.js", () => ({ prisma: {} }));
vi.mock("../apps/worker/src/env.js", () => ({ env: {
  FAST_INLINE_LISTING_LIMIT_PER_RUN: 1,
  FAST_INLINE_LISTING_CONCURRENCY: 2,
  FAST_INLINE_LISTING_PROCESSING_ENABLED: true,
  TELEGRAM_FLASH_BUNDLE_ENABLED: false,
  TELEGRAM_FLASH_BUNDLE_MIN_ITEMS: 3,
  TELEGRAM_FLASH_BUNDLE_MAX_ITEMS: 10,
} }));
vi.mock("../apps/worker/src/lib/log.js", () => ({ log: { warn: vi.fn() } }));
vi.mock("../apps/worker/src/lib/queues.js", () => ({ enqueue: mocks.enqueue, redisConnection: {} }));
vi.mock("../apps/worker/src/modules/challenge-incident.js", () => ({ recordChallengeIncident: vi.fn() }));
vi.mock("../apps/worker/src/modules/challenge-incident-policy.js", () => ({ requiresManualChallengeVerification: vi.fn() }));
vi.mock("../apps/worker/src/modules/source-search-plan.js", () => ({ loadSourceSearchState: vi.fn() }));
vi.mock("../apps/worker/src/modules/telegram-service.js", () => ({
  sendSystemAlert: vi.fn(),
  createTelegramFlashBundle: vi.fn(),
  releaseFlashListingsToCards: vi.fn(),
}));
vi.mock("../apps/worker/src/modules/observation-journal.js", () => ({
  observationIdentity: (listing: { source: string; externalId: string }) => `${listing.source}\u001f${listing.externalId}`,
  recordPendingObservations: mocks.persistBatch,
}));
vi.mock("../apps/worker/src/modules/bounded-parallel.js", () => ({
  mapWithConcurrency: async <T, R>(items: readonly T[], _limit: number, mapper: (item: T) => Promise<R>) => Promise.all(items.map(mapper)),
}));
vi.mock("../apps/worker/src/modules/backfill-profile.js", () => ({ backfillScanBudget: vi.fn() }));
vi.mock("../apps/worker/src/modules/source-protection-policy.js", () => ({ captchaPauseSeconds: vi.fn(), rateLimitPauseSeconds: vi.fn() }));
vi.mock("../apps/worker/src/modules/source-health-ownership.js", () => ({ laneOwnsSourceHealth: vi.fn() }));
vi.mock("../apps/worker/src/modules/telegram-flash-policy.js", () => ({ planTelegramFlashBundle: ({ listings }: { listings: NormalizedListing[] }) => ({ enabled: false, flash: [], remainder: listings }) }));
vi.mock("../apps/worker/src/modules/scheduled-job-policy.js", () => ({ scheduledOlxJobExecutionState: vi.fn() }));
vi.mock("../apps/worker/src/processors/listing-detected.js", () => ({ processListingDetected: mocks.processListing }));

import { dispatchListings } from "../apps/worker/src/processors/collector-run-helpers.js";

describe("collector dispatch durability boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistBatch.mockImplementation(async (listings: NormalizedListing[]) => new Map(
      listings.map((listing) => [`${listing.source}\u001f${listing.externalId}`, {
        decision: "PENDING", listingId: null, matchedFilterIds: [],
      }]),
    ));
    mocks.processListing.mockResolvedValue({ outcome: "DISPATCHED", matchedFilterIds: [], rejectionReasons: [] });
    mocks.enqueue.mockResolvedValue(undefined);
  });

  it("journals the complete burst before the first inline claim/filter and reuses the upsert result", async () => {
    const listings = [listing("one"), listing("two")];
    await dispatchListings(listings, ["filter-1"], "REALTIME", { used: 0 });

    expect(mocks.persistBatch).toHaveBeenCalledTimes(1);
    expect(mocks.persistBatch).toHaveBeenCalledWith(listings, "REALTIME");
    expect(mocks.persistBatch.mock.invocationCallOrder[0]).toBeLessThan(mocks.processListing.mock.invocationCallOrder[0]!);
    expect(mocks.persistBatch.mock.invocationCallOrder[0]).toBeLessThan(mocks.enqueue.mock.invocationCallOrder[0]!);
    expect(mocks.processListing).toHaveBeenCalledWith(expect.objectContaining({
      listing: listings[0],
      observationPersisted: true,
      persistedObservationState: { decision: "PENDING", listingId: null, matchedFilterIds: [] },
    }));
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "listing.detected",
      "detected",
      expect.objectContaining({ listing: listings[1], observationPersisted: true }),
      expect.any(Object),
    );
  });

  it("does not claim or enqueue anything when the durable batch write fails", async () => {
    mocks.persistBatch.mockRejectedValueOnce(new Error("postgres unavailable"));
    await expect(dispatchListings([listing("one")], [], "REALTIME", { used: 0 })).rejects.toThrow("postgres unavailable");
    expect(mocks.processListing).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

function listing(externalId: string): NormalizedListing {
  return {
    source: "OLX",
    externalId,
    url: `https://www.olx.ua/d/${externalId}`,
    canonicalUrl: `https://www.olx.ua/d/${externalId}`,
    photoUrls: [],
    firstSeenAt: new Date("2026-09-12T08:00:00Z"),
  };
}
