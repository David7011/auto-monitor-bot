ALTER TABLE "source_seen_listings"
  ADD COLUMN "firstObservedChannel" TEXT,
  ADD COLUMN "lastObservedChannel" TEXT,
  ADD COLUMN "firstObservedTarget" TEXT,
  ADD COLUMN "lastObservedTarget" TEXT;

CREATE INDEX "source_seen_listings_source_firstObservedChannel_firstSeenAt_idx"
  ON "source_seen_listings"("source", "firstObservedChannel", "firstSeenAt");
