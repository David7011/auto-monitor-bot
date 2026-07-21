import {
  inferBrandFromModel,
  inferBrandFromText,
  normalizeBrandName,
  normalizeCityIds,
  normalizeRegionIds,
  normalizeVehicleText,
  resolveCityId,
  resolveRegionId,
} from "@amb/shared";

export type ParsedQuickFilter = {
  brand: string | null;
  model: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  priceFrom: number | null;
  priceTo: number | null;
  regions: string[];
  cities: string[];
  cleanQuery: string;
  vehicleQuery: string | null;
};

type ExtractedRanges = Pick<ParsedQuickFilter, "yearFrom" | "yearTo" | "priceFrom" | "priceTo"> & {
  remaining: string;
};

const PRICE_SUFFIX = String.raw`(?:\s*(?:\$|usd|у\.?\s*е\.?|доллар(?:а|ов)?|дол(?:л)?\.?))?`;
const NUMBER_TOKEN = String.raw`(?:\d{1,3}(?:[\s.,]\d{3})+|\d{3,8}|\d{1,3}\s*(?:к|k|тыс(?:яч(?:а|и)?)?))`;
const VEHICLE_STOP_WORDS = new Set([
  "авто",
  "автомобиль",
  "автомобили",
  "все",
  "вся",
  "любой",
  "любая",
  "любые",
  "марка",
  "машина",
  "машины",
  "цена",
  "ценой",
  "доллар",
  "доллара",
  "долларов",
  "дол",
  "usd",
  "у",
  "е",
  "от",
  "до",
]);

export function parseQuickFilter(text: string): ParsedQuickFilter {
  const cleanQuery = text.replace(/^\/?(?:filter|фильтр)\b/iu, "").trim();
  const ranges = extractRanges(cleanQuery);
  let searchable = ranges.remaining;

  const geo = extractGeo(searchable);
  for (const phrase of geo.phrases) {
    searchable = searchable.replace(new RegExp(escapeRegex(phrase), "giu"), " ");
  }

  searchable = searchable
    .replace(/\b(?:все|любые?)\s+(?:авто|автомобили?|машины?)\b/giu, " ")
    .replace(/\b(?:без|любая)\s+марки\b/giu, " ")
    .replace(/[,$;:|]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  const words = searchable
    .split(/\s+/u)
    .map((word) => word.trim())
    .filter((word) => isVehicleWord(word));
  const vehicleQuery = words.join(" ").trim() || null;

  let brand = vehicleQuery ? inferBrandFromText(vehicleQuery) ?? null : null;
  const modelWords = removeBrandPrefix(words, brand);
  let model = modelWords.slice(0, 3).join(" ").trim() || null;

  if (model && modelWords.length > 1) {
    const firstTwo = modelWords.slice(0, 2).join(" ");
    if (inferBrandFromModel(firstTwo)) model = firstTwo;
  }

  if (!brand && model) brand = inferBrandFromModel(model) ?? null;
  if (brand) brand = normalizeBrandName(brand) ?? brand;

  // Unknown free text is retained as a keyword query, but numbers and price
  // markers are never promoted to a vehicle make or model.
  if (!brand && model && !containsLetter(model)) model = null;

  const regions = normalizeRegionIds(geo.regions);
  return {
    brand,
    model,
    yearFrom: ranges.yearFrom,
    yearTo: ranges.yearTo,
    priceFrom: ranges.priceFrom,
    priceTo: ranges.priceTo,
    regions,
    cities: normalizeCityIds(geo.cities, regions),
    cleanQuery,
    vehicleQuery,
  };
}

export function extractGeo(value: string): { regions: string[]; cities: string[]; phrases: string[] } {
  const words = value.split(/[,\s]+/u).filter(Boolean);
  const regions: string[] = [];
  const cities: string[] = [];
  const phrases: string[] = [];

  for (let size = Math.min(3, words.length); size >= 1; size--) {
    for (let index = 0; index <= words.length - size; index++) {
      const phrase = words.slice(index, index + size).join(" ");
      const cityId = resolveCityId(phrase);
      const regionId = resolveRegionId(phrase);
      if (cityId) {
        cities.push(cityId);
        phrases.push(phrase);
        if (!looksLikeRegionPhrase(phrase)) continue;
      }
      if (regionId) {
        regions.push(regionId);
        phrases.push(phrase);
      }
    }
  }

  return {
    regions: [...new Set(regions)],
    cities: [...new Set(cities)],
    phrases: [...new Set(phrases)].sort((a, b) => b.length - a.length),
  };
}

function extractRanges(value: string): ExtractedRanges {
  let remaining = value;
  let yearFrom: number | null = null;
  let yearTo: number | null = null;
  let priceFrom: number | null = null;
  let priceTo: number | null = null;

  const rangePattern = new RegExp(`(${NUMBER_TOKEN})${PRICE_SUFFIX}\\s*[-–—]\\s*(${NUMBER_TOKEN})${PRICE_SUFFIX}`, "giu");
  remaining = remaining.replace(rangePattern, (match, firstRaw: string, secondRaw: string) => {
    const first = parseLocalizedNumber(firstRaw);
    const second = parseLocalizedNumber(secondRaw);
    if (first == null || second == null) return match;
    const low = Math.min(first, second);
    const high = Math.max(first, second);
    if (isYear(low) && isYear(high)) {
      yearFrom = low;
      yearTo = high;
    } else {
      priceFrom = low;
      priceTo = high;
    }
    return " ";
  });

  const upperPricePattern = new RegExp(`(?:^|\\s)(?:цена\\s*)?(?:до|to|max|макс(?:имум)?)\\s*\\$?\\s*(${NUMBER_TOKEN})${PRICE_SUFFIX}`, "giu");
  remaining = remaining.replace(upperPricePattern, (_match, raw: string) => {
    const parsed = parseLocalizedNumber(raw);
    if (parsed != null) priceTo = parsed;
    return " ";
  });

  const lowerPricePattern = new RegExp(`(?:^|\\s)(?:цена\\s*)?(?:от|from|min|мин(?:имум)?)\\s*\\$?\\s*(${NUMBER_TOKEN})${PRICE_SUFFIX}`, "giu");
  remaining = remaining.replace(lowerPricePattern, (_match, raw: string) => {
    const parsed = parseLocalizedNumber(raw);
    if (parsed != null) priceFrom = parsed;
    return " ";
  });

  const currencyPricePattern = new RegExp(`\\$\\s*(${NUMBER_TOKEN})|(${NUMBER_TOKEN})\\s*(?:usd|доллар(?:а|ов)?|дол(?:л)?\\.)`, "giu");
  remaining = remaining.replace(currencyPricePattern, (_match, prefixed: string | undefined, suffixed: string | undefined) => {
    const parsed = parseLocalizedNumber(prefixed ?? suffixed ?? "");
    if (parsed != null && priceFrom == null && priceTo == null) priceTo = parsed;
    return " ";
  });

  const yearRangePattern = /\b((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2})\b/gu;
  remaining = remaining.replace(yearRangePattern, (_match, firstRaw: string, secondRaw: string) => {
    const first = Number(firstRaw);
    const second = Number(secondRaw);
    yearFrom = Math.min(first, second);
    yearTo = Math.max(first, second);
    return " ";
  });

  remaining = remaining.replace(/\b((?:19|20)\d{2})\b/gu, (_match, raw: string) => {
    const year = Number(raw);
    if (yearFrom == null && isYear(year)) {
      yearFrom = year;
      yearTo = year;
    }
    return " ";
  });

  return { yearFrom, yearTo, priceFrom, priceTo, remaining };
}

function parseLocalizedNumber(raw: string): number | null {
  const normalized = raw.toLowerCase().trim();
  const multiplier = /(?:к|k|тыс)/u.test(normalized) ? 1000 : 1;
  const digits = normalized.replace(/[^\d]/gu, "");
  if (!digits) return null;
  const parsed = Number(digits) * multiplier;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isYear(value: number): boolean {
  return value >= 1900 && value <= new Date().getFullYear() + 1;
}

function isVehicleWord(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-zа-яіїєґ]/giu, "");
  if (!normalized || VEHICLE_STOP_WORDS.has(normalized)) return false;
  if (!containsLetter(value) || /^\d+(?:[.,]\d+)?$/u.test(value)) return false;
  return true;
}

function containsLetter(value: string): boolean {
  return /[a-zа-яіїєґ]/iu.test(value);
}

function removeBrandPrefix(words: string[], brand: string | null): string[] {
  if (!brand) return words;
  const target = normalizeVehicleText(brand).split(/\s+/u);
  for (let size = Math.min(3, words.length); size >= 1; size--) {
    const prefix = normalizeVehicleText(words.slice(0, size).join(" ")).split(/\s+/u);
    if (prefix.join(" ") === target.slice(0, size).join(" ") || normalizeBrandName(words.slice(0, size).join(" ")) === brand) {
      return words.slice(size);
    }
  }
  return words;
}

function looksLikeRegionPhrase(value: string): boolean {
  return /обл(?:асть|\.)?|region/iu.test(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
