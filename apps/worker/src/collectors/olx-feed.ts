import type { ListingObservationChannel } from "@amb/shared";
import { env } from "../env.js";
import {
  olxRequestCoordinator,
  type OlxRequestClass,
} from "../modules/olx-request-coordinator.js";
import type { SourceSearchContext } from "./base.js";
import {
  type BlockedHtmlResult,
  fetchHtml,
  isBlockedHtml,
  withPageNumber,
} from "./html-utils.js";
import {
  olxLocationScopes,
  type OlxLocationScope,
} from "./olx-geo.js";
import {
  extractPrerenderedState,
  normalizeOlxApiAd,
  type OlxAd,
  type OlxApiResponse,
} from "./olx-normalization.js";
import { sourceHttpClient } from "./source-http-client.js";

type OlxFeedMetadata = {
  primary: boolean;
  url: string;
  requestCount: number;
  channel: ListingObservationChannel;
  observationTarget: string;
  requestStartedAt?: Date;
  firstByteAt?: Date;
  coordinatorWaitMs?: number;
  coordinatorPostFinishQuietMs?: number;
};

export type OlxFeedResult = (
  | { ads: OlxAd[] }
  | { blocked: BlockedHtmlResult }
  | { error: Error }
) & OlxFeedMetadata;

const OLX_CATEGORY_ID = 108;
const OLX_FEED_REFERER = "https://www.olx.ua/uk/transport/legkovye-avtomobili/";

export function olxApiPageSize(): number {
  const configured = Math.trunc(env.OLX_API_PAGE_SIZE);
  if (!Number.isFinite(configured) || configured <= 0) return 50;
  return Math.max(10, Math.min(50, configured));
}

export type OlxFeedTargetOptions = {
  pageSize: number;
  includePrivateFeed: boolean;
};

export function olxApiFeedUrls(
  context: SourceSearchContext,
  page = 1,
  options?: Partial<OlxFeedTargetOptions>,
): string[] {
  return buildOlxFeedTargets(context, page, olxLocationScopes(context), {
    pageSize: options?.pageSize ?? olxApiPageSize(),
    includePrivateFeed: options?.includePrivateFeed ?? env.OLX_PRIVATE_FEED_ENABLED,
  }).map((target) => target.apiUrl);
}

export async function fetchOlxDetailAd(
  url: string,
  requestClass: OlxRequestClass,
): Promise<OlxAd | undefined> {
  const response = await fetchHtml(url, {
    source: "OLX",
    timeoutMs: env.OLX_REQUEST_TIMEOUT_MS,
    headers: { referer: OLX_FEED_REFERER },
    requestClass,
  });
  const blocked = isBlockedHtml(response.status, response.body, response.retryAfterSeconds);
  if (blocked.rateLimited || blocked.captchaDetected || response.status < 200 || response.status >= 300) {
    return undefined;
  }

  const state = extractPrerenderedState(response.body);
  const detail = state.ad?.ad;
  if (!detail) return undefined;
  return normalizeOlxApiAd({ ...detail, url: detail.url ?? url });
}

export async function fetchOlxFeed(
  apiUrl: string,
  htmlUrl: string,
  primary: boolean,
  channel: ListingObservationChannel,
  observationTarget: string,
  requestClass: OlxRequestClass,
): Promise<OlxFeedResult> {
  // The website HTML is the supported public surface and already contains
  // the newest listing state. Prefer it over OLX's undocumented internal JSON
  // endpoint. In particular, never follow an HTML protection response with a
  // second API request: that used to prolong HTTP 403 incidents.
  const htmlResult = await fetchOlxHtmlFeed(
    htmlUrl,
    primary,
    htmlChannelFor(channel),
    observationTarget,
    requestClass,
  );
  if ("ads" in htmlResult || "blocked" in htmlResult) return htmlResult;

  const apiResult = await fetchOlxApiFeed(
    apiUrl,
    primary,
    env.OLX_REQUEST_TIMEOUT_MS,
    channel,
    observationTarget,
    requestClass,
  );
  if ("error" in apiResult) {
    return {
      error: new Error(`${htmlResult.error.message}; API fallback: ${apiResult.error.message}`),
      primary,
      url: htmlUrl,
      requestCount: apiResult.requestCount + htmlResult.requestCount,
      channel: htmlChannelFor(channel),
      observationTarget,
      requestStartedAt: apiResult.requestStartedAt ?? htmlResult.requestStartedAt,
      firstByteAt: apiResult.firstByteAt ?? htmlResult.firstByteAt,
      coordinatorWaitMs: apiResult.coordinatorWaitMs ?? htmlResult.coordinatorWaitMs,
      coordinatorPostFinishQuietMs:
        apiResult.coordinatorPostFinishQuietMs ?? htmlResult.coordinatorPostFinishQuietMs,
    };
  }
  return { ...apiResult, requestCount: apiResult.requestCount + htmlResult.requestCount };
}

function htmlChannelFor(channel: ListingObservationChannel): ListingObservationChannel {
  if (channel === "OLX_PUBLIC_API") return "OLX_PUBLIC_HTML";
  if (channel === "OLX_REGIONAL_API") return "OLX_REGIONAL_HTML";
  return channel === "OLX_PRIVATE_API" ? "OLX_HTML_COVERAGE" : channel;
}

export async function fetchOlxApiFeed(
  url: string,
  primary: boolean,
  timeoutMs = env.OLX_REQUEST_TIMEOUT_MS,
  channel: ListingObservationChannel = "OLX_PUBLIC_API",
  observationTarget = olxObservationTargetFromUrl(url),
  requestClass: OlxRequestClass = "ENRICHMENT",
): Promise<OlxFeedResult> {
  const response = await sourceHttpClient.json<OlxApiResponse>(url, {
    source: "OLX",
    timeoutMs,
    headers: { referer: OLX_FEED_REFERER },
    requestClass,
  });
  const metadata: OlxFeedMetadata = {
    primary,
    url,
    requestCount: 1,
    channel,
    observationTarget,
    requestStartedAt: response.requestStartedAt,
    firstByteAt: response.firstByteAt,
    coordinatorWaitMs: response.coordinatorWaitMs,
    coordinatorPostFinishQuietMs: response.coordinatorPostFinishQuietMs,
  };

  if (response.classification === "RATE_LIMITED") {
    return {
      blocked: {
        rateLimited: true,
        detector: response.detector ?? "olx-api-rate-limit",
        limitedReason: "OLX временно ограничил частоту запросов к поисковой ленте",
        retryAfterSeconds: response.retryAfterSeconds,
        responseStatus: response.status > 0 ? response.status : undefined,
      },
      ...metadata,
    };
  }
  if (response.classification === "CHALLENGE") {
    return {
      blocked: {
        captchaDetected: true,
        detector: response.detector ?? "olx-api-access-denied",
        limitedReason: "OLX включил защитную страницу для публичной поисковой ленты",
        responseStatus: response.status > 0 ? response.status : undefined,
      },
      ...metadata,
    };
  }
  if (response.classification === "ACCESS_DENIED") {
    return {
      blocked: {
        rateLimited: true,
        detector: response.detector ?? "olx-api-access-denied",
        limitedReason: response.status === 403
          ? "OLX вернул HTTP 403 без CAPTCHA; выполняется безопасная пауза без повторного спама"
          : "OLX временно отклонил запрос без CAPTCHA; выполняется безопасная пауза без повторного спама",
        responseStatus: response.status > 0 ? response.status : undefined,
      },
      ...metadata,
    };
  }
  if (response.classification !== "SUCCESS" || !response.data) {
    return {
      error: new Error(
        response.errorMessage ?? `OLX API returned ${response.classification} (HTTP ${response.status})`,
      ),
      ...metadata,
    };
  }

  return {
    ads: (response.data.data ?? []).map(normalizeOlxApiAd),
    ...metadata,
  };
}

export async function fetchOlxHtmlFeed(
  url: string,
  primary: boolean,
  channel: ListingObservationChannel = "OLX_HTML_COVERAGE",
  observationTarget = olxObservationTargetFromUrl(url),
  requestClass: OlxRequestClass = "COVERAGE",
): Promise<OlxFeedResult> {
  try {
    const response = await fetchHtml(url, {
      source: "OLX",
      timeoutMs: env.OLX_REQUEST_TIMEOUT_MS,
      headers: { referer: OLX_FEED_REFERER },
      requestClass,
    });
    const metadata: OlxFeedMetadata = {
      primary,
      url,
      requestCount: 1,
      channel,
      observationTarget,
      requestStartedAt: response.requestStartedAt,
      firstByteAt: response.firstByteAt,
      coordinatorWaitMs: response.coordinatorWaitMs,
      coordinatorPostFinishQuietMs: response.coordinatorPostFinishQuietMs,
    };
    const blocked = isBlockedHtml(response.status, response.body, response.retryAfterSeconds);
    if (blocked.rateLimited || blocked.captchaDetected) return { blocked, ...metadata };
    if (response.status < 200 || response.status >= 300) {
      return { error: new Error(`HTTP ${response.status}`), ...metadata };
    }

    const ads = new Map<string, OlxAd>();
    let structuredStateError: Error | undefined;
    try {
      const prerenderedState = extractPrerenderedState(response.body);
      for (const ad of prerenderedState.listing?.listing?.ads ?? []) ads.set(String(ad.id), ad);
    } catch (error) {
      structuredStateError = error instanceof Error ? error : new Error(String(error));
    }
    for (const card of extractRenderedOlxCards(response.body)) {
      if (!ads.has(String(card.id))) ads.set(String(card.id), card);
    }
    if (ads.size === 0 && structuredStateError) {
      return { error: structuredStateError, ...metadata };
    }
    return { ads: [...ads.values()], ...metadata };
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      primary,
      url,
      requestCount: 1,
      channel,
      observationTarget,
    };
  }
}

export async function hydrateHtmlCardOnlyAds(
  results: OlxFeedResult[],
  knownExternalIds: ReadonlySet<string>,
  deadlineAt: Date,
): Promise<{ requestCount: number; failedCount: number }> {
  const candidates = new Map<string, OlxAd>();
  for (const result of results) {
    if (!isAdsResult(result)) continue;
    for (const ad of result.ads) {
      const id = String(ad.id);
      if (ad.htmlCardOnly && !knownExternalIds.has(id)) candidates.set(id, ad);
    }
  }

  const limit = Math.max(0, Math.min(20, env.OLX_HTML_DETAIL_MAX_PER_SCAN));
  const selected = [...candidates.values()].slice(0, limit);
  const hydrated = new Map<string, OlxAd>();
  let requestCount = 0;
  for (let index = 0; index < selected.length && Date.now() < deadlineAt.getTime() - 1_000; index += 2) {
    const batch = selected.slice(index, index + 2);
    const details = await Promise.all(batch.map(async (card) => {
      requestCount += 1;
      try {
        return await fetchOlxDetailAd(card.url ?? "", "COVERAGE");
      } catch {
        return undefined;
      }
    }));
    details.forEach((detail) => {
      if (detail) hydrated.set(String(detail.id), detail);
    });
    if (index + 2 < selected.length) await delay(250 + Math.floor(Math.random() * 150));
  }

  for (const result of results) {
    if (!isAdsResult(result)) continue;
    result.ads = result.ads.flatMap((ad) => {
      if (!ad.htmlCardOnly || knownExternalIds.has(String(ad.id))) return [ad];
      const detail = hydrated.get(String(ad.id));
      return detail ? [detail] : [];
    });
  }

  return { requestCount, failedCount: Math.max(0, candidates.size - hydrated.size) };
}

export function extractRenderedOlxCards(html: string, now = new Date()): OlxAd[] {
  const starts = [...html.matchAll(/<div\b[^>]*\bdata-cy="l-card"[^>]*>/gu)];
  const cards: OlxAd[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const openingTag = starts[index]?.[0] ?? "";
    const id = openingTag.match(/\bid="(\d+)"/u)?.[1];
    if (!id) continue;
    const start = starts[index]?.index ?? 0;
    const end = starts[index + 1]?.index ?? html.length;
    const block = html.slice(start, end);
    const href = block.match(/\bhref="([^"]*\/d\/[^"]+)"/u)?.[1];
    if (!href) continue;
    const titleHtml = block.match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/u)?.[1]
      ?? block.match(/\balt="([^"]+)"/u)?.[1];
    const priceText = testIdText(block, "ad-price");
    const locationDateText = testIdText(block, "location-date");
    const summaryText = decodeHtmlText(block.replace(/<[^>]+>/gu, " ")).replace(/\s+/gu, " ").trim();
    const price = parseRenderedCardPrice(priceText);
    const locationAndDate = parseRenderedCardLocationDate(locationDateText, now);
    const vehicleSummaryText = locationDateText
      ? summaryText.replace(locationDateText, " ")
      : summaryText;
    const year = vehicleSummaryText.match(/(?:^|\s)((?:19|20)\d{2})(?=\s|$)/u)?.[1];
    const mileage = vehicleSummaryText.match(/(\d+(?:[.,]\d+)?)\s*тис\.?\s*км/iu)?.[1]?.replace(",", ".");
    const engineVolume = vehicleSummaryText.match(/(\d+(?:[.,]\d+)?)\s*л\.?/iu)?.[1]?.replace(",", ".");
    const photo = block.match(/<img\b[^>]*\bsrc="([^"]+)"/u)?.[1];
    const params: NonNullable<OlxAd["params"]> = [{ key: "card_summary", value: summaryText }];
    if (year) params.push({ key: "motor_year", value: year });
    if (mileage) params.push({ key: "motor_mileage_thou", value: mileage });
    if (engineVolume) params.push({ key: "engine_size", value: engineVolume });
    try {
      cards.push({
        id,
        url: new URL(decodeHtmlText(href), "https://www.olx.ua").toString(),
        title: titleHtml
          ? decodeHtmlText(titleHtml.replace(/<[^>]+>/gu, " ")).replace(/\s+/gu, " ").trim()
          : undefined,
        createdTime: locationAndDate.createdTime,
        price,
        location: locationAndDate.city ? { cityName: locationAndDate.city } : undefined,
        photos: photo ? [decodeHtmlText(photo)] : [],
        params,
        htmlCardOnly: true,
      });
    } catch {
      // Ignore malformed rendered cards; the structured feed remains primary.
    }
  }
  return cards;
}

function testIdText(block: string, testId: string): string | undefined {
  const escaped = testId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = block.match(new RegExp(`<[^>]+data-testid="${escaped}"[^>]*>([\\s\\S]*?)<\\/[^>]+>`, "u"));
  return match?.[1]
    ? decodeHtmlText(match[1].replace(/<[^>]+>/gu, " ")).replace(/\s+/gu, " ").trim()
    : undefined;
}

function parseRenderedCardPrice(text: string | undefined): OlxAd["price"] | undefined {
  if (!text) return undefined;
  const valueText = text.match(/\d[\d\s.,]*/u)?.[0]?.replace(/\s/gu, "").replace(",", ".");
  const value = valueText ? Number.parseFloat(valueText) : Number.NaN;
  if (!Number.isFinite(value)) return undefined;
  const currencyCode = /(?:грн|uah)/iu.test(text) ? "UAH"
    : /(?:usd|\$)/iu.test(text) ? "USD"
      : /(?:eur|€)/iu.test(text) ? "EUR"
        : undefined;
  return { regularPrice: { value, currencyCode } };
}

function parseRenderedCardLocationDate(
  text: string | undefined,
  now: Date,
): { city?: string; createdTime?: string } {
  if (!text) return {};
  const separator = text.lastIndexOf(" - ");
  const location = separator >= 0 ? text.slice(0, separator).trim() : text.trim();
  const dateText = separator >= 0 ? text.slice(separator + 3).trim() : "";
  return {
    city: location.split(",")[0]?.trim() || undefined,
    createdTime: parseRenderedCardDate(dateText, now)?.toISOString(),
  };
}

export function parseRenderedCardDate(value: string, now = new Date()): Date | undefined {
  const normalized = value.toLowerCase().replace(/\s+/gu, " ").trim();
  const time = normalized.match(/(?:о|в)\s*(\d{1,2}):(\d{2})/u);
  if (/^(?:сьогодні|сегодня)(?:\s|$)/u.test(normalized) && time) {
    const parts = kyivCalendarParts(now);
    return kyivLocalDate(parts.year, parts.month, parts.day, Number(time[1]), Number(time[2]));
  }
  if (/^(?:вчора|вчера)(?:\s|$)/u.test(normalized) && time) {
    const parts = kyivCalendarParts(new Date(now.getTime() - 24 * 60 * 60 * 1_000));
    return kyivLocalDate(parts.year, parts.month, parts.day, Number(time[1]), Number(time[2]));
  }

  const absolute = normalized.match(/^(\d{1,2})\s+([\p{L}ёіїєґ]+)\s+(\d{4})/u);
  if (!absolute) return undefined;
  const month = OLX_MONTHS[absolute[2] ?? ""];
  if (!month) return undefined;
  return kyivLocalDate(Number(absolute[3]), month, Number(absolute[1]), 12, 0);
}

const OLX_MONTHS: Record<string, number> = {
  січня: 1, января: 1,
  лютого: 2, февраля: 2,
  березня: 3, марта: 3,
  квітня: 4, апреля: 4,
  травня: 5, мая: 5,
  червня: 6, июня: 6,
  липня: 7, июля: 7,
  серпня: 8, августа: 8,
  вересня: 9, сентября: 9,
  жовтня: 10, октября: 10,
  листопада: 11, ноября: 11,
  грудня: 12, декабря: 12,
};

function kyivCalendarParts(value: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

function kyivLocalDate(year: number, month: number, day: number, hour: number, minute: number): Date | undefined {
  const middayUtc = new Date(Date.UTC(year, month - 1, day, 12));
  const zoneName = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Kyiv",
    timeZoneName: "longOffset",
  }).formatToParts(middayUtc).find((part) => part.type === "timeZoneName")?.value;
  const offsetParts = zoneName?.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/u);
  if (!offsetParts) return undefined;
  const offset = `${offsetParts[1]}${String(offsetParts[2]).padStart(2, "0")}:${offsetParts[3] ?? "00"}`;
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${offset}`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function olxFeedTargets(
  context: SourceSearchContext,
  page: number,
  scopes: OlxLocationScope[] = olxLocationScopes(context),
): Array<{ apiUrl: string; htmlUrl: string; privateOnly: boolean; observationTarget: string }> {
  return buildOlxFeedTargets(context, page, scopes, {
    pageSize: olxApiPageSize(),
    includePrivateFeed: env.OLX_PRIVATE_FEED_ENABLED,
  });
}

export function buildOlxFeedTargets(
  context: SourceSearchContext,
  page: number,
  scopes: OlxLocationScope[],
  options: OlxFeedTargetOptions,
): Array<{ apiUrl: string; htmlUrl: string; privateOnly: boolean; observationTarget: string }> {
  const query = olxSearchQuery(context);
  const pageSize = Math.max(1, Math.min(50, Math.trunc(options.pageSize) || 50));
  const variants = options.includePrivateFeed ? [false, true] : [false];
  return scopes.flatMap((scope) =>
    variants.map((privateOnly) => {
      const api = new URL("https://www.olx.ua/api/v1/offers");
      api.searchParams.set("offset", String(Math.max(0, page - 1) * pageSize));
      api.searchParams.set("limit", String(pageSize));
      api.searchParams.set("category_id", String(OLX_CATEGORY_ID));
      if (scope.regionId) api.searchParams.set("region_id", String(scope.regionId));
      if (scope.cityId) api.searchParams.set("city_id", String(scope.cityId));
      if (privateOnly) api.searchParams.set("owner_type", "private");
      if (query) api.searchParams.set("query", query);
      api.searchParams.set("sort_by", "created_at:desc");

      const path = scope.htmlPath ? `${scope.htmlPath}/` : "";
      const html = new URL(`https://www.olx.ua/uk/transport/legkovye-avtomobili/${path}`);
      html.searchParams.set("search[order]", "created_at:desc");
      if (privateOnly) html.searchParams.set("search[private_business]", "private");
      if (query) html.searchParams.set("search[q]", query);
      const htmlUrl = withPageNumber(html.toString(), page);
      return {
        apiUrl: api.toString(),
        htmlUrl,
        privateOnly,
        observationTarget: olxObservationTarget(scope, page, privateOnly),
      };
    }),
  );
}

export function coordinatorCoverageMetrics(): Record<string, string | number | boolean | null> {
  const snapshot = olxRequestCoordinator.snapshot();
  return {
    coordinatorRealtimeRequests: snapshot.started.REALTIME,
    coordinatorCoverageRequests: snapshot.started.COVERAGE,
    coordinatorBackfillRequests: snapshot.started.BACKFILL,
    coordinatorRecoveryRequests: snapshot.started.RECOVERY,
    coordinatorEnrichmentRequests: snapshot.started.ENRICHMENT,
    coordinatorRateLimitedResponses: snapshot.rateLimited,
    coordinatorChallengeResponses: snapshot.challenges,
    coordinatorAccessDeniedResponses: snapshot.accessDenied,
    coordinatorActiveRealtime: snapshot.activeRealtime,
    coordinatorActiveBackground: snapshot.activeBackground,
    coordinatorQueuedBackground: snapshot.queuedBackground,
    coordinatorRealtimePreemptions: snapshot.realtimePreemptions,
    coordinatorRealtimeTotalWaitMs: snapshot.totalWaitMs.REALTIME,
    coordinatorRealtimeLastWaitMs: snapshot.lastWaitMs.REALTIME,
    coordinatorRealtimeMaxWaitMs: snapshot.maxWaitMs.REALTIME,
    coordinatorRealtimeAverageWaitMs: snapshot.started.REALTIME > 0
      ? Math.round(snapshot.totalWaitMs.REALTIME / snapshot.started.REALTIME)
      : 0,
    coordinatorQuietCanaryMode: snapshot.realtimeQuietCanary.mode,
    coordinatorQuietCanaryBaselineMs: snapshot.realtimeQuietCanary.baselineQuietMs,
    coordinatorQuietCanaryCandidateMs: snapshot.realtimeQuietCanary.candidateQuietMs,
    coordinatorQuietCanaryQualifyingSamples: snapshot.realtimeQuietCanary.qualifyingSamples,
    coordinatorQuietCanarySamples: snapshot.realtimeQuietCanary.canarySamples,
    coordinatorQuietCanaryBaselineP95Ms: snapshot.realtimeQuietCanary.baselineP95Ms,
    coordinatorQuietCanaryP95Ms: snapshot.realtimeQuietCanary.canaryP95Ms,
    coordinatorQuietCanaryRollbackReason: snapshot.realtimeQuietCanary.rollbackReason,
  };
}

export function isAdsResult(
  result: OlxFeedResult,
): result is Extract<OlxFeedResult, { ads: OlxAd[] }> {
  return "ads" in result;
}

export function isBlockedResult(
  result: OlxFeedResult,
): result is Extract<OlxFeedResult, { blocked: BlockedHtmlResult }> {
  return "blocked" in result;
}

export function isPrimaryBlockedResult(
  result: OlxFeedResult,
): result is Extract<OlxFeedResult, { blocked: BlockedHtmlResult }> {
  return result.primary && isBlockedResult(result);
}

export function isErrorResult(
  result: OlxFeedResult,
): result is Extract<OlxFeedResult, { error: Error }> {
  return "error" in result;
}

function olxObservationTarget(scope: OlxLocationScope, page: number, privateOnly: boolean): string {
  return [
    `region:${scope.regionId ?? "all"}`,
    `city:${scope.cityId ?? "all"}`,
    `page:${Math.max(1, page)}`,
    `owner:${privateOnly ? "private" : "all"}`,
  ].join(";");
}

function olxObservationTargetFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const limit = Math.max(1, Number(url.searchParams.get("limit")) || olxApiPageSize());
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    return [
      `region:${url.searchParams.get("region_id") ?? "all"}`,
      `city:${url.searchParams.get("city_id") ?? "all"}`,
      `page:${Math.floor(offset / limit) + 1}`,
      `owner:${url.searchParams.has("owner_type") || url.searchParams.has("search[private_business]") ? "private" : "all"}`,
    ].join(";");
  } catch {
    return "region:unknown;city:unknown;page:unknown;owner:unknown";
  }
}

function olxSearchQuery(context: SourceSearchContext): string | undefined {
  const terms = [context.brand, ...context.models]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return [...new Set(terms)].join(" ").trim() || undefined;
}

function decodeHtmlText(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, token: string) => {
    if (token.startsWith("#x")) return String.fromCodePoint(Number.parseInt(token.slice(2), 16));
    if (token.startsWith("#")) return String.fromCodePoint(Number.parseInt(token.slice(1), 10));
    return named[token.toLowerCase()] ?? entity;
  });
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
