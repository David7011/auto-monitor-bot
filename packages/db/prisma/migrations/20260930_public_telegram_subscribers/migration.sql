CREATE TABLE "telegram_subscribers" (
  "id" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "blockedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "telegram_subscribers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_subscribers_chatId_key" ON "telegram_subscribers"("chatId");
CREATE INDEX "telegram_subscribers_active_startedAt_idx" ON "telegram_subscribers"("active", "startedAt");

ALTER TABLE "telegram_notifications" DROP CONSTRAINT IF EXISTS "telegram_notifications_listingId_key";
DROP INDEX IF EXISTS "telegram_notifications_listingId_key";
CREATE UNIQUE INDEX "telegram_notifications_listingId_chatId_key" ON "telegram_notifications"("listingId", "chatId");
