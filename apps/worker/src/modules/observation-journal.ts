import { createHash } from "node:crypto";
import {
  Prisma,
  prisma,
  type Filter,
  type ObservationDecision,
} from "@amb/db";
import type {
  FilterRejectionReason,
  ListingDiscoveryLane,
  ListingSource,
  NormalizedListing,
  TimestampConfidence,
} from "@amb/shared";

const NORMALIZER_VERSION = 2;
const WRITE_BATCH_SIZE = 12;

export type ObservationEvaluationInput = {
  decision: ObservationDecision;
  matchedFilterIds?: string[];
  rejectionReasons?: FilterRejectionReason[];
  filterRevision?: string;
  listingId?: string;
  dispatchAttempted?: boolean;
};

export function buildFilterSetRevision(
  filters: Array<Pick<Filter, "id" | "enabled" | "updatedAt">>,
): string {
  const value = filters
    .map((filter) => `${filter.id}:${filter.enabled ? 1 : 0}:${filter.updatedAt.toISOString()}`)
    .sort()
    .join("|");
  return createHash("sha256").update(value || "no-active-filters").digest("hex").slice(0, 32);
}

export async function recordPendingObservations(
  listings: NormalizedListing[],
  lane: ListingDiscoveryLane,
): Promise<void> {
  for (let index = 0; index < listings.length; index += WRITE_BATCH_SIZE) {
    const batch = listings.slice(index, index + WRITE_BATCH_SIZE);
    await Promise.all(batch.map((listing) => upsertObservation(listing, lane)));
  }
}

export async function recordObservationEvaluation(
  listing: NormalizedListing,
  lane: ListingDiscoveryLane,
  input: ObservationEvaluationInput,
): Promise<void> {
  const now = new Date();
  const shared = observationData(listing, lane);
  await prisma.sourceSeenListing.upsert({
    where: { source_externalId: { source: listing.source, externalId: listing.externalId } },
    create: {
      ...shared,
      decision: input.decision,
      matchedFilterIds: unique(input.matchedFilterIds ?? []),
      rejectionReasons: unique(input.rejectionReasons ?? []),
      filterRevision: input.filterRevision,
      lastEvaluatedAt: now,
      dispatchAttemptedAt: input.dispatchAttempted ? now : null,
      listingId: input.listingId,
      evaluationCount: 1,
    },
    update: {
      ...observationUpdateData(listing),
      decision: input.decision,
      matchedFilterIds: unique(input.matchedFilterIds ?? []),
      rejectionReasons: unique(input.rejectionReasons ?? []),
      filterRevision: input.filterRevision,
      lastEvaluatedAt: now,
      ...(input.dispatchAttempted ? { dispatchAttemptedAt: now } : {}),
      ...(input.listingId ? { listingId: input.listingId } : {}),
      evaluationCount: { increment: 1 },
    },
  });
}

export async function markObservationOutcome(
  source: ListingSource,
  externalId: string,
  input: {
    decision: ObservationDecision;
    listingId?: string;
    notifiedAt?: Date;
    rejectionReasons?: FilterRejectionReason[];
  },
): Promise<void> {
  await prisma.sourceSeenListing.updateMany({
    where: { source, externalId },
    data: {
      decision: input.decision,
      lastEvaluatedAt: new Date(),
      ...(input.listingId ? { listingId: input.listingId } : {}),
      ...(input.notifiedAt ? { notifiedAt: input.notifiedAt } : {}),
      ...(input.rejectionReasons ? { rejectionReasons: unique(input.rejectionReasons) } : {}),
    },
  });
}

export async function releaseIncompleteObservationIds(lookbackHours: number): Promise<number> {
  const cutoff = new Date(Date.now() - Math.max(1, lookbackHours) * 60 * 60 * 1000);
  const retryBefore = new Date(Date.now() - 30 * 60 * 1000);
  return prisma.$executeRaw`
    WITH recent_incomplete AS (
      SELECT incomplete.source, array_agg(incomplete."externalId") AS ids
      FROM (
        SELECT seen.source, seen."externalId"
        FROM "source_seen_listings" AS seen
        WHERE seen."normalizedData" IS NULL
          AND (seen."lastEvaluatedAt" IS NULL OR seen."lastEvaluatedAt" <= ${retryBefore})
          AND (
            seen."publishedAt" >= ${cutoff}
            OR (seen."publishedAt" IS NULL AND seen."firstSeenAt" >= ${cutoff})
          )
        ORDER BY seen."publishedAt" DESC NULLS LAST, seen."firstSeenAt" DESC
        LIMIT 500
      ) AS incomplete
      GROUP BY incomplete.source
    )
    UPDATE "source_search_states" AS state
    SET "knownExternalIds" = ARRAY(
      SELECT known_id
      FROM unnest(state."knownExternalIds") AS known_id
      WHERE NOT (known_id = ANY(recent_incomplete.ids))
    )
    FROM recent_incomplete
    WHERE state.source = recent_incomplete.source
      AND state."knownExternalIds" && recent_incomplete.ids
  `;
}

export function serializeNormalizedListing(listing: NormalizedListing): Prisma.InputJsonValue {
  const { raw: _raw, ...safeListing } = listing;
  return JSON.parse(JSON.stringify({
    ...safeListing,
    photoUrls: listing.photoUrls.slice(0, 30),
  })) as Prisma.InputJsonValue;
}

export function deserializeNormalizedListing(value: Prisma.JsonValue): NormalizedListing | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, Prisma.JsonValue>;
  const source = stringValue(data.source) as ListingSource | undefined;
  const externalId = stringValue(data.externalId);
  const url = stringValue(data.url);
  if (!source || !externalId || !url) return null;

  return {
    source,
    externalId,
    url,
    canonicalUrl: stringValue(data.canonicalUrl) ?? url,
    title: stringValue(data.title),
    brand: stringValue(data.brand),
    model: stringValue(data.model),
    bodyType: stringValue(data.bodyType),
    fuelType: stringValue(data.fuelType),
    gearbox: stringValue(data.gearbox),
    driveType: stringValue(data.driveType),
    color: stringValue(data.color),
    engineVolume: numberValue(data.engineVolume),
    enginePower: numberValue(data.enginePower),
    doors: numberValue(data.doors),
    seats: numberValue(data.seats),
    condition: stringValue(data.condition),
    customsCleared: booleanValue(data.customsCleared),
    bargainPossible: booleanValue(data.bargainPossible),
    year: numberValue(data.year),
    priceOriginal: numberValue(data.priceOriginal),
    currencyOriginal: stringValue(data.currencyOriginal),
    priceNormalized: numberValue(data.priceNormalized),
    exchangeRateUsed: numberValue(data.exchangeRateUsed),
    exchangeRateDate: dateValue(data.exchangeRateDate),
    mileage: numberValue(data.mileage),
    city: stringValue(data.city),
    region: stringValue(data.region),
    sellerPhone: stringValue(data.sellerPhone),
    vin: stringValue(data.vin),
    plateNormalized: stringValue(data.plateNormalized),
    description: stringValue(data.description),
    photoUrls: stringArray(data.photoUrls),
    publishedAt: dateValue(data.publishedAt),
    refreshedAt: dateValue(data.refreshedAt),
    timestampConfidence: (stringValue(data.timestampConfidence) as TimestampConfidence | undefined) ?? "UNKNOWN",
    freshnessFallback: stringValue(data.freshnessFallback) === "FIRST_SEEN" ? "FIRST_SEEN" : undefined,
    skipReason: stringValue(data.skipReason) as NormalizedListing["skipReason"],
    firstSeenAt: dateValue(data.firstSeenAt) ?? new Date(),
    observationChannel: stringValue(data.observationChannel) as NormalizedListing["observationChannel"],
    observationTarget: stringValue(data.observationTarget),
    raw: { replayedFromObservation: true },
  };
}

async function upsertObservation(listing: NormalizedListing, lane: ListingDiscoveryLane): Promise<void> {
  await prisma.sourceSeenListing.upsert({
    where: { source_externalId: { source: listing.source, externalId: listing.externalId } },
    create: observationData(listing, lane),
    update: observationUpdateData(listing),
  });
}

function observationData(listing: NormalizedListing, lane: ListingDiscoveryLane) {
  return {
    source: listing.source,
    externalId: listing.externalId,
    url: listing.url,
    canonicalUrl: listing.canonicalUrl,
    title: listing.title ?? null,
    brand: listing.brand ?? null,
    model: listing.model ?? null,
    year: listing.year ?? null,
    priceNormalized: listing.priceNormalized ?? null,
    engineVolume: listing.engineVolume ?? null,
    mileage: listing.mileage ?? null,
    city: listing.city ?? null,
    region: listing.region ?? null,
    publishedAt: listing.publishedAt ?? null,
    refreshedAt: listing.refreshedAt ?? null,
    timestampConfidence: listing.timestampConfidence ?? "UNKNOWN",
    skipReason: listing.skipReason ?? null,
    normalizedData: serializeNormalizedListing(listing),
    normalizerVersion: NORMALIZER_VERSION,
    firstSeenAt: new Date(listing.firstSeenAt),
    lastSeenAt: new Date(),
    discoveryLane: lane,
    firstObservedChannel: listing.observationChannel ?? null,
    lastObservedChannel: listing.observationChannel ?? null,
    firstObservedTarget: listing.observationTarget ?? null,
    lastObservedTarget: listing.observationTarget ?? null,
  } satisfies Prisma.SourceSeenListingUncheckedCreateInput;
}

function observationUpdateData(listing: NormalizedListing) {
  return {
    url: listing.url,
    canonicalUrl: listing.canonicalUrl,
    title: listing.title ?? null,
    brand: listing.brand ?? null,
    model: listing.model ?? null,
    year: listing.year ?? null,
    priceNormalized: listing.priceNormalized ?? null,
    engineVolume: listing.engineVolume ?? null,
    mileage: listing.mileage ?? null,
    city: listing.city ?? null,
    region: listing.region ?? null,
    publishedAt: listing.publishedAt ?? null,
    refreshedAt: listing.refreshedAt ?? null,
    timestampConfidence: listing.timestampConfidence ?? "UNKNOWN",
    skipReason: listing.skipReason ?? null,
    normalizedData: serializeNormalizedListing(listing),
    normalizerVersion: NORMALIZER_VERSION,
    lastSeenAt: new Date(),
    ...(listing.observationChannel ? { lastObservedChannel: listing.observationChannel } : {}),
    ...(listing.observationTarget ? { lastObservedTarget: listing.observationTarget } : {}),
  } satisfies Prisma.SourceSeenListingUncheckedUpdateInput;
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].slice(0, 30);
}

function stringValue(value: Prisma.JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: Prisma.JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: Prisma.JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: Prisma.JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function dateValue(value: Prisma.JsonValue | undefined): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
