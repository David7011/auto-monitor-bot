import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedListing } from "@amb/shared";
const mocks = vi.hoisted(() => ({ update: vi.fn(), find: vi.fn() }));
vi.mock("../packages/db/src/index.js", () => ({ Prisma: {}, prisma: { sourceSeenListing: { updateMany: mocks.update, findUnique: mocks.find } } }));
import { recordObservationEvaluation } from "../apps/worker/src/modules/observation-journal.js";

const listing = { source: "OLX", externalId: "cas-1", url: "https://example.test/cas-1", canonicalUrl: "https://example.test/cas-1", firstSeenAt: new Date(), photoUrls: [], raw: {} } as NormalizedListing;
describe("terminal observation evaluation CAS", () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it("performs one atomic conditional write on the ordinary path", async () => {
    mocks.update.mockResolvedValue({ count: 1 });
    await expect(recordObservationEvaluation(listing, "REALTIME", { decision: "PENDING" })).resolves.toBe(true);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ decision: { not: "NOTIFIED" }, notifiedAt: null, telegramAcceptedAt: null }) }));
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it("declines a stale evaluator without reviving a terminal receipt", async () => {
    mocks.update.mockResolvedValue({ count: 0 }); mocks.find.mockResolvedValue({ decision: "NOTIFIED" });
    await expect(recordObservationEvaluation(listing, "BACKFILL", { decision: "REJECTED" })).resolves.toBe(false);
  });
  it("fails explicitly if the mandatory durable journal is missing", async () => {
    mocks.update.mockResolvedValue({ count: 0 }); mocks.find.mockResolvedValue(null);
    await expect(recordObservationEvaluation(listing, "BACKFILL", { decision: "MATCHED" })).rejects.toThrow("journal missing");
  });
});
