ALTER TABLE "source_search_states"
  ADD COLUMN "coverageAnchorExternalIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "coverageRecoveryPending" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "coverageRecoveryCutoffAt" TIMESTAMP(3),
  ADD COLUMN "knownIdsResetAt" TIMESTAMP(3);

-- Keep a small, separate continuity proof when the disposable OLX cache is
-- cleared. The cache still becomes exactly empty at 2000 entries; these anchors
-- exist only to prove page overlap and are never used as listing retention.
CREATE OR REPLACE FUNCTION "reset_olx_known_ids_at_threshold"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."source" = 'OLX'
     AND cardinality(NEW."knownExternalIds") >= 2000 THEN
    NEW."coverageAnchorExternalIds" :=
      NEW."knownExternalIds"[1:LEAST(50, cardinality(NEW."knownExternalIds"))];
    NEW."coverageRecoveryPending" := TRUE;
    NEW."coverageRecoveryCutoffAt" := LEAST(
      COALESCE(NEW."coverageRecoveryCutoffAt", 'infinity'::timestamp),
      COALESCE(NEW."lastSuccessfulScanAt" - INTERVAL '5 minutes', NOW() - INTERVAL '24 hours')
    );
    NEW."knownIdsResetAt" := NOW();
    NEW."knownExternalIds" := ARRAY[]::TEXT[];
  END IF;
  RETURN NEW;
END;
$$;
