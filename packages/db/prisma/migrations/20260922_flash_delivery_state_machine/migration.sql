ALTER TYPE "TelegramFlashBundleStatus" ADD VALUE IF NOT EXISTS 'SENDING';
ALTER TYPE "TelegramFlashBundleStatus" ADD VALUE IF NOT EXISTS 'TRANSIENT';
ALTER TYPE "TelegramFlashBundleStatus" ADD VALUE IF NOT EXISTS 'AMBIGUOUS';
ALTER TYPE "TelegramFlashBundleStatus" ADD VALUE IF NOT EXISTS 'DELIVERED';
ALTER TYPE "TelegramFlashBundleStatus" ADD VALUE IF NOT EXISTS 'PERMANENT';
ALTER TYPE "TelegramFlashBundleStatus" ADD VALUE IF NOT EXISTS 'QUARANTINED';

ALTER TABLE "telegram_flash_bundles"
  ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "telegram_flash_bundles_status_nextAttemptAt_createdAt_idx"
  ON "telegram_flash_bundles"("status", "nextAttemptAt", "createdAt");
