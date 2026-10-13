import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listings: [] as Array<Record<string, unknown>>,
  receipts: [] as Array<Record<string, unknown>>,
  bundles: [] as Array<Record<string, unknown>>,
  enqueue: vi.fn(),
}));
vi.mock("../apps/worker/src/env.js", () => ({ env: { TELEGRAM_CHAT_ID: "owner", TELEGRAM_FLASH_BUNDLE_MAX_ITEMS: 20 } }));
vi.mock("../apps/worker/src/lib/queues.js", () => ({ enqueue: state.enqueue }));
vi.mock("../packages/db/src/index.js", () => {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    listing: { findMany: vi.fn(async () => state.listings) },
    telegramNotification: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        for (const row of data) if (!state.receipts.some(r => r.chatId === row.chatId && r.listingId === row.listingId)) state.receipts.push({ ...row });
      }),
      findMany: vi.fn(async ({ where }: { where: { chatId: string } }) => state.receipts.filter(r => r.chatId === where.chatId)),
      updateMany: vi.fn(async ({ where, data }: { where: { chatId: string; listingId: { in: string[] } }; data: Record<string, unknown> }) => {
        for (const row of state.receipts) if (row.chatId === where.chatId && where.listingId.in.includes(row.listingId as string)) Object.assign(row, data);
      }),
    },
    telegramFlashBundle: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.bundles.find(r => r.id === where.id)),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        if (!state.bundles.some(r => r.id === create.id)) state.bundles.push(create);
      }),
    },
  };
  return { Prisma: { sql: vi.fn(), join: vi.fn() }, prisma: {
    telegramSubscriber: { findMany: vi.fn(async () => [{ chatId: "owner" }, { chatId: "subscriber" }]) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => {
      const before = structuredClone({ receipts: state.receipts, bundles: state.bundles });
      try { return await fn(tx); } catch (error) { state.receipts = before.receipts; state.bundles = before.bundles; throw error; }
    }),
  } };
});

import { queueTelegramFirstSignals, splitFirstSignalListings } from "../apps/worker/src/modules/telegram-first-signal.js";
import type { TelegramListingSnapshot } from "../apps/worker/src/modules/telegram-listing-format.js";

function listings(count: number): TelegramListingSnapshot[] {
  return Array.from({ length: count }, (_, i) => ({ id: `listing-${i}`, source: "OLX", url: `https://example.test/${i}`, title: `Car ${i}`, city: "Kyiv" } as TelegramListingSnapshot));
}

describe("durable first signals for every recipient", () => {
  beforeEach(() => { state.listings = []; state.receipts = []; state.bundles = []; state.enqueue.mockReset().mockResolvedValue(undefined); });

  it.each([1, 2, 20, 21, 100])("covers all %i listings for both recipients before queue handoff", async count => {
    const rows = listings(count);
    state.listings = rows as unknown as typeof state.listings;
    state.enqueue.mockImplementation(async () => { expect(state.receipts).toHaveLength(count * 2); });
    await queueTelegramFirstSignals(rows.map(r => r.id), "batch");
    for (const chatId of ["owner", "subscriber"]) {
      const ids = state.bundles.filter(r => r.chatId === chatId).flatMap(r => r.listingIds as string[]);
      expect(ids).toEqual(rows.map(r => r.id));
      expect(new Set(ids).size).toBe(count);
    }
    expect(state.enqueue).toHaveBeenCalledTimes(Math.ceil(count / 20) * 2);
  });

  it("keeps every recipient durable when one queue handoff fails, and retries without duplicate bundles", async () => {
    state.listings = listings(2) as unknown as typeof state.listings;
    state.enqueue.mockRejectedValueOnce(new Error("Redis unavailable"));
    await expect(queueTelegramFirstSignals(["listing-0", "listing-1"], "batch")).rejects.toThrow("Redis unavailable");
    expect(state.enqueue).toHaveBeenCalledTimes(2);
    expect(state.bundles).toHaveLength(2);
    expect(state.receipts).toHaveLength(4);
    await queueTelegramFirstSignals(["listing-0", "listing-1"], "retry-batch");
    expect(state.bundles).toHaveLength(2);
    expect(state.receipts).toHaveLength(4);
  });

  it("does not reopen a delivered or permanently blocked recipient", async () => {
    state.listings = listings(1) as unknown as typeof state.listings;
    state.receipts = [{ listingId: "listing-0", chatId: "owner", status: "DELIVERED", messageId: "123" },
      { listingId: "listing-0", chatId: "subscriber", status: "PERMANENT" }];
    await queueTelegramFirstSignals(["listing-0"], "batch");
    expect(state.bundles).toHaveLength(0);
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  it("splits long messages by rendered size without losing tail links", () => {
    const rows = listings(100).map(row => ({ ...row, title: "X".repeat(90), city: "Y".repeat(160) }));
    const groups = splitFirstSignalListings(rows);
    expect(groups.length).toBeGreaterThan(5);
    expect(groups.flat().map(r => r.id)).toEqual(rows.map(r => r.id));
  });

  it("keeps background signals below realtime queue priority", async () => {
    state.listings = listings(1).map(row => ({ ...row, discoveryLane: "BACKFILL" }));
    await queueTelegramFirstSignals(["listing-0"], "background");
    expect(state.enqueue).toHaveBeenCalledWith("telegram.flash", "flash", expect.any(Object), expect.objectContaining({ priority: 8 }));
  });
});
