CREATE TYPE "MarketPriceStatus" AS ENUM ('READY', 'INSUFFICIENT_DATA', 'FAILED');
CREATE TYPE "MarketPriceVerdict" AS ENUM ('UNKNOWN', 'HIGH_RISK_BARGAIN', 'BELOW_MARKET', 'FAIR', 'ABOVE_MARKET');

ALTER TABLE "vehicle_checks"
  ADD COLUMN "make" TEXT,
  ADD COLUMN "engineVolume" DOUBLE PRECISION,
  ADD COLUMN "fuelType" TEXT,
  ADD COLUMN "bodyType" TEXT,
  ADD COLUMN "driveType" TEXT,
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "discrepancies" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "market_price_estimates" (
  "id" TEXT NOT NULL,
  "listingId" TEXT NOT NULL,
  "status" "MarketPriceStatus" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
  "verdict" "MarketPriceVerdict" NOT NULL DEFAULT 'UNKNOWN',
  "targetPrice" INTEGER,
  "sampleSize" INTEGER NOT NULL DEFAULT 0,
  "averagePrice" INTEGER,
  "medianPrice" INTEGER,
  "q1Price" INTEGER,
  "q3Price" INTEGER,
  "minPrice" INTEGER,
  "maxPrice" INTEGER,
  "fairLowPrice" INTEGER,
  "fairHighPrice" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "sources" "ListingSource"[] NOT NULL DEFAULT ARRAY[]::"ListingSource"[],
  "params" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "market_price_estimates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "market_price_estimates_listingId_key" ON "market_price_estimates"("listingId");
CREATE INDEX "market_price_estimates_status_idx" ON "market_price_estimates"("status");
CREATE INDEX "market_price_estimates_verdict_idx" ON "market_price_estimates"("verdict");

ALTER TABLE "market_price_estimates"
  ADD CONSTRAINT "market_price_estimates_listingId_fkey"
  FOREIGN KEY ("listingId") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
