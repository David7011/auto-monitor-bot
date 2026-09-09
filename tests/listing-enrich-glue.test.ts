import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listingFind: vi.fn(),
  listingUpdate: vi.fn(),
  observationUpdateMany: vi.fn(),
  enqueue: vi.fn(),
  runMarketPriceEstimate: vi.fn(),
  findPossibleDuplicate: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../packages/db/src/index.js", () => ({
  prisma: {
    listing: { findUnique: mocks.listingFind, update: mocks.listingUpdate },
    sourceSeenListing: { updateMany: mocks.observationUpdateMany },
  },
}));
vi.mock("../apps/worker/src/lib/queues.js", () => ({ enqueue: mocks.enqueue }));
vi.mock("../apps/worker/src/lib/log.js", () => ({ log: { warn: mocks.logWarn } }));
vi.mock("../apps/worker/src/modules/market-price.js", () => ({ runMarketPriceEstimate: mocks.runMarketPriceEstimate }));
vi.mock("../apps/worker/src/modules/duplicate-guard.js", () => ({ findPossibleDuplicate: mocks.findPossibleDuplicate }));

import { processListingEnrich } from "../apps/worker/src/processors/listing-enrich.js";

describe("listing.enrich glue isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listingFind.mockResolvedValue({
      categoryKey: "vehicle.car",
      title: "Car",
      year: 2024,
      priceNormalized: 20_000,
      priceOriginal: 20_000,
    });
    mocks.observationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.listingUpdate.mockResolvedValue({});
    mocks.enqueue.mockResolvedValue(undefined);
    mocks.runMarketPriceEstimate.mockResolvedValue(undefined);
    mocks.findPossibleDuplicate.mockResolvedValue(null);
    mocks.logWarn.mockResolvedValue(undefined);
  });

  it("does nothing when the listing was removed before background enrichment", async () => {
    mocks.listingFind.mockResolvedValueOnce(null);
    await processListingEnrich({ listingId: "missing" });
    expect(mocks.observationUpdateMany).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("completes non-vehicle enrichment without starting vehicle-only work", async () => {
    mocks.listingFind.mockResolvedValueOnce({ categoryKey: "electronics.laptop", title: "Laptop" });
    await processListingEnrich({ listingId: "listing-home" });
    expect(mocks.observationUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.runMarketPriceEstimate).not.toHaveBeenCalled();
  });

  it("starts vehicle checks, updates Telegram after pricing, and annotates a possible duplicate", async () => {
    mocks.findPossibleDuplicate.mockResolvedValueOnce({
      matchedListingId: "possible-1",
      confidence: 0.8,
      reasons: ["same phone"],
    });

    await processListingEnrich({ listingId: "listing-1" });

    expect(mocks.enqueue).toHaveBeenNthCalledWith(1, "vehicle.check", "check", { listingId: "listing-1" });
    expect(mocks.runMarketPriceEstimate).toHaveBeenCalledWith("listing-1");
    expect(mocks.enqueue).toHaveBeenNthCalledWith(2, "telegram.update", "update", { listingId: "listing-1" });
    expect(mocks.listingUpdate).toHaveBeenCalledWith({
      where: { id: "listing-1" },
      data: {
        possibleDuplicateOfId: "possible-1",
        duplicateConfidence: 0.8,
        duplicateReasons: ["same phone"],
      },
    });
    expect(mocks.observationUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { enrichmentCompletedAt: expect.any(Date) },
    }));
  });

  it("contains optional pricing and duplicate failures without losing completion evidence", async () => {
    mocks.runMarketPriceEstimate.mockRejectedValueOnce(new Error("pricing unavailable"));
    mocks.findPossibleDuplicate.mockRejectedValueOnce(new Error("duplicate lookup unavailable"));

    await expect(processListingEnrich({ listingId: "listing-1" })).resolves.toBeUndefined();

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith("market-price", "Market price estimate failed", "pricing unavailable");
    expect(mocks.logWarn).toHaveBeenCalledWith("possible-duplicate", "Possible duplicate annotation failed", "duplicate lookup unavailable");
    expect(mocks.observationUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { enrichmentCompletedAt: expect.any(Date) },
    }));
  });
});
