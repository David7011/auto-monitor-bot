ALTER TYPE "CollectorRunStatus" ADD VALUE IF NOT EXISTS 'SKIPPED';
ALTER TYPE "CollectorRunStatus" ADD VALUE IF NOT EXISTS 'CANCELLED_BY_USER';

ALTER TYPE "TelegramNotificationStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
ALTER TYPE "TelegramNotificationStatus" ADD VALUE IF NOT EXISTS 'RETRY_PENDING';

ALTER TABLE "monitoring_state"
  ADD COLUMN IF NOT EXISTS "generation" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "telegram_notifications"
  ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "processingStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastErrorCode" TEXT,
  ADD COLUMN IF NOT EXISTS "lastErrorMessage" TEXT;

CREATE INDEX IF NOT EXISTS "telegram_notifications_status_leaseExpiresAt_idx"
  ON "telegram_notifications"("status", "leaseExpiresAt");
