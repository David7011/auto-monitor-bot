import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  enqueue: vi.fn(async (
    queue: string,
    _name: string,
    data: { listingId?: string },
    _options?: { jobId?: string },
  ) => {
    mocks.events.push(`enqueue:${queue}:${data.listingId ?? ""}`);
  }),
  sendTelegramFlashBundle: vi.fn(async () => {
    mocks.events.push("send:flash");
    return ["listing-new", "listing-old"];
  }),
}));

vi.mock("../apps/worker/src/modules/telegram-service.js", () => ({
  sendListingLink: vi.fn(),
  sendTelegramFlashBundle: mocks.sendTelegramFlashBundle,
  TelegramRateLimitError: class TelegramRateLimitError extends Error {
    constructor(message: string, public readonly retryAfterSeconds: number) {
      super(message);
    }
  },
  updateListingMessage: vi.fn(),
}));

vi.mock("../apps/worker/src/lib/queues.js", () => ({ enqueue: mocks.enqueue }));

import { processTelegramFlash } from "../apps/worker/src/processors/telegram.js";
import { QUEUE_NAMES } from "../packages/shared/src/constants/queues.js";

describe("telegram.flash processor", () => {
  beforeEach(() => {
    mocks.events.length = 0;
    mocks.enqueue.mockClear();
    mocks.sendTelegramFlashBundle.mockClear();
  });

  it("confirms the flash message before enqueueing any detailed card", async () => {
    await processTelegramFlash({ flashBundleId: "flash-1" });

    expect(mocks.events).toEqual([
      "send:flash",
      `enqueue:${QUEUE_NAMES.TELEGRAM_SEND}:listing-new`,
      `enqueue:${QUEUE_NAMES.TELEGRAM_SEND}:listing-old`,
    ]);
    expect(mocks.enqueue.mock.calls.map((call) => call[3]?.jobId)).toEqual([
      "telegram-flash-card-flash-1-listing-new",
      "telegram-flash-card-flash-1-listing-old",
    ]);
  });

  it("does not enqueue cards while another worker owns the durable lease", async () => {
    mocks.sendTelegramFlashBundle.mockResolvedValueOnce([]);

    await processTelegramFlash({ flashBundleId: "flash-locked" });

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
