ALTER TABLE "collector_runs"
  ADD COLUMN "trigger" "CollectorRunTrigger" NOT NULL DEFAULT 'SCHEDULED';

-- The durable collector.coverage queue originally persisted its runs as
-- BACKFILL. Reclassify only rows carrying its unambiguous durable marker so
-- genuine recovery/depth history is preserved.
UPDATE "collector_runs" AS run
SET
  "lane" = 'COVERAGE'::"CollectorLane",
  "trigger" = 'COVERAGE'::"CollectorRunTrigger"
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(COALESCE(run."coverageMetrics", '[]'::jsonb)) AS metric
  WHERE metric->>'kind' = 'olx-coverage-queue'
);

UPDATE "collector_runs"
SET "trigger" = 'MANUAL'::"CollectorRunTrigger"
WHERE "lane" = 'MANUAL'::"CollectorLane";

UPDATE "collector_runs"
SET "trigger" = 'BACKFILL'::"CollectorRunTrigger"
WHERE "lane" = 'BACKFILL'::"CollectorLane";

CREATE INDEX "collector_runs_source_lane_trigger_startedAt_idx"
  ON "collector_runs"("source", "lane", "trigger", "startedAt");
