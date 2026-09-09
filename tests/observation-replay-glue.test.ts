import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redisSet: vi.fn(),
  redisEval: vi.fn(),
  filterFindMany: vi.fn(),
  observationFindMany: vi.fn(),
  observationCount: vi.fn(),
  auditCreate: vi.fn(),
  auditUpdate: vi.fn(),
  buildFilterSetRevision: vi.fn(),
  deserializeNormalizedListing: vi.fn(),
  markObservationOutcome: vi.fn(),
  releaseIncompleteObservationIds: vi.fn(),
  processListingDetected: vi.fn(),
  fetchOlxDetailListing: vi.fn(),
  reconstructObservationListing: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../packages/db/src/index.js", () => ({
  Prisma: { DbNull: Symbol("DbNull") },
  prisma: {
    filter: { findMany: mocks.filterFindMany },
    sourceSeenListing: { findMany: mocks.observationFindMany, count: mocks.observationCount },
    completenessAudit: { create: mocks.auditCreate, update: mocks.auditUpdate },
  },
}));
vi.mock("../apps/worker/src/lib/queues.js", () => ({
  redisConnection: { set: mocks.redisSet, eval: mocks.redisEval },
}));
vi.mock("../apps/worker/src/lib/log.js", () => ({ log: { info: mocks.logInfo, warn: mocks.logWarn } }));
vi.mock("../apps/worker/src/modules/observation-journal.js", () => ({
  buildFilterSetRevision: mocks.buildFilterSetRevision,
  deserializeNormalizedListing: mocks.deserializeNormalizedListing,
  markObservationOutcome: mocks.markObservationOutcome,
  releaseIncompleteObservationIds: mocks.releaseIncompleteObservationIds,
}));
vi.mock("../apps/worker/src/processors/listing-detected.js", () => ({ processListingDetected: mocks.processListingDetected }));
vi.mock("../apps/worker/src/collectors/olx.js", () => ({ fetchOlxDetailListing: mocks.fetchOlxDetailListing }));
vi.mock("../apps/worker/src/modules/observation-recovery.js", () => ({
  reconstructObservationListing: mocks.reconstructObservationListing,
}));

import { processObservationReplay } from "../apps/worker/src/processors/observation-replay.js";

const normalizedListing = {
  source: "OLX",
  externalId: "replay-1",
  url: "https://example.test/replay-1",
  canonicalUrl: "https://example.test/replay-1",
  firstSeenAt: new Date("2026-09-09T12:00:00.000Z"),
  photoUrls: [],
  raw: {},
};

describe("observation replay glue invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisSet.mockResolvedValue("OK");
    mocks.redisEval.mockResolvedValue(1);
    mocks.filterFindMany.mockResolvedValue([]);
    mocks.buildFilterSetRevision.mockReturnValue("revision-1");
    mocks.releaseIncompleteObservationIds.mockResolvedValue(0);
    mocks.observationFindMany.mockResolvedValue([]);
    mocks.observationCount.mockResolvedValue(0);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.auditUpdate.mockResolvedValue({});
    mocks.deserializeNormalizedListing.mockReturnValue(normalizedListing);
    mocks.markObservationOutcome.mockResolvedValue(undefined);
    mocks.processListingDetected.mockResolvedValue({
      outcome: "REJECTED",
      matchedFilterIds: [],
      rejectionReasons: [],
    });
    mocks.fetchOlxDetailListing.mockResolvedValue(undefined);
    mocks.reconstructObservationListing.mockReturnValue(normalizedListing);
    mocks.logInfo.mockResolvedValue(undefined);
    mocks.logWarn.mockResolvedValue(undefined);
  });

  it("does no work when another replay owns the Redis lease", async () => {
    mocks.redisSet.mockResolvedValueOnce(null);

    await expect(processObservationReplay({ trigger: "PERIODIC" })).resolves.toBeUndefined();
    expect(mocks.filterFindMany).not.toHaveBeenCalled();
    expect(mocks.redisEval).not.toHaveBeenCalled();
  });

  it("releases its lease after an empty periodic scan without creating noise", async () => {
    await expect(processObservationReplay({ trigger: "PERIODIC" })).resolves.toBeUndefined();

    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.redisEval).toHaveBeenCalledOnce();
    expect(mocks.logInfo).not.toHaveBeenCalled();
  });

  it("records dispatched and already-handled results in one completeness audit", async () => {
    mocks.observationFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { source: "OLX", externalId: "replay-1", normalizedData: { id: 1 } },
        { source: "OLX", externalId: "replay-2", normalizedData: { id: 2 } },
      ]);
    mocks.deserializeNormalizedListing
      .mockReturnValueOnce(normalizedListing)
      .mockReturnValueOnce({ ...normalizedListing, externalId: "replay-2" });
    mocks.processListingDetected
      .mockResolvedValueOnce({ outcome: "DISPATCHED", matchedFilterIds: ["filter-1"], rejectionReasons: [] })
      .mockResolvedValueOnce({ outcome: "DUPLICATE", matchedFilterIds: ["filter-1"], rejectionReasons: [] });

    await processObservationReplay({ trigger: "MANUAL", lookbackHours: 48, limit: 10 });

    expect(mocks.processListingDetected).toHaveBeenCalledTimes(2);
    expect(mocks.processListingDetected).toHaveBeenNthCalledWith(1, expect.objectContaining({
      discoveryLane: "BACKFILL",
      bypassHotClaim: true,
      observationPersisted: true,
    }));
    expect(mocks.auditUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "audit-1" },
      data: expect.objectContaining({
        observedCount: 2,
        evaluatedCount: 2,
        matchedCount: 1,
        dispatchedCount: 1,
        alreadyHandledCount: 1,
        failedCount: 0,
      }),
    }));
    expect(mocks.redisEval).toHaveBeenCalledOnce();
  });

  it("falls back to reconstructable journal data when OLX detail hydration fails", async () => {
    const row = {
      source: "OLX",
      externalId: "incomplete-1",
      url: "https://example.test/incomplete-1",
      canonicalUrl: "https://example.test/incomplete-1",
      title: "Incomplete",
      brand: null,
      model: null,
      year: null,
      priceNormalized: null,
      engineVolume: null,
      mileage: null,
      city: null,
      region: null,
      firstSeenAt: new Date(),
      publishedAt: null,
      refreshedAt: null,
      timestampConfidence: "UNKNOWN",
      skipReason: null,
    };
    mocks.observationFindMany.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    mocks.fetchOlxDetailListing.mockRejectedValueOnce(new Error("detail unavailable"));
    mocks.processListingDetected.mockResolvedValueOnce({ outcome: "DISPATCHED", matchedFilterIds: [], rejectionReasons: [] });

    await processObservationReplay({ trigger: "STARTUP" });

    expect(mocks.reconstructObservationListing).toHaveBeenCalledWith(row);
    expect(mocks.processListingDetected).toHaveBeenCalledWith(expect.objectContaining({ observationPersisted: true }));
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "completeness",
      expect.stringContaining("detail hydration failed"),
      "detail unavailable",
    );
    expect(mocks.redisEval).toHaveBeenCalledOnce();
  });

  it("marks an existing audit failed and releases the lease on an outer database error", async () => {
    mocks.observationFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { source: "OLX", externalId: "replay-1", normalizedData: { id: 1 } },
    ]);
    mocks.observationCount.mockRejectedValueOnce(new Error("count failed"));

    await expect(processObservationReplay({ trigger: "MANUAL" })).rejects.toThrow("count failed");
    expect(mocks.auditUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: "audit-1" },
      data: expect.objectContaining({ failedCount: 1, details: { error: "count failed" } }),
    }));
    expect(mocks.redisEval).toHaveBeenCalledOnce();
  });
});
