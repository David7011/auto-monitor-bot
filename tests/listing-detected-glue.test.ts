import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Filter } from "../packages/db/src/index.js";
import type { NormalizedListing } from "../packages/shared/src/index.js";

const mocks = vi.hoisted(() => ({
  filterFindMany: vi.fn(),
  observationFindUnique: vi.fn(),
  listingCreate: vi.fn(),
  listingUpdate: vi.fn(),
  listingFindFirst: vi.fn(),
  listingMatchCreateMany: vi.fn(),
  listingUpdateMany: vi.fn(),
  transaction: vi.fn(),
  matchFiltersDetailed: vi.fn(),
  findStrongDuplicate: vi.fn(),
  enqueue: vi.fn(),
  sendListingLink: vi.fn(),
  stageListingForFlash: vi.fn(),
  claimHotListing: vi.fn(),
  releaseHotListingClaim: vi.fn(),
  recordPendingObservation: vi.fn(),
  recordObservationEvaluation: vi.fn(),
  markObservationOutcome: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../packages/db/src/index.js", () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  prisma: {
    filter: { findMany: mocks.filterFindMany },
    sourceSeenListing: { findUnique: mocks.observationFindUnique },
    listing: {
      create: mocks.listingCreate,
      update: mocks.listingUpdate,
      updateMany: mocks.listingUpdateMany,
      findFirst: mocks.listingFindFirst,
    },
    listingMatch: { createMany: mocks.listingMatchCreateMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock("../apps/worker/src/modules/filter-engine.js", () => ({ matchFiltersDetailed: mocks.matchFiltersDetailed }));
vi.mock("../apps/worker/src/modules/duplicate-guard.js", () => ({ findStrongDuplicate: mocks.findStrongDuplicate }));
vi.mock("../apps/worker/src/lib/queues.js", () => ({ enqueue: mocks.enqueue }));
vi.mock("../apps/worker/src/lib/log.js", () => ({ log: { info: mocks.logInfo, warn: mocks.logWarn } }));
vi.mock("../apps/worker/src/env.js", () => ({
  env: {
    FAST_INLINE_TELEGRAM_SEND_ENABLED: true,
    FAST_INLINE_TELEGRAM_DEADLINE_MS: 2_500,
  },
}));
vi.mock("../apps/worker/src/modules/telegram-service.js", () => ({
  sendListingLink: mocks.sendListingLink,
  stageListingForFlash: mocks.stageListingForFlash,
  TELEGRAM_SEND_LEASE_MS: 60_000,
}));
vi.mock("../apps/worker/src/modules/hot-duplicate-guard.js", () => ({
  claimHotListing: mocks.claimHotListing,
  releaseHotListingClaim: mocks.releaseHotListingClaim,
}));
vi.mock("../apps/worker/src/modules/observation-journal.js", () => ({
  buildFilterSetRevision: () => "filter-revision",
  recordPendingObservation: mocks.recordPendingObservation,
  recordObservationEvaluation: mocks.recordObservationEvaluation,
  markObservationOutcome: mocks.markObservationOutcome,
}));

import { processListingDetected } from "../apps/worker/src/processors/listing-detected.js";

const filter = {
  id: "filter-1",
  name: "Fast OLX",
  enabled: true,
  shadowMode: false,
  sources: ["OLX"],
} as unknown as Filter;

const listing = {
  source: "OLX",
  externalId: "olx-glue-1",
  url: "https://www.olx.ua/d/uk/obyavlenie/test-ID1.html",
  canonicalUrl: "https://www.olx.ua/d/uk/obyavlenie/test-ID1.html",
  title: "Test vehicle",
  photoUrls: [],
  firstSeenAt: new Date("2026-09-09T12:00:00.000Z"),
  raw: {},
} as NormalizedListing;

function matchedEvaluation(matched: Filter[] = [filter]) {
  return {
    matched,
    evaluations: matched.map((item) => ({ filterId: item.id, outcome: "MATCH" as const, unknownReasons: [] })),
    rejectionReasons: matched.length > 0 ? [] : ["price outside range"],
  };
}

describe("listing.detected glue invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.filterFindMany.mockResolvedValue([filter]);
    mocks.recordPendingObservation.mockResolvedValue(undefined);
    mocks.claimHotListing.mockResolvedValue("claim-token");
    mocks.releaseHotListingClaim.mockResolvedValue(undefined);
    mocks.matchFiltersDetailed.mockReturnValue(matchedEvaluation());
    mocks.findStrongDuplicate.mockResolvedValue(null);
    mocks.listingCreate.mockResolvedValue({ ...listing, id: "listing-1", notificationMode: "LIVE" });
    mocks.listingUpdate.mockResolvedValue({ notificationMode: "LIVE" });
    mocks.listingFindFirst.mockResolvedValue(null);
    mocks.listingMatchCreateMany.mockResolvedValue({ count: 1 });
    mocks.listingUpdateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(async (operations: unknown[]) => Promise.all(operations));
    mocks.sendListingLink.mockResolvedValue(undefined);
    mocks.stageListingForFlash.mockResolvedValue(true);
    mocks.enqueue.mockResolvedValue(undefined);
    mocks.recordObservationEvaluation.mockResolvedValue(undefined);
    mocks.markObservationOutcome.mockResolvedValue(undefined);
    mocks.logInfo.mockResolvedValue(undefined);
    mocks.logWarn.mockResolvedValue(undefined);
  });

  it("journals before taking the short-lived hot duplicate claim", async () => {
    const order: string[] = [];
    mocks.recordPendingObservation.mockImplementationOnce(async () => { order.push("journal"); });
    mocks.claimHotListing.mockImplementationOnce(async () => { order.push("claim"); return null; });

    await expect(processListingDetected({ listing })).resolves.toEqual({
      outcome: "HOT_DUPLICATE",
      matchedFilterIds: [],
      rejectionReasons: [],
    });
    expect(order).toEqual(["journal", "claim"]);
    expect(mocks.matchFiltersDetailed).not.toHaveBeenCalled();
  });

  it("honours a retained NOTIFIED journal row without querying or sending again", async () => {
    mocks.recordPendingObservation.mockResolvedValueOnce({
      decision: "NOTIFIED",
      listingId: "retained-listing",
      matchedFilterIds: ["filter-1"],
    });

    await expect(processListingDetected({ listing, bypassHotClaim: true })).resolves.toMatchObject({
      outcome: "DUPLICATE",
      listingId: "retained-listing",
    });
    expect(mocks.observationFindUnique).not.toHaveBeenCalled();
    expect(mocks.sendListingLink).not.toHaveBeenCalled();
  });

  it("releases a rejected candidate claim so a later filter revision can replay it", async () => {
    mocks.matchFiltersDetailed.mockReturnValueOnce(matchedEvaluation([]));

    await expect(processListingDetected({ listing })).resolves.toMatchObject({ outcome: "REJECTED" });
    expect(mocks.recordObservationEvaluation).toHaveBeenCalledWith(
      listing,
      "REALTIME",
      expect.objectContaining({ decision: "REJECTED", dispatchAttempted: false }),
    );
    expect(mocks.releaseHotListingClaim).toHaveBeenCalledWith("claim-token");
    expect(mocks.listingCreate).not.toHaveBeenCalled();
  });

  it("persists and journals dispatch before performing the first Telegram send", async () => {
    const order: string[] = [];
    mocks.listingCreate.mockImplementationOnce(async () => {
      order.push("listing");
      return { ...listing, id: "listing-1", notificationMode: "LIVE" };
    });
    mocks.markObservationOutcome.mockImplementationOnce(async () => { order.push("outcome"); });
    mocks.sendListingLink.mockImplementationOnce(async () => { order.push("telegram"); });

    await expect(processListingDetected({ listing })).resolves.toMatchObject({
      outcome: "DISPATCHED",
      listingId: "listing-1",
      matchedFilterIds: ["filter-1"],
    });
    expect(order).toEqual(["listing", "outcome", "telegram"]);
    expect(mocks.enqueue).toHaveBeenCalledWith("listing.enrich", "enrich", { listingId: "listing-1" });
  });

  it("suppresses Telegram for shadow-only matches while keeping durable evidence", async () => {
    const shadowFilter = { ...filter, shadowMode: true } as Filter;
    mocks.matchFiltersDetailed.mockReturnValueOnce(matchedEvaluation([shadowFilter]));

    await expect(processListingDetected({ listing })).resolves.toMatchObject({ outcome: "SHADOWED" });
    expect(mocks.markObservationOutcome).toHaveBeenCalledWith("OLX", "olx-glue-1", {
      decision: "MATCHED",
      listingId: "listing-1",
    });
    expect(mocks.sendListingLink).not.toHaveBeenCalled();
  });

  it("refreshes a strong duplicate and relies on the receipt-aware first notification path", async () => {
    mocks.findStrongDuplicate.mockResolvedValueOnce({ matchedListingId: "listing-existing" });

    await expect(processListingDetected({ listing })).resolves.toMatchObject({
      outcome: "DUPLICATE",
      listingId: "listing-existing",
    });
    expect(mocks.listingUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "listing-existing" } }));
    expect(mocks.sendListingLink).toHaveBeenCalledWith("listing-existing", undefined, expect.objectContaining({ signal: expect.anything() }));
    expect(mocks.listingCreate).not.toHaveBeenCalled();
  });

  it("releases the claim and marks the journal FAILED when glue processing throws", async () => {
    mocks.recordObservationEvaluation.mockRejectedValueOnce(new Error("database interrupted"));

    await expect(processListingDetected({ listing })).rejects.toThrow("database interrupted");
    expect(mocks.releaseHotListingClaim).toHaveBeenCalledWith("claim-token");
    expect(mocks.markObservationOutcome).toHaveBeenCalledWith("OLX", "olx-glue-1", { decision: "FAILED" });
  });
});
