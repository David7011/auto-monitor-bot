import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chatAction: vi.fn(),
  subUpdateMany: vi.fn(),
}));

vi.mock("../packages/db/src/index.js", () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  prisma: { telegramSubscriber: { updateMany: mocks.subUpdateMany } },
}));
vi.mock("../apps/worker/node_modules/grammy/out/mod.js", () => ({
  Bot: class { api = { sendChatAction: mocks.chatAction }; },
}));
vi.mock("../apps/worker/src/env.js", () => ({
  env: {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "owner-1",
    TELEGRAM_BLOCK_SUPPRESS_ENABLED: true,
  },
}));
vi.mock("../apps/worker/src/lib/log.js", () => ({ log: { warn: vi.fn(async () => undefined), error: vi.fn(async () => undefined), info: vi.fn(async () => undefined) } }));
vi.mock("../apps/worker/src/lib/queues.js", () => ({ redisConnection: {} }));
vi.mock("../apps/worker/src/modules/telegram-send-gate.js", () => ({
  telegramRateGateKey: () => "test",
  TelegramSendGate: class { async waitForSlot() {} async deferFor() {} },
}));

import { verifyAndSuppressBlockedChat } from "../apps/worker/src/modules/telegram-service.js";

function blockedError() {
  return new Error("Forbidden: bot was blocked by the user");
}

describe("verified block suppression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.subUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("deactivates a subscriber only after the probe confirms the block", async () => {
    mocks.chatAction.mockRejectedValueOnce(blockedError());
    await expect(verifyAndSuppressBlockedChat("chat-9", "Forbidden: bot was blocked by the user")).resolves.toBe(true);
    expect(mocks.chatAction).toHaveBeenCalledWith("chat-9", "typing");
    expect(mocks.subUpdateMany).toHaveBeenCalledWith({
      where: { chatId: "chat-9", active: true },
      data: { active: false, blockedAt: expect.any(Date) },
    });
  });

  it("keeps the subscriber when the probe delivers fine (flake)", async () => {
    mocks.chatAction.mockResolvedValueOnce(true);
    await expect(verifyAndSuppressBlockedChat("chat-9", "Forbidden: bot was blocked by the user")).resolves.toBe(false);
    expect(mocks.subUpdateMany).not.toHaveBeenCalled();
  });

  it("keeps the subscriber when the probe itself fails transiently", async () => {
    mocks.chatAction.mockRejectedValueOnce(new Error("network timeout"));
    await expect(verifyAndSuppressBlockedChat("chat-9", "Forbidden: bot was blocked by the user")).resolves.toBe(false);
    expect(mocks.subUpdateMany).not.toHaveBeenCalled();
  });

  it("never auto-suppresses the owner chat", async () => {
    await expect(verifyAndSuppressBlockedChat("owner-1", "Forbidden: bot was blocked by the user")).resolves.toBe(false);
    expect(mocks.chatAction).not.toHaveBeenCalled();
    expect(mocks.subUpdateMany).not.toHaveBeenCalled();
  });
});
