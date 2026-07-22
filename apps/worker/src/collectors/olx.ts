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
  normalizeVehicleText,
  sortListingsNewestFirst,
  type ListingObservationChannel,
  type NormalizedListing,
} from "@amb/shared";
import { env } from "../env.js";
import {
  collectorScanOptions,
  scanDeadlineReached,
  type CollectorResult,
  type CollectorScanOptions,
  type SourceCollector,
  type SourceSearchContext,
  type SourceSearchState,
} from "./base.js";
import {
  type BlockedHtmlResult,
  fetchHtml,
  inferBargainPossible,
  inferCustomsCleared,
  isBlockedHtml,
  parseEnginePower,
  parseEngineVolume,
  withPageNumber,
} from "./html-utils.js";
import { sourceHttpClient } from "./source-http-client.js";
import {
  olxLocationScopes,
  regionalCoverageScopes,
  resolveOlxLocationScopes,
  uniqueLocationScopes,
  type OlxLocationScope,
} from "./olx-geo.js";
import { currentUsdExchangeRate } from "../modules/exchange-rate.js";
import { olxCoverageSchedule } from "./olx-coverage.js";

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

type OlxApiAd = {
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

type OlxApiResponse = {
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

type OlxFeedMetadata = {
  primary: boolean;
  url: string;
  requestCount: number;
  channel: ListingObservationChannel;
  observationTarget: string;
};

type OlxFeedResult = (
  | { ads: OlxAd[] }
  | { blocked: BlockedHtmlResult }
  | { error: Error }
) & OlxFeedMetadata;

const OLX_CATEGORY_ID = 108;
const OLX_FEED_REFERER = "https://www.olx.ua/uk/transport/legkovye-avtomobili/";

export class OlxCollector implements SourceCollector {
  readonly source = "OLX" as const;
  readonly supportsNewestFirst = true;
  readonly newestFirstVerified = true;

  async collect(
    context: SourceSearchContext,
    state: SourceSearchState,
    input?: CollectorScanOptions,
  ): Promise<CollectorResult> {
    const scan = collectorScanOptions(input);
    const listings: NormalizedListing[] = [];
    const seenExternalIds = new Set<string>();
    const now = new Date();
    const semanticWarnings: string[] = [];
    const resolvedLocations = await resolveOlxLocationScopes(context);
    semanticWarnings.push(...resolvedLocations.warnings);
    const isBackfill = scan.lane === "BACKFILL";
    const coverageSchedule = olxCoverageSchedule({
      now,
      state,
      isBackfill,
      hasRegionalFilters: context.regions.length > 0,
      regionalIntervalSeconds: env.OLX_COVERAGE_INTERVAL_SECONDS,
      htmlIntervalSeconds: env.OLX_HTML_COVERAGE_INTERVAL_SECONDS,
      privateIntervalSeconds: env.OLX_PRIVATE_COVERAGE_INTERVAL_SECONDS,
    });
    const coverageDue = coverageSchedule.regionalDue;
    const htmlCoverageDue = coverageSchedule.htmlDue;
    const privateCoverageDue = coverageSchedule.privateDue && !env.OLX_PRIVATE_FEED_ENABLED;
    let lastRegionalCoverageAt: Date | undefined;
    let lastHtmlCoverageAt: Date | undefined;
    let htmlCoveragePausedUntil: Date | null | undefined;
    let lastPrivateCoverageAt: Date | undefined;
    const fastObservedIds = new Set<string>();
    const htmlObservedIds = new Set<string>();
    const privateObservedIds = new Set<string>();
    let fastFeedRequests = 0;
    let htmlFeedRequests = 0;
    let privateFeedRequests = 0;
    const activeScopes = isBackfill || coverageDue
      ? uniqueLocationScopes([...resolvedLocations.scopes, ...regionalCoverageScopes(context)])
      : resolvedLocations.scopes;
    const maxCandidates = Math.max(1, Math.min(scan.maxCandidates, scan.lane === "REALTIME" ? env.OLX_MAX_NEW_PER_RUN : scan.maxCandidates));
    // The public API rejects offsets above OLX_API_MAX_OFFSET, so deeper pages
    // would only burn requests on 400 responses and HTML fallbacks.
    const maxOffsetPages = Math.max(1, Math.floor(Math.max(0, env.OLX_API_MAX_OFFSET) / olxApiPageSize()) + 1);
    const maxPages = Math.min(
      maxOffsetPages,
      isBackfill
        ? Math.max(1, scan.maxPages, env.OLX_BACKFILL_MAX_PAGES)
        : Math.max(1, scan.maxPages, env.OLX_REALTIME_MAX_PAGES),
    );
    let pageCount = 0;
    let requestCount = 0;
    let observedCount = 0;
    const scannedExternalIds = new Set<string>();
    let cutoffReached = false;
    let degradedReason: string | undefined;
    // A fast scan is "anchored" once it overlaps listings from the previous
    // scan (or the freshness cutoff): that proves nothing was skipped between
    // the two scans, so pagination can stop.
    let anchored = false;

    for (let page = 1; page <= maxPages; page += 1) {
      if (scanDeadlineReached(scan)) {
        degradedReason = `OLX scan deadline reached after ${pageCount} page(s)`;
        semanticWarnings.push(degradedReason);
        break;
      }

      const feedTargets = olxFeedTargets(context, page, activeScopes);
      const directTargetKeys = new Set(
        olxFeedTargets(context, page, resolvedLocations.scopes).map((target) => target.observationTarget),
      );
      const feedResults: OlxFeedResult[] = await Promise.all(
        feedTargets.map((target, index) => fetchOlxFeed(
          target.apiUrl,
          target.htmlUrl,
          index === 0,
          target.privateOnly
            ? "OLX_PRIVATE_API"
            : directTargetKeys.has(target.observationTarget) ? "OLX_PUBLIC_API" : "OLX_REGIONAL_API",
          target.observationTarget,
        )),
      );
      fastFeedRequests += feedTargets.length;
      for (const result of feedResults) {
        if (isAdsResult(result)) for (const ad of result.ads) fastObservedIds.add(String(ad.id));
      }
      requestCount += feedResults.reduce((total, result) => total + result.requestCount, 0);
      const primaryBlocked = feedResults.find(isPrimaryBlockedResult);
      if (primaryBlocked) {
        return {
          listings,
          ...primaryBlocked.blocked,
          affectedUrl: primaryBlocked.url,
          pageCount,
          requestCount,
          observedCount,
          semanticWarnings,
        };
      }

      // The HTML search and the public JSON feed are not perfectly identical:
      // OLX can expose a few cards in one index before the other. Once a minute,
      // merge the exact-city HTML feeds. This closes that blind spot without
      // adding browser automation or increasing the high-frequency request rate.
      if (page === 1 && htmlCoverageDue) {
        lastHtmlCoverageAt = now;
        const htmlTargets = olxFeedTargets(context, 1, resolvedLocations.scopes);
        const htmlResults = await Promise.all(
          htmlTargets.map((target) => fetchOlxHtmlFeed(
            target.htmlUrl,
            false,
            "OLX_HTML_COVERAGE",
            target.observationTarget,
          )),
        );
        requestCount += htmlResults.reduce((total, result) => total + result.requestCount, 0);
        htmlFeedRequests += htmlTargets.length;
        for (const result of htmlResults) {
          if (isAdsResult(result)) for (const ad of result.ads) htmlObservedIds.add(String(ad.id));
        }
        const htmlBlocked = htmlResults.find(isBlockedResult);
        if (htmlBlocked) {
          const pauseSeconds = htmlBlocked.blocked.captchaDetected
            ? Math.max(60, env.CAPTCHA_PAUSE_SECONDS)
            : Math.max(30, env.RATE_LIMIT_PAUSE_BASE_SECONDS);
          htmlCoveragePausedUntil = new Date(now.getTime() + pauseSeconds * 1000);
          semanticWarnings.push(
            `OLX HTML-сверка приостановлена на ${pauseSeconds} с; основной быстрый API-канал продолжает работу`,
          );
        } else {
          htmlCoveragePausedUntil = null;
        }
        const hydration = await hydrateHtmlCardOnlyAds(htmlResults, state, scan.deadlineAt);
        requestCount += hydration.requestCount;
        if (hydration.failedCount > 0) {
          semanticWarnings.push(
            `OLX HTML-сверка: ${hydration.failedCount} карточка(и) не успели пройти безопасную детальную проверку`,
          );
        }
        feedResults.push(...htmlResults.filter((result) => !isBlockedResult(result)));
      }

      // The owner-filtered feed is a low-frequency shadow lane. It is not part
      // of the four-second hot path, but catches temporary index differences
      // without doubling every realtime scan or provoking protection pages.
      if (page === 1 && privateCoverageDue) {
        lastPrivateCoverageAt = now;
        const privateTargets = buildOlxFeedTargets(context, 1, resolvedLocations.scopes, {
          pageSize: olxApiPageSize(),
          includePrivateFeed: true,
        }).filter((target) => target.privateOnly);
        const privateResults = await Promise.all(
          privateTargets.map((target) => fetchOlxApiFeed(
            target.apiUrl,
            false,
            env.OLX_REQUEST_TIMEOUT_MS,
            "OLX_PRIVATE_API",
            target.observationTarget,
          )),
        );
        privateFeedRequests += privateTargets.length;
        requestCount += privateResults.reduce((total, result) => total + result.requestCount, 0);
        for (const result of privateResults) {
          if (isAdsResult(result)) for (const ad of result.ads) privateObservedIds.add(String(ad.id));
        }
        feedResults.push(...privateResults);
      }

      const successfulFeeds = feedResults.filter(isAdsResult);
      if (successfulFeeds.length === 0) {
        const blocked = feedResults.find(isBlockedResult);
        if (blocked) {
          return {
            listings,
            ...blocked.blocked,
            affectedUrl: blocked.url,
            pageCount,
            requestCount,
            observedCount,
            semanticWarnings,
          };
        }

        const errors = feedResults
          .filter(isErrorResult)
          .map((result) => `${result.url}: ${result.error.message}`)
          .join("; ");
        throw new Error(errors ? `OLX search failed: ${errors}` : "OLX search failed: no feeds returned listings");
      }
      if (coverageDue && page === 1) lastRegionalCoverageAt = now;

      const secondaryBlockedFeeds = feedResults.filter((result) => !result.primary && isBlockedResult(result));
      if (secondaryBlockedFeeds.length > 0) {
        degradedReason = `${secondaryBlockedFeeds.length} дополнительная OLX-лента временно защищена`;
        semanticWarnings.push(degradedReason);
      }

      if (page === 1 && successfulFeeds.every((feed) => feed.ads.length < env.OLX_MIN_EXPECTED_PAGE_ITEMS)) {
        degradedReason = `OLX вернул подозрительно короткую первую страницу: ${successfulFeeds.map((feed) => feed.ads.length).join(", ")}`;
        semanticWarnings.push(degradedReason);
      }

      pageCount += 1;
      let observedOnPage = 0;
      let pageAnchored = true;
      let pageCutoff = Boolean(context.publishedAfter);
      for (const feed of successfulFeeds) {
        const selection = selectOlxCandidates(feed.ads, {
          now,
          publishedAfter: context.publishedAfter,
          knownExternalIds: state.knownExternalIds,
          seenExternalIds,
          maxCandidates: Math.max(0, maxCandidates - listings.length),
          observationChannel: feed.channel,
          observationTarget: feed.observationTarget,
        });
        listings.push(...selection.listings);
        for (const externalId of selection.scannedExternalIds) scannedExternalIds.add(externalId);
        observedCount += selection.observedCount;
        observedOnPage += selection.observedCount;
        const exhausted = feed.ads.length === 0;
        const knownTailAnchored = selection.identifiableCount > 0 &&
          (selection.allKnown || selection.knownTailStreak >= Math.max(1, env.KNOWN_LISTING_STOP_THRESHOLD));
        // OLX may mix promoted old adverts into an otherwise fresh page. A
        // single known/old item therefore proves nothing about the next page.
        // Realtime stops only after a continuous known tail (or an all-known
        // feed), and backfill stops only when every identifiable advert in all
        // successful feeds is demonstrably older than the cutoff.
        if (!(exhausted || knownTailAnchored) || selection.candidateLimitReached) pageAnchored = false;
        if (!(exhausted || selection.fullyBeforeCutoff) || selection.candidateLimitReached) pageCutoff = false;
      }

      const feedErrors = feedResults.filter(isErrorResult);
      if (feedErrors.length > 0) {
        pageAnchored = false;
        pageCutoff = false;
        degradedReason = `${feedErrors.length} OLX feed(s) failed on page ${page}`;
        semanticWarnings.push(degradedReason);
      }
      const feedsExhausted = successfulFeeds.every((feed) => feed.ads.length === 0);
      if (feedsExhausted) {
        cutoffReached = Boolean(context.publishedAfter);
        anchored = true;
        break;
      }
      if (observedOnPage === 0) {
        if (page === 1) semanticWarnings.push("OLX returned no parseable adverts on the first page");
      }
      if (listings.length >= maxCandidates) {
        anchored = pageAnchored;
        break;
      }
      if (!isBackfill && shouldStopOlxRealtimePage(pageAnchored, pageCutoff)) {
        anchored = true;
        if (pageCutoff) cutoffReached = true;
        break;
      }
      // Newest-first order means one page fully past the freshness cutoff ends
      // the useful backfill depth as well.
      if (isBackfill && pageCutoff) {
        cutoffReached = true;
        break;
      }
      if (isBackfill && page < maxPages) {
        const baseDelay = Math.max(0, env.OLX_BACKFILL_PAGE_DELAY_MS);
        await delay(baseDelay + Math.floor(Math.random() * Math.max(1, Math.round(baseDelay * 0.35))));
      }
    }

    if (!isBackfill && !anchored && state.knownExternalIds.size > 0 && observedCount > 0) {
      semanticWarnings.push(
        `OLX realtime window overflow: ${pageCount} page(s) scanned without overlapping known listings; deep backfill will recover the tail`,
      );
    }

    return {
      listings: sortListingsNewestFirst(listings),
      scannedExternalIds: [...scannedExternalIds],
      observedCount,
      pageCount,
      requestCount,
      cutoffReached,
      semanticWarnings,
      limited: Boolean(degradedReason),
      limitedReason: degradedReason,
      coverageGap: !isBackfill && !anchored && state.knownExternalIds.size > 0 && observedCount > 0,
      coverageStateUpdate: {
        lastRegionalCoverageAt,
        lastHtmlCoverageAt,
        htmlCoveragePausedUntil,
        lastPrivateCoverageAt,
      },
      coverageMetrics: {
        fingerprint: context.fingerprint,
        regionalDue: coverageSchedule.regionalDue,
        htmlDue: coverageSchedule.htmlDue,
        privateDue: privateCoverageDue,
        fastFeedRequests,
        htmlFeedRequests,
        privateFeedRequests,
        fastObserved: fastObservedIds.size,
        htmlObserved: htmlObservedIds.size,
        htmlOnlyObserved: [...htmlObservedIds].filter((id) => !fastObservedIds.has(id)).length,
        privateObserved: privateObservedIds.size,
        privateOnlyObserved: [...privateObservedIds].filter((id) => !fastObservedIds.has(id)).length,
      },
    };
  }
}

function olxApiPageSize(): number {
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

export type OlxMarketResearchQuery = {
  brand: string;
  model: string;
  year?: number;
  engineVolume?: number;
  excludeExternalId?: string;
};

export async function fetchOlxMarketComparables(query: OlxMarketResearchQuery): Promise<NormalizedListing[]> {
  const context: SourceSearchContext = {
    source: "OLX",
    fingerprint: "market-research",
    filterIds: [],
    brand: query.brand,
    models: [query.model],
    bodyTypes: [],
    fuelTypes: [],
    gearboxes: [],
    driveTypes: [],
    colors: [],
    regions: [],
    cities: [],
    keywords: [],
    excludeKeywords: [],
    freshnessMode: "ALL_TIME",
    initialWindowBehavior: "SKIP_EXISTING",
    maxInitialWindowNotifications: 0,
  };
  const results = new Map<string, NormalizedListing>();
  const maxPages = Math.max(1, Math.min(10, env.MARKET_RESEARCH_OLX_MAX_PAGES));
  const deadlineAt = Date.now() + Math.max(2_000, env.MARKET_RESEARCH_DEADLINE_MS);

  for (let page = 1; page <= maxPages && results.size < env.MARKET_RESEARCH_MAX_COMPARABLES; page += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 250) break;
    const target = olxFeedTargets(context, page, [{}])[0];
    if (!target) break;
    const feed = await fetchOlxApiFeed(target.apiUrl, true, Math.min(env.OLX_REQUEST_TIMEOUT_MS, remainingMs));
    if (!isAdsResult(feed)) {
      if (results.size === 0) {
        const reason = isBlockedResult(feed) ? feed.blocked.limitedReason : feed.error.message;
        throw new Error(`OLX market research unavailable: ${reason ?? "unknown response"}`);
      }
      break;
    }
    if (feed.ads.length === 0) break;

    for (const ad of feed.ads) {
      const listing = normalizeOlxAd(ad);
      if (!listing || listing.externalId === query.excludeExternalId || !isOlxMarketComparable(listing, query)) continue;
      results.set(listing.externalId, listing);
      if (results.size >= env.MARKET_RESEARCH_MAX_COMPARABLES) break;
    }
  }

  return [...results.values()];
}

export async function fetchOlxDetailListing(url: string, now = new Date()): Promise<NormalizedListing | undefined> {
  const detail = await fetchOlxDetailAd(url);
  return detail ? normalizeOlxAd(detail, now) : undefined;
}

async function fetchOlxDetailAd(url: string): Promise<OlxAd | undefined> {
  const response = await fetchHtml(url, {
    source: "OLX",
    timeoutMs: env.OLX_REQUEST_TIMEOUT_MS,
    headers: { referer: OLX_FEED_REFERER },
  });
  const blocked = isBlockedHtml(response.status, response.body, response.retryAfterSeconds);
  if (blocked.rateLimited || blocked.captchaDetected || response.status < 200 || response.status >= 300) return undefined;

  const state = extractPrerenderedState(response.body);
  const detail = state.ad?.ad;
  if (!detail) return undefined;
  return normalizeOlxApiAd({ ...detail, url: detail.url ?? url });
}

async function fetchOlxFeed(
  apiUrl: string,
  htmlUrl: string,
  primary: boolean,
  channel: ListingObservationChannel,
  observationTarget: string,
): Promise<OlxFeedResult> {
  const apiResult = await fetchOlxApiFeed(apiUrl, primary, env.OLX_REQUEST_TIMEOUT_MS, channel, observationTarget);
  if ("ads" in apiResult || "blocked" in apiResult) return apiResult;

  const htmlResult = await fetchOlxHtmlFeed(htmlUrl, primary, "OLX_HTML_FALLBACK", observationTarget);
  if ("error" in htmlResult) {
    return {
      error: new Error(`${apiResult.error.message}; HTML fallback: ${htmlResult.error.message}`),
      primary,
      url: apiUrl,
      requestCount: apiResult.requestCount + htmlResult.requestCount,
      channel: "OLX_HTML_FALLBACK",
      observationTarget,
    };
  }
  return { ...htmlResult, requestCount: apiResult.requestCount + htmlResult.requestCount };
}

async function fetchOlxApiFeed(
  url: string,
  primary: boolean,
  timeoutMs = env.OLX_REQUEST_TIMEOUT_MS,
  channel: ListingObservationChannel = "OLX_PUBLIC_API",
  observationTarget = olxObservationTargetFromUrl(url),
): Promise<OlxFeedResult> {
  const metadata: OlxFeedMetadata = { primary, url, requestCount: 1, channel, observationTarget };
  const response = await sourceHttpClient.json<OlxApiResponse>(url, {
    source: "OLX",
    timeoutMs,
    headers: { referer: OLX_FEED_REFERER },
  });

  if (response.classification === "RATE_LIMITED") {
    return {
      blocked: {
        rateLimited: true,
        detector: response.detector ?? "olx-api-rate-limit",
        limitedReason: "OLX временно ограничил частоту запросов к поисковой ленте",
        retryAfterSeconds: response.retryAfterSeconds,
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
      },
      ...metadata,
    };
  }
  if (response.classification === "ACCESS_DENIED") {
    return {
      blocked: {
        rateLimited: true,
        detector: response.detector ?? "olx-api-access-denied",
        limitedReason: "OLX временно отклонил запрос без CAPTCHA; используется короткая безопасная пауза",
      },
      ...metadata,
    };
  }
  if (response.classification !== "SUCCESS" || !response.data) {
    return {
      error: new Error(response.errorMessage ?? `OLX API returned ${response.classification} (HTTP ${response.status})`),
      ...metadata,
    };
  }

  return {
    ads: (response.data.data ?? []).map(normalizeOlxApiAd),
    ...metadata,
  };
}

async function fetchOlxHtmlFeed(
  url: string,
  primary: boolean,
  channel: ListingObservationChannel = "OLX_HTML_COVERAGE",
  observationTarget = olxObservationTargetFromUrl(url),
): Promise<OlxFeedResult> {
  const metadata: OlxFeedMetadata = { primary, url, requestCount: 1, channel, observationTarget };
  try {
    const response = await fetchHtml(url, {
      source: "OLX",
      timeoutMs: env.OLX_REQUEST_TIMEOUT_MS,
      headers: { referer: OLX_FEED_REFERER },
    });
    const blocked = isBlockedHtml(response.status, response.body, response.retryAfterSeconds);
    if (blocked.rateLimited || blocked.captchaDetected) return { blocked, ...metadata };
    if (response.status < 200 || response.status >= 300) {
      return { error: new Error(`HTTP ${response.status}`), ...metadata };
    }

    const prerenderedState = extractPrerenderedState(response.body);
    const ads = new Map<string, OlxAd>();
    for (const ad of prerenderedState.listing?.listing?.ads ?? []) ads.set(String(ad.id), ad);
    for (const card of extractRenderedOlxCards(response.body)) {
      if (!ads.has(String(card.id))) ads.set(String(card.id), card);
    }
    return { ads: [...ads.values()], ...metadata };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)), ...metadata };
  }
}

async function hydrateHtmlCardOnlyAds(
  results: OlxFeedResult[],
  state: SourceSearchState,
  deadlineAt: Date,
): Promise<{ requestCount: number; failedCount: number }> {
  const candidates = new Map<string, OlxAd>();
  for (const result of results) {
    if (!isAdsResult(result)) continue;
    for (const ad of result.ads) {
      const id = String(ad.id);
      if (ad.htmlCardOnly && !state.knownExternalIds.has(id)) candidates.set(id, ad);
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
        return await fetchOlxDetailAd(card.url ?? "");
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
      if (!ad.htmlCardOnly || state.knownExternalIds.has(String(ad.id))) return [ad];
      const detail = hydrated.get(String(ad.id));
      return detail ? [detail] : [];
    });
  }

  return { requestCount, failedCount: Math.max(0, candidates.size - hydrated.size) };
}

export function extractRenderedOlxCards(html: string): OlxAd[] {
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
    try {
      cards.push({
        id,
        url: new URL(decodeHtmlText(href), "https://www.olx.ua").toString(),
        title: titleHtml ? decodeHtmlText(titleHtml.replace(/<[^>]+>/gu, " ")).replace(/\s+/gu, " ").trim() : undefined,
        htmlCardOnly: true,
      });
    } catch {
      // Ignore malformed rendered cards; the structured feed remains primary.
    }
  }
  return cards;
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

function olxFeedTargets(
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

function isOlxMarketComparable(listing: NormalizedListing, query: OlxMarketResearchQuery): boolean {
  if (!listing.priceNormalized || listing.priceNormalized <= 0) return false;
  const brand = normalizeVehicleText(query.brand);
  const model = normalizeVehicleText(query.model);
  const candidateBrand = normalizeVehicleText(listing.brand ?? listing.title ?? "");
  const candidateModel = normalizeVehicleText([listing.model, listing.title].filter(Boolean).join(" "));
  if (!candidateBrand.includes(brand) || !candidateModel.includes(model)) return false;
  if (query.year && (!listing.year || Math.abs(listing.year - query.year) > 2)) return false;
  if (query.engineVolume && listing.engineVolume && Math.abs(listing.engineVolume - query.engineVolume) > 0.5) return false;
  return true;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function normalizeOlxApiAd(ad: OlxApiAd): OlxAd {
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

function apiParamLabel(value: OlxApiParam["value"]): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return value?.label ?? (typeof value?.key === "string" ? value.key : undefined);
}

function apiParamNormalizedValue(value: OlxApiParam["value"]): string | string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value.key;
}

export function selectOlxCandidates(
  ads: readonly OlxAd[],
  options: {
    now: Date;
    publishedAfter?: Date;
    knownExternalIds: ReadonlySet<string>;
    seenExternalIds?: Set<string>;
    maxCandidates: number;
    observationChannel?: ListingObservationChannel;
    observationTarget?: string;
  },
): {
  listings: NormalizedListing[];
  observedCount: number;
  cutoffEncountered: boolean;
  knownEncountered: boolean;
  identifiableCount: number;
  knownTailStreak: number;
  allKnown: boolean;
  fullyBeforeCutoff: boolean;
  candidateLimitReached: boolean;
  scannedExternalIds: string[];
} {
  const listings: NormalizedListing[] = [];
  const seen = options.seenExternalIds ?? new Set<string>();
  let observedCount = 0;
  let cutoffEncountered = false;
  let knownEncountered = false;
  let identifiableCount = 0;
  let allKnown = true;
  let fullyBeforeCutoff = Boolean(options.publishedAfter);
  let candidateLimitReached = false;
  const scannedExternalIds: string[] = [];
  const orderingSignals: Array<{ known: boolean }> = [];

  for (const ad of ads) {
    const externalId = String(ad.id ?? "");
    if (!externalId) {
      allKnown = false;
      fullyBeforeCutoff = false;
      continue;
    }

    identifiableCount += 1;
    const known = options.knownExternalIds.has(externalId);
    orderingSignals.push({ known });
    knownEncountered ||= known;
    allKnown &&= known;

    const publishedAt = olxPublishedAt(ad);
    const beforeCutoff = Boolean(options.publishedAfter && publishedAt && publishedAt < options.publishedAfter);
    cutoffEncountered ||= beforeCutoff;
    if (!beforeCutoff) fullyBeforeCutoff = false;

    if (known) scannedExternalIds.push(externalId);
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    observedCount += 1;

    // Known IDs are the dominant realtime path. Avoid full parameter and text
    // normalization until an advert is actually new for this search context.
    if (known) continue;

    const listing = normalizeOlxAd(ad, options.now);
    if (!listing) continue;
    listing.observationChannel = options.observationChannel;
    listing.observationTarget = options.observationTarget;
    if (beforeCutoff) {
      scannedExternalIds.push(externalId);
      continue;
    }
    if (listings.length >= Math.max(0, options.maxCandidates)) {
      candidateLimitReached = true;
      continue;
    }
    listings.push(listing);
    scannedExternalIds.push(externalId);
  }

  let knownTailStreak = 0;
  for (let index = orderingSignals.length - 1; index >= 0; index -= 1) {
    if (!orderingSignals[index]?.known) break;
    knownTailStreak += 1;
  }

  return {
    listings,
    observedCount,
    cutoffEncountered,
    knownEncountered,
    identifiableCount,
    knownTailStreak,
    allKnown: identifiableCount > 0 && allKnown,
    fullyBeforeCutoff: identifiableCount > 0 && fullyBeforeCutoff,
    candidateLimitReached,
    scannedExternalIds,
  };
}

export function shouldStopOlxRealtimePage(pageAnchored: boolean, pageFullyBeforeCutoff: boolean): boolean {
  return pageAnchored || pageFullyBeforeCutoff;
}

function olxPublishedAt(ad: OlxAd): Date | undefined {
  const createdAt = parseDate(ad.createdTime);
  const refreshedAt = parseDate(ad.lastRefreshTime);
  return env.OLX_INCLUDE_REFRESHED ? mostRecentDate(createdAt, refreshedAt) : createdAt;
}

function isAdsResult(result: OlxFeedResult): result is Extract<OlxFeedResult, { ads: OlxAd[] }> {
  return "ads" in result;
}

function isBlockedResult(result: OlxFeedResult): result is Extract<OlxFeedResult, { blocked: BlockedHtmlResult }> {
  return "blocked" in result;
}

function isPrimaryBlockedResult(result: OlxFeedResult): result is Extract<OlxFeedResult, { blocked: BlockedHtmlResult }> {
  return result.primary && isBlockedResult(result);
}

function isErrorResult(result: OlxFeedResult): result is Extract<OlxFeedResult, { error: Error }> {
  return "error" in result;
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
  const engineVolume = parseEngineVolume(firstParamValue(params, ["engine_size", "motor_engine_size", "motor_engine_size_litre", "engine_volume"]));
  const enginePower = parseEnginePower(firstParamValue(params, ["engine_power", "motor_power", "power"]) ?? attributeText);
  const customsCleared = booleanFromParam(params.get("cleared_customs"), ["yes", "так", "да"], ["no", "ні", "нет"])
    ?? inferCustomsCleared(attributeText);
  const createdAt = parseDate(ad.createdTime);
  const refreshedAt = parseDate(ad.lastRefreshTime);
  // In hunting mode a re-listed / bumped advert (recent last_refresh_time,
  // older created_time) counts as fresh, so resellers' re-posts and price
  // drops are caught. Otherwise only the original creation time is used.
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
    bodyType: findAttributeValue(valueFromParam(params.get("car_body")), BODY_TYPE_OPTIONS) ?? inferredAttributes.bodyType,
    fuelType: findAttributeValue(valueFromParam(params.get("fuel_type")), FUEL_TYPE_OPTIONS) ?? inferredAttributes.fuelType,
    gearbox: findAttributeValue(valueFromParam(params.get("transmission_type")), GEARBOX_OPTIONS) ?? inferredAttributes.gearbox,
    driveType: findAttributeValue(valueFromParam(params.get("drive_type")), DRIVE_TYPE_OPTIONS) ?? inferredAttributes.driveType,
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

function firstParamValue(params: Map<string, OlxParam>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = valueFromParam(params.get(key));
    if (value) return value;
  }
  return undefined;
}

function extractPrerenderedState(html: string): OlxPrerenderedState {
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
  const values = [param.value, ...(Array.isArray(param.normalizedValue) ? param.normalizedValue : [param.normalizedValue])]
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
