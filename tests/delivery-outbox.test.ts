import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("../packages/db/src/index.js", () => ({
  prisma: {
    $transaction: mocks.transaction,
    telegramNotification: { findMany: mocks.findMany },
  },
}));

import {
  reconcileOrphanDeliveryIntents,
  selectPendingCardDeliveryIntents,
} from "../apps/worker/src/modules/delivery-outbox.js";

describe("durable delivery outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const tx = { $executeRaw: mocks.executeRaw, $queryRaw: mocks.queryRaw };
    mocks.transaction.mockImplementation(async (operation) => operation(tx));
    mocks.executeRaw.mockResolvedValue(0);
    mocks.queryRaw.mockResolvedValue([{ id: "intent-1" }, { id: "intent-2" }]);
    mocks.findMany.mockResolvedValue([{ listingId: "listing-1" }]);
  });

  it.each([
    [0, 1],
    [20.9, 20],
    [50_000, 2_000],
  ])("bounds orphan reconciliation limit %s to %s inside one transaction", async (limit, expected) => {
    await expect(reconcileOrphanDeliveryIntents("chat-1", limit)).resolves.toBe(2);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 3_000, timeout: 5_000 });
    expect(mocks.executeRaw).toHaveBeenCalledTimes(2);
    const interpolation = mocks.queryRaw.mock.calls[0]?.slice(1);
    expect(interpolation).toContain("chat-1");
    expect(interpolation).toContain(expected);
  });

  it("uses a non-secret placeholder when Telegram is not configured", async () => {
    await reconcileOrphanDeliveryIntents("", 1);
    expect(mocks.queryRaw.mock.calls[0]?.slice(1)).toContain("not-configured");
  });

  it("selects due retryable LIVE intents without a lifetime attempt ceiling", async () => {
    const now = new Date("2026-09-21T12:00:00.000Z");
    await expect(selectPendingCardDeliveryIntents(17, now)).resolves.toEqual([{ listingId: "listing-1" }]);
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["PENDING", "TRANSIENT", "AMBIGUOUS", "RETRY_PENDING", "FAILED"] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        listing: { notificationMode: "LIVE", status: { notIn: ["IGNORED", "DUPLICATE"] } },
      },
      select: { listingId: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 17,
    });
  });
});
