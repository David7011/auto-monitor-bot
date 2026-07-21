BEGIN;

-- Remove the Telegram channel reader data while preserving Telegram bot notifications.
DELETE FROM "social_sources" WHERE "platform" = 'TELEGRAM';
DROP TABLE IF EXISTS "telegram_source_candidates";
DROP TABLE IF EXISTS "telegram_source_states";
DROP TYPE IF EXISTS "TelegramCandidateStatus";
DROP TYPE IF EXISTS "TelegramSessionHealth";

-- Placeholder Viber seeds had no invite link and could never produce events.
DELETE FROM "social_sources" AS source
WHERE source."platform" = 'VIBER'
  AND source."url" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "viber_source_states" AS state
    WHERE state."socialSourceId" = source."id"
      AND state."inviteUrl" IS NOT NULL
  );

CREATE TYPE "CommunityAccessStatus" AS ENUM (
  'UNKNOWN',
  'LINK_OK',
  'LINK_EXPIRED',
  'PRIVATE_ACCESS_REQUIRED',
  'ERROR'
);

CREATE TYPE "CommunityBridgeStatus" AS ENUM (
  'NOT_CONFIGURED',
  'CONNECTED',
  'STALE',
  'ERROR'
);

CREATE TABLE "community_source_states" (
  "socialSourceId" TEXT NOT NULL,
  "inviteUrl" TEXT,
  "accessStatus" "CommunityAccessStatus" NOT NULL DEFAULT 'UNKNOWN',
  "bridgeStatus" "CommunityBridgeStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
  "externalChannelId" TEXT,
  "lastExternalMessageId" TEXT,
  "lastWebhookAt" TIMESTAMP(3),
  "lastManualCheckAt" TIMESTAMP(3),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "community_source_states_pkey" PRIMARY KEY ("socialSourceId"),
  CONSTRAINT "community_source_states_socialSourceId_fkey"
    FOREIGN KEY ("socialSourceId") REFERENCES "social_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "community_source_states" (
  "socialSourceId",
  "inviteUrl",
  "accessStatus",
  "lastManualCheckAt",
  "notes",
  "createdAt",
  "updatedAt"
)
SELECT
  "socialSourceId",
  "inviteUrl",
  CASE "accessStatus"::text
    WHEN 'INVITE_OK' THEN 'LINK_OK'::"CommunityAccessStatus"
    WHEN 'INVITE_EXPIRED' THEN 'LINK_EXPIRED'::"CommunityAccessStatus"
    WHEN 'PRIVATE_ACCESS_REQUIRED' THEN 'PRIVATE_ACCESS_REQUIRED'::"CommunityAccessStatus"
    WHEN 'ERROR' THEN 'ERROR'::"CommunityAccessStatus"
    ELSE 'UNKNOWN'::"CommunityAccessStatus"
  END,
  "lastManualCheckAt",
  "notes",
  "createdAt",
  "updatedAt"
FROM "viber_source_states";

CREATE INDEX "community_source_states_accessStatus_idx"
  ON "community_source_states"("accessStatus");
CREATE INDEX "community_source_states_bridgeStatus_lastWebhookAt_idx"
  ON "community_source_states"("bridgeStatus", "lastWebhookAt");

DROP TABLE "viber_source_states";
DROP TYPE "ViberAccessStatus";

ALTER TABLE "filters" DROP COLUMN "telegramChannels";

-- Remove all legacy listing/search state produced by Telegram channels.
DELETE FROM "listings" WHERE "source" = 'TELEGRAM';
DELETE FROM "source_seen_listings" WHERE "source" = 'TELEGRAM';
DELETE FROM "source_search_states" WHERE "source" = 'TELEGRAM';
DELETE FROM "collector_runs" WHERE "source" = 'TELEGRAM';
DELETE FROM "sources" WHERE "source" = 'TELEGRAM';
UPDATE "filters" SET "sources" = array_remove("sources", 'TELEGRAM'::"ListingSource");
UPDATE "market_price_estimates" SET "sources" = array_remove("sources", 'TELEGRAM'::"ListingSource");

ALTER TYPE "ListingSource" RENAME TO "ListingSource_old";
CREATE TYPE "ListingSource" AS ENUM ('AUTO_RIA', 'OLX', 'RST', 'CARS_UA', 'COMMUNITY', 'MOCK');

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

ALTER TYPE "SocialPlatform" RENAME TO "SocialPlatform_old";
CREATE TYPE "SocialPlatform" AS ENUM ('VIBER', 'WHATSAPP', 'DISCORD', 'CUSTOM');
ALTER TABLE "social_sources"
  ALTER COLUMN "platform" TYPE "SocialPlatform" USING ("platform"::text::"SocialPlatform");
DROP TYPE "SocialPlatform_old";

ALTER TYPE "SocialSourceCategory" RENAME TO "SocialSourceCategory_old";
CREATE TYPE "SocialSourceCategory" AS ENUM (
  'VIBER_COMMUNITY',
  'WHATSAPP_CHANNEL',
  'WHATSAPP_GROUP',
  'DISCORD_CHANNEL',
  'CUSTOM_SOCIAL_SOURCE'
);
ALTER TABLE "social_sources"
  ALTER COLUMN "category" TYPE "SocialSourceCategory" USING ("category"::text::"SocialSourceCategory");
DROP TYPE "SocialSourceCategory_old";

ALTER TYPE "SocialIntegrationMode" RENAME TO "SocialIntegrationMode_old";
CREATE TYPE "SocialIntegrationMode" AS ENUM (
  'DEVICE_BRIDGE',
  'MANUAL_ONLY',
  'CUSTOM_WEBHOOK'
);
ALTER TABLE "social_sources" ALTER COLUMN "integrationMode" DROP DEFAULT;
ALTER TABLE "social_sources"
  ALTER COLUMN "integrationMode" TYPE "SocialIntegrationMode"
  USING ("integrationMode"::text::"SocialIntegrationMode");
ALTER TABLE "social_sources"
  ALTER COLUMN "integrationMode" SET DEFAULT 'MANUAL_ONLY';
UPDATE "social_sources"
SET "integrationMode" = 'DEVICE_BRIDGE'
WHERE "platform" IN ('VIBER', 'WHATSAPP');
DROP TYPE "SocialIntegrationMode_old";

COMMIT;
