import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  listingCount: vi.fn(),
  notificationFindMany: vi.fn(),
  notificationUpdateMany: vi.fn(),
  notificationFindUnique: vi.fn(),
  notificationUpdate: vi.fn(),
  listingDeleteMany: vi.fn(),
  seenUpsert: vi.fn(),
  lock: vi.fn(),
  applyKeyboard: vi.fn(),
  cleanupMessage: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("../packages/db/src/index.js", () => ({
  Prisma: { DbNull: Symbol("DbNull") },
  acquireTelegramRetentionLock: mocks.lock,
  prisma: {
    $transaction: mocks.transaction,
    listing: { count: mocks.listingCount },
    telegramNotification: {
      findMany: mocks.notificationFindMany,
      updateMany: mocks.notificationUpdateMany,
    },
  },
}));
vi.mock("../apps/worker/src/modules/telegram-service.js", () => ({
  applyListingRetentionKeyboard: mocks.applyKeyboard,
  cleanupListingTelegramMessage: mocks.cleanupMessage,
}));
vi.mock("../apps/worker/src/lib/log.js", () => ({ log: { info: mocks.logInfo } }));

import {
  adoptFreshListingNotifications,
  notificationCleanupDue,
  previewListingRetention,
  runListingRetentionMaintenance,
} from "../apps/worker/src/modules/listing-retention.js";

const now = new Date("2026-09-15T12:00:00.000Z");
const old = new Date("2026-09-14T00:00:00.000Z");

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "notification-1",
    chatId: "chat-1",
    messageId: "42",
    status: "DELIVERED",
    sentAt: old,
    deleteAfter: old,
    favoritedAt: null,
    retainUntil: null,
    retentionPolicyAppliedAt: old,
    cleanupAttemptedAt: null,
    lastErrorCode: null,
    listing: {
      id: "listing-1",
      source: "OLX",
      externalId: "external-1",
      url: "https://example.test/1",
      canonicalUrl: "https://example.test/1",
      firstSeenAt: old,
      discoveryLane: "REALTIME",
    },
    ...overrides,
  };
}

function claimed(overrides: Record<string, unknown> = {}) {
  return {
    id: "notification-1",
    chatId: "chat-1",
    messageId: "42",
    status: "DELIVERED",
    sentAt: old,
    deleteAfter: old,
    favoritedAt: null,
    retainUntil: null,
    retentionPolicyAppliedAt: old,
    cleanupAttemptedAt: null,
    lastErrorCode: null,
    ...overrides,
  };
}

function finalized(overrides: Record<string, unknown> = {}) {
  return {
    id: "notification-1",
    status: "DELIVERED",
    messageId: "42",
    sentAt: old,
    deleteAfter: old,
    favoritedAt: null,
    retainUntil: null,
    retentionPolicyAppliedAt: old,
    cleanupAttemptedAt: now,
    ...overrides,
  };
}

describe("listing retention runtime", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const tx = {
      telegramNotification: {
        findUnique: mocks.notificationFindUnique,
        update: mocks.notificationUpdate,
        updateMany: mocks.notificationUpdateMany,
      },
      listing: { deleteMany: mocks.listingDeleteMany },
      sourceSeenListing: { upsert: mocks.seenUpsert },
    };
    mocks.transaction.mockImplementation(async (operation) => operation(tx));
    mocks.notificationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.notificationUpdate.mockResolvedValue({});
    mocks.listingDeleteMany.mockResolvedValue({ count: 1 });
    mocks.seenUpsert.mockResolvedValue({});
    mocks.lock.mockResolvedValue(undefined);
    mocks.cleanupMessage.mockResolvedValue({ outcome: "CLEARED" });
    mocks.logInfo.mockResolvedValue(undefined);
  });

  it("reports every preview class without changing data", async () => {
    mocks.listingCount.mockResolvedValueOnce(4).mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    await expect(previewListingRetention(now)).resolves.toEqual({
      due: 4,
      expiredFavorites: 1,
      legacyLocalOnly: 2,
      withoutNotification: 3,
    });
    expect(mocks.listingCount).toHaveBeenCalledTimes(4);
  });

  it("adopts successful fresh messages and persists retry/permanent outcomes", async () => {
    mocks.notificationFindMany.mockResolvedValue([
      { id: "retry", listingId: "l1", chatId: "c", messageId: "1", sentAt: now, listing: { url: "u1" } },
      { id: "permanent", listingId: "l2", chatId: "c", messageId: "2", sentAt: now, listing: { url: "u2" } },
      { id: "success", listingId: "l3", chatId: "c", messageId: "3", sentAt: now, listing: { url: "u3" } },
      { id: "invalid", listingId: "l4", chatId: "c", messageId: null, sentAt: null, listing: { url: "u4" } },
    ]);
    mocks.applyKeyboard
      .mockResolvedValueOnce({ outcome: "RETRY", errorCode: "TEMP", errorMessage: "temporary" })
      .mockResolvedValueOnce({ outcome: "PERMANENT_FAILURE", errorMessage: "gone" })
      .mockResolvedValueOnce({ outcome: "UPDATED" });

    await expect(adoptFreshListingNotifications(now)).resolves.toEqual({
      selected: 4, adopted: 1, deferred: 1, permanentFailures: 1,
    });
    expect(mocks.notificationUpdateMany).toHaveBeenCalledTimes(3);
    expect(mocks.logInfo).toHaveBeenCalledWith("listing-retention", expect.stringContaining("deferred 1"));
  });

  it("returns an empty summary without noisy logging", async () => {
    mocks.notificationFindMany.mockResolvedValue([]);
    await expect(runListingRetentionMaintenance(now, 0)).resolves.toEqual({
      selected: 0, deletedListings: 0, detachedObservations: 0, telegramCleared: 0,
      legacyLocalOnly: 0, deferred: 0, deferredReasons: {}, skipped: 0,
    });
    expect(mocks.logInfo).not.toHaveBeenCalled();
  });

  it("backs failed Telegram cleanup off and records a reason histogram", async () => {
    mocks.notificationFindMany.mockResolvedValue([candidate()]);
    mocks.notificationFindUnique.mockResolvedValueOnce(claimed());
    mocks.cleanupMessage.mockResolvedValueOnce({
      outcome: "RETRY", errorCode: "TELEGRAM_RATE_LIMITED", errorMessage: "retry later",
    });
    const summary = await runListingRetentionMaintenance(now, 1);
    expect(summary).toMatchObject({ deferred: 1, deferredReasons: { TELEGRAM_RATE_LIMITED: 1 } });
    expect(mocks.notificationUpdateMany).toHaveBeenCalledWith({
      where: { id: "notification-1", cleanupAttemptedAt: now },
      data: { lastErrorCode: "TELEGRAM_RATE_LIMITED", lastErrorMessage: "retry later" },
    });
    expect(mocks.logInfo).toHaveBeenCalledWith("listing-retention", expect.stringContaining("TELEGRAM_RATE_LIMITED=1"));
  });

  it("skips missing, cooling and no-longer-due claims without calling Telegram", async () => {
    mocks.notificationFindMany.mockResolvedValue([
      candidate({ id: "missing" }), candidate({ id: "cooling" }), candidate({ id: "not-due" }),
    ]);
    mocks.notificationFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(claimed({ id: "cooling", cleanupAttemptedAt: new Date(now.getTime() - 60_000) }))
      .mockResolvedValueOnce(claimed({ id: "not-due", deleteAfter: new Date(now.getTime() + 60_000) }));
    await expect(runListingRetentionMaintenance(now, 3)).resolves.toMatchObject({ selected: 3, skipped: 3 });
    expect(mocks.cleanupMessage).not.toHaveBeenCalled();
  });

  it("deletes a claimed LIVE listing and persists its compact dedupe tombstone", async () => {
    mocks.notificationFindMany.mockResolvedValue([candidate()]);
    mocks.notificationFindUnique.mockResolvedValueOnce(claimed()).mockResolvedValueOnce(finalized());
    await expect(runListingRetentionMaintenance(now, 1)).resolves.toMatchObject({
      selected: 1, deletedListings: 1, telegramCleared: 1, detachedObservations: 1, skipped: 0,
    });
    expect(mocks.cleanupMessage).toHaveBeenCalledOnce();
    expect(mocks.listingDeleteMany).toHaveBeenCalledOnce();
    expect(mocks.seenUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { source_externalId: { source: "OLX", externalId: "external-1" } },
      update: expect.objectContaining({ listingId: null, decision: "NOTIFIED" }),
    }));
  });

  it("purges legacy local-only rows without making a Telegram request", async () => {
    mocks.notificationFindMany.mockResolvedValue([candidate({ retentionPolicyAppliedAt: null })]);
    mocks.notificationFindUnique
      .mockResolvedValueOnce(claimed({ retentionPolicyAppliedAt: null }))
      .mockResolvedValueOnce(finalized({ retentionPolicyAppliedAt: null }));
    await expect(runListingRetentionMaintenance(now, 1)).resolves.toMatchObject({
      deletedListings: 1, telegramCleared: 0, legacyLocalOnly: 1,
    });
    expect(mocks.cleanupMessage).not.toHaveBeenCalled();
  });

  it.each([
    [null, 0],
    [finalized({ cleanupAttemptedAt: new Date(now.getTime() - 1) }), 0],
    [finalized({ messageId: null }), 0],
  ])("preserves a row when finalization loses its invariant %#", async (refreshed, deleteCount) => {
    mocks.notificationFindMany.mockResolvedValue([candidate()]);
    mocks.notificationFindUnique.mockResolvedValueOnce(claimed()).mockResolvedValueOnce(refreshed);
    mocks.listingDeleteMany.mockResolvedValueOnce({ count: deleteCount });
    await expect(runListingRetentionMaintenance(now, 1)).resolves.toMatchObject({ deletedListings: 0, skipped: 1 });
    expect(mocks.seenUpsert).not.toHaveBeenCalled();
  });

  it("does not repeat cleanup after a delivered receipt has been cleared", async () => {
    let row = claimed();
    mocks.notificationFindMany.mockImplementation(async () => row.messageId ? [candidate()] : []);
    mocks.notificationFindUnique.mockImplementation(async () => row);
    mocks.notificationUpdate.mockImplementation(async ({ data }) => {
      row = { ...row, ...data };
      return row;
    });
    mocks.notificationUpdateMany.mockImplementation(async ({ data }) => {
      row = { ...row, ...data };
      return { count: 1 };
    });
    await expect(runListingRetentionMaintenance(now, 1)).resolves.toMatchObject({ deletedListings: 1 });
    await expect(runListingRetentionMaintenance(new Date(now.getTime() + 30 * 60_000), 1))
      .resolves.toMatchObject({ selected: 0, deletedListings: 0 });
    expect(mocks.cleanupMessage).toHaveBeenCalledOnce();
    expect(row.status).toBe("DELIVERED");
    expect(row.messageId).toBeNull();
    expect(row.retentionPolicyAppliedAt).toBeNull();
    expect(row.favoritedAt).toBeNull();
  });

  it("preserves the listing and accepted receipt while another recipient still needs it", async () => {
    mocks.notificationFindMany.mockResolvedValue([candidate()]);
    mocks.notificationFindUnique.mockResolvedValueOnce(claimed()).mockResolvedValueOnce(finalized());
    mocks.listingDeleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(runListingRetentionMaintenance(now, 1)).resolves.toMatchObject({
      telegramCleared: 1, deletedListings: 0, skipped: 0,
    });
    expect(mocks.notificationUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ messageId: null, deleteAfter: null }),
    }));
    expect(mocks.listingDeleteMany).toHaveBeenCalledWith({ where: {
      id: "listing-1",
      telegramNotifications: { every: {
        status: { in: ["SENT", "UPDATED", "DELIVERED"] },
        messageId: null, deleteAfter: null, cleanupAttemptedAt: { not: null },
      } },
    } });
    expect(mocks.seenUpsert).not.toHaveBeenCalled();
  });

  it("clears an expired favorite without violating database policy constraints", async () => {
    mocks.notificationFindMany.mockResolvedValue([candidate({ favoritedAt: old, retainUntil: old, deleteAfter: null })]);
    mocks.notificationFindUnique
      .mockResolvedValueOnce(claimed({ favoritedAt: old, retainUntil: old, deleteAfter: null }))
      .mockResolvedValueOnce(finalized({ favoritedAt: old, retainUntil: old, deleteAfter: null }));
    mocks.listingDeleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(runListingRetentionMaintenance(now, 1)).resolves.toMatchObject({ telegramCleared: 1, deletedListings: 0 });
    expect(mocks.notificationUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        messageId: null, deleteAfter: null, retainUntil: null,
        favoritedAt: null, retentionPolicyAppliedAt: null,
      }),
    }));
  });

  it("preserves data when the conditional receipt finalization loses its claim", async () => {
    mocks.notificationFindMany.mockResolvedValue([candidate()]);
    mocks.notificationFindUnique.mockResolvedValueOnce(claimed()).mockResolvedValueOnce(finalized());
    mocks.notificationUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(runListingRetentionMaintenance(now, 1)).resolves.toMatchObject({ deletedListings: 0, skipped: 1 });
    expect(mocks.listingDeleteMany).not.toHaveBeenCalled();
  });

  it.each(["SENT", "UPDATED", "DELIVERED"])("cleans legacy %s receipts using the same status contract", async (status) => {
    mocks.notificationFindMany.mockResolvedValue([candidate({ status, retentionPolicyAppliedAt: null })]);
    mocks.notificationFindUnique
      .mockResolvedValueOnce(claimed({ status, retentionPolicyAppliedAt: null }))
      .mockResolvedValueOnce(finalized({ status, retentionPolicyAppliedAt: null }));
    await expect(runListingRetentionMaintenance(now, 1)).resolves.toMatchObject({ deletedListings: 1 });
    expect(mocks.notificationFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { AND: [expect.anything(), expect.objectContaining({ status: { in: ["SENT", "UPDATED", "DELIVERED"] } })] },
    }));
  });

  it.each(["PENDING", "SENDING", "TRANSIENT", "AMBIGUOUS", "QUARANTINED", "FAILED"])(
    "does not clean %s receipts even with an expired policy", async (status) => {
      mocks.notificationFindMany.mockResolvedValue([candidate({ status })]);
      mocks.notificationFindUnique.mockResolvedValueOnce(claimed({ status }));
      await expect(runListingRetentionMaintenance(now, 1)).resolves.toMatchObject({ skipped: 1, deletedListings: 0 });
      expect(mocks.cleanupMessage).not.toHaveBeenCalled();
    },
  );

  it("classifies favorite, managed and legacy due boundaries", () => {
    const regular = new Date("2026-09-15T00:00:00.000Z");
    expect(notificationCleanupDue(claimed({ favoritedAt: old, retainUntil: now }), now, regular)).toBe(true);
    expect(notificationCleanupDue(claimed({ favoritedAt: old, retainUntil: null }), now, regular)).toBe(false);
    expect(notificationCleanupDue(claimed({ retentionPolicyAppliedAt: old, deleteAfter: now }), now, regular)).toBe(true);
    expect(notificationCleanupDue(claimed({ retentionPolicyAppliedAt: null, status: "SENT", sentAt: old }), now, regular)).toBe(true);
    expect(notificationCleanupDue(claimed({ retentionPolicyAppliedAt: null, status: "FAILED" }), now, regular)).toBe(false);
  });
});
