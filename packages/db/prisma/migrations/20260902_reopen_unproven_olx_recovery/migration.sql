-- A zero-item first page is not proof that an offline OLX window was covered.
-- Reopen only the latest window for a search state, so older audit history is
-- not changed when a newer, legitimate proof already supersedes it.
WITH latest_windows AS (
  SELECT DISTINCT ON ("sourceSearchStateId")
    "id",
    "sourceSearchStateId"
  FROM "coverage_recovery_windows"
  WHERE "source" = 'OLX'::"ListingSource"
  ORDER BY "sourceSearchStateId", "detectedAt" DESC
), reopened AS (
  UPDATE "coverage_recovery_windows" AS recovery
  SET
    "status" = 'PENDING'::"CoverageRecoveryStatus",
    "lastAttemptAt" = NULL,
    "lastAttemptRunId" = NULL,
    "verifiedAt" = NULL,
    "verifiedRunId" = NULL,
    "verificationMethod" = NULL,
    "oldestObservedAt" = NULL,
    "pageCount" = 0,
    "requestCount" = 0,
    "observedCount" = 0,
    "updatedAt" = CURRENT_TIMESTAMP
  FROM latest_windows
  WHERE recovery."id" = latest_windows."id"
    AND recovery."status" = 'VERIFIED'::"CoverageRecoveryStatus"
    AND recovery."verificationMethod" = 'EXHAUSTED'::"CoverageVerificationMethod"
    AND recovery."pageCount" <= 1
    AND recovery."observedCount" = 0
  RETURNING recovery."sourceSearchStateId", recovery."requiredCutoffAt"
)
UPDATE "source_search_states" AS state
SET
  "coverageRecoveryPending" = TRUE,
  "coverageRecoveryCutoffAt" = LEAST(
    COALESCE(state."coverageRecoveryCutoffAt", reopened."requiredCutoffAt"),
    reopened."requiredCutoffAt"
  ),
  -- The original frozen anchors were discarded by the bad close. Leaving this
  -- empty forces proof by the durable cutoff or genuine feed exhaustion.
  "coverageAnchorExternalIds" = ARRAY[]::TEXT[],
  "lastPage" = 1,
  "updatedAt" = CURRENT_TIMESTAMP
FROM reopened
WHERE state."id" = reopened."sourceSearchStateId";
