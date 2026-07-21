import { Prisma, prisma, type Listing, type ListingSource, type MarketPriceVerdict } from "@amb/db";
import { researchActiveMarket } from "./market-research.js";

const MIN_READY_SAMPLE_SIZE = 5;
const MAX_COMPARABLES = 160;

type ComparableListing = {
  id: string;
  externalId: string;
  source: ListingSource;
  priceNormalized: number | null;
  brand: string | null;
  model: string | null;
  year: number | null;
  engineVolume: number | null;
};

export type MarketPriceStats = {
  status: "READY" | "INSUFFICIENT_DATA";
  verdict: MarketPriceVerdict;
  targetPrice: number | null;
  sampleSize: number;
  averagePrice: number | null;
  medianPrice: number | null;
  q1Price: number | null;
  q3Price: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  fairLowPrice: number | null;
  fairHighPrice: number | null;
  sources: ListingSource[];
  discardedOutliers: number;
};

export async function runMarketPriceEstimate(listingId: string): Promise<void> {
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing) throw new Error(`Listing not found: ${listingId}`);

  const [databaseComparables, activeResearch] = await Promise.all([
    findComparableListings(listing),
    researchActiveMarket(listing).catch(() => ({ comparables: [], providers: [], cacheHit: false, researchedAt: null })),
  ]);
  const comparables = uniqueComparableListings([...activeResearch.comparables, ...databaseComparables]);
  const stats = calculateMarketPriceStats(
    listing.priceNormalized ?? null,
    comparables.map((item) => ({
      price: item.priceNormalized ?? 0,
      source: item.source,
    })),
  );

  const sourceBreakdown = Object.fromEntries(
    [...new Set(comparables.map((item) => item.source))].map((source) => [source, comparables.filter((item) => item.source === source).length]),
  );
  const params = {
    brand: listing.brand,
    model: listing.model,
    year: listing.year,
    engineVolume: listing.engineVolume,
    corpus: "all-stored-observations",
    activeSampleSize: activeResearch.comparables.length,
    databaseSampleSize: databaseComparables.length,
    activeProviders: activeResearch.providers,
    activeCacheHit: activeResearch.cacheHit,
    researchedAt: activeResearch.researchedAt,
    sourceBreakdown,
    discardedOutliers: stats.discardedOutliers,
    comparableIds: comparables.map((item) => item.id).slice(0, 20),
  } satisfies Prisma.JsonObject;

  const { discardedOutliers: _discardedOutliers, ...persistedStats } = stats;

  await prisma.marketPriceEstimate.upsert({
    where: { listingId },
    create: {
      listingId,
      ...persistedStats,
      params,
    },
    update: {
      ...persistedStats,
      params,
    },
  });
}

export function calculateMarketPriceStats(
  targetPrice: number | null,
  comparables: Array<{ price: number; source: ListingSource }>,
): MarketPriceStats {
  const validComparables = comparables
    .map((item) => ({ ...item, price: Math.round(item.price) }))
    .filter((item) => Number.isFinite(item.price) && item.price > 0);
  const rawPrices = validComparables.map((item) => item.price).sort((a, b) => a - b);
  const filteredComparables = filterPriceOutliers(validComparables, rawPrices);
  const prices = filteredComparables
    .map((item) => item.price)
    .sort((a, b) => a - b);

  const sampleSize = prices.length;
  const status = sampleSize >= MIN_READY_SAMPLE_SIZE ? "READY" : "INSUFFICIENT_DATA";
  const medianPrice = quantile(prices, 0.5);
  const q1Price = quantile(prices, 0.25);
  const q3Price = quantile(prices, 0.75);
  const averagePrice = sampleSize ? Math.round(prices.reduce((sum, price) => sum + price, 0) / sampleSize) : null;
  const minPrice = prices[0] ?? null;
  const maxPrice = prices[prices.length - 1] ?? null;
  const fairLowPrice = medianPrice == null ? null : Math.round(Math.min(q1Price ?? medianPrice * 0.9, medianPrice * 0.9));
  const fairHighPrice = medianPrice == null ? null : Math.round(Math.max(q3Price ?? medianPrice * 1.1, medianPrice * 1.1));
  const verdict = status === "READY" ? classifyPrice(targetPrice, medianPrice, fairLowPrice, fairHighPrice) : "UNKNOWN";

  return {
    status,
    verdict,
    targetPrice,
    sampleSize,
    averagePrice,
    medianPrice,
    q1Price,
    q3Price,
    minPrice,
    maxPrice,
    fairLowPrice,
    fairHighPrice,
    sources: [...new Set(filteredComparables.map((item) => item.source))],
    discardedOutliers: validComparables.length - filteredComparables.length,
  };
}

async function findComparableListings(listing: Listing): Promise<ComparableListing[]> {
  const strict = await queryComparableListings(listing, { yearWindow: 1, engineWindow: 0.3, limit: MAX_COMPARABLES });
  if (strict.length >= MIN_READY_SAMPLE_SIZE) return strict;

  const relaxed = await queryComparableListings(listing, { yearWindow: 2, engineWindow: undefined, limit: MAX_COMPARABLES });
  if (relaxed.length >= MIN_READY_SAMPLE_SIZE) return relaxed;

  return queryComparableListings(listing, { yearWindow: 4, engineWindow: undefined, titleFallback: true, limit: MAX_COMPARABLES });
}

async function queryComparableListings(
  listing: Listing,
  options: { yearWindow: number; engineWindow?: number; titleFallback?: boolean; limit: number },
): Promise<ComparableListing[]> {
  const where: Prisma.ListingWhereInput = {
    id: { not: listing.id },
    priceNormalized: { gt: 0 },
    status: { not: "DUPLICATE" },
  };

  const identity = vehicleIdentityWhere(listing, Boolean(options.titleFallback));
  if (identity.length === 0) return [];
  where.AND = [{ OR: identity }];

  if (listing.year) {
    where.year = {
      gte: listing.year - options.yearWindow,
      lte: listing.year + options.yearWindow,
    };
  }

  if (listing.engineVolume && options.engineWindow) {
    where.engineVolume = {
      gte: Math.max(0, listing.engineVolume - options.engineWindow),
      lte: listing.engineVolume + options.engineWindow,
    };
  }

  const observationWhere: Prisma.SourceSeenListingWhereInput = {
    priceNormalized: { gt: 0 },
    NOT: { source: listing.source, externalId: listing.externalId },
    AND: [{ OR: observationIdentityWhere(listing, Boolean(options.titleFallback)) }],
  };
  if (listing.year) {
    observationWhere.year = { gte: listing.year - options.yearWindow, lte: listing.year + options.yearWindow };
  }
  if (listing.engineVolume && options.engineWindow) {
    observationWhere.engineVolume = {
      gte: Math.max(0, listing.engineVolume - options.engineWindow),
      lte: listing.engineVolume + options.engineWindow,
    };
  }

  const [matchedListings, observations] = await Promise.all([
    prisma.listing.findMany({
      where,
      orderBy: { firstSeenAt: "desc" },
      take: options.limit,
      select: {
        id: true,
        externalId: true,
        source: true,
        priceNormalized: true,
        brand: true,
        model: true,
        year: true,
        engineVolume: true,
      },
    }),
    prisma.sourceSeenListing.findMany({
      where: observationWhere,
      orderBy: { firstSeenAt: "desc" },
      take: options.limit,
      select: {
        id: true,
        externalId: true,
        source: true,
        priceNormalized: true,
        brand: true,
        model: true,
        year: true,
        engineVolume: true,
      },
    }),
  ]);

  const uniqueComparables = new Map<string, ComparableListing>();
  for (const comparable of [...observations, ...matchedListings]) {
    const key = `${comparable.source}:${comparable.externalId}`;
    if (!uniqueComparables.has(key)) uniqueComparables.set(key, comparable);
  }
  return [...uniqueComparables.values()].slice(0, options.limit);
}

function uniqueComparableListings(comparables: ComparableListing[]): ComparableListing[] {
  const unique = new Map<string, ComparableListing>();
  for (const comparable of comparables) {
    const key = `${comparable.source}:${comparable.externalId}`;
    if (!unique.has(key)) unique.set(key, comparable);
  }
  return [...unique.values()].slice(0, MAX_COMPARABLES);
}

function filterPriceOutliers<T extends { price: number }>(items: T[], sortedPrices: number[]): T[] {
  if (items.length < 8) return items;
  const q1 = quantile(sortedPrices, 0.25);
  const q3 = quantile(sortedPrices, 0.75);
  if (q1 == null || q3 == null || q3 <= q1) return items;
  const iqr = q3 - q1;
  const low = Math.max(1, q1 - 1.5 * iqr);
  const high = q3 + 1.5 * iqr;
  const filtered = items.filter((item) => item.price >= low && item.price <= high);
  return filtered.length >= MIN_READY_SAMPLE_SIZE ? filtered : items;
}

function vehicleIdentityWhere(listing: Listing, titleFallback: boolean): Prisma.ListingWhereInput[] {
  const clauses: Prisma.ListingWhereInput[] = [];
  const brand = listing.brand?.trim();
  const model = listing.model?.trim();

  if (brand && model) {
    clauses.push({
      AND: [
        { brand: { equals: brand, mode: "insensitive" } },
        { model: { equals: model, mode: "insensitive" } },
      ],
    });
  }

  if (!brand && model && isSpecificModel(model)) {
    clauses.push({ model: { equals: model, mode: "insensitive" } });
  }

  if (brand && titleFallback) {
    clauses.push({ title: { contains: brand, mode: "insensitive" } });
  }
  if (model && titleFallback && isSpecificModel(model)) {
    clauses.push({ title: { contains: model, mode: "insensitive" } });
  }

  return clauses;
}

function observationIdentityWhere(listing: Listing, titleFallback: boolean): Prisma.SourceSeenListingWhereInput[] {
  const clauses: Prisma.SourceSeenListingWhereInput[] = [];
  const brand = listing.brand?.trim();
  const model = listing.model?.trim();

  if (brand && model) {
    clauses.push({
      AND: [
        { brand: { equals: brand, mode: "insensitive" } },
        { model: { equals: model, mode: "insensitive" } },
      ],
    });
  }
  if (!brand && model && isSpecificModel(model)) clauses.push({ model: { equals: model, mode: "insensitive" } });
  if (brand && titleFallback) clauses.push({ title: { contains: brand, mode: "insensitive" } });
  if (model && titleFallback && isSpecificModel(model)) clauses.push({ title: { contains: model, mode: "insensitive" } });
  return clauses;
}

function isSpecificModel(model: string): boolean {
  const normalized = model.toLowerCase().replace(/[^a-z0-9а-яіїєґ]+/giu, "");
  return normalized.length >= 4;
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] ?? null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lower = sorted[base] ?? 0;
  const upper = sorted[base + 1] ?? lower;
  return Math.round(lower + rest * (upper - lower));
}

function classifyPrice(
  targetPrice: number | null,
  medianPrice: number | null,
  fairLowPrice: number | null,
  fairHighPrice: number | null,
): MarketPriceVerdict {
  if (!targetPrice || !medianPrice || !fairLowPrice || !fairHighPrice) return "UNKNOWN";
  if (targetPrice <= Math.round(medianPrice * 0.7)) return "HIGH_RISK_BARGAIN";
  if (targetPrice < fairLowPrice) return "BELOW_MARKET";
  if (targetPrice > fairHighPrice) return "ABOVE_MARKET";
  return "FAIR";
}
