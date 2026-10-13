import type { TelegramNotificationStatus } from "@amb/db";

export const ACCEPTED_NOTIFICATION_STATUSES: TelegramNotificationStatus[] = ["SENT", "UPDATED", "DELIVERED"];
export const RETRYABLE_DELIVERY_STATUSES = ["PENDING", "TRANSIENT", "AMBIGUOUS", "RETRY_PENDING", "FAILED"] as const;

export function telegramRetryDueWhere(now: Date) {
  return { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] };
}
