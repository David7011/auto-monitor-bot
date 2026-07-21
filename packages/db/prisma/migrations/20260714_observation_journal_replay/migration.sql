CREATE TYPE "ObservationDecision" AS ENUM (
  'PENDING',
  'REJECTED',
  'MATCHED',
  'DUPLICATE',
  'DISPATCHED',
  'NOTIFIED',
  'FAILED'
);

ALTER TABLE "source_seen_listings"
  ADD COLUMN "brand" TEXT,
  ADD COLUMN "model" TEXT,
  ADD COLUMN "year" INTEGER,
  ADD COLUMN "priceNormalized" INTEGER,
  ADD COLUMN "engineVolume" DOUBLE PRECISION,
  ADD COLUMN "mileage" INTEGER,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "region" TEXT,
  ADD COLUMN "normalizedData" JSONB,
  ADD COLUMN "decision" "ObservationDecision" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "matchedFilterIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "rejectionReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "filterRevision" TEXT,
  ADD COLUMN "normalizerVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "lastEvaluatedAt" TIMESTAMP(3),
  ADD COLUMN "dispatchAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "notifiedAt" TIMESTAMP(3),
  ADD COLUMN "listingId" TEXT,
  ADD COLUMN "evaluationCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "collector_runs"
  ADD COLUMN "matchedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rejectedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "duplicateCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "dispatchedCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "completeness_audits" (
  "id" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "filterRevision" TEXT,
  "lookbackHours" INTEGER NOT NULL DEFAULT 24,
  "observedCount" INTEGER NOT NULL DEFAULT 0,
  "evaluatedCount" INTEGER NOT NULL DEFAULT 0,
  "matchedCount" INTEGER NOT NULL DEFAULT 0,
  "rejectedCount" INTEGER NOT NULL DEFAULT 0,
  "dispatchedCount" INTEGER NOT NULL DEFAULT 0,
  "alreadyHandledCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "pendingCount" INTEGER NOT NULL DEFAULT 0,
  "details" JSONB,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "completeness_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "source_seen_listings_source_publishedAt_idx"
  ON "source_seen_listings"("source", "publishedAt");
CREATE INDEX "source_seen_listings_decision_lastEvaluatedAt_idx"
  ON "source_seen_listings"("decision", "lastEvaluatedAt");
CREATE INDEX "source_seen_listings_listingId_idx"
  ON "source_seen_listings"("listingId");
CREATE INDEX "source_seen_listings_brand_model_year_idx"
  ON "source_seen_listings"("brand", "model", "year");
CREATE INDEX "completeness_audits_startedAt_idx" ON "completeness_audits"("startedAt");
CREATE INDEX "completeness_audits_finishedAt_idx" ON "completeness_audits"("finishedAt");

UPDATE "source_seen_listings" AS seen
SET
  "brand" = listing."brand",
  "model" = listing."model",
  "year" = listing."year",
  "priceNormalized" = listing."priceNormalized",
  "engineVolume" = listing."engineVolume",
  "mileage" = listing."mileage",
  "city" = listing."city",
  "region" = listing."region",
  "listingId" = listing."id",
  "decision" = CASE
    WHEN notification."sentAt" IS NOT NULL THEN 'NOTIFIED'::"ObservationDecision"
    ELSE 'DISPATCHED'::"ObservationDecision"
  END,
  "notifiedAt" = notification."sentAt",
  "lastEvaluatedAt" = COALESCE(notification."sentAt", listing."updatedAt"),
  "matchedFilterIds" = COALESCE(matches."filterIds", ARRAY[]::TEXT[]),
  "normalizedData" = jsonb_strip_nulls(jsonb_build_object(
    'source', listing."source"::text,
    'externalId', listing."externalId",
    'url', listing."url",
    'canonicalUrl', listing."canonicalUrl",
    'title', listing."title",
    'brand', listing."brand",
    'model', listing."model",
    'bodyType', listing."bodyType",
    'fuelType', listing."fuelType",
    'gearbox', listing."gearbox",
    'driveType', listing."driveType",
    'color', listing."color",
    'engineVolume', listing."engineVolume",
    'enginePower', listing."enginePower",
    'doors', listing."doors",
    'seats', listing."seats",
    'condition', listing."condition",
    'customsCleared', listing."customsCleared",
    'bargainPossible', listing."bargainPossible",
    'year', listing."year",
    'priceOriginal', listing."priceOriginal",
    'currencyOriginal', listing."currencyOriginal",
    'priceNormalized', listing."priceNormalized",
    'exchangeRateUsed', listing."exchangeRateUsed",
    'mileage', listing."mileage",
    'city', listing."city",
    'region', listing."region",
    'sellerPhone', listing."sellerPhone",
    'vin', listing."vin",
    'plateNormalized', listing."plateNormalized",
    'description', listing."description",
    'photoUrls', to_jsonb(listing."photoUrls"),
    'publishedAt', listing."publishedAt",
    'refreshedAt', listing."refreshedAt",
    'timestampConfidence', listing."timestampConfidence"::text,
    'skipReason', listing."skipReason",
    'firstSeenAt', listing."firstSeenAt"
  ))
FROM "listings" AS listing
LEFT JOIN "telegram_notifications" AS notification ON notification."listingId" = listing."id"
LEFT JOIN LATERAL (
  SELECT array_agg(match."filterId") AS "filterIds"
  FROM "listing_matches" AS match
  WHERE match."listingId" = listing."id"
) AS matches ON TRUE
WHERE seen."source" = listing."source"
  AND seen."externalId" = listing."externalId";

-- Rebuild today's OLX observation journal once. Existing listings remain
-- protected by the database and Telegram idempotency constraints.
UPDATE "source_search_states"
SET "knownExternalIds" = ARRAY[]::TEXT[]
WHERE "source" = 'OLX';
