ALTER TYPE "TelegramNotificationStatus" ADD VALUE IF NOT EXISTS 'SENDING';
ALTER TYPE "TelegramNotificationStatus" ADD VALUE IF NOT EXISTS 'TRANSIENT';
ALTER TYPE "TelegramNotificationStatus" ADD VALUE IF NOT EXISTS 'AMBIGUOUS';
ALTER TYPE "TelegramNotificationStatus" ADD VALUE IF NOT EXISTS 'DELIVERED';
ALTER TYPE "TelegramNotificationStatus" ADD VALUE IF NOT EXISTS 'PERMANENT';
ALTER TYPE "TelegramNotificationStatus" ADD VALUE IF NOT EXISTS 'QUARANTINED';

ALTER TABLE "telegram_notifications"
  ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "telegram_notifications_status_nextAttemptAt_createdAt_idx"
  ON "telegram_notifications"("status", "nextAttemptAt", "createdAt");
