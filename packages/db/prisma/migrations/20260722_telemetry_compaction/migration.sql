CREATE TABLE "collector_run_hourly" (
  "id" TEXT NOT NULL,
  "bucketAt" TIMESTAMP(3) NOT NULL,
  "source" "ListingSource" NOT NULL,
  "lane" "CollectorLane" NOT NULL,
  "status" "CollectorRunStatus" NOT NULL,
  "runCount" INTEGER NOT NULL DEFAULT 0,
  "foundCount" BIGINT NOT NULL DEFAULT 0,
  "newCount" BIGINT NOT NULL DEFAULT 0,
  "recoveredCount" BIGINT NOT NULL DEFAULT 0,
  "requestCount" BIGINT NOT NULL DEFAULT 0,
  "observedCount" BIGINT NOT NULL DEFAULT 0,
  "matchedCount" BIGINT NOT NULL DEFAULT 0,
  "rejectedCount" BIGINT NOT NULL DEFAULT 0,
  "duplicateCount" BIGINT NOT NULL DEFAULT 0,
  "dispatchedCount" BIGINT NOT NULL DEFAULT 0,
  "totalDurationMs" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "collector_run_hourly_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "collector_run_hourly_bucketAt_source_lane_status_key"
  ON "collector_run_hourly"("bucketAt", "source", "lane", "status");
CREATE INDEX "collector_run_hourly_source_bucketAt_idx"
  ON "collector_run_hourly"("source", "bucketAt");

ALTER TABLE "errors"
  ADD COLUMN "fingerprint" TEXT,
  ADD COLUMN "occurrences" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

WITH grouped AS (
  SELECT
    MIN("id") AS keep_id,
    md5("level"::text || chr(31) || "scope" || chr(31) || "message") AS fingerprint,
    COUNT(*)::integer AS occurrences,
    MIN("createdAt") AS first_seen,
    MAX("createdAt") AS last_seen
  FROM "errors"
  GROUP BY "level", "scope", "message"
), updated AS (
  UPDATE "errors" AS target
  SET
    "fingerprint" = grouped.fingerprint,
    "occurrences" = grouped.occurrences,
    "firstSeenAt" = grouped.first_seen,
    "lastSeenAt" = grouped.last_seen
  FROM grouped
  WHERE target."id" = grouped.keep_id
  RETURNING target."id"
)
DELETE FROM "errors" AS duplicate
USING grouped
WHERE duplicate."level"::text || chr(31) || duplicate."scope" || chr(31) || duplicate."message" =
      (SELECT original."level"::text || chr(31) || original."scope" || chr(31) || original."message"
       FROM "errors" AS original WHERE original."id" = grouped.keep_id)
  AND duplicate."id" <> grouped.keep_id;

CREATE UNIQUE INDEX "errors_fingerprint_key" ON "errors"("fingerprint");
CREATE INDEX "errors_lastSeenAt_idx" ON "errors"("lastSeenAt");
