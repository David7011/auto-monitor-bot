import { sendListingLink, TelegramRateLimitError, updateListingMessage } from "../modules/telegram-service.js";
import { QUEUE_NAMES, TELEGRAM_SEND_PRIORITY } from "@amb/shared";
import { enqueue } from "../lib/queues.js";

export type TelegramSendJob = { listingId: string; rateLimitRetry?: number };
export type TelegramUpdateJob = { listingId: string; rateLimitRetry?: number };

/** telegram.send — highest priority, sends the link right away. */
export async function processTelegramSend(job: TelegramSendJob): Promise<void> {
  try {
    await sendListingLink(job.listingId);
    await enqueue(QUEUE_NAMES.LISTING_ENRICH, "enrich", { listingId: job.listingId });
  } catch (error) {
    if (!(error instanceof TelegramRateLimitError) || (job.rateLimitRetry ?? 0) >= 10) throw error;
    await enqueue(
      QUEUE_NAMES.TELEGRAM_SEND,
      "send",
      { ...job, rateLimitRetry: (job.rateLimitRetry ?? 0) + 1 },
      {
        delay: error.retryAfterSeconds * 1000 + 250,
        priority: TELEGRAM_SEND_PRIORITY,
        jobId: `telegram-rate-limit-${job.listingId}-${Date.now()}`,
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
