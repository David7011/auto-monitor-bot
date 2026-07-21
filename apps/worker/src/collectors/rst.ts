import { canonicalizeUrl, inferBrandFromText, inferVehicleAttributes, normalizeBrandName, type NormalizedListing } from "@amb/shared";
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
  absoluteUrl,
  fetchHtml,
  inferBargainPossible,
  inferCustomsCleared,
  isBlockedHtml,
  parseEnginePower,
  parseEngineVolume,
  parseInteger,
  stripTags,
  withPageNumber,
} from "./html-utils.js";

const BASE_URL = "https://rst.ua";
const MAX_NEW_PER_RUN = 25;

export class RstCollector implements SourceCollector {
  readonly source = "RST" as const;
  readonly supportsNewestFirst = false;
  readonly newestFirstVerified = false;

  async collect(
    _context: SourceSearchContext,
    state: SourceSearchState,
    input?: CollectorScanOptions,
  ): Promise<CollectorResult> {
    const scan = collectorScanOptions(input);
    const listings: NormalizedListing[] = [];
    const now = new Date();
    const semanticWarnings: string[] = [];
    const maxPages = scan.lane === "BACKFILL" ? Math.max(1, scan.maxPages) : 1;
    const maxCandidates = Math.max(1, Math.min(scan.maxCandidates, scan.lane === "REALTIME" ? MAX_NEW_PER_RUN : scan.maxCandidates));
    let pageCount = 0;
    let requestCount = 0;
    let observedCount = 0;

    for (let page = 1; page <= maxPages; page += 1) {
      if (scanDeadlineReached(scan)) {
        semanticWarnings.push(`RST scan deadline reached after ${pageCount} page(s)`);
        break;
      }

      const pageUrl = withPageNumber(env.RST_SEARCH_URL, page);
      const response = await fetchHtml(pageUrl, { source: "RST", encoding: "windows-1251" });
      requestCount += 1;
      const blocked = isBlockedHtml(response.status, response.body);
      if (blocked.rateLimited || blocked.captchaDetected) {
        return { listings, ...blocked, responseStatus: response.status, affectedUrl: pageUrl, pageCount, requestCount, observedCount, semanticWarnings };
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`RST search failed: HTTP ${response.status}`);
      }

      const articles = extractArticles(response.body);
      pageCount += 1;
      observedCount += articles.length;
      if (articles.length === 0) {
        if (page === 1) semanticWarnings.push("RST returned no parseable adverts on the first page");
        break;
      }

      for (const article of articles) {
        if (state.knownExternalIds.has(article.id)) continue;
        if (listings.length >= maxCandidates) break;
        const listing = normalizeRstArticle(article, now, scan.lane === "REALTIME");
        if (listing) listings.push(listing);
      }

      if (listings.length >= maxCandidates) break;
    }

    return {
      listings,
      observedCount,
      pageCount,
      requestCount,
      semanticWarnings,
      limited: true,
      limitedReason: "RST не предоставляет точное время публикации; новизна подтверждается первым появлением объявления в выдаче",
    };
  }
}

function normalizeRstArticle(
  article: { id: string; html: string },
  now: Date,
  allowFirstSeenFreshness: boolean,
): NormalizedListing | undefined {
  const titleMatch = article.html.match(/<a[^>]+class="ai"[^>]+href="(?<href>[^"]+)"[^>]*>(?<title>[\s\S]*?)<\/a>/);
  const href = titleMatch?.groups?.href;
  if (!href) return undefined;

  const url = absoluteUrl(href, BASE_URL);
  const title = stripTags(titleMatch.groups?.title ?? "");
  const priceOriginal = parseInteger(article.html.match(/<div class="pr">[\s\S]*?<b>\$(?<price>[\d']+)/)?.groups?.price);
  const year = parseInteger(article.html.match(/title="рік"[^>]*>[\s\S]*?(?<year>\d{4})/)?.groups?.year);
  const mileage = parseInteger(article.html.match(/(?<mileage>[\d']+)\s*km/i)?.groups?.mileage);
  const region = extractRegion(article.html);
  const photo = article.html.match(/<img[^>]+src="(?<src>\/\/i\d?\.rst\.ua\/oldcars\/[^"]+)"/)?.groups?.src;
  const description = stripTags(article.html);
  const attributes = inferVehicleAttributes(`${title} ${description}`);

  return {
    source: "RST",
    externalId: article.id,
    url,
    canonicalUrl: canonicalizeUrl(url),
    title,
    brand: inferBrand(title),
    model: inferModel(title),
    bodyType: attributes.bodyType,
    fuelType: attributes.fuelType,
    gearbox: attributes.gearbox,
    driveType: attributes.driveType,
    engineVolume: parseEngineVolume(description),
    enginePower: parseEnginePower(description),
    customsCleared: inferCustomsCleared(description),
    bargainPossible: inferBargainPossible(description),
    year,
    priceOriginal,
    currencyOriginal: priceOriginal != null ? "USD" : undefined,
    priceNormalized: priceOriginal,
    mileage,
    city: region,
    region,
    description,
    photoUrls: photo ? [absoluteUrl(photo, BASE_URL)] : [],
    timestampConfidence: "UNKNOWN",
    skipReason: "FRESHNESS_BY_FIRST_SEEN",
    freshnessFallback: allowFirstSeenFreshness ? "FIRST_SEEN" : undefined,
    firstSeenAt: now,
    raw: { html: article.html.slice(0, 5000) },
  };
}

function extractArticles(html: string): Array<{ id: string; html: string }> {
  const articles: Array<{ id: string; html: string }> = [];
  const articleRegex = /<article\s+id="i-(?<id>\d+)"[\s\S]*?<\/article>/g;

  for (const match of html.matchAll(articleRegex)) {
    const id = match.groups?.id;
    if (!id) continue;
    articles.push({ id, html: match[0] });
  }

  return articles;
}

function extractRegion(html: string): string | undefined {
  const match = html.match(/<li title="регіон">(?<value>[\s\S]*?)<\/li>/);
  const value = match?.groups?.value ? stripTags(match.groups.value) : undefined;
  return value?.replace(/\s+обл\.?$/i, " область");
}

function inferBrand(title: string): string | undefined {
  return normalizeBrandName(inferBrandFromText(title) ?? title.trim().split(/\s+/)[0]);
}

function inferModel(title: string): string | undefined {
  const tokens = title.trim().split(/\s+/);
  return tokens.length > 1 ? tokens.slice(1).join(" ") : undefined;
}
