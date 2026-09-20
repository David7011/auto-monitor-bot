CREATE TYPE "EffectiveCadenceMode" AS ENUM ('STANDARD', 'LIVE', 'RECOVERY', 'CANARY', 'PROTECTED');

CREATE TABLE "effective_cadences" (
  "id" TEXT NOT NULL,
  "source" "ListingSource" NOT NULL,
  "mode" "EffectiveCadenceMode" NOT NULL,
  "intervalSeconds" INTEGER NOT NULL,
  "jitterSeconds" INTEGER NOT NULL,
  "valueSource" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL,
  "nextExpectedRunAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effective_cadences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "effective_cadence_history" (
  "id" TEXT NOT NULL,
  "effectiveCadenceId" TEXT NOT NULL,
  "source" "ListingSource" NOT NULL,
  "mode" "EffectiveCadenceMode" NOT NULL,
  "intervalSeconds" INTEGER NOT NULL,
  "jitterSeconds" INTEGER NOT NULL,
  "valueSource" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL,
  "nextExpectedRunAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "effective_cadence_history_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "effective_cadences_source_key" ON "effective_cadences"("source");
CREATE INDEX "effective_cadence_history_source_changedAt_idx" ON "effective_cadence_history"("source", "changedAt");
CREATE INDEX "effective_cadence_history_effectiveCadenceId_changedAt_idx" ON "effective_cadence_history"("effectiveCadenceId", "changedAt");

ALTER TABLE "effective_cadence_history"
  ADD CONSTRAINT "effective_cadence_history_effectiveCadenceId_fkey"
  FOREIGN KEY ("effectiveCadenceId") REFERENCES "effective_cadences"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve the actual persisted production setting. This is observability only:
-- neither sources nor monitoring_state cadence values are changed by this migration.
INSERT INTO "effective_cadences" (
  "id", "source", "mode", "intervalSeconds", "jitterSeconds", "valueSource",
  "reason", "changedAt", "nextExpectedRunAt", "createdAt", "updatedAt"
)
SELECT
  'effective-cadence-' || lower("source"::text),
  "source",
  CASE WHEN "intervalSeconds" = 20 AND "jitterSeconds" = 4
    THEN 'LIVE'::"EffectiveCadenceMode"
    ELSE 'STANDARD'::"EffectiveCadenceMode"
  END,
  "intervalSeconds",
  "jitterSeconds",
  'migration.persisted-source',
  CASE WHEN "intervalSeconds" = 20 AND "jitterSeconds" = 4
    THEN 'Persisted OLX cadence matches the configured LIVE baseline'
    ELSE 'Persisted OLX cadence differs from the configured LIVE baseline'
  END,
  "updatedAt",
  "nextCheckAt",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "sources"
WHERE "source" = 'OLX'::"ListingSource"
ON CONFLICT ("source") DO NOTHING;

INSERT INTO "effective_cadence_history" (
  "id", "effectiveCadenceId", "source", "mode", "intervalSeconds", "jitterSeconds",
  "valueSource", "reason", "changedAt", "nextExpectedRunAt", "createdAt"
)
SELECT
  'effective-cadence-history-' || lower("source"::text),
  "id", "source", "mode", "intervalSeconds", "jitterSeconds", "valueSource",
  "reason", "changedAt", "nextExpectedRunAt", CURRENT_TIMESTAMP
FROM "effective_cadences"
WHERE "source" = 'OLX'::"ListingSource";
