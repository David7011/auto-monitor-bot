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

export function normalizeOlxAd(ad: OlxAd, now = new Date()): NormalizedListing | undefined {
  const externalId = String(ad.id ?? "");
  if (!externalId || !ad.url) return undefined;

  const params = new Map((ad.params ?? []).map((param) => [param.key, param]));
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

  return {
    source: "OLX",
    externalId,
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
    timestampConfidence: publishedAt ? "HIGH" : "UNKNOWN",
    skipReason: publishedAt ? undefined : ad.createdTime ? "INVALID_PUBLICATION_DATE" : "UNKNOWN_PUBLICATION_DATE",
    firstSeenAt: now,
    raw: ad,
  };
}

export function olxPublishedAt(ad: OlxAd): Date | undefined {
  const createdAt = parseDate(ad.createdTime);
  const refreshedAt = parseDate(ad.lastRefreshTime);
  return env.OLX_INCLUDE_REFRESHED ? mostRecentDate(createdAt, refreshedAt) : createdAt;
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
