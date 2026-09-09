import {
  BODY_TYPE_OPTIONS,
  DRIVE_TYPE_OPTIONS,
  FUEL_TYPE_OPTIONS,
  GEARBOX_OPTIONS,
  canonicalizeUrl,
  findAttributeValue,
  inferBrandFromModel,
  inferBrandFromText,
  inferVehicleAttributes,
  type NormalizedListing,
  type MarketplaceCategoryKey,
  type TimestampConfidence,
  validateCategoryAttributes,
} from "@amb/shared";
import { env } from "../env.js";
import { currentUsdExchangeRate } from "../modules/exchange-rate.js";
import {
  inferBargainPossible,
  inferCustomsCleared,
  parseEnginePower,
  parseEngineVolume,
} from "./html-utils.js";

type OlxParam = {
  key: string;
  value?: string;
  normalizedValue?: string | string[];
};

export type OlxAd = {
  id: number | string;
  title?: string;
  description?: string;
  url?: string;
  createdTime?: string;
  lastRefreshTime?: string;
  price?: {
    regularPrice?: {
      value?: number;
      currencyCode?: string;
    };
  };
  location?: {
    cityName?: string;
    regionName?: string;
  };
  photos?: string[];
  params?: OlxParam[];
  htmlCardOnly?: boolean;
  /** Structured timestamps are exact; rendered card dates have lower precision. */
  timestampConfidence?: TimestampConfidence;
};

type OlxApiParamValue = {
  value?: number;
  currency?: string;
  key?: string | string[];
  label?: string;
};

type OlxApiParam = {
  key: string;
  value?: OlxApiParamValue | string | number;
};

export type OlxApiAd = {
  id: number | string;
  title?: string;
  description?: string;
  url?: string;
  created_time?: string;
  last_refresh_time?: string;
  params?: OlxApiParam[];
  location?: {
    city?: { name?: string };
    region?: { name?: string };
  };
  photos?: Array<string | { link?: string; href?: string }>;
};

export type OlxApiResponse = {
  data?: OlxApiAd[];
};

type OlxPrerenderedState = {
  ad?: {
    ad?: OlxApiAd;
  };
  listing?: {
    listing?: {
      ads?: OlxAd[];
    };
  };
};

export function normalizeOlxApiAd(ad: OlxApiAd): OlxAd {
  const price = ad.params?.find((param) => param.key === "price")?.value;
  const priceValue = typeof price === "object" && price ? price.value : undefined;
  const currencyCode = typeof price === "object" && price ? price.currency : undefined;
  return {
    id: ad.id,
    title: ad.title,
    description: ad.description,
    url: ad.url,
    createdTime: ad.created_time,
    lastRefreshTime: ad.last_refresh_time,
    price: priceValue != null ? { regularPrice: { value: priceValue, currencyCode } } : undefined,
    location: {
      cityName: ad.location?.city?.name,
      regionName: ad.location?.region?.name,
    },
    photos: (ad.photos ?? [])
      .map((photo) => typeof photo === "string" ? photo : photo.link ?? photo.href)
      .filter((photo): photo is string => Boolean(photo)),
    params: (ad.params ?? []).map((param) => ({
      key: param.key,
      value: apiParamLabel(param.value),
      normalizedValue: apiParamNormalizedValue(param.value),
    })),
  };
}

export function extractPrerenderedState(html: string): OlxPrerenderedState {
  const marker = "window.__PRERENDERED_STATE__=";
  let pos = html.indexOf(marker);
  if (pos === -1) throw new Error("OLX prerendered state not found");

  pos += marker.length;
  while (pos < html.length && /\s/.test(html[pos] ?? "")) pos++;
  if (html[pos] !== '"') throw new Error("OLX prerendered state has unexpected format");

  const start = pos;
  let escaped = false;
  pos++;
  for (; pos < html.length; pos++) {
    const ch = html[pos];
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      break;
    }
  }

  const jsonText = JSON.parse(html.slice(start, pos + 1)) as string;
  return JSON.parse(jsonText) as OlxPrerenderedState;
}

export function normalizeOlxAd(
  ad: OlxAd,
  now = new Date(),
  categoryKey: MarketplaceCategoryKey = "vehicle.car",
): NormalizedListing | undefined {
  const externalId = String(ad.id ?? "");
  if (!externalId || !ad.url) return undefined;

  const params = new Map((ad.params ?? []).map((param) => [param.key, param]));
  if (categoryKey !== "vehicle.car") return normalizeMarketplaceAd(ad, params, now, categoryKey);
  const year = numberFromParam(params.get("motor_year"));
  const mileageThousand = numberFromParam(params.get("motor_mileage_thou"));
  const price = ad.price?.regularPrice?.value;
  const currency = ad.price?.regularPrice?.currencyCode;
  const attributeText = [ad.title, ad.description, paramsText(ad.params)].filter(Boolean).join(" ");
  const inferredAttributes = inferVehicleAttributes(attributeText);
  const model = valueFromParam(params.get("model"));
  const brand = inferBrandFromText(ad.title) ?? inferBrandFromModel(model);
  const engineVolume = parseEngineVolume(firstParamValue(params, [
    "engine_size",
    "motor_engine_size",
    "motor_engine_size_litre",
    "engine_volume",
  ]));
  const enginePower = parseEnginePower(
    firstParamValue(params, ["engine_power", "motor_power", "power"]) ?? attributeText,
  );
  const customsCleared = booleanFromParam(params.get("cleared_customs"), ["yes", "так", "да"], ["no", "ні", "нет"])
    ?? inferCustomsCleared(attributeText);
  const createdAt = parseDate(ad.createdTime);
  const refreshedAt = parseDate(ad.lastRefreshTime);
  // In hunting mode a re-listed / bumped advert counts as fresh.
  const publishedAt = env.OLX_INCLUDE_REFRESHED ? mostRecentDate(createdAt, refreshedAt) : createdAt;
  const normalizedPrice = normalizePriceToUsd(price, currency);
  const categoryAttributes = validateCategoryAttributes(categoryKey, inferCategoryAttributes(categoryKey, attributeText)).attributes;

  return {
    source: "OLX",
    externalId,
    categoryKey,
    categorySchemaVersion: 1,
    categoryAttributes,
    url: ad.url,
    canonicalUrl: canonicalizeUrl(ad.url),
    title: ad.title,
    brand,
    model,
    bodyType: findAttributeValue(valueFromParam(params.get("car_body")), BODY_TYPE_OPTIONS)
      ?? inferredAttributes.bodyType,
    fuelType: findAttributeValue(valueFromParam(params.get("fuel_type")), FUEL_TYPE_OPTIONS)
      ?? inferredAttributes.fuelType,
    gearbox: findAttributeValue(valueFromParam(params.get("transmission_type")), GEARBOX_OPTIONS)
      ?? inferredAttributes.gearbox,
    driveType: findAttributeValue(valueFromParam(params.get("drive_type")), DRIVE_TYPE_OPTIONS)
      ?? inferredAttributes.driveType,
    color: firstParamValue(params, ["color", "car_color"]),
    engineVolume,
    enginePower,
    doors: numberFromParam(params.get("doors")),
    seats: numberFromParam(params.get("seats")),
    condition: firstParamValue(params, ["condition", "state"]),
    customsCleared,
    bargainPossible: inferBargainPossible(attributeText),
    year,
    priceOriginal: price,
    currencyOriginal: currency,
    priceNormalized: normalizedPrice?.amount,
    exchangeRateUsed: normalizedPrice?.rate,
    exchangeRateDate: normalizedPrice?.date,
    mileage: mileageThousand != null ? mileageThousand * 1000 : undefined,
    city: ad.location?.cityName,
    region: ad.location?.regionName,
    description: ad.description,
    photoUrls: ad.photos ?? [],
    publishedAt,
    refreshedAt,
    timestampConfidence: olxTimestampConfidence(ad, publishedAt),
    skipReason: publishedAt
      ? olxTimestampConfidence(ad, publishedAt) === "LOW" ? "PUBLICATION_TIME_DAY_ONLY" : undefined
      : ad.createdTime ? "INVALID_PUBLICATION_DATE" : "UNKNOWN_PUBLICATION_DATE",
    firstSeenAt: now,
    raw: ad,
  };
}

/** Non-vehicle fast path deliberately never invokes vehicle inference. */
function normalizeMarketplaceAd(
  ad: OlxAd,
  params: Map<string, OlxParam>,
  now: Date,
  categoryKey: MarketplaceCategoryKey,
): NormalizedListing {
  const text = [ad.title, ad.description, paramsText(ad.params)].filter(Boolean).join(" ");
  const brand = firstParamValue(params, ["brand", "manufacturer"])
    ?? text.match(/\b(HP|Lenovo|Dell|Apple|Asus|Acer|MSI|Samsung|Xiaomi|Huawei|Honor|Google|OnePlus|Sony|Nintendo|Microsoft|Ninebot|Segway)\b/iu)?.[1];
  const model = valueFromParam(params.get("model"));
  const categoryAttributes = validateCategoryAttributes(categoryKey, {
    ...inferCategoryAttributes(categoryKey, text), ...(brand ? { brand } : {}), ...(model ? { model } : {}),
  }).attributes;
  const createdAt = parseDate(ad.createdTime);
  const refreshedAt = parseDate(ad.lastRefreshTime);
  const publishedAt = env.OLX_INCLUDE_REFRESHED ? mostRecentDate(createdAt, refreshedAt) : createdAt;
  return {
    source: "OLX", externalId: String(ad.id), categoryKey, categorySchemaVersion: 1, categoryAttributes,
    url: ad.url!, canonicalUrl: canonicalizeUrl(ad.url!), title: ad.title, brand, model,
    priceOriginal: ad.price?.regularPrice?.value, currencyOriginal: ad.price?.regularPrice?.currencyCode,
    condition: firstParamValue(params, ["condition", "state"]),
    city: ad.location?.cityName, region: ad.location?.regionName,
    description: ad.description, photoUrls: ad.photos ?? [], publishedAt, refreshedAt,
    timestampConfidence: olxTimestampConfidence(ad, publishedAt),
    skipReason: publishedAt
      ? olxTimestampConfidence(ad, publishedAt) === "LOW" ? "PUBLICATION_TIME_DAY_ONLY" : undefined
      : ad.createdTime ? "INVALID_PUBLICATION_DATE" : "UNKNOWN_PUBLICATION_DATE",
    firstSeenAt: now, raw: ad,
  };
}

export function inferCategoryAttributes(
  categoryKey: MarketplaceCategoryKey,
  text: string,
): Record<string, string | number | string[]> {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (categoryKey === "vehicle.car" || categoryKey === "generic") return {};
  const commonRiskKeywords = [
    "під ремонт", "под ремонт", "на запчастини", "на запчасти", "не працює", "не работает",
    "дефект", "нюанс", "icloud", "mdm", "lock",
  ].filter((value) => normalized.toLowerCase().includes(value));
  const storageGb = capacityGb(normalized, /(?:ssd|hdd|emmc|накопичувач|накопитель|storage|пам(?:'|’)ять|память)\s*[:/-]?\s*(\d+(?:[.,]\d+)?)\s*(tb|тб|gb|гб)/iu,
    /(\d+(?:[.,]\d+)?)\s*(tb|тб|gb|гб)\s*(?:ssd|hdd|emmc|storage)/iu);
  const ramGb = capacityGb(normalized, /(?:ram|озу|оператив\w*|ddr\d*)\s*[:/-]?\s*(\d+(?:[.,]\d+)?)\s*(gb|гб)/iu,
    /(\d+(?:[.,]\d+)?)\s*(gb|гб)\s*(?:ram|озу|оператив\w*|ddr\d*)/iu);
  const gpu = normalized.match(/\b((?:rtx|gtx|rx)\s*\d{3,4}(?:\s*ti|\s*super|\s*xt)?|intel\s+(?:iris|arc)[\w\s-]*|radeon\s+[\w-]+)/iu)?.[1];
  const cpu = normalized.match(/\b((?:intel\s+)?(?:core\s+)?i[3579]-?\d{3,5}[a-z]{0,2}|(?:amd\s+)?ryzen\s+[3579]\s+\d{3,5}[a-z]{0,2}|apple\s+m[1-9](?:\s+(?:pro|max|ultra))?)/iu)?.[1];
  const batteryHealthPercent = numberMatch(normalized, /(?:battery|акб|батаре\w*)[^\d]{0,16}(\d{2,3})\s*%/iu);

  if (categoryKey === "electronics.laptop" || categoryKey === "electronics.desktop") {
    const refreshRateHz = numberMatch(normalized, /(\d{2,3})\s*(?:hz|гц)/iu);
    const screenInches = numberMatch(normalized, /(1[0-9](?:[.,]\d)?)\s*(?:"|дюйм)/iu);
    return cleanAttributes({ cpu, gpu, ramGb, storageGb, screenInches, refreshRateHz, batteryHealthPercent, riskKeywords: commonRiskKeywords });
  }
  if (categoryKey === "electronics.phone") {
    const phoneStorageGb = storageGb ?? capacityGb(normalized, /\b(\d{2,4})\s*(gb|гб)\b/iu);
    return cleanAttributes({ storageGb: phoneStorageGb, batteryHealthPercent, riskKeywords: commonRiskKeywords });
  }
  if (categoryKey === "electronics.component.gpu") {
    const vramGb = capacityGb(normalized, /(?:vram|gddr\d*|відеопам\w*|видеопам\w*)?\s*[:/-]?\s*(\d+(?:[.,]\d+)?)\s*(gb|гб)/iu);
    return cleanAttributes({ model: gpu, vramGb, riskKeywords: commonRiskKeywords });
  }
  if (categoryKey === "gaming.console") {
    const platform = normalized.match(/\b(playstation|ps[345]|xbox(?:\s+(?:one|series\s+[sx]))?|nintendo\s+switch|steam\s+deck)\b/iu)?.[1];
    return cleanAttributes({ platform, model: platform, storageGb });
  }
  const powerW = numberMatch(normalized, /(\d{3,5})\s*(?:w|вт)/iu);
  const rangeKm = numberMatch(normalized, /(?:запас\s+ходу|запас\s+хода|range)[^\d]{0,12}(\d{1,3})\s*(?:км|km)/iu);
  const batteryWh = numberMatch(normalized, /(\d{2,5})\s*(?:wh|вт[·\s-]*год)/iu);
  return cleanAttributes({ powerW, rangeKm, batteryWh });
}

function numberMatch(text: string, pattern: RegExp): number | undefined {
  const values = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))]
    .map((match) => Number.parseFloat((match[1] ?? "").replace(",", "."))).filter(Number.isFinite);
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : undefined;
}

function capacityGb(text: string, ...patterns: RegExp[]): number | undefined {
  const values = patterns.flatMap((pattern) => [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))])
    .map((match) => Number.parseFloat((match[1] ?? "").replace(",", ".")) * (/^(?:tb|тб)$/iu.test(match[2] ?? "") ? 1024 : 1))
    .filter(Number.isFinite);
  // Conflicting capacities are not evidence for picking the first/min/max.
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : undefined;
}

function cleanAttributes(value: Record<string, string | number | string[] | undefined>): Record<string, string | number | string[]> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string | number | string[]] => entry[1] !== undefined));
}

export function olxPublishedAt(ad: OlxAd): Date | undefined {
  const createdAt = parseDate(ad.createdTime);
  const refreshedAt = parseDate(ad.lastRefreshTime);
  const publishedAt = env.OLX_INCLUDE_REFRESHED ? mostRecentDate(createdAt, refreshedAt) : createdAt;
  const confidence = olxTimestampConfidence(ad, publishedAt);
  // A day-only card is represented at noon for display, not as evidence that
  // a historical boundary was reached. Keep it eligible for observation.
  return confidence === "LOW" || confidence === "UNKNOWN" ? undefined : publishedAt;
}

export function olxPublicationBeforeCutoff(ad: OlxAd, cutoff: Date): boolean {
  const publishedAt = olxPublishedAt(ad);
  if (!publishedAt) return false;
  // A rendered HH:mm timestamp covers the entire minute. Never skip a card
  // whose unknown seconds could place it after the requested boundary.
  const uncertaintyMs = olxTimestampConfidence(ad, publishedAt) === "MEDIUM" ? 60_000 : 0;
  return uncertaintyMs > 0
    ? publishedAt.getTime() + uncertaintyMs <= cutoff.getTime()
    : publishedAt < cutoff;
}

function olxTimestampConfidence(ad: OlxAd, publishedAt: Date | undefined): TimestampConfidence {
  if (!publishedAt) return "UNKNOWN";
  return ad.timestampConfidence ?? (ad.htmlCardOnly ? "LOW" : "HIGH");
}

function apiParamLabel(value: OlxApiParam["value"]): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return value?.label ?? (typeof value?.key === "string" ? value.key : undefined);
}

function apiParamNormalizedValue(value: OlxApiParam["value"]): string | string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value.key;
}

function firstParamValue(params: Map<string, OlxParam>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = valueFromParam(params.get(key));
    if (value) return value;
  }
  return undefined;
}

function valueFromParam(param: OlxParam | undefined): string | undefined {
  if (!param) return undefined;
  if (typeof param.value === "string" && param.value.trim()) return param.value.trim();
  if (typeof param.normalizedValue === "string" && param.normalizedValue.trim()) return param.normalizedValue.trim();
  return undefined;
}

function paramsText(params: OlxParam[] | undefined): string {
  return (params ?? [])
    .flatMap((param) => {
      const values: string[] = [];
      if (typeof param.value === "string") values.push(param.value);
      if (typeof param.normalizedValue === "string") values.push(param.normalizedValue);
      if (Array.isArray(param.normalizedValue)) values.push(...param.normalizedValue);
      return values;
    })
    .join(" ");
}

function numberFromParam(param: OlxParam | undefined): number | undefined {
  const value = valueFromParam(param);
  if (!value) return undefined;
  const parsed = Number.parseInt(value.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanFromParam(
  param: OlxParam | undefined,
  truthy: readonly string[],
  falsy: readonly string[],
): boolean | undefined {
  if (!param) return undefined;
  const values = [
    param.value,
    ...(Array.isArray(param.normalizedValue) ? param.normalizedValue : [param.normalizedValue]),
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  if (values.some((value) => truthy.includes(value))) return true;
  if (values.some((value) => falsy.includes(value))) return false;
  return undefined;
}

function normalizePriceToUsd(
  price: number | undefined,
  currency: string | undefined,
): { amount: number; rate?: number; date?: Date } | undefined {
  if (price == null) return undefined;
  if (currency === "USD") return { amount: price };
  if (currency === "UAH") {
    const exchange = currentUsdExchangeRate();
    if (Number.isFinite(exchange.rate) && exchange.rate > 0) {
      return { amount: Math.round(price / exchange.rate), rate: exchange.rate, date: exchange.date };
    }
  }
  return undefined;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function mostRecentDate(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}
