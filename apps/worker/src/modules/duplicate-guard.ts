import { Prisma, prisma } from "@amb/db";
import { normalizeText, type NormalizedListing } from "@amb/shared";

export type DuplicateReason =
  | "SOURCE_EXTERNAL_ID"
  | "CANONICAL_URL"
  | "VIN"
  | "PLATE"
  | "SELLER_PHONE"
  | "TITLE_PRICE_YEAR";

export type DuplicateDecision = {
  type: "NONE" | "POSSIBLE" | "STRONG";
  matchedListingId?: string;
  reasons: DuplicateReason[];
  confidence: number;
};

export async function checkDuplicate(listing: NormalizedListing): Promise<DuplicateDecision> {
  const strong = await findStrongDuplicate(listing);
  if (strong) return strong;

  const possible = await findPossibleDuplicate(listing);
  if (possible) return possible;

  return { type: "NONE", reasons: [], confidence: 0 };
}

async function findStrongDuplicate(listing: NormalizedListing): Promise<DuplicateDecision | null> {
  const raw = listing.raw as { vin?: string; plateNormalized?: string } | null | undefined;
  const vin = listing.vin ?? raw?.vin;
  const plateNormalized = listing.plateNormalized ?? raw?.plateNormalized;
  // sellerPhone is deliberately NOT a strong key: it identifies a seller, not a
  // car. Dealers post many distinct cars under one phone, so treating it as a
  // strong duplicate would silently suppress genuinely different listings. Only
  // per-car identity keys stay strong.
  const or: Prisma.ListingWhereInput[] = [
    { source: listing.source, externalId: listing.externalId },
    ...(listing.canonicalUrl.trim() ? [{ canonicalUrl: listing.canonicalUrl }] : []),
    ...(vin ? [{ vin }] : []),
    ...(plateNormalized ? [{ plateNormalized }] : []),
  ];

  const match = await prisma.listing.findFirst({
    where: { OR: or },
    select: {
      id: true,
      source: true,
      externalId: true,
      canonicalUrl: true,
      vin: true,
      plateNormalized: true,
    },
  });
  if (!match) return null;

  if (match.source === listing.source && match.externalId === listing.externalId) {
    return { type: "STRONG", matchedListingId: match.id, reasons: ["SOURCE_EXTERNAL_ID"], confidence: 1 };
  }
  if (listing.canonicalUrl.trim() && match.canonicalUrl === listing.canonicalUrl) {
    return { type: "STRONG", matchedListingId: match.id, reasons: ["CANONICAL_URL"], confidence: 1 };
  }
  if (vin && match.vin === vin) return { type: "STRONG", matchedListingId: match.id, reasons: ["VIN"], confidence: 0.98 };
  if (plateNormalized && match.plateNormalized === plateNormalized) {
    return { type: "STRONG", matchedListingId: match.id, reasons: ["PLATE"], confidence: 0.98 };
  }
  return null;
}

async function findPossibleDuplicate(listing: NormalizedListing): Promise<DuplicateDecision | null> {
  if (!listing.title || listing.year == null || (listing.priceNormalized ?? listing.priceOriginal) == null) return null;

  // Compare each price only against the field it came from — matching a USD
  // normalized value against another car's raw UAH priceOriginal is a false hit.
  const priceMatch: Prisma.ListingWhereInput =
    listing.priceNormalized != null
      ? { priceNormalized: listing.priceNormalized }
      : { priceOriginal: listing.priceOriginal };
  const candidates = await prisma.listing.findMany({
    where: {
      year: listing.year,
      ...priceMatch,
    },
    select: { id: true, title: true },
    take: 25,
  });
  return findTitlePriceYearPossibleDuplicate(listing, candidates);
}

export function findTitlePriceYearPossibleDuplicate(
  listing: Pick<NormalizedListing, "title">,
  candidates: Array<{ id: string; title: string | null }>,
): DuplicateDecision | null {
  if (!listing.title) return null;
  const normalizedTitle = normalizeText(listing.title);
  const match = candidates.find((candidate) => candidate.title && normalizeText(candidate.title) === normalizedTitle);
  if (!match) return null;
  return { type: "POSSIBLE", matchedListingId: match.id, reasons: ["TITLE_PRICE_YEAR"], confidence: 0.55 };
}
