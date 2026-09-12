import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const receipt = {
    id: "notification-1", listingId: "listing-1", status: "PENDING", messageId: null as string | null,
    acceptedAt: null as Date | null, sentAt: null as Date | null, leaseExpiresAt: null as Date | null,
  };
  const flash = { ...receipt, id: "flash-1", listingIds: ["listing-1"], lastText: "a listing" };
  const notificationFind = vi.fn(async () => ({ ...receipt }));
  const flashFind = vi.fn(async () => ({ ...flash }));
  const updateReceipt = vi.fn(async (args: { data: object }) => Object.assign(receipt, args.data));
  const updateFlash = vi.fn(async (args: { data: object }) => Object.assign(flash, args.data));
  function updateMatching(row: typeof receipt, args: { where: { messageId?: null; status?: string | object }; data: object }) {
    if (args.where.messageId === null && row.messageId !== null) return { count: 0 };
    if (typeof args.where.status === "string" && row.status !== args.where.status) return { count: 0 };
    Object.assign(row, args.data);
    return { count: 1 };
  }
  return {
    receipt, flash, notificationFind, flashFind, updateReceipt, updateFlash,
    send: vi.fn(async () => ({ message_id: 123 })),
    transaction: vi.fn(async (operations: unknown[]) => Promise.all(operations)),
    notificationUpdateMany: vi.fn(async (args: Parameters<typeof updateMatching>[1]) => updateMatching(receipt, args)),
    flashUpdateMany: vi.fn(async (args: Parameters<typeof updateMatching>[1]) => updateMatching(flash, args)),
    listingUpdate: vi.fn(async () => ({})),
    listingUpdateMany: vi.fn(async () => ({ count: 1 })),
    observationUpdate: vi.fn(async () => ({ count: 1 })),
  };
});

vi.mock("../packages/db/src/index.js", () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  prisma: {
    telegramNotification: { findUnique: mocks.notificationFind, update: mocks.updateReceipt, updateMany: mocks.notificationUpdateMany },
    telegramFlashBundle: { findUnique: mocks.flashFind, update: mocks.updateFlash, updateMany: mocks.flashUpdateMany },
    listing: { update: mocks.listingUpdate, updateMany: mocks.listingUpdateMany, findMany: vi.fn(async () => [{ id: "listing-1" }]) },
    sourceSeenListing: { updateMany: mocks.observationUpdate },
    $transaction: mocks.transaction,
  },
}));
vi.mock("../apps/worker/node_modules/grammy/out/mod.js", () => ({ Bot: class { api = { sendMessage: mocks.send }; } }));
vi.mock("../apps/worker/src/env.js", () => ({ env: { TELEGRAM_BOT_TOKEN: "test", TELEGRAM_CHAT_ID: "test", LISTING_RETENTION_HOURS: 12 } }));
vi.mock("../apps/worker/src/lib/log.js", () => ({ log: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("../apps/worker/src/lib/queues.js", () => ({ redisConnection: {} }));
vi.mock("../apps/worker/src/modules/telegram-send-gate.js", () => ({
  telegramRateGateKey: () => "test",
  TelegramSendGate: class { async waitForSlot() {} async defer() {} },
}));
vi.mock("../apps/worker/src/modules/telegram-listing-format.js", () => ({
  initialMessageText: () => "a listing", enrichedMessageText: () => "a listing", clampTelegramText: (text: string) => text,
}));

import { sendListingLink, sendTelegramFlashBundle, type TelegramListingSnapshot } from "../apps/worker/src/modules/telegram-service.js";

const snapshot = {
  id: "listing-1", url: "https://example.test/1", notificationMode: "LIVE", discoveryLane: "REALTIME", firstSeenAt: new Date(),
} as TelegramListingSnapshot;

describe("Telegram acceptance receipt survives local DB projection failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notificationFind.mockImplementation(async () => ({ ...mocks.receipt }));
    mocks.flashFind.mockImplementation(async () => ({ ...mocks.flash }));
    mocks.transaction.mockReset().mockImplementation(async (operations) => Promise.all(operations));
    for (const row of [mocks.receipt, mocks.flash]) Object.assign(row, {
      status: "PENDING", messageId: null, acceptedAt: null, sentAt: null, leaseExpiresAt: null,
    });
  });

  it("retries the journal after a confirmed card without sending it again", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("journal connection failed"));
    await expect(sendListingLink("listing-1", snapshot)).rejects.toThrow("journal connection failed");
    expect(mocks.receipt.status).toBe("SENT");
    expect(mocks.receipt.messageId).toBe("123");
    await sendListingLink("listing-1", snapshot);
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.listingUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["NEW", "MATCHED"] } }),
    }));
  });

  it("cannot reclaim a card that another attempt sent between read and CAS", async () => {
    mocks.notificationFind.mockImplementationOnce(async () => {
      const stale = { ...mocks.receipt };
      Object.assign(mocks.receipt, { status: "SENT", messageId: "concurrent", acceptedAt: new Date() });
      return stale;
    });
    await sendListingLink("listing-1", snapshot);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.receipt.messageId).toBe("concurrent");
  });

  it("does not let a fallback send while the original ambiguous lease is active", async () => {
    Object.assign(mocks.receipt, {
      status: "PROCESSING",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    await sendListingLink("listing-1", snapshot);

    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.notificationUpdateMany).not.toHaveBeenCalled();
  });

  it("allows a bounded fallback after the ambiguous lease expires", async () => {
    Object.assign(mocks.receipt, {
      status: "PROCESSING",
      leaseExpiresAt: new Date(Date.now() - 1),
    });

    await sendListingLink("listing-1", snapshot);

    expect(mocks.notificationUpdateMany).toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.receipt.status).toBe("SENT");
  });

  it("persists a flash receipt before projection updates and only replays projections", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("journal connection failed"));
    await expect(sendTelegramFlashBundle("flash-1")).rejects.toThrow("journal connection failed");
    expect(mocks.flash.status).toBe("SENT");
    await expect(sendTelegramFlashBundle("flash-1")).resolves.toEqual(["listing-1"]);
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.listingUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["NEW", "MATCHED"] } }),
    }));
  });

  it("cannot reclaim a flash that another attempt sent between read and CAS", async () => {
    mocks.flashFind.mockImplementationOnce(async () => {
      const stale = { ...mocks.flash };
      Object.assign(mocks.flash, { status: "SENT", messageId: "concurrent", acceptedAt: new Date() });
      return stale;
    });
    await expect(sendTelegramFlashBundle("flash-1")).resolves.toEqual([]);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
