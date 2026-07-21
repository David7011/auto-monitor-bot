ALTER TABLE "source_search_states"
  ADD COLUMN "lastRegionalCoverageAt" TIMESTAMP(3),
  ADD COLUMN "lastHtmlCoverageAt" TIMESTAMP(3),
  ADD COLUMN "htmlCoveragePausedUntil" TIMESTAMP(3),
  ADD COLUMN "lastPrivateCoverageAt" TIMESTAMP(3);

ALTER TABLE "collector_runs"
  ADD COLUMN "coverageMetrics" JSONB;
