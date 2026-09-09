-- A CUTOFF verification is valid only when the durable audit row contains an
-- observed publication timestamp at or before the required recovery cutoff.
-- Reopen only the latest invalid OLX window for each search state.
WITH latest_windows AS (
  SELECT DISTINCT ON ("sourceSearchStateId")
    "id",
    "sourceSearchStateId"
  FROM "coverage_recovery_windows"
  WHERE "source" = 'OLX'::"ListingSource"
  ORDER BY "sourceSearchStateId", "detectedAt" DESC
), invalid_windows AS (
  SELECT
    recovery."id",
    recovery."sourceSearchStateId",
    recovery."persistedBoundaryAt",
    recovery."requiredCutoffAt"
  FROM "coverage_recovery_windows" AS recovery
  INNER JOIN latest_windows ON latest_windows."id" = recovery."id"
  WHERE recovery."status" = 'VERIFIED'::"CoverageRecoveryStatus"
    AND recovery."verificationMethod" = 'CUTOFF'::"CoverageVerificationMethod"
    AND (
      recovery."oldestObservedAt" IS NULL
      OR recovery."oldestObservedAt" > recovery."requiredCutoffAt"
    )
), reopened AS (
  UPDATE "coverage_recovery_windows" AS recovery
  SET
    "status" = 'PENDING'::"CoverageRecoveryStatus",
    "lastAttemptAt" = NULL,
    "lastAttemptRunId" = NULL,
    "verifiedAt" = NULL,
    "verifiedRunId" = NULL,
    "verificationMethod" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
  FROM invalid_windows
  WHERE recovery."id" = invalid_windows."id"
  RETURNING
    invalid_windows."sourceSearchStateId",
    invalid_windows."persistedBoundaryAt",
    invalid_windows."requiredCutoffAt"
), reconstructed AS (
  SELECT
    reopened."sourceSearchStateId",
    reopened."requiredCutoffAt",
    ARRAY(
      SELECT seen."externalId"
      FROM "source_seen_listings" AS seen
      WHERE seen."source" = 'OLX'::"ListingSource"
        AND seen."firstSeenAt" <= reopened."persistedBoundaryAt"
      ORDER BY seen."firstSeenAt" DESC, seen."externalId"
      LIMIT 50
    ) AS anchors
  FROM reopened
)
UPDATE "source_search_states" AS state
SET
  "coverageRecoveryPending" = TRUE,
  "coverageRecoveryCutoffAt" = LEAST(
    COALESCE(state."coverageRecoveryCutoffAt", reconstructed."requiredCutoffAt"),
    reconstructed."requiredCutoffAt"
  ),
  "coverageAnchorExternalIds" = reconstructed.anchors,
  -- Restart safely from the head because the invalid verification cleared the
  -- in-progress cursor. Bounded attempts will persist their new resume page.
  "lastPage" = 1,
  "updatedAt" = CURRENT_TIMESTAMP
FROM reconstructed
WHERE state."id" = reconstructed."sourceSearchStateId";
