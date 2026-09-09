-- A source capability limit is not evidence that a historical boundary was
-- reached. Keep it as a durable terminal state, separately from VERIFIED.
ALTER TYPE "CoverageRecoveryStatus" ADD VALUE IF NOT EXISTS 'UNRESOLVED';

DO $$
BEGIN
  CREATE TYPE "CoverageRecoveryUnresolvedReason" AS ENUM (
    'PUBLIC_OFFSET_CAP',
    'UNSTABLE_PAGINATION',
    'NON_PARTITIONABLE_RANGE',
    'SOURCE_EXHAUSTED_BEFORE_BOUNDARY'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "coverage_recovery_windows"
  ADD COLUMN IF NOT EXISTS "unresolvedReason" "CoverageRecoveryUnresolvedReason",
  ADD COLUMN IF NOT EXISTS "unresolvedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "attemptGeneration" TEXT,
  ADD COLUMN IF NOT EXISTS "acknowledgedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "acknowledgedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "acknowledgementNote" TEXT,
  ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0;

-- Older code accepted an empty deep page as EXHAUSTED without proving the
-- required timestamp. Re-open those windows rather than preserving a false
-- VERIFIED claim. The state trigger already protects known-ID resets; this is
-- an explicit one-time repair for the historical verifier bug.
UPDATE "coverage_recovery_windows"
SET
  "status" = 'PENDING'::"CoverageRecoveryStatus",
  "verifiedAt" = NULL,
  "verifiedRunId" = NULL,
  "verificationMethod" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'VERIFIED'::"CoverageRecoveryStatus"
  AND "verificationMethod" = 'EXHAUSTED'::"CoverageVerificationMethod";

UPDATE "source_search_states" AS state
SET
  "coverageRecoveryPending" = TRUE,
  "coverageRecoveryCutoffAt" = LEAST(
    COALESCE(state."coverageRecoveryCutoffAt", recovery_window."requiredCutoffAt"),
    recovery_window."requiredCutoffAt"
  ),
  "lastPage" = 1,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "coverage_recovery_windows" AS recovery_window
WHERE recovery_window."sourceSearchStateId" = state."id"
  AND recovery_window."status" = 'PENDING'::"CoverageRecoveryStatus"
  AND recovery_window."verificationMethod" IS NULL;
