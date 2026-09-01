import type { ListingSource } from "../types/listing.js";
import { getCityById, normalizeCityIds, normalizeRegionIds } from "../data/ukraine-regions.js";
import { normalizeText } from "./normalize.js";
import { normalizeVehicleText } from "./vehicle-attributes.js";

export type FilterHygieneCandidate = {
  id: string;
  name: string;
  enabled: boolean;
  sources: readonly ListingSource[];
  autoRiaCategoryId?: number | null;
  autoRiaMarkId?: number | null;
  autoRiaModelId?: number | null;
  brand?: string | null;
  model?: string | null;
  modelNames?: readonly string[];
  generation?: string | null;
  bodyTypes?: readonly string[];
  fuelTypes?: readonly string[];
  gearboxes?: readonly string[];
  driveTypes?: readonly string[];
  colors?: readonly string[];
  engineVolumeFrom?: number | null;
  engineVolumeTo?: number | null;
  enginePowerFrom?: number | null;
  enginePowerTo?: number | null;
  doorsFrom?: number | null;
  doorsTo?: number | null;
  seatsFrom?: number | null;
  seatsTo?: number | null;
  conditions?: readonly string[];
  customsCleared?: boolean | null;
  bargainPossible?: boolean | null;
  freshnessMode?: string | null;
  yearFrom?: number | null;
  yearTo?: number | null;
  priceFrom?: number | null;
  priceTo?: number | null;
  mileageFrom?: number | null;
  mileageTo?: number | null;
  regions?: readonly string[];
  cities?: readonly string[];
  keywords?: readonly string[];
  excludeKeywords?: readonly string[];
};

export type FilterHygieneWarning = {
  kind: "EXACT_DUPLICATE" | "MATERIAL_OVERLAP" | "DUPLICATE_NAME";
  severity: "warning" | "danger";
  filterIds: [string, string];
  filterNames: [string, string];
  message: string;
};

const EXACT_ARRAY_FIELDS = [
  "sources",
  "modelNames",
  "bodyTypes",
  "fuelTypes",
  "gearboxes",
  "driveTypes",
  "colors",
  "conditions",
  "regions",
  "cities",
  "keywords",
  "excludeKeywords",
] as const;

const EXACT_TEXT_FIELDS = ["brand", "model", "generation", "freshnessMode"] as const;
const EXACT_SCALAR_FIELDS = [
  "autoRiaCategoryId",
  "autoRiaMarkId",
  "autoRiaModelId",
  "engineVolumeFrom",
  "engineVolumeTo",
  "enginePowerFrom",
  "enginePowerTo",
  "doorsFrom",
  "doorsTo",
  "seatsFrom",
  "seatsTo",
  "customsCleared",
  "bargainPossible",
  "yearFrom",
  "yearTo",
  "priceFrom",
  "priceTo",
  "mileageFrom",
  "mileageTo",
] as const;

/** A stable signature of every field that changes which listings match. */
export function effectiveFilterSignature(filter: FilterHygieneCandidate): string {
  const normalized: Record<string, unknown> = {};
  for (const field of EXACT_ARRAY_FIELDS) normalized[field] = normalizedList(filter[field]);
  for (const field of EXACT_TEXT_FIELDS) normalized[field] = normalizedValue(filter[field]);
  for (const field of EXACT_SCALAR_FIELDS) normalized[field] = filter[field] ?? null;
  return JSON.stringify(normalized);
}

export function findExactActiveFilter(
  candidate: FilterHygieneCandidate,
  filters: readonly FilterHygieneCandidate[],
  excludeId = candidate.id,
): FilterHygieneCandidate | undefined {
  const signature = effectiveFilterSignature(candidate);
  return filters.find(
    (filter) => filter.enabled && filter.id !== excludeId && effectiveFilterSignature(filter) === signature,
  );
}

export function analyzeFilterHygiene(filters: readonly FilterHygieneCandidate[]): FilterHygieneWarning[] {
  const active = filters.filter((filter) => filter.enabled);
  const warnings: FilterHygieneWarning[] = [];

  for (let leftIndex = 0; leftIndex < active.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex++) {
      const left = active[leftIndex];
      const right = active[rightIndex];
      if (!left || !right) continue;

      const filterIds: [string, string] = [left.id, right.id];
      const filterNames: [string, string] = [left.name, right.name];
      if (effectiveFilterSignature(left) === effectiveFilterSignature(right)) {
        warnings.push({
          kind: "EXACT_DUPLICATE",
          severity: "danger",
          filterIds,
          filterNames,
          message: `Фильтры «${left.name}» и «${right.name}» имеют полностью одинаковые условия.`,
        });
        continue;
      }

      if (filtersMateriallyOverlap(left, right)) {
        warnings.push({
          kind: "MATERIAL_OVERLAP",
          severity: "warning",
          filterIds,
          filterNames,
          message: `Фильтры «${left.name}» и «${right.name}» заметно пересекаются и могут находить одни объявления.`,
        });
        continue;
      }

      if (normalizedName(left.name) === normalizedName(right.name)) {
        warnings.push({
          kind: "DUPLICATE_NAME",
          severity: "warning",
          filterIds,
          filterNames,
          message: `У активных фильтров одинаковое название «${left.name}». Добавьте отличительный признак.`,
        });
      }
    }
  }

  return warnings;
}

/**
 * Deliberately conservative overlap check: it reports a pair only when every
 * material constraint still has a common value. It can miss a fuzzy textual
 * intersection, but will not spam the UI with clearly unrelated filters.
 */
export function filtersMateriallyOverlap(
  left: FilterHygieneCandidate,
  right: FilterHygieneCandidate,
): boolean {
  if (!listConstraintsOverlap(left.sources, right.sources)) return false;
  if (!scalarConstraintsOverlap(left.autoRiaCategoryId, right.autoRiaCategoryId)) return false;
  if (!scalarConstraintsOverlap(left.autoRiaMarkId, right.autoRiaMarkId)) return false;
  if (!scalarConstraintsOverlap(left.autoRiaModelId, right.autoRiaModelId)) return false;
  if (!textConstraintsOverlap(left.brand, right.brand, normalizeVehicleText)) return false;
  if (!modelConstraintsOverlap(left, right)) return false;
  if (!textConstraintsOverlap(left.generation, right.generation, normalizeText)) return false;
  if (!listConstraintsOverlap(left.bodyTypes, right.bodyTypes)) return false;
  if (!listConstraintsOverlap(left.fuelTypes, right.fuelTypes)) return false;
  if (!listConstraintsOverlap(left.gearboxes, right.gearboxes)) return false;
  if (!listConstraintsOverlap(left.driveTypes, right.driveTypes)) return false;
  if (!listConstraintsOverlap(left.colors, right.colors)) return false;
  if (!listConstraintsOverlap(left.conditions, right.conditions)) return false;
  if (!rangeConstraintsOverlap(left.yearFrom, left.yearTo, right.yearFrom, right.yearTo)) return false;
  if (!rangeConstraintsOverlap(left.priceFrom, left.priceTo, right.priceFrom, right.priceTo)) return false;
  if (!rangeConstraintsOverlap(left.mileageFrom, left.mileageTo, right.mileageFrom, right.mileageTo)) return false;
  if (!rangeConstraintsOverlap(left.engineVolumeFrom, left.engineVolumeTo, right.engineVolumeFrom, right.engineVolumeTo)) return false;
  if (!rangeConstraintsOverlap(left.enginePowerFrom, left.enginePowerTo, right.enginePowerFrom, right.enginePowerTo)) return false;
  if (!rangeConstraintsOverlap(left.doorsFrom, left.doorsTo, right.doorsFrom, right.doorsTo)) return false;
  if (!rangeConstraintsOverlap(left.seatsFrom, left.seatsTo, right.seatsFrom, right.seatsTo)) return false;
  if (!scalarConstraintsOverlap(left.customsCleared, right.customsCleared)) return false;
  if (!scalarConstraintsOverlap(left.bargainPossible, right.bargainPossible)) return false;
  if (!geoConstraintsOverlap(left, right)) return false;
  if (!listConstraintsOverlap(left.keywords, right.keywords)) return false;
  return !requiredKeywordsAreExcluded(left, right) && !requiredKeywordsAreExcluded(right, left);
}

function modelConstraintsOverlap(left: FilterHygieneCandidate, right: FilterHygieneCandidate): boolean {
  const leftModels = normalizedList([left.model ?? "", ...(left.modelNames ?? [])], normalizeVehicleText);
  const rightModels = normalizedList([right.model ?? "", ...(right.modelNames ?? [])], normalizeVehicleText);
  return normalizedListsOverlap(leftModels, rightModels);
}

function geoConstraintsOverlap(left: FilterHygieneCandidate, right: FilterHygieneCandidate): boolean {
  const leftCoverage = geoCoverage(left.regions, left.cities);
  const rightCoverage = geoCoverage(right.regions, right.cities);
  if (!leftCoverage || !rightCoverage) return true;

  for (const [regionId, leftCities] of leftCoverage) {
    const rightCities = rightCoverage.get(regionId);
    if (rightCities === undefined) continue;
    if (leftCities === null || rightCities === null) return true;
    if ([...leftCities].some((cityId) => rightCities.has(cityId))) return true;
  }
  return false;
}

/** null means the whole region; an undefined map means the whole country. */
function geoCoverage(
  regions: readonly string[] | undefined,
  cities: readonly string[] | undefined,
): Map<string, Set<string> | null> | undefined {
  const normalizedRegions = normalizeRegionIds(regions);
  const normalizedCities = normalizeCityIds(cities);
  if (normalizedRegions.length === 0 && normalizedCities.length === 0) return undefined;

  const cityGroups = new Map<string, Set<string>>();
  for (const cityId of normalizedCities) {
    const regionId = getCityById(cityId)?.regionId;
    if (!regionId) continue;
    const group = cityGroups.get(regionId) ?? new Set<string>();
    group.add(cityId);
    cityGroups.set(regionId, group);
  }

  const coverage = new Map<string, Set<string> | null>();
  for (const regionId of normalizedRegions) coverage.set(regionId, cityGroups.get(regionId) ?? null);
  for (const [regionId, cityIds] of cityGroups) {
    if (!coverage.has(regionId)) coverage.set(regionId, cityIds);
  }
  return coverage;
}

function requiredKeywordsAreExcluded(required: FilterHygieneCandidate, excluding: FilterHygieneCandidate): boolean {
  const keywords = normalizedList(required.keywords);
  const excluded = new Set(normalizedList(excluding.excludeKeywords));
  return keywords.length > 0 && keywords.every((keyword) => excluded.has(keyword));
}

function listConstraintsOverlap(
  left: readonly (string | ListingSource)[] | undefined,
  right: readonly (string | ListingSource)[] | undefined,
): boolean {
  return normalizedListsOverlap(normalizedList(left), normalizedList(right));
}

function normalizedListsOverlap(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return true;
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function textConstraintsOverlap(
  left: string | null | undefined,
  right: string | null | undefined,
  normalize: (value: string) => string,
): boolean {
  const normalizedLeft = normalize(left ?? "");
  const normalizedRight = normalize(right ?? "");
  if (!normalizedLeft || !normalizedRight) return true;
  return normalizedLeft === normalizedRight || normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}

function scalarConstraintsOverlap<T>(left: T | null | undefined, right: T | null | undefined): boolean {
  return left == null || right == null || left === right;
}

function rangeConstraintsOverlap(
  leftFrom: number | null | undefined,
  leftTo: number | null | undefined,
  rightFrom: number | null | undefined,
  rightTo: number | null | undefined,
): boolean {
  const lower = Math.max(leftFrom ?? Number.NEGATIVE_INFINITY, rightFrom ?? Number.NEGATIVE_INFINITY);
  const upper = Math.min(leftTo ?? Number.POSITIVE_INFINITY, rightTo ?? Number.POSITIVE_INFINITY);
  return lower <= upper;
}

function normalizedList(
  values: readonly (string | ListingSource)[] | null | undefined,
  normalize: (value: string) => string = normalizeText,
): string[] {
  return [...new Set((values ?? []).map((value) => normalize(String(value))).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function normalizedValue(value: string | null | undefined): string | null {
  const normalized = normalizeText(value ?? "");
  return normalized || null;
}

function normalizedName(value: string): string {
  return normalizeText(value);
}
