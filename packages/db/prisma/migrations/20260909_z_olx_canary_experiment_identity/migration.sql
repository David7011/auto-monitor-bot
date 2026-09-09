ALTER TABLE "monitoring_state"
  ADD COLUMN "olxCanaryExperimentId" TEXT,
  ADD COLUMN "olxCanaryCodeRevision" TEXT,
  ADD COLUMN "olxCanaryConfigHash" TEXT,
  ADD COLUMN "olxCanaryConfigSnapshot" JSONB;
