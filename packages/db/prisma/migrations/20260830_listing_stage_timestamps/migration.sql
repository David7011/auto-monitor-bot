ALTER TABLE "source_seen_listings"
  ADD COLUMN "requestStartedAt" TIMESTAMP(3),
  ADD COLUMN "firstByteAt" TIMESTAMP(3),
  ADD COLUMN "hotCandidateAt" TIMESTAMP(3),
  ADD COLUMN "journalPersistedAt" TIMESTAMP(3),
  ADD COLUMN "telegramAcceptedAt" TIMESTAMP(3);

ALTER TABLE "telegram_notifications"
  ADD COLUMN "acceptedAt" TIMESTAMP(3);

ALTER TABLE "telegram_flash_bundles"
  ADD COLUMN "acceptedAt" TIMESTAMP(3);

CREATE INDEX "source_seen_listings_source_journalPersistedAt_idx"
  ON "source_seen_listings"("source", "journalPersistedAt");

CREATE INDEX "source_seen_listings_telegramAcceptedAt_idx"
  ON "source_seen_listings"("telegramAcceptedAt");

-- Set the default only after adding the nullable column: historical rows stay
-- NULL instead of receiving a fabricated migration-time journal timestamp.
ALTER TABLE "source_seen_listings"
  ALTER COLUMN "journalPersistedAt" SET DEFAULT CURRENT_TIMESTAMP;
