-- Follow-up constraints are separate because the additive foundation may
-- already be deployed. No data is dropped or rewritten.
ALTER TABLE "listings" DROP CONSTRAINT IF EXISTS "listings_category_key_check";
ALTER TABLE "listings" ADD CONSTRAINT "listings_category_key_check" CHECK (
  "categoryKey" IN ('vehicle.car','electronics.laptop','electronics.phone','electronics.desktop','electronics.component.gpu','gaming.console','transport.escooter','generic')
);

ALTER TABLE "source_seen_listings" DROP CONSTRAINT IF EXISTS "source_seen_listings_category_key_check";
ALTER TABLE "source_seen_listings" ADD CONSTRAINT "source_seen_listings_category_key_check" CHECK (
  "categoryKey" IN ('vehicle.car','electronics.laptop','electronics.phone','electronics.desktop','electronics.component.gpu','gaming.console','transport.escooter','generic')
);

ALTER TABLE "source_search_states" DROP CONSTRAINT IF EXISTS "source_search_states_category_key_check";
ALTER TABLE "source_search_states" ADD CONSTRAINT "source_search_states_category_key_check" CHECK (
  "categoryKey" IN ('vehicle.car','electronics.laptop','electronics.phone','electronics.desktop','electronics.component.gpu','gaming.console','transport.escooter','generic')
);
ALTER TABLE "source_search_states" DROP CONSTRAINT IF EXISTS "source_search_states_parser_health_check";
ALTER TABLE "source_search_states" ADD CONSTRAINT "source_search_states_parser_health_check" CHECK (
  "parserHealth" IN ('HEALTHY','DEGRADED','UNKNOWN')
);

ALTER TABLE "collector_runs" DROP CONSTRAINT IF EXISTS "collector_runs_category_key_check";
ALTER TABLE "collector_runs" ADD CONSTRAINT "collector_runs_category_key_check" CHECK (
  "categoryKey" IN ('vehicle.car','electronics.laptop','electronics.phone','electronics.desktop','electronics.component.gpu','gaming.console','transport.escooter','generic','mixed')
);

ALTER TABLE "filters" DROP CONSTRAINT IF EXISTS "filters_category_schema_version_check";
ALTER TABLE "filters" ADD CONSTRAINT "filters_category_schema_version_check" CHECK ("categorySchemaVersion" >= 1);
ALTER TABLE "listings" DROP CONSTRAINT IF EXISTS "listings_category_schema_version_check";
ALTER TABLE "listings" ADD CONSTRAINT "listings_category_schema_version_check" CHECK ("categorySchemaVersion" >= 1);
ALTER TABLE "source_seen_listings" DROP CONSTRAINT IF EXISTS "source_seen_listings_category_schema_version_check";
ALTER TABLE "source_seen_listings" ADD CONSTRAINT "source_seen_listings_category_schema_version_check" CHECK ("categorySchemaVersion" >= 1);
ALTER TABLE "source_search_states" DROP CONSTRAINT IF EXISTS "source_search_states_category_schema_version_check";
ALTER TABLE "source_search_states" ADD CONSTRAINT "source_search_states_category_schema_version_check" CHECK ("categorySchemaVersion" >= 1);
