-- Final, order-safe definition of the OLX disposable-ID cache guard.
-- A fresh database applies migration folders lexically, so this migration must
-- remain after every earlier reset_olx_known_ids_at_threshold definition.
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

DROP TRIGGER IF EXISTS "source_search_states_reset_olx_known_ids" ON "source_search_states";

CREATE TRIGGER "source_search_states_reset_olx_known_ids"
BEFORE INSERT OR UPDATE OF "knownExternalIds"
ON "source_search_states"
FOR EACH ROW
EXECUTE FUNCTION "reset_olx_known_ids_at_threshold"();
