ALTER TYPE "SourceStatus" ADD VALUE IF NOT EXISTS 'LIMITED';
ALTER TYPE "CollectorRunStatus" ADD VALUE IF NOT EXISTS 'LIMITED';

CREATE TABLE IF NOT EXISTS "source_search_states" (
    "id" TEXT NOT NULL,
    "source" "ListingSource" NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "filterIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "initialSyncCompletedAt" TIMESTAMP(3),
    "lastCursor" TEXT,
    "lastExternalId" TEXT,
    "lastPublishedAt" TIMESTAMP(3),
    "lastSuccessfulScanAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3),
    "knownExternalIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "query" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_search_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "source_search_states_source_fingerprint_key"
ON "source_search_states"("source", "fingerprint");

CREATE INDEX IF NOT EXISTS "source_search_states_source_nextCheckAt_idx"
ON "source_search_states"("source", "nextCheckAt");
