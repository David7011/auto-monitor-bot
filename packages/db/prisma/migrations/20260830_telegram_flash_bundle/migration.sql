CREATE TYPE "TelegramFlashBundleStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'RETRY_PENDING',
  'SENT',
  'FAILED'
);

ALTER TYPE "TelegramNotificationStatus" ADD VALUE IF NOT EXISTS 'FLASH_PENDING' AFTER 'PENDING';

ALTER TABLE "telegram_notifications"
  ADD COLUMN "flashBundleId" TEXT;

CREATE TABLE "telegram_flash_bundles" (
  "id" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "listingIds" TEXT[],
  "messageId" TEXT,
  "status" "TelegramFlashBundleStatus" NOT NULL DEFAULT 'PENDING',
  "lastText" TEXT NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "processingStartedAt" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "sentAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "telegram_flash_bundles_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "telegram_notifications_flashBundleId_idx"
  ON "telegram_notifications"("flashBundleId");
CREATE INDEX "telegram_flash_bundles_status_leaseExpiresAt_idx"
  ON "telegram_flash_bundles"("status", "leaseExpiresAt");
CREATE INDEX "telegram_flash_bundles_createdAt_idx"
  ON "telegram_flash_bundles"("createdAt");
