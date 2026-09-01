ALTER TABLE "monitoring_state"
  ADD COLUMN "lastCoverageTickAt" TIMESTAMP(3),
  ADD COLUMN "nextCoverageTickAt" TIMESTAMP(3);
