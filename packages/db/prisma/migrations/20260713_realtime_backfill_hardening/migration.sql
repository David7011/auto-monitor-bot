CREATE TYPE "CollectorLane" AS ENUM ('REALTIME', 'BACKFILL', 'MANUAL');

ALTER TABLE "sources"
  ADD COLUMN "consecutiveEmptyResults" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastSuccessfulAt" TIMESTAMP(3),
  ADD COLUMN "lastNonEmptyAt" TIMESTAMP(3),
  ADD COLUMN "lastDurationMs" INTEGER,
  ADD COLUMN "healthScore" INTEGER NOT NULL DEFAULT 100;

ALTER TABLE "listings"
  ADD COLUMN "discoveryLane" "CollectorLane" NOT NULL DEFAULT 'REALTIME';

ALTER TABLE "source_seen_listings"
  ADD COLUMN "discoveryLane" "CollectorLane" NOT NULL DEFAULT 'REALTIME';

ALTER TABLE "collector_runs"
  ADD COLUMN "lane" "CollectorLane" NOT NULL DEFAULT 'REALTIME',
  ADD COLUMN "recoveredCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pageCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "requestCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "observedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "semanticWarnings" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "monitoring_state"
  ADD COLUMN "lastBackfillTickAt" TIMESTAMP(3),
  ADD COLUMN "nextBackfillTickAt" TIMESTAMP(3),
  ADD COLUMN "backfillIntervalSeconds" INTEGER NOT NULL DEFAULT 600;

CREATE INDEX "collector_runs_lane_startedAt_idx" ON "collector_runs"("lane", "startedAt");

-- RST does not expose a trustworthy publication timestamp. Its old state was
-- marked initialized before IDs could be retained, so force one silent seed.
UPDATE "source_search_states"
SET "initialSyncCompletedAt" = NULL,
    "knownExternalIds" = ARRAY[]::TEXT[]
WHERE "source" = 'RST' AND cardinality("knownExternalIds") = 0;
