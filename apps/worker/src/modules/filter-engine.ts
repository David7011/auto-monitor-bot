import {
  BODY_TYPE_OPTIONS,
  DRIVE_TYPE_OPTIONS,
  FUEL_TYPE_OPTIONS,
  GEARBOX_OPTIONS,
  isReliableFreshListing,
  listingMatchesGeoSelection,
  normalizeText,
  normalizeVehicleText,
  type FilterRejectionReason,
  type NormalizedListing,
  vehicleAttributeMatches,
} from "@amb/shared";
import type { Filter } from "@amb/db";

export type FilterEvaluation = {
  filterId: string;
  filterName: string;
  matched: boolean;
  reasons: FilterRejectionReason[];
};

export type FilterMatchResult = {
  matched: Filter[];
  evaluations: FilterEvaluation[];
  rejectionReasons: FilterRejectionReason[];
};

/**
 * FilterEngine works only with NormalizedListing and never depends on a
 * concrete source. There is no currency in user filters: the user sets
 * priceFrom/priceTo against priceNormalized (falling back to priceOriginal).
 *
 * If regions AND cities are both empty, the regional restriction is not
 * applied (search across all of Ukraine).
 */
export function listingMatchesFilter(listing: NormalizedListing, filter: Filter): boolean {
  return evaluateListingFilter(listing, filter).matched;
}

export function evaluateListingFilter(listing: NormalizedListing, filter: Filter): FilterEvaluation {
  const reasons: FilterRejectionReason[] = [];
  if (!filter.enabled) reasons.push("FILTER_DISABLED");

  if (filter.sources.length > 0 && !filter.sources.includes(listing.source)) reasons.push("SOURCE");
  if (!isReliableFreshListing(listing, filter.freshnessMode)) reasons.push("FRESHNESS");

  const haystack = [listing.title, listing.description, listing.brand, listing.model, listing.color, listing.condition]
    .filter(Boolean)
    .join(" ");

  if (filter.brand && !matchesName(listing.brand, filter.brand, haystack)) reasons.push("BRAND");
  const modelNames = [...new Set([filter.model, ...filter.modelNames].filter(Boolean))] as string[];
  if (modelNames.length > 0 && !modelNames.some((model) => matchesName(listing.model, model, haystack))) reasons.push("MODEL");
  if (filter.generation && !normalizeText(haystack).includes(normalizeText(filter.generation))) reasons.push("GENERATION");

  if (!vehicleAttributeMatches(filter.bodyTypes, listing.bodyType, haystack, BODY_TYPE_OPTIONS)) reasons.push("BODY_TYPE");
  if (!vehicleAttributeMatches(filter.fuelTypes, listing.fuelType, haystack, FUEL_TYPE_OPTIONS)) reasons.push("FUEL_TYPE");
  if (!vehicleAttributeMatches(filter.gearboxes, listing.gearbox, haystack, GEARBOX_OPTIONS)) reasons.push("GEARBOX");
  if (!vehicleAttributeMatches(filter.driveTypes, listing.driveType, haystack, DRIVE_TYPE_OPTIONS)) reasons.push("DRIVE_TYPE");
  if (!textOptionMatches(filter.colors, listing.color, haystack)) reasons.push("COLOR");
  if (!textOptionMatches(filter.conditions, listing.condition, haystack)) reasons.push("CONDITION");

  if (!numberInRange(listing.year, filter.yearFrom, filter.yearTo)) reasons.push("YEAR");
  if (!numberInRange(listing.engineVolume, filter.engineVolumeFrom, filter.engineVolumeTo)) reasons.push("ENGINE_VOLUME");
  if (!numberInRange(listing.enginePower, filter.enginePowerFrom, filter.enginePowerTo)) reasons.push("ENGINE_POWER");
  if (!numberInRange(listing.doors, filter.doorsFrom, filter.doorsTo)) reasons.push("DOORS");
  if (!numberInRange(listing.seats, filter.seatsFrom, filter.seatsTo)) reasons.push("SEATS");

  const price = listing.priceNormalized ?? listing.priceOriginal;
  if (!numberInRange(price, filter.priceFrom, filter.priceTo)) reasons.push("PRICE");

  if (!numberInRange(listing.mileage, filter.mileageFrom, filter.mileageTo)) reasons.push("MILEAGE");
  if (filter.customsCleared != null && listing.customsCleared !== filter.customsCleared) reasons.push("CUSTOMS");
  if (filter.bargainPossible != null && listing.bargainPossible !== filter.bargainPossible) reasons.push("BARGAIN");

  if (!listingMatchesGeoSelection(listing, filter.regions, filter.cities)) reasons.push("GEOGRAPHY");

  const keywordHaystack = normalizeText([listing.title, listing.description].filter(Boolean).join(" "));

  if (filter.excludeKeywords.length > 0) {
    const excluded = filter.excludeKeywords.some((kw) => keywordHaystack.includes(normalizeText(kw)));
    if (excluded) reasons.push("EXCLUDED_KEYWORD");
  }

  if (filter.keywords.length > 0) {
    const hasKeyword = filter.keywords.some((kw) => keywordHaystack.includes(normalizeText(kw)));
    if (!hasKeyword) reasons.push("REQUIRED_KEYWORD");
  }

  return {
    filterId: filter.id,
    filterName: filter.name,
    matched: reasons.length === 0,
    reasons,
  };
}

/** Returns the list of filters that match the listing. */
export function matchFilters(listing: NormalizedListing, filters: Filter[]): Filter[] {
  return matchFiltersDetailed(listing, filters).matched;
}

export function matchFiltersDetailed(listing: NormalizedListing, filters: Filter[]): FilterMatchResult {
  const evaluations = filters.map((filter) => evaluateListingFilter(listing, filter));
  const matchedIds = new Set(evaluations.filter((evaluation) => evaluation.matched).map((evaluation) => evaluation.filterId));
  const rejectionReasons = filters.length === 0
    ? ["NO_ENABLED_FILTERS" as const]
    : [...new Set(evaluations.flatMap((evaluation) => evaluation.reasons))];

  return {
    matched: filters.filter((filter) => matchedIds.has(filter.id)),
    evaluations,
    rejectionReasons,
  };
}

function matchesName(listingValue: string | undefined | null, expectedValue: string, haystack: string): boolean {
  const expected = normalizeVehicleText(expectedValue);
  if (!expected) return true;

  const normalizedListingValue = normalizeVehicleText(listingValue ?? "");
  if (normalizedListingValue === expected || normalizedListingValue.includes(expected)) return true;

  return normalizeVehicleText(haystack).includes(expected);
}

function textOptionMatches(expectedValues: string[], listingValue: string | undefined | null, haystack: string): boolean {
  if (expectedValues.length === 0) return true;
  const normalizedListing = normalizeText(listingValue ?? "");
  const normalizedHaystack = normalizeText(haystack);
  return expectedValues.some((value) => {
    const expected = normalizeText(value);
    return normalizedListing.includes(expected) || normalizedHaystack.includes(expected);
  });
}

function numberInRange(value: number | undefined | null, from: number | null, to: number | null): boolean {
  if (from == null && to == null) return true;
  if (value == null) return false;
  if (from != null && value < from) return false;
  if (to != null && value > to) return false;
  return true;
}
