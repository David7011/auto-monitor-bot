CREATE TYPE "ChallengeIncidentStatus" AS ENUM (
  'DETECTED',
  'COOLDOWN',
  'MANUAL_VERIFICATION_REQUIRED',
  'PROBE_PENDING',
  'RECOVERING',
  'RESOLVED',
  'REPEATED'
);

CREATE TABLE "challenge_incidents" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "detector" TEXT NOT NULL,
  "responseStatus" INTEGER,
  "affectedUrlHash" TEXT,
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cooldownUntil" TIMESTAMP(3),
  "status" "ChallengeIncidentStatus" NOT NULL DEFAULT 'DETECTED',
  "probeAttempts" INTEGER NOT NULL DEFAULT 0,
  "lastProbeAt" TIMESTAMP(3),
  "recoveredAt" TIMESTAMP(3),
  "resolution" TEXT,
  "metadataRedacted" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "challenge_incidents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "challenge_incidents_sourceId_status_idx" ON "challenge_incidents"("sourceId", "status");
CREATE INDEX "challenge_incidents_detectedAt_idx" ON "challenge_incidents"("detectedAt");

ALTER TABLE "challenge_incidents"
  ADD CONSTRAINT "challenge_incidents_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
