CREATE TYPE "OlxCadenceCanaryMode" AS ENUM (
  'BASELINE',
  'CANARY',
  'PROMOTED',
  'ROLLED_BACK',
  'DISABLED'
);

ALTER TABLE "monitoring_state"
  ADD COLUMN "olxCanaryMode" "OlxCadenceCanaryMode" NOT NULL DEFAULT 'BASELINE',
  ADD COLUMN "olxCanaryQualificationStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "olxCanaryStartedAt" TIMESTAMP(3),
  ADD COLUMN "olxCanaryBaselineP95Ms" INTEGER,
  ADD COLUMN "olxCanaryCurrentP95Ms" INTEGER,
  ADD COLUMN "olxCanaryCleanRunCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "olxCanaryRunCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "olxCanaryRollbackReason" TEXT,
  ADD COLUMN "olxCanaryLastEvaluatedRunId" TEXT,
  ADD COLUMN "olxCanaryLastTransitionAt" TIMESTAMP(3);
