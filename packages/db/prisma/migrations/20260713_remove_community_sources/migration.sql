-- Community/social readers were removed from the product. Keep Telegram only
-- as the notification and remote-control channel.
DROP TABLE IF EXISTS "community_source_states";
DROP TABLE IF EXISTS "social_source_filters";
DROP TABLE IF EXISTS "social_sources";

DELETE FROM "listings" WHERE "source" = 'COMMUNITY';
DELETE FROM "source_seen_listings" WHERE "source" = 'COMMUNITY';
DELETE FROM "source_search_states" WHERE "source" = 'COMMUNITY';
DELETE FROM "collector_runs" WHERE "source" = 'COMMUNITY';
DELETE FROM "sources" WHERE "source" = 'COMMUNITY';
UPDATE "filters" SET "sources" = array_remove("sources", 'COMMUNITY'::"ListingSource");
UPDATE "market_price_estimates" SET "sources" = array_remove("sources", 'COMMUNITY'::"ListingSource");

ALTER TYPE "ListingSource" RENAME TO "ListingSource_old";
CREATE TYPE "ListingSource" AS ENUM ('AUTO_RIA', 'OLX', 'RST', 'CARS_UA', 'MOCK');

ALTER TABLE "filters"
  ALTER COLUMN "sources" TYPE "ListingSource"[] USING ("sources"::text[]::"ListingSource"[]);
ALTER TABLE "sources"
  ALTER COLUMN "source" TYPE "ListingSource" USING ("source"::text::"ListingSource");
ALTER TABLE "listings"
  ALTER COLUMN "source" TYPE "ListingSource" USING ("source"::text::"ListingSource");
ALTER TABLE "source_seen_listings"
  ALTER COLUMN "source" TYPE "ListingSource" USING ("source"::text::"ListingSource");
ALTER TABLE "source_search_states"
  ALTER COLUMN "source" TYPE "ListingSource" USING ("source"::text::"ListingSource");
ALTER TABLE "market_price_estimates" ALTER COLUMN "sources" DROP DEFAULT;
ALTER TABLE "market_price_estimates"
  ALTER COLUMN "sources" TYPE "ListingSource"[] USING ("sources"::text[]::"ListingSource"[]);
ALTER TABLE "market_price_estimates"
  ALTER COLUMN "sources" SET DEFAULT ARRAY[]::"ListingSource"[];
ALTER TABLE "collector_runs"
  ALTER COLUMN "source" TYPE "ListingSource" USING ("source"::text::"ListingSource");

DROP TYPE "ListingSource_old";
DROP TYPE IF EXISTS "CommunityBridgeStatus";
DROP TYPE IF EXISTS "CommunityAccessStatus";
DROP TYPE IF EXISTS "SocialSourceStatus";
DROP TYPE IF EXISTS "SocialIntegrationMode";
DROP TYPE IF EXISTS "SocialSourceCategory";
DROP TYPE IF EXISTS "SocialPlatform";
