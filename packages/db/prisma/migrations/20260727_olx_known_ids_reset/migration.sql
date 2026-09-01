-- Enforce the OLX lightweight known-ID cache ceiling in PostgreSQL as well as
-- in the worker. This is deliberately scoped to source_search_states: listing
-- rows and Telegram favorites live in separate tables and are never touched.
CREATE OR REPLACE FUNCTION "reset_olx_known_ids_at_threshold"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."source" = 'OLX'
     AND cardinality(NEW."knownExternalIds") >= 2000 THEN
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
