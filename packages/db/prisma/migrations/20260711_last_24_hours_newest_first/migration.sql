ALTER TABLE "sources"
  ADD COLUMN "newestFirstVerified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "newestFirstVerifiedAt" TIMESTAMP(3);

ALTER TABLE "source_search_states"
  ADD COLUMN "latestSeenPublishedAt" TIMESTAMP(3),
  ADD COLUMN "latestSeenExternalId" TEXT,
  ADD COLUMN "oldestScannedPublishedAt" TIMESTAMP(3),
  ADD COLUMN "lastCompletedCutoff" TIMESTAMP(3),
  ADD COLUMN "lastPage" INTEGER,
  ADD COLUMN "realtimeCursor" JSONB,
  ADD COLUMN "backfillCursor" JSONB,
  ADD COLUMN "newestFirstVerifiedAt" TIMESTAMP(3);

CREATE INDEX "source_search_states_source_latestSeenPublishedAt_idx"
  ON "source_search_states"("source", "latestSeenPublishedAt");
