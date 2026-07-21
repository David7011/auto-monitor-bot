import type { ListingSource, TimestampConfidence } from "../types/listing.js";

export type FreshnessMode = "LAST_HOUR" | "TODAY" | "LAST_24_HOURS" | "LAST_3_DAYS" | "LAST_7_DAYS" | "ALL_TIME";

const KYIV_TIME_ZONE = "Europe/Kyiv";
const MAX_FUTURE_PUBLICATION_DRIFT_MS = 2 * 60 * 1000;

const SOURCE_PRIORITY: Record<ListingSource, number> = {
  AUTO_RIA: 50,
  OLX: 40,
  CARS_UA: 30,
  AUTOMOTO: 25,
  RST: 20,
  MOCK: 10,
};

export type FreshnessListingInput = {
  source: ListingSource;
  externalId: string;
  publishedAt?: Date | string | null;
  timestampConfidence?: TimestampConfidence | null;
  refreshedAt?: Date | string | null;
  firstSeenAt?: Date | string | null;
  freshnessFallback?: "FIRST_SEEN" | null;
};

export function isFreshListing(
  publishedAt: Date | string | null | undefined,
  mode: FreshnessMode | string | null | undefined = "TODAY",
  now = new Date(),
): boolean {
  if (mode === "ALL_TIME") return true;
  if (!publishedAt) return false;

  const published = publishedAt instanceof Date ? publishedAt : new Date(publishedAt);
  if (Number.isNaN(published.getTime()) || published > now) return false;

  const cutoff = freshnessCutoff(mode, now);
  return cutoff ? published >= cutoff : true;
}

export function freshnessCutoff(
  mode: FreshnessMode | string | null | undefined = "TODAY",
  now = new Date(),
): Date | undefined {
  switch (mode) {
    case "LAST_HOUR":
      return new Date(now.getTime() - 60 * 60 * 1000);
    case "LAST_24_HOURS":
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case "LAST_3_DAYS":
      return new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    case "LAST_7_DAYS":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "ALL_TIME":
      return undefined;
    case "TODAY":
    default:
      return startOfTodayInKyiv(now);
  }
}

export function isReliableFreshListing(
  listing: FreshnessListingInput,
  mode: FreshnessMode | string | null | undefined = "TODAY",
  now = new Date(),
): boolean {
  if (mode === "ALL_TIME") return true;
  if (listing.timestampConfidence === "UNKNOWN" || !listing.publishedAt) {
    if (listing.freshnessFallback !== "FIRST_SEEN") return false;
    return isFreshListing(listing.firstSeenAt, mode, now);
  }
  const published = parseDate(listing.publishedAt);
  if (!published) return false;
  if (published.getTime() > now.getTime() + MAX_FUTURE_PUBLICATION_DRIFT_MS) return false;
  const cutoff = freshnessCutoff(mode, now);
  return cutoff ? published >= cutoff : true;
}

export function filterReliableFreshListings<T extends FreshnessListingInput>(
  listings: T[],
  mode: FreshnessMode | string | null | undefined,
  now = new Date(),
): T[] {
  return sortListingsNewestFirst(listings.filter((listing) => isReliableFreshListing(listing, mode, now)));
}

export function sortListingsNewestFirst<T extends FreshnessListingInput>(listings: T[]): T[] {
  return [...listings].sort((a, b) => compareListingsNewestFirst(a, b));
}

export function compareListingsNewestFirst(a: FreshnessListingInput, b: FreshnessListingInput): number {
  const aTime = parseDate(a.publishedAt)?.getTime() ?? 0;
  const bTime = parseDate(b.publishedAt)?.getTime() ?? 0;
  if (aTime !== bTime) return bTime - aTime;

  const aPriority = SOURCE_PRIORITY[a.source] ?? 0;
  const bPriority = SOURCE_PRIORITY[b.source] ?? 0;
  if (aPriority !== bPriority) return bPriority - aPriority;

  return String(b.externalId).localeCompare(String(a.externalId));
}

export function startOfTodayInKyiv(now = new Date()): Date {
  const parts = getZonedParts(now, KYIV_TIME_ZONE);
  return zonedDateTimeToUtc(parts.year, parts.month, parts.day, 0, 0, 0, KYIV_TIME_ZONE);
}

function getZonedParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function parseDate(value: Date | string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offsetMs = getTimeZoneOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offsetMs);
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}
