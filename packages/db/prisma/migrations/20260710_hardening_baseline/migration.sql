-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ListingSource" AS ENUM ('AUTO_RIA', 'OLX', 'RST', 'CARS_UA', 'TELEGRAM', 'MOCK');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('NEW', 'MATCHED', 'SENT', 'ENRICHED', 'IGNORED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "MonitoringStatus" AS ENUM ('STOPPED', 'STARTING', 'RUNNING', 'PAUSED', 'ERROR', 'RATE_LIMITED', 'CAPTCHA_DETECTED');

-- CreateEnum
CREATE TYPE "SourceStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ERROR', 'RATE_LIMITED', 'CAPTCHA_DETECTED', 'DISABLED');

-- CreateEnum
CREATE TYPE "VehicleCheckStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'NO_PLATE_OR_VIN_FOUND', 'PLATE_FOUND', 'VIN_FOUND', 'CHECK_DONE', 'CHECK_PARTIAL', 'CHECK_FAILED');

-- CreateEnum
CREATE TYPE "CollectorRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED', 'RATE_LIMITED', 'CAPTCHA_DETECTED');

-- CreateEnum
CREATE TYPE "TelegramNotificationStatus" AS ENUM ('PENDING', 'SENT', 'UPDATED', 'FAILED');

-- CreateEnum
CREATE TYPE "ErrorLogLevel" AS ENUM ('INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "TimestampConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('TELEGRAM', 'VIBER', 'CUSTOM');

-- CreateEnum
CREATE TYPE "SocialSourceCategory" AS ENUM ('TELEGRAM_OWNER_MARKET', 'TELEGRAM_REGIONAL_MARKET', 'TELEGRAM_DEALER_USED', 'VIBER_COMMUNITY', 'CUSTOM_SOCIAL_SOURCE');

-- CreateEnum
CREATE TYPE "SocialIntegrationMode" AS ENUM ('TELETHON_EVENT', 'MANUAL_ONLY', 'CUSTOM_WEBHOOK');

-- CreateEnum
CREATE TYPE "SocialSourceStatus" AS ENUM ('UNVERIFIED', 'VALIDATING', 'ACTIVE', 'INACTIVE', 'PRIVATE_ACCESS_REQUIRED', 'USER_NOT_JOINED', 'NOT_FOUND', 'FLOOD_WAIT', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "TelegramCandidateStatus" AS ENUM ('NEW', 'ADDED', 'IGNORED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "TelegramSessionHealth" AS ENUM ('UNKNOWN', 'CONNECTED', 'DISCONNECTED', 'FLOOD_WAIT', 'ERROR');

-- CreateEnum
CREATE TYPE "ViberAccessStatus" AS ENUM ('UNKNOWN', 'INVITE_OK', 'INVITE_EXPIRED', 'PRIVATE_ACCESS_REQUIRED', 'ERROR');

-- CreateTable
CREATE TABLE "filters" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sources" "ListingSource"[],
    "autoRiaCategoryId" INTEGER,
    "autoRiaMarkId" INTEGER,
    "autoRiaModelId" INTEGER,
    "brand" TEXT,
    "model" TEXT,
    "modelNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "generation" TEXT,
    "bodyTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fuelTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gearboxes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "driveTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "colors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "engineVolumeFrom" DOUBLE PRECISION,
    "engineVolumeTo" DOUBLE PRECISION,
    "enginePowerFrom" INTEGER,
    "enginePowerTo" INTEGER,
    "doorsFrom" INTEGER,
    "doorsTo" INTEGER,
    "seatsFrom" INTEGER,
    "seatsTo" INTEGER,
    "conditions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customsCleared" BOOLEAN,
    "bargainPossible" BOOLEAN,
    "freshnessMode" TEXT NOT NULL DEFAULT 'TODAY',
    "telegramChannels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "yearFrom" INTEGER,
    "yearTo" INTEGER,
    "priceFrom" INTEGER,
    "priceTo" INTEGER,
    "mileageFrom" INTEGER,
    "mileageTo" INTEGER,
    "regions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludeKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "filters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL,
    "source" "ListingSource" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "SourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "supportsNewestFirst" BOOLEAN NOT NULL DEFAULT true,
    "initialSyncCompletedAt" TIMESTAMP(3),
    "intervalSeconds" INTEGER NOT NULL DEFAULT 120,
    "lastCheckedAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3),
    "lastError" TEXT,
    "consecutiveErrors" INTEGER NOT NULL DEFAULT 0,
    "pausedUntil" TIMESTAMP(3),
    "jitterSeconds" INTEGER NOT NULL DEFAULT 20,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listings" (
    "id" TEXT NOT NULL,
    "source" "ListingSource" NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "title" TEXT,
    "brand" TEXT,
    "model" TEXT,
    "bodyType" TEXT,
    "fuelType" TEXT,
    "gearbox" TEXT,
    "driveType" TEXT,
    "color" TEXT,
    "engineVolume" DOUBLE PRECISION,
    "enginePower" INTEGER,
    "doors" INTEGER,
    "seats" INTEGER,
    "condition" TEXT,
    "customsCleared" BOOLEAN,
    "bargainPossible" BOOLEAN,
    "year" INTEGER,
    "priceOriginal" INTEGER,
    "currencyOriginal" TEXT,
    "priceNormalized" INTEGER,
    "mileage" INTEGER,
    "city" TEXT,
    "region" TEXT,
    "description" TEXT,
    "photoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "publishedAt" TIMESTAMP(3),
    "refreshedAt" TIMESTAMP(3),
    "timestampConfidence" "TimestampConfidence" NOT NULL DEFAULT 'UNKNOWN',
    "skipReason" TEXT,
    "possibleDuplicateOfId" TEXT,
    "duplicateConfidence" DOUBLE PRECISION,
    "duplicateReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sellerPhone" TEXT,
    "vin" TEXT,
    "plateNormalized" TEXT,
    "exchangeRateUsed" DOUBLE PRECISION,
    "exchangeRateDate" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawData" JSONB,
    "status" "ListingStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_seen_listings" (
    "id" TEXT NOT NULL,
    "source" "ListingSource" NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "canonicalUrl" TEXT,
    "title" TEXT,
    "publishedAt" TIMESTAMP(3),
    "refreshedAt" TIMESTAMP(3),
    "timestampConfidence" "TimestampConfidence" NOT NULL DEFAULT 'UNKNOWN',
    "skipReason" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_seen_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_matches" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "filterId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_notifications" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" TEXT,
    "status" "TelegramNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "lastText" TEXT,
    "sentAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_checks" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "plateRaw" TEXT,
    "plateNormalized" TEXT,
    "vin" TEXT,
    "checkStatus" "VehicleCheckStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "model" TEXT,
    "year" INTEGER,
    "color" TEXT,
    "mileage" INTEGER,
    "accidents" TEXT,
    "restrictions" TEXT,
    "rawResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collector_runs" (
    "id" TEXT NOT NULL,
    "source" "ListingSource" NOT NULL,
    "status" "CollectorRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "foundCount" INTEGER NOT NULL DEFAULT 0,
    "newCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collector_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "errors" (
    "id" TEXT NOT NULL,
    "level" "ErrorLogLevel" NOT NULL DEFAULT 'ERROR',
    "scope" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_sources" (
    "id" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "category" "SocialSourceCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT,
    "url" TEXT,
    "regionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "priority" INTEGER NOT NULL DEFAULT 50,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "integrationMode" "SocialIntegrationMode" NOT NULL DEFAULT 'MANUAL_ONLY',
    "status" "SocialSourceStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "lastValidatedAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3),
    "lastEventLatencyMs" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_source_states" (
    "socialSourceId" TEXT NOT NULL,
    "telegramChannelId" TEXT,
    "accessHashEncrypted" TEXT,
    "lastProcessedMessageId" TEXT,
    "initialSyncCompleted" BOOLEAN NOT NULL DEFAULT false,
    "reconnectCount" INTEGER NOT NULL DEFAULT 0,
    "floodWaitUntil" TIMESTAMP(3),
    "sessionHealth" "TelegramSessionHealth" NOT NULL DEFAULT 'UNKNOWN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_source_states_pkey" PRIMARY KEY ("socialSourceId")
);

-- CreateTable
CREATE TABLE "telegram_source_candidates" (
    "id" TEXT NOT NULL,
    "telegramChannelId" TEXT,
    "title" TEXT NOT NULL,
    "username" TEXT,
    "discoveredFromSourceId" TEXT,
    "discoveredFromMessageId" TEXT,
    "status" "TelegramCandidateStatus" NOT NULL DEFAULT 'NEW',
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_source_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "viber_source_states" (
    "socialSourceId" TEXT NOT NULL,
    "inviteUrl" TEXT,
    "accessStatus" "ViberAccessStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastManualCheckAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "viber_source_states_pkey" PRIMARY KEY ("socialSourceId")
);

-- CreateTable
CREATE TABLE "social_source_filters" (
    "socialSourceId" TEXT NOT NULL,
    "filterId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_source_filters_pkey" PRIMARY KEY ("socialSourceId","filterId")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitoring_state" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "status" "MonitoringStatus" NOT NULL DEFAULT 'STOPPED',
    "startedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "lastTickAt" TIMESTAMP(3),
    "nextTickAt" TIMESTAMP(3),
    "intervalSeconds" INTEGER NOT NULL DEFAULT 120,
    "jitterSeconds" INTEGER NOT NULL DEFAULT 20,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitoring_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sources_source_key" ON "sources"("source");

-- CreateIndex
CREATE UNIQUE INDEX "listings_canonicalUrl_key" ON "listings"("canonicalUrl");

-- CreateIndex
CREATE INDEX "listings_firstSeenAt_idx" ON "listings"("firstSeenAt");

-- CreateIndex
CREATE INDEX "listings_publishedAt_idx" ON "listings"("publishedAt");

-- CreateIndex
CREATE INDEX "listings_source_idx" ON "listings"("source");

-- CreateIndex
CREATE INDEX "listings_status_idx" ON "listings"("status");

-- CreateIndex
CREATE INDEX "listings_sellerPhone_idx" ON "listings"("sellerPhone");

-- CreateIndex
CREATE INDEX "listings_vin_idx" ON "listings"("vin");

-- CreateIndex
CREATE INDEX "listings_plateNormalized_idx" ON "listings"("plateNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "listings_source_externalId_key" ON "listings"("source", "externalId");

-- CreateIndex
CREATE INDEX "source_seen_listings_source_firstSeenAt_idx" ON "source_seen_listings"("source", "firstSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "source_seen_listings_source_externalId_key" ON "source_seen_listings"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "listing_matches_listingId_filterId_key" ON "listing_matches"("listingId", "filterId");

-- CreateIndex
CREATE INDEX "telegram_notifications_messageId_idx" ON "telegram_notifications"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_notifications_listingId_key" ON "telegram_notifications"("listingId");

-- CreateIndex
CREATE INDEX "vehicle_checks_plateNormalized_idx" ON "vehicle_checks"("plateNormalized");

-- CreateIndex
CREATE INDEX "vehicle_checks_vin_idx" ON "vehicle_checks"("vin");

-- CreateIndex
CREATE INDEX "vehicle_checks_listingId_idx" ON "vehicle_checks"("listingId");

-- CreateIndex
CREATE INDEX "collector_runs_source_idx" ON "collector_runs"("source");

-- CreateIndex
CREATE INDEX "collector_runs_startedAt_idx" ON "collector_runs"("startedAt");

-- CreateIndex
CREATE INDEX "errors_createdAt_idx" ON "errors"("createdAt");

-- CreateIndex
CREATE INDEX "social_sources_platform_enabled_status_idx" ON "social_sources"("platform", "enabled", "status");

-- CreateIndex
CREATE INDEX "social_sources_category_priority_idx" ON "social_sources"("category", "priority");

-- CreateIndex
CREATE INDEX "social_sources_updatedAt_idx" ON "social_sources"("updatedAt");

-- CreateIndex
CREATE INDEX "telegram_source_states_telegramChannelId_idx" ON "telegram_source_states"("telegramChannelId");

-- CreateIndex
CREATE INDEX "telegram_source_states_sessionHealth_idx" ON "telegram_source_states"("sessionHealth");

-- CreateIndex
CREATE INDEX "telegram_source_candidates_status_discoveredAt_idx" ON "telegram_source_candidates"("status", "discoveredAt");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_source_candidates_telegramChannelId_key" ON "telegram_source_candidates"("telegramChannelId");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_source_candidates_username_key" ON "telegram_source_candidates"("username");

-- CreateIndex
CREATE INDEX "viber_source_states_accessStatus_idx" ON "viber_source_states"("accessStatus");

-- CreateIndex
CREATE INDEX "social_source_filters_filterId_idx" ON "social_source_filters"("filterId");

-- CreateIndex
CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");

-- AddForeignKey
ALTER TABLE "listing_matches" ADD CONSTRAINT "listing_matches_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_matches" ADD CONSTRAINT "listing_matches_filterId_fkey" FOREIGN KEY ("filterId") REFERENCES "filters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_notifications" ADD CONSTRAINT "telegram_notifications_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_checks" ADD CONSTRAINT "vehicle_checks_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_source_states" ADD CONSTRAINT "telegram_source_states_socialSourceId_fkey" FOREIGN KEY ("socialSourceId") REFERENCES "social_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_source_candidates" ADD CONSTRAINT "telegram_source_candidates_discoveredFromSourceId_fkey" FOREIGN KEY ("discoveredFromSourceId") REFERENCES "social_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "viber_source_states" ADD CONSTRAINT "viber_source_states_socialSourceId_fkey" FOREIGN KEY ("socialSourceId") REFERENCES "social_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_source_filters" ADD CONSTRAINT "social_source_filters_socialSourceId_fkey" FOREIGN KEY ("socialSourceId") REFERENCES "social_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_source_filters" ADD CONSTRAINT "social_source_filters_filterId_fkey" FOREIGN KEY ("filterId") REFERENCES "filters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

