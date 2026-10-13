import {
  sendListingLink,
  sendTelegramFlashBundle,
  TelegramRateLimitError,
  updateListingMessage,
  queueListingFirstSignal,
  telegramFlashRecipient,
  TelegramDeliveryDeferredError,
} from "../modules/telegram-service.js";
import { TELEGRAM_DETAIL_PRIORITY } from "../modules/telegram-first-signal.js";
import { QUEUE_NAMES, TELEGRAM_SEND_PRIORITY } from "@amb/shared";
import { enqueue } from "../lib/queues.js";

export type TelegramSendJob = { listingId: string; chatId?: string; rateLimitRetry?: number };
export type TelegramFlashJob = { flashBundleId: string; rateLimitRetry?: number };
export type TelegramUpdateJob = { listingId: string; rateLimitRetry?: number };

/** telegram.send — highest priority, sends the link right away. */
export async function processTelegramSend(job: TelegramSendJob): Promise<void> {
  try {
    if (!job.chatId) {
      await queueListingFirstSignal(job.listingId);
      return;
    }
    await sendListingLink(job.listingId, undefined, { chatId: job.chatId });
    await enqueue(QUEUE_NAMES.LISTING_ENRICH, "enrich", { listingId: job.listingId });
  } catch (error) {
    if (error instanceof TelegramDeliveryDeferredError) {
      await enqueue(QUEUE_NAMES.TELEGRAM_SEND, "details", job, { delay: Math.max(1, error.retryAt.getTime() - Date.now()), priority: TELEGRAM_DETAIL_PRIORITY });
      return;
    }
    if (!(error instanceof TelegramRateLimitError) || (job.rateLimitRetry ?? 0) >= 10) throw error;
    await enqueue(
      QUEUE_NAMES.TELEGRAM_SEND,
      "send",
      { ...job, rateLimitRetry: (job.rateLimitRetry ?? 0) + 1 },
      {
        delay: error.retryAfterSeconds * 1000 + 250,
        priority: job.chatId ? TELEGRAM_DETAIL_PRIORITY : TELEGRAM_SEND_PRIORITY,
      },
    );
  }
}

/** telegram.flash — confirms every burst link before any detailed card. */
export async function processTelegramFlash(job: TelegramFlashJob): Promise<void> {
  try {
    const listingIds = await sendTelegramFlashBundle(job.flashBundleId);
    if (!listingIds.length) return;
    const chatId = await telegramFlashRecipient(job.flashBundleId);
    for (const listingId of listingIds) {
      await enqueue(
        QUEUE_NAMES.TELEGRAM_SEND,
        "send",
        { listingId, chatId },
        {
          priority: TELEGRAM_DETAIL_PRIORITY,
          jobId: `telegram-flash-card-${job.flashBundleId}-${listingId}`,
        },
      );
      await enqueue(QUEUE_NAMES.LISTING_ENRICH, "enrich", { listingId }, { deduplicationId: `enrich-${listingId}` });
    }
  } catch (error) {
    if (error instanceof TelegramDeliveryDeferredError) {
      await enqueue(QUEUE_NAMES.TELEGRAM_FLASH, "flash", job, { delay: Math.max(1, error.retryAt.getTime() - Date.now()), priority: TELEGRAM_SEND_PRIORITY });
      return;
    }
    if (!(error instanceof TelegramRateLimitError) || (job.rateLimitRetry ?? 0) >= 10) throw error;
    await enqueue(
      QUEUE_NAMES.TELEGRAM_FLASH,
      "flash",
      { ...job, rateLimitRetry: (job.rateLimitRetry ?? 0) + 1 },
      {
        delay: error.retryAfterSeconds * 1_000 + 250,
        priority: TELEGRAM_SEND_PRIORITY,
        jobId: `telegram-flash-rate-limit-${job.flashBundleId}-${Date.now()}`,
      },
    );
  }
}

/** telegram.update — edits the SAME message after background check finishes. */
export async function processTelegramUpdate(job: TelegramUpdateJob): Promise<void> {
  try {
    await updateListingMessage(job.listingId);
  } catch (error) {
    if (!(error instanceof TelegramRateLimitError) || (job.rateLimitRetry ?? 0) >= 10) throw error;
    await enqueue(
      QUEUE_NAMES.TELEGRAM_UPDATE,
      "update",
      { ...job, rateLimitRetry: (job.rateLimitRetry ?? 0) + 1 },
      {
        delay: error.retryAfterSeconds * 1000 + 250,
        jobId: `telegram-update-rate-limit-${job.listingId}-${Date.now()}`,
      },
    );
  }
}
