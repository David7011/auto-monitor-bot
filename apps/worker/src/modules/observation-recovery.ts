import type { ListingSource, TimestampConfidence } from "@amb/db";
import { canonicalizeUrl, type ListingSkipReason, type NormalizedListing } from "@amb/shared";

export type RecoverableObservation = {
  source: ListingSource;
  externalId: string;
  url: string;
  canonicalUrl: string | null;
  title: string | null;
  brand: string | null;
  model: string | null;
  year: number | null;
  priceNormalized: number | null;
  engineVolume: number | null;
  mileage: number | null;
  city: string | null;
  region: string | null;
  publishedAt: Date | null;
  refreshedAt: Date | null;
  timestampConfidence: TimestampConfidence;
  skipReason: string | null;
  firstSeenAt: Date;
};

export function reconstructObservationListing(row: RecoverableObservation): NormalizedListing {
  return {
    source: row.source,
    externalId: row.externalId,
    url: row.url,
    canonicalUrl: row.canonicalUrl || canonicalizeUrl(row.url),
    title: row.title ?? undefined,
    brand: row.brand ?? undefined,
    model: row.model ?? undefined,
    year: row.year ?? undefined,
    priceNormalized: row.priceNormalized ?? undefined,
    currencyOriginal: row.priceNormalized != null ? "USD" : undefined,
    engineVolume: row.engineVolume ?? undefined,
    mileage: row.mileage ?? undefined,
    city: row.city ?? undefined,
    region: row.region ?? undefined,
    photoUrls: [],
    publishedAt: row.publishedAt ?? undefined,
    refreshedAt: row.refreshedAt ?? undefined,
    timestampConfidence: row.timestampConfidence,
    skipReason: normalizeSkipReason(row.skipReason),
    firstSeenAt: row.firstSeenAt,
    raw: {
      recoveredFromObservationJournal: true,
      source: row.source,
      externalId: row.externalId,
    },
  };
}

function normalizeSkipReason(value: string | null): ListingSkipReason | undefined {
  if (!value) return undefined;
  const supported: ListingSkipReason[] = [
    "UNKNOWN_PUBLICATION_DATE",
    "INVALID_PUBLICATION_DATE",
    "PUBLICATION_TIME_DAY_ONLY",
    "FRESHNESS_BY_FIRST_SEEN",
    "PRICE_NORMALIZATION_UNAVAILABLE",
  ];
  return supported.includes(value as ListingSkipReason) ? value as ListingSkipReason : undefined;
}
