ALTER TABLE "telegram_notifications"
  ADD COLUMN "deleteAfter" TIMESTAMP(3),
  ADD COLUMN "favoritedAt" TIMESTAMP(3),
  ADD COLUMN "retainUntil" TIMESTAMP(3),
  ADD COLUMN "retentionPolicyAppliedAt" TIMESTAMP(3),
  ADD COLUMN "cleanupAttemptedAt" TIMESTAMP(3);

CREATE INDEX "telegram_notifications_deleteAfter_idx"
  ON "telegram_notifications"("deleteAfter");

CREATE INDEX "telegram_notifications_retainUntil_idx"
  ON "telegram_notifications"("retainUntil");

CREATE INDEX "telegram_notifications_cleanupAttemptedAt_idx"
  ON "telegram_notifications"("cleanupAttemptedAt");
