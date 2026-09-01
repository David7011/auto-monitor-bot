import {
  BODY_TYPE_OPTIONS,
  DRIVE_TYPE_OPTIONS,
  FUEL_TYPE_OPTIONS,
  GEARBOX_OPTIONS,
  autoRiaGeoParamsForSelection,
  canonicalizeUrl,
  findAttributeValue,
  inferVehicleAttributes,
  normalizePlate,
  type NormalizedListing,
} from "@amb/shared";
import {
  collectorScanOptions,
  type CollectorResult,
  type CollectorScanOptions,
  type SourceCollector,
  type SourceSearchContext,
  type SourceSearchState,
} from "./base.js";
import { env } from "../env.js";
import { redisConnection } from "../lib/queues.js";
import { consumeAutoRiaQuota } from "../modules/auto-ria-quota.js";
import { sourceHttpClient } from "./source-http-client.js";

type RiaSearchResponse = {
  result?: {
    search_result?: {
      ids?: Array<string | number>;
    };
    ids?: Array<string | number>;
  };
  ids?: Array<string | number>;
};

type RiaInfoResponse = {
  autoData?: {
    autoId?: number;
    year?: number;
    race?: string;
    raceInt?: number;
    description?: string;
  };
  markName?: string;
  modelName?: string;
  title?: string;
  bodyName?: string;
  fuelName?: string;
  gearboxName?: string;
  driveName?: string;
  USD?: number;
  UAH?: number;
  price?: number;
  locationCityName?: string;
  stateData?: { regionName?: string };
  photoData?: { seoLinkF?: string };
  linkToView?: string;
  addDate?: string;
  updateDate?: string;
  vin?: string;
  VIN?: string;
  stateNumber?: string;
};

type FetchJsonResult<T> =
  | { ok: true; data: T; requestMade?: boolean }
  | {
      ok: false;
      rateLimited?: boolean;
      captchaDetected?: boolean;
      quotaDeferredSeconds?: number;
      requestMade?: boolean;
      status?: number;
      message?: string;
    };

const API_BASE = "https://developers.ria.com/auto";
const INFO_CACHE_TTL_SECONDS = 24 * 60 * 60;

const BODY_TYPE_IDS: Record<string, number> = {
  sedan: 3,
  hatchback: 4,
  wagon: 2,
  coupe: 5,
  convertible: 6,
  minivan: 8,
  van: 9,
  pickup: 7,
  suv: 5,
  crossover: 5,
};

const FUEL_TYPE_IDS: Record<string, number> = {
  gasoline: 1,
  petrol: 1,
  diesel: 2,
  gas: 4,
  hybrid: 3,
  electric: 6,
};

const GEARBOX_IDS: Record<string, number> = {
  manual: 1,
  automatic: 2,
  robot: 3,
  variator: 4,
};

/**
 * AUTO.RIA collector using the official developers.ria.com API.
 *
 * Search is filter-context aware: one request plan per active filter query,
 * newest-first, deleted ads excluded, paid endpoints disabled unless explicitly
 * enabled in env. Info calls are spent only on ids that are new for the current
 * search context.
 */
export class AutoRiaCollector implements SourceCollector {
  readonly source = "AUTO_RIA" as const;
  readonly supportsNewestFirst = true;
  readonly newestFirstVerified = true;

  async collect(
    context: SourceSearchContext,
    state: SourceSearchState,
    input?: CollectorScanOptions,
  ): Promise<CollectorResult> {
    const scan = collectorScanOptions(input);
    const apiKey = env.AUTO_RIA_API_KEY;
    if (!apiKey) {
      throw new Error("AUTO_RIA_API_KEY is not set");
    }

    const searchQuota = await consumeAutoRiaQuota("search");
    if (!searchQuota.allowed) {
      return {
        listings: [],
        limited: true,
        quotaDeferredSeconds: searchQuota.retryAfterSeconds ?? 15 * 60,
        limitedReason: `AUTO.RIA: локальный планировщик сохранил квоту API (${searchQuota.reason ?? "лимит"})`,
        observedCount: 0,
        pageCount: 0,
        requestCount: 0,
      };
    }

    const searchUrl = buildAutoRiaSearchUrl(context, apiKey);
    const search = await fetchJson<RiaSearchResponse>(searchUrl);
    if (!search.ok) {
      return {
        listings: [],
        rateLimited: search.rateLimited,
        captchaDetected: search.captchaDetected,
        limitedReason: search.message,
        responseStatus: search.status,
        requestCount: search.requestMade === false ? 0 : 1,
      };
    }

    const ids = extractIds(search.data);
    const listings: NormalizedListing[] = [];
    const now = new Date();
    let requestCount = 1;
    const maxCandidates = Math.max(1, Math.min(env.AUTO_RIA_MAX_INFO_PER_SCAN, scan.maxCandidates));
    const candidateIds = selectAutoRiaCandidateIds(
      ids,
      state.knownExternalIds,
      maxCandidates,
      env.KNOWN_LISTING_STOP_THRESHOLD,
    );
    const semanticWarnings: string[] = [];

    for (const id of candidateIds) {
      if (Date.now() >= scan.deadlineAt.getTime()) {
        semanticWarnings.push(`AUTO.RIA scan deadline reached after ${requestCount} request(s)`);
        break;
      }

      const info = await loadAutoRiaInfo(id, apiKey);
      if (info.requestMade) requestCount += 1;
      if (!info.ok) {
        if (info.quotaDeferredSeconds) {
          return {
            listings,
            limited: true,
            quotaDeferredSeconds: info.quotaDeferredSeconds,
            limitedReason: info.message,
            observedCount: ids.length,
            pageCount: 1,
            requestCount,
            semanticWarnings,
          };
        }
        if (info.rateLimited || info.captchaDetected) {
          return {
            listings,
            rateLimited: info.rateLimited,
            captchaDetected: info.captchaDetected,
            limitedReason: info.message,
            responseStatus: info.status,
            observedCount: ids.length,
            pageCount: 1,
            requestCount,
            semanticWarnings,
          };
        }
        continue;
      }

      const listing = normalizeAutoRiaInfo(id, info.data, now);
      if (listing) {
        listings.push(listing);
        if (scan.onHotCandidates) await scan.onHotCandidates([listing]);
      }
    }

    return { listings, observedCount: ids.length, pageCount: 1, requestCount, semanticWarnings };
  }
}

/**
 * Do not trust one known ID as a complete continuity anchor: promoted or
 * reordered cards can put a genuinely new ID immediately below it. Continue
 * through a bounded consecutive-known tail, while strictly capping expensive
 * info calls. A stable feed therefore costs no extra detail requests.
 */
export function selectAutoRiaCandidateIds(
  ids: readonly string[],
  knownExternalIds: ReadonlySet<string>,
  maxCandidates: number,
  knownTailThreshold: number,
): string[] {
  const selected: string[] = [];
  let knownTail = 0;
  const limit = Math.max(0, Math.trunc(maxCandidates));
  const tailLimit = Math.max(1, Math.trunc(knownTailThreshold));
  if (limit === 0) return selected;

  for (const id of ids) {
    if (knownExternalIds.has(id)) {
      knownTail += 1;
      if (knownTail >= tailLimit) break;
      continue;
    }
    knownTail = 0;
    if (!id || selected.includes(id)) continue;
    selected.push(id);
    if (selected.length >= limit) break;
  }
  return selected;
}

export function buildAutoRiaSearchUrl(context: SourceSearchContext, apiKey: string): string {
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("category_id", String(context.autoRiaCategoryId ?? 1));
  params.set("searchType", "4");
  params.set("status_id", "0");
  params.set("order_by", "7");
  params.set("countpage", "100");
  params.set("page", "0");
  params.set("with_photo", "1");
  params.set("currency", "1");

  appendNumber(params, "marka_id[0]", context.autoRiaMarkId);
  appendNumber(params, "model_id[0]", context.autoRiaModelId);
  appendNumber(params, "s_yers[0]", context.yearFrom);
  appendNumber(params, "po_yers[0]", context.yearTo);
  appendNumber(params, "price_ot", context.priceFrom);
  appendNumber(params, "price_do", context.priceTo);
  appendNumber(params, "raceFrom", context.mileageFrom != null ? Math.floor(context.mileageFrom / 1000) : undefined);
  appendNumber(params, "raceTo", context.mileageTo != null ? Math.ceil(context.mileageTo / 1000) : undefined);
  appendNumber(params, "engineVolumeFrom", context.engineVolumeFrom);
  appendNumber(params, "engineVolumeTo", context.engineVolumeTo);
  appendNumber(params, "powerFrom", context.enginePowerFrom);
  appendNumber(params, "powerTo", context.enginePowerTo);
  appendNumber(params, "doorFrom", context.doorsFrom);
  appendNumber(params, "doorTo", context.doorsTo);
  appendNumber(params, "seatsFrom", context.seatsFrom);
  appendNumber(params, "seatsTo", context.seatsTo);

  appendMappedValues(params, "type", context.bodyTypes, BODY_TYPE_IDS);
  appendMappedValues(params, "fuel_id", context.fuelTypes, FUEL_TYPE_IDS);
  appendMappedValues(params, "gearbox", context.gearboxes, GEARBOX_IDS);
  appendGeoValues(params, context);

  if (context.customsCleared === true) params.set("custom", "1");
  if (context.publishedAfter) {
    const publishedAfter = context.publishedAfter.toISOString();
    params.set("published_after", publishedAfter);
    params.set("created_after", publishedAfter);
  }

  return `${API_BASE}/search?${params.toString()}`;
}

async function loadAutoRiaInfo(id: string, apiKey: string): Promise<FetchJsonResult<RiaInfoResponse>> {
  const cacheKey = `auto-ria:info:${id}`;
  const cached = await getCachedInfo(cacheKey);
  if (cached) return { ok: true, data: cached, requestMade: false };

  const quota = await consumeAutoRiaQuota("info");
  if (!quota.allowed) {
    return {
      ok: false,
      quotaDeferredSeconds: quota.retryAfterSeconds ?? 15 * 60,
      requestMade: false,
      message: `AUTO.RIA: локальный планировщик отложил информационные запросы (${quota.reason ?? "лимит"})`,
    };
  }

  const info = await fetchJson<RiaInfoResponse>(`${API_BASE}/info?api_key=${encodeURIComponent(apiKey)}&auto_id=${encodeURIComponent(id)}`);
  if (info.ok) await setCachedInfo(cacheKey, info.data);
  return info;
}

async function fetchJson<T>(url: string): Promise<FetchJsonResult<T>> {
  const response = await sourceHttpClient.json<T>(url, { source: "AUTO_RIA" });

  if (response.classification === "SUCCESS" && response.data != null) return { ok: true, data: response.data, requestMade: true };
  if (response.classification === "RATE_LIMITED") {
    return { ok: false, rateLimited: true, requestMade: true, status: response.status, message: "AUTO.RIA сообщил об ограничении частоты запросов" };
  }
  if (response.classification === "CHALLENGE") {
    return { ok: false, captchaDetected: true, requestMade: true, status: response.status, message: `AUTO.RIA вернул защитную страницу (${response.detector ?? "неизвестно"})` };
  }
  if (response.classification === "ACCESS_DENIED") {
    return { ok: false, rateLimited: true, requestMade: true, status: response.status, message: "AUTO.RIA вернул ограничение доступа HTTP 403" };
  }

  return {
    ok: false,
    requestMade: true,
    status: response.status,
    message: response.errorMessage ?? `AUTO.RIA ${response.classification}${response.status ? ` HTTP ${response.status}` : ""}`,
  };
}

function normalizeAutoRiaInfo(id: string, info: RiaInfoResponse, now: Date): NormalizedListing | undefined {
  const inferredAttributes = inferVehicleAttributes(
    [info.title, info.markName, info.modelName, info.autoData?.description].filter(Boolean).join(" "),
  );
  const link = info.linkToView
    ? absoluteAutoRiaUrl(info.linkToView)
    : `https://auto.ria.com/auto___${encodeURIComponent(id)}.html`;
  const publishedAt = parseDate(info.addDate);
  const refreshedAt = parseDate(info.updateDate);
  const priceUsd = numberOrUndefined(info.USD);
  const priceUah = numberOrUndefined(info.UAH ?? info.price);
  const vin = typeof info.vin === "string" && info.vin.trim() ? info.vin.trim() : typeof info.VIN === "string" ? info.VIN.trim() : undefined;
  const plate = typeof info.stateNumber === "string" && info.stateNumber.trim() ? normalizePlate(info.stateNumber) : undefined;

  return {
    source: "AUTO_RIA",
    externalId: id,
    url: link,
    canonicalUrl: canonicalizeUrl(link),
    title: info.title ?? [info.markName, info.modelName, info.autoData?.year].filter(Boolean).join(" "),
    brand: info.markName,
    model: info.modelName,
    bodyType: findAttributeValue(info.bodyName, BODY_TYPE_OPTIONS) ?? inferredAttributes.bodyType,
    fuelType: findAttributeValue(info.fuelName, FUEL_TYPE_OPTIONS) ?? inferredAttributes.fuelType,
    gearbox: findAttributeValue(info.gearboxName, GEARBOX_OPTIONS) ?? inferredAttributes.gearbox,
    driveType: findAttributeValue(info.driveName, DRIVE_TYPE_OPTIONS) ?? inferredAttributes.driveType,
    year: info.autoData?.year,
    priceOriginal: priceUsd ?? priceUah,
    currencyOriginal: priceUsd != null ? "USD" : priceUah != null ? "UAH" : undefined,
    priceNormalized: priceUsd,
    mileage: info.autoData?.raceInt ? info.autoData.raceInt * 1000 : undefined,
    city: info.locationCityName,
    region: info.stateData?.regionName,
    description: info.autoData?.description,
    photoUrls: info.photoData?.seoLinkF ? [absoluteAutoRiaUrl(info.photoData.seoLinkF)] : [],
    publishedAt,
    refreshedAt,
    timestampConfidence: publishedAt ? "HIGH" : "UNKNOWN",
    skipReason: publishedAt ? undefined : info.addDate ? "INVALID_PUBLICATION_DATE" : "UNKNOWN_PUBLICATION_DATE",
    vin,
    plateNormalized: plate,
    firstSeenAt: now,
    raw: sanitizeAutoRiaInfo(id, info),
  };
}

function extractIds(response: RiaSearchResponse): string[] {
  const raw = response.result?.search_result?.ids ?? response.result?.ids ?? response.ids ?? [];
  return raw.map((id) => String(id)).filter(Boolean);
}

function sanitizeAutoRiaInfo(id: string, info: RiaInfoResponse): Record<string, unknown> {
  return {
    provider: "AUTO_RIA",
    autoId: id,
    addDate: info.addDate,
    updateDate: info.updateDate,
    markName: info.markName,
    modelName: info.modelName,
    title: info.title,
    year: info.autoData?.year,
    raceInt: info.autoData?.raceInt,
    bodyName: info.bodyName,
    fuelName: info.fuelName,
    gearboxName: info.gearboxName,
    driveName: info.driveName,
    locationCityName: info.locationCityName,
    regionName: info.stateData?.regionName,
    hasVin: Boolean(info.vin || info.VIN),
    hasStateNumber: Boolean(info.stateNumber),
  };
}

async function getCachedInfo(cacheKey: string): Promise<RiaInfoResponse | null> {
  try {
    const cached = await redisConnection.get(cacheKey);
    return cached ? (JSON.parse(cached) as RiaInfoResponse) : null;
  } catch {
    return null;
  }
}

async function setCachedInfo(cacheKey: string, info: RiaInfoResponse): Promise<void> {
  try {
    await redisConnection.set(cacheKey, JSON.stringify(info), "EX", INFO_CACHE_TTL_SECONDS);
  } catch {
    // Cache is a performance optimization only; collector correctness does not depend on it.
  }
}

function appendNumber(params: URLSearchParams, key: string, value: number | undefined): void {
  if (typeof value === "number" && Number.isFinite(value)) params.set(key, String(value));
}

function appendMappedValues(params: URLSearchParams, key: string, values: string[], map: Record<string, number>): void {
  let index = 0;
  for (const value of values) {
    const id = map[value.toLowerCase()];
    if (id == null) continue;
    params.set(`${key}[${index}]`, String(id));
    index++;
  }
}

function appendGeoValues(params: URLSearchParams, context: SourceSearchContext): void {
  const geo = autoRiaGeoParamsForSelection(context.regions, context.cities).slice(0, 25);
  geo.forEach((item, index) => {
    params.set(`state[${index}]`, String(item.stateId));
    params.set(`city[${index}]`, String(item.cityIdValue));
  });
}

function absoluteAutoRiaUrl(value: string): string {
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `https://auto.ria.com${value}`;
  return `https://auto.ria.com/${value}`;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function numberOrUndefined(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
