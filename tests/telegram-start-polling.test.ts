import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn(), activate: vi.fn(), send: vi.fn() }));
vi.mock("../apps/api/src/env.js", () => ({ env: { REDIS_URL: "redis://127.0.0.1:1", TELEGRAM_CONTROL_BOT_ENABLED: true, TELEGRAM_BOT_TOKEN: "test" } }));
vi.mock("../apps/api/src/modules/telegram-subscription.js", () => ({ activateTelegramSubscriber: mocks.activate }));
vi.mock("../apps/api/src/lib/error-log.js", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));
vi.mock("../apps/api/src/modules/telegram-control-client.js", () => ({
  telegramApi: mocks.api, sendTelegramMessageToChat: mocks.send, abortActiveTelegramRequests: vi.fn(),
  answerTelegramCallback: vi.fn(), editTelegramMessage: vi.fn(), editTelegramReplyMarkup: vi.fn(), sendTelegramMessage: vi.fn(),
}));
import { startTelegramControlBot, stopTelegramControlBot } from "../apps/api/src/modules/telegram-control-bot.js";
afterEach(() => { stopTelegramControlBot(); vi.useRealTimers(); });
it("processes pending /start after boot and retries it before acknowledging a failed registration", async () => {
  vi.useFakeTimers();
  const offsets: number[] = [];
  mocks.send.mockResolvedValue(undefined);
  mocks.activate.mockRejectedValueOnce(new Error("temporary DB outage")).mockResolvedValue(undefined);
  mocks.api.mockImplementation(async (method: string, args: { offset?: number }) => {
    if (method === "deleteWebhook") return true;
    offsets.push(args.offset ?? -1);
    if (offsets.length <= 2) return [{ update_id: 10, message: { message_id: 1, chat: { id: 7, type: "private" }, text: "/start" } }];
    stopTelegramControlBot();
    return [];
  });
  startTelegramControlBot();
  await vi.runAllTimersAsync();
  expect(offsets).toEqual([0, 0, 11]);
  expect(mocks.activate).toHaveBeenCalledTimes(2);
  expect(mocks.activate).toHaveBeenLastCalledWith("7");
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

it("registers another subscriber without waiting for a stalled welcome", async () => {
  vi.useFakeTimers();
  mocks.activate.mockClear();
  mocks.send.mockImplementation(() => new Promise(() => {}));
  let polls = 0;
  mocks.api.mockImplementation(async (method: string) => {
    if (method === "deleteWebhook") return true;
    if (++polls === 1) return [7, 8].map(id => ({ update_id: id, message: { message_id: id, chat: { id, type: "private" }, text: "/start" } }));
    stopTelegramControlBot(); return [];
  });
  startTelegramControlBot();
  await vi.runAllTimersAsync();
  expect(mocks.activate.mock.calls.map(call => call[0])).toEqual(["7", "8"]);
  expect(polls).toBe(2);
});

