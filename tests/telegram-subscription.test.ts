import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(), resetFlash: vi.fn(), resetCard: vi.fn(), flashes: vi.fn(), cards: vi.fn(), enqueue: vi.fn(),
}));
vi.mock("../packages/db/src/index.js", () => ({ prisma: {
  $transaction: async (fn: (tx: unknown) => Promise<void>) => fn({
    telegramSubscriber: { upsert: mocks.upsert }, telegramFlashBundle: { updateMany: mocks.resetFlash },
    telegramNotification: { updateMany: mocks.resetCard },
  }),
  telegramFlashBundle: { findMany: mocks.flashes }, telegramNotification: { findMany: mocks.cards },
} }));
vi.mock("../apps/api/src/lib/queues.js", () => ({ enqueue: mocks.enqueue }));
import { activateTelegramSubscriber } from "../apps/api/src/modules/telegram-subscription.js";

describe("Telegram subscription recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.flashes.mockResolvedValue([]); mocks.cards.mockResolvedValue([]);
  });
  it("activates a new subscriber without replaying historical listings", async () => {
    await activateTelegramSubscriber("new");
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { chatId: "new" }, update: expect.objectContaining({ active: true, blockedAt: null }),
    }));
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("restores only this chat's known permanent failures and preserves accepted flash", async () => {
    mocks.flashes.mockResolvedValue([{ id: "failed-flash" }]);
    await activateTelegramSubscriber("returning");
    expect(mocks.resetFlash).toHaveBeenCalledWith(expect.objectContaining({ where: {
      chatId: "returning", status: "PERMANENT", acceptedAt: null, messageId: null,
      lastErrorCode: "TELEGRAM_FLASH_PERMANENT",
    } }));
    expect(mocks.resetCard.mock.calls[0][0].where).toMatchObject({ chatId: "returning", status: "PERMANENT", messageId: null });
    expect(mocks.enqueue).toHaveBeenCalledWith("telegram.flash", "subscriber-resume", { flashBundleId: "failed-flash" }, { priority: 1 });
  });
  it("routes accepted cards to their recipient and unsignalled cards through first-signal admission", async () => {
    mocks.cards.mockResolvedValue([{ listingId: "accepted", acceptedAt: new Date() }, { listingId: "new", acceptedAt: null }]);
    await activateTelegramSubscriber("returning");
    expect(mocks.enqueue).toHaveBeenCalledWith("telegram.send", "subscriber-resume", { listingId: "accepted", chatId: "returning" }, { priority: 12 });
    expect(mocks.enqueue).toHaveBeenCalledWith("telegram.send", "subscriber-resume", { listingId: "new" }, { priority: 1 });
  });
  it("propagates failed queue handoff so the update can retry durable pending work", async () => {
    mocks.flashes.mockResolvedValue([{ id: "durable" }]);
    mocks.enqueue.mockRejectedValueOnce(new Error("Redis offline"));
    await expect(activateTelegramSubscriber("returning")).rejects.toThrow("Redis offline");
    await activateTelegramSubscriber("returning");
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  });
});

