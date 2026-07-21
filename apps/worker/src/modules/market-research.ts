import { createHash } from "node:crypto";
import type { Listing, ListingSource } from "@amb/db";
import { normalizeVehicleText } from "@amb/shared";
import { fetchOlxMarketComparables } from "../collectors/olx.js";
import { env } from "../env.js";
import { redisConnection } from "../lib/queues.js";

export type ActiveMarketComparable = {
  id: string;
  externalId: string;
  source: ListingSource;
  priceNormalized: number;
  brand: string | null;
  model: string | null;
  year: number | null;
  engineVolume: number | null;
};

export type ActiveMarketResearchResult = {
  comparables: ActiveMarketComparable[];
  providers: string[];
  cacheHit: boolean;
  researchedAt: string | null;
};

type CachedResearch = {
  comparables: ActiveMarketComparable[];
  providers: string[];
  researchedAt: string;
};

export async function researchActiveMarket(listing: Listing): Promise<ActiveMarketResearchResult> {
  const brand = listing.brand?.trim();
  const model = listing.model?.trim();
  if (!brand || !model) return { comparables: [], providers: [], cacheHit: false, researchedAt: null };

  const signature = marketSignature(brand, model, listing.year, listing.engineVolume, {
    region: listing.region,
    mileage: listing.mileage,
    fuelType: listing.fuelType,
    gearbox: listing.gearbox,
    bodyType: listing.bodyType,
  });
  const cacheKey = `market-research:v2:${signature}`;
  const lockKey = `${cacheKey}:lock`;
  const cached = await readCache(cacheKey);
  if (cached) return { ...cached, cacheHit: true };

  const lockValue = `${process.pid}:${Date.now()}`;
  const acquired = await acquireLock(lockKey, lockValue);
  if (!acquired) {
    await delay(250);
    const shared = await readCache(cacheKey);
    return shared ? { ...shared, cacheHit: true } : { comparables: [], providers: [], cacheHit: false, researchedAt: null };
  }

  try {
    const olxListings = await fetchOlxMarketComparables({
      brand,
      model,
      year: listing.year ?? undefined,
      engineVolume: listing.engineVolume ?? undefined,
      excludeExternalId: listing.source === "OLX" ? listing.externalId : undefined,
    });
    const researchedAt = new Date().toISOString();
    const result: CachedResearch = {
      comparables: olxListings.map((item) => ({
        id: `active:OLX:${item.externalId}`,
        externalId: item.externalId,
        source: "OLX",
        priceNormalized: item.priceNormalized ?? 0,
        brand: item.brand ?? null,
        model: item.model ?? null,
        year: item.year ?? null,
        engineVolume: item.engineVolume ?? null,
      })),
      providers: ["OLX"],
      researchedAt,
    };
    await writeCache(cacheKey, result);
    return { ...result, cacheHit: false };
  } finally {
    await releaseLock(lockKey, lockValue);
  }
}

export function marketSignature(
  brand: string,
  model: string,
  year: number | null,
  engineVolume: number | null,
  attributes: {
    region?: string | null;
    mileage?: number | null;
    fuelType?: string | null;
    gearbox?: string | null;
    bodyType?: string | null;
  } = {},
): string {
  const identity = [
    normalizeVehicleText(brand),
    normalizeVehicleText(model),
    year ?? "any-year",
    engineVolume == null ? "any-engine" : Math.round(engineVolume * 10) / 10,
    normalizeVehicleText(attributes.region ?? "") || "any-region",
    attributes.mileage == null ? "any-mileage" : Math.round(attributes.mileage / 50_000) * 50_000,
    normalizeVehicleText(attributes.fuelType ?? "") || "any-fuel",
    normalizeVehicleText(attributes.gearbox ?? "") || "any-gearbox",
    normalizeVehicleText(attributes.bodyType ?? "") || "any-body",
  ].join("|");
  return createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

async function readCache(key: string): Promise<CachedResearch | null> {
  try {
    const value = await redisConnection.get(key);
    if (!value) return null;
    const parsed = JSON.parse(value) as CachedResearch;
    return Array.isArray(parsed.comparables) && Array.isArray(parsed.providers) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(key: string, value: CachedResearch): Promise<void> {
  try {
    await redisConnection.set(key, JSON.stringify(value), "EX", Math.max(300, env.MARKET_RESEARCH_CACHE_TTL_SECONDS));
  } catch {
    // Market research remains usable without Redis; only deduplication is lost.
  }
}

async function acquireLock(key: string, value: string): Promise<boolean> {
  try {
    return await redisConnection.set(key, value, "PX", 60_000, "NX") === "OK";
  } catch {
    return true;
  }
}

async function releaseLock(key: string, value: string): Promise<void> {
  try {
    await redisConnection.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      value,
    );
  } catch {
    // The short-lived lock expires automatically.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
