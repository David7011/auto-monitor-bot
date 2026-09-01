import { env } from "../env.js";
import { TelegramSendGate, telegramRateGateKey } from "@amb/shared";
import { ensureRedisReady, redisConnection } from "../lib/queues.js";
import { TelegramApiTimeoutError } from "../lib/telegram-polling-policy.js";
import type { ReplyMarkup } from "./telegram-control-filters.js";

type TelegramApiResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_code?: number; description?: string; parameters?: { retry_after?: number } };

const activeAbortControllers = new Set<AbortController>();
const telegramRateGate = new TelegramSendGate(env.TELEGRAM_LISTING_SEND_MIN_INTERVAL_MS, {
  redis: {
    eval: async (script, numberOfKeys, ...args) => {
      await ensureRedisReady();
      return redisConnection.eval(script, numberOfKeys, ...args);
    },
  },
  key: telegramRateGateKey(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID),
});
const RATE_GATED_METHOD_PRIORITIES: Readonly<Record<string, number>> = {
  sendMessage: 1,
  editMessageText: 5,
  editMessageReplyMarkup: 5,
  deleteMessage: 10,
};

export function abortActiveTelegramRequests(): void {
  for (const controller of activeAbortControllers) controller.abort();
  activeAbortControllers.clear();
}

export async function sendTelegramMessage(text: string, replyMarkup: ReplyMarkup): Promise<void> {
  await telegramApi<unknown>("sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: trimTelegramMessage(text),
    reply_markup: replyMarkup,
    disable_web_page_preview: true,
  });
}

export async function editTelegramMessage(
  chatId: number | string,
  messageId: number,
  text: string,
  replyMarkup: ReplyMarkup,
): Promise<void> {
  await telegramApi<unknown>("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: trimTelegramMessage(text),
    reply_markup: replyMarkup,
    disable_web_page_preview: true,
  });
}

export async function editTelegramReplyMarkup(
  chatId: number | string,
  messageId: number,
  replyMarkup: ReplyMarkup,
): Promise<void> {
  await telegramApi<unknown>("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

export async function answerTelegramCallback(
  callbackQueryId: string,
  text: string,
): Promise<void> {
  await telegramApi<unknown>("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  }).catch(() => undefined);
}

export async function telegramApi<T>(
  method: string,
  payload: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<T> {
  const gatePriority = RATE_GATED_METHOD_PRIORITIES[method];
  if (gatePriority != null) await telegramRateGate.waitForSlot(gatePriority);
  const controller = new AbortController();
  activeAbortControllers.add(controller);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as TelegramApiResponse<T> | null;
    if (!response.ok || !body?.ok) {
      const description = body && "description" in body ? body.description : undefined;
      const retryAfter = body && "parameters" in body ? body.parameters?.retry_after : undefined;
      if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
        await telegramRateGate.deferFor(Math.ceil(retryAfter) * 1_000).catch(() => undefined);
      }
      throw new Error(description || `Telegram API ${method} failed with HTTP ${response.status}`);
    }
    return body.result;
  } catch (error) {
    if (timedOut) throw new TelegramApiTimeoutError(method, timeoutMs);
    throw error;
  } finally {
    clearTimeout(timeout);
    activeAbortControllers.delete(controller);
  }
}

export function isAllowedTelegramChat(chatId: number | string): boolean {
  return String(chatId) === String(env.TELEGRAM_CHAT_ID);
}

function trimTelegramMessage(text: string): string {
  return text.length <= 3900 ? text : `${text.slice(0, 3890)}\n...`;
}
