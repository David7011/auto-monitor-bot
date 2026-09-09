-- Reconstruct anchors that definitely existed before the persisted shutdown
-- boundary. These IDs can prove continuity; IDs first seen after that boundary
-- cannot, because they may have been learned by a newer realtime pass.
WITH latest_pending AS (
  SELECT DISTINCT ON (recovery_window."sourceSearchStateId")
    recovery_window."sourceSearchStateId",
    recovery_window."persistedBoundaryAt"
  FROM "coverage_recovery_windows" AS recovery_window
  WHERE recovery_window."source" = 'OLX'::"ListingSource"
    AND recovery_window."status" = 'PENDING'::"CoverageRecoveryStatus"
  ORDER BY recovery_window."sourceSearchStateId", recovery_window."detectedAt" DESC
), reconstructed AS (
  SELECT
    pending."sourceSearchStateId",
    ARRAY(
      SELECT seen."externalId"
      FROM "source_seen_listings" AS seen
      WHERE seen."source" = 'OLX'::"ListingSource"
        AND seen."firstSeenAt" <= pending."persistedBoundaryAt"
      ORDER BY seen."firstSeenAt" DESC, seen."externalId"
      LIMIT 50
    ) AS anchors
  FROM latest_pending AS pending
)
UPDATE "source_search_states" AS state
SET
  "coverageAnchorExternalIds" = reconstructed.anchors,
  "updatedAt" = CURRENT_TIMESTAMP
FROM reconstructed
WHERE state."id" = reconstructed."sourceSearchStateId"
  AND state."coverageRecoveryPending" = TRUE
  AND cardinality(state."coverageAnchorExternalIds") = 0
  AND cardinality(reconstructed.anchors) > 0;
