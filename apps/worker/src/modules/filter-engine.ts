import {
  BODY_TYPE_OPTIONS,
  DRIVE_TYPE_OPTIONS,
  FUEL_TYPE_OPTIONS,
  GEARBOX_OPTIONS,
  isReliableFreshListing,
  listingMatchesGeoSelection,
  normalizeText,
  normalizeVehicleText,
  marketplaceCategoryKey,
  validateCategoryAttributes,
  validateCategoryFilterCriteria,
  type TriStateFilterOutcome,
  type FilterRejectionReason,
  type NormalizedListing,
  vehicleAttributeMatches,
} from "@amb/shared";
import type { Filter } from "@amb/db";

export type FilterEvaluation = {
  filterId: string;
  filterName: string;
  matched: boolean;
  outcome: TriStateFilterOutcome;
  provisional: boolean;
  unknownReasons: string[];
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
  const categoryKey = marketplaceCategoryKey(filter.categoryKey);
  const listingCategory = marketplaceCategoryKey(listing.categoryKey);
  if (categoryKey !== "vehicle.car" || listingCategory !== "vehicle.car") {
    return evaluateCategoryListingFilter(listing, filter);
  }
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
    outcome: reasons.length === 0 ? "MATCH" : "NO_MATCH",
    provisional: false,
    unknownReasons: [],
    reasons,
  };
}

function evaluateCategoryListingFilter(listing: NormalizedListing, filter: Filter): FilterEvaluation {
  const reasons: FilterRejectionReason[] = [];
  const unknownReasons: string[] = [];
  const categoryKey = marketplaceCategoryKey(filter.categoryKey);
  const listingCategory = marketplaceCategoryKey(listing.categoryKey);
  if (!filter.enabled) reasons.push("FILTER_DISABLED");
  if (categoryKey !== listingCategory) reasons.push("CATEGORY");
  if (filter.sources.length > 0 && !filter.sources.includes(listing.source)) reasons.push("SOURCE");
  if (!isReliableFreshListing(listing, filter.freshnessMode)) reasons.push("FRESHNESS");

  const haystack = [listing.title, listing.description, listing.brand, listing.model, listing.condition]
    .filter(Boolean)
    .join(" ");
  if (filter.brand && !matchesName(listing.brand, filter.brand, haystack)) {
    if (!listing.brand) unknownReasons.push("Brand unavailable before enrichment");
    else reasons.push("BRAND");
  }
  const modelNames = [...new Set([filter.model, ...filter.modelNames].filter(Boolean))] as string[];
  if (modelNames.length > 0 && !modelNames.some((model) => matchesName(listing.model, model, haystack))) {
    if (!listing.model) unknownReasons.push("Model unavailable before enrichment");
    else reasons.push("MODEL");
  }
  if (!textOptionMatches(filter.conditions, listing.condition, haystack)) {
    if (!listing.condition) unknownReasons.push("Condition unavailable before enrichment");
    else reasons.push("CONDITION");
  }
  // Non-vehicle filter prices are UAH, matching the category form. Never
  // compare USD-normalized automotive prices with a UAH budget.
  const price = listing.currencyOriginal === "UAH" ? listing.priceOriginal : undefined;
  if (price == null && (filter.priceFrom != null || filter.priceTo != null)) unknownReasons.push("Price in UAH unavailable before enrichment");
  else if (!numberInRange(price, filter.priceFrom, filter.priceTo)) reasons.push("PRICE");
  if (!listingMatchesGeoSelection(listing, filter.regions, filter.cities)) {
    if (!listing.region && !listing.city) unknownReasons.push("Geography unavailable before enrichment");
    else reasons.push("GEOGRAPHY");
  }

  const keywordHaystack = normalizeText([listing.title, listing.description].filter(Boolean).join(" "));
  if (filter.excludeKeywords.some((keyword) => keywordHaystack.includes(normalizeText(keyword)))) reasons.push("EXCLUDED_KEYWORD");
  if (filter.keywords.length > 0 && !filter.keywords.some((keyword) => keywordHaystack.includes(normalizeText(keyword)))) {
    reasons.push("REQUIRED_KEYWORD");
  }

  const attributes = validateCategoryAttributes(categoryKey, listing.categoryAttributes).attributes;
  const criteria = validateCategoryFilterCriteria(filter.categoryCriteria).criteria;
  evaluateMinimum(attributes, "ramGb", criteria.minRamGb, "RAM", reasons, unknownReasons);
  evaluateMinimum(attributes, "storageGb", criteria.minStorageGb, "storage", reasons, unknownReasons);
  evaluateMinimum(attributes, "batteryHealthPercent", criteria.minBatteryHealthPercent, "battery health", reasons, unknownReasons);
  evaluateMinimum(attributes, "vramGb", criteria.minVramGb, "VRAM", reasons, unknownReasons);
  evaluateMinimum(attributes, "powerW", criteria.minPowerW, "power", reasons, unknownReasons);
  evaluateMinimum(attributes, "rangeKm", criteria.minRangeKm, "range", reasons, unknownReasons);
  evaluateIncludes(attributes, "cpu", criteria.cpuIncludes, "CPU", reasons, unknownReasons);
  evaluateIncludes(attributes, categoryKey === "electronics.component.gpu" ? "model" : "gpu", criteria.gpuIncludes, "GPU", reasons, unknownReasons);
  evaluateIncludes(attributes, "platform", criteria.platformIncludes, "platform", reasons, unknownReasons);

  const outcome: TriStateFilterOutcome = reasons.length > 0 ? "NO_MATCH" : unknownReasons.length > 0 ? "UNKNOWN" : "MATCH";
  // Both policies keep UNKNOWN observable. MAX_COVERAGE is the production
  // default and sends a provisional card. STRICT is retained in the outcome so
  // a future urgent-detail worker can refine it without ever recording a false
  // NO_MATCH; until then it also remains provisional rather than silently lost.
  return {
    filterId: filter.id,
    filterName: filter.name,
    matched: outcome !== "NO_MATCH",
    outcome,
    provisional: outcome === "UNKNOWN",
    unknownReasons,
    reasons,
  };
}

function evaluateMinimum(
  attributes: Record<string, string | number | string[]>,
  key: string,
  minimum: number | undefined,
  label: string,
  reasons: FilterRejectionReason[],
  unknown: string[],
): void {
  if (minimum == null) return;
  const value = attributes[key];
  if (typeof value !== "number") unknown.push(`${label} unavailable before enrichment`);
  else if (value < minimum) reasons.push("CATEGORY_ATTRIBUTE");
}

function evaluateIncludes(
  attributes: Record<string, string | number | string[]>,
  key: string,
  expected: string[] | undefined,
  label: string,
  reasons: FilterRejectionReason[],
  unknown: string[],
): void {
  if (!expected?.length) return;
  const value = attributes[key];
  if (typeof value !== "string") unknown.push(`${label} unavailable before enrichment`);
  else if (!expected.some((needle) => normalizeText(value).includes(normalizeText(needle)))) reasons.push("CATEGORY_ATTRIBUTE");
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
