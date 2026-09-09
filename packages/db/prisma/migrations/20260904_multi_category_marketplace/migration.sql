-- Additive multi-category foundation. Legacy rows remain vehicle.car and no
-- automotive column is removed, so old application builds can still read data.
ALTER TABLE "filters"
  ADD COLUMN IF NOT EXISTS "categoryKey" TEXT NOT NULL DEFAULT 'vehicle.car',
  ADD COLUMN IF NOT EXISTS "categorySchemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "categoryCriteria" JSONB,
  ADD COLUMN IF NOT EXISTS "unknownPolicy" TEXT NOT NULL DEFAULT 'MAX_COVERAGE',
  ADD COLUMN IF NOT EXISTS "shadowMode" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "listings"
  ADD COLUMN IF NOT EXISTS "categoryKey" TEXT NOT NULL DEFAULT 'vehicle.car',
  ADD COLUMN IF NOT EXISTS "categorySchemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "categoryAttributes" JSONB;

ALTER TABLE "source_seen_listings"
  ADD COLUMN IF NOT EXISTS "categoryKey" TEXT NOT NULL DEFAULT 'vehicle.car',
  ADD COLUMN IF NOT EXISTS "categorySchemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "categoryAttributes" JSONB,
  ADD COLUMN IF NOT EXISTS "evaluationNotes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "filterCompletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "telegramRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "enrichmentStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "enrichmentCompletedAt" TIMESTAMP(3);

ALTER TABLE "source_search_states"
  ADD COLUMN IF NOT EXISTS "categoryKey" TEXT NOT NULL DEFAULT 'vehicle.car',
  ADD COLUMN IF NOT EXISTS "categorySchemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "sourceCategoryId" INTEGER,
  ADD COLUMN IF NOT EXISTS "sourceCategoryPath" TEXT,
  ADD COLUMN IF NOT EXISTS "plannerVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "parserHealth" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "parserHealthDetails" JSONB,
  ADD COLUMN IF NOT EXISTS "lastParserHealthyAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "shardMetrics" JSONB;

ALTER TABLE "collector_runs"
  ADD COLUMN IF NOT EXISTS "categoryKey" TEXT NOT NULL DEFAULT 'vehicle.car',
  ADD COLUMN IF NOT EXISTS "searchFingerprint" TEXT;

CREATE INDEX IF NOT EXISTS "listings_categoryKey_firstSeenAt_idx"
  ON "listings"("categoryKey", "firstSeenAt");
CREATE INDEX IF NOT EXISTS "source_seen_listings_categoryKey_firstSeenAt_idx"
  ON "source_seen_listings"("categoryKey", "firstSeenAt");
CREATE INDEX IF NOT EXISTS "source_search_states_source_categoryKey_nextCheckAt_idx"
  ON "source_search_states"("source", "categoryKey", "nextCheckAt");
CREATE INDEX IF NOT EXISTS "collector_runs_source_categoryKey_startedAt_idx"
  ON "collector_runs"("source", "categoryKey", "startedAt");

ALTER TABLE "filters" DROP CONSTRAINT IF EXISTS "filters_category_key_check";
ALTER TABLE "filters" ADD CONSTRAINT "filters_category_key_check" CHECK (
  "categoryKey" IN ('vehicle.car','electronics.laptop','electronics.phone','electronics.desktop','electronics.component.gpu','gaming.console','transport.escooter','generic')
);
ALTER TABLE "filters" DROP CONSTRAINT IF EXISTS "filters_unknown_policy_check";
ALTER TABLE "filters" ADD CONSTRAINT "filters_unknown_policy_check" CHECK ("unknownPolicy" IN ('MAX_COVERAGE','STRICT'));
