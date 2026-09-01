import {
  canonicalizeUrl,
  extractPlateFromText,
  inferVehicleAttributes,
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
  absoluteUrl,
  decodeHtmlEntities,
  fetchHtml,
  isBlockedHtml,
  parseEngineVolume,
  parseInteger,
  stripTags,
  withPageNumber,
} from "./html-utils.js";

const BASE_URL = "https://automoto.ua";
const MAX_NEW_PER_RUN = 40;
const AUTOMOTO_CITY_PATH_BY_ID: Readonly<Record<string, string>> = {
  kyiv: "Kiev",
  vinnytsia: "Vinnitsa",
  lutsk: "Lutsk",
  dnipro: "Dnepr-Dnepropetrovsk",
  donetsk: "Donetsk",
  zhytomyr: "Zhitomir",
  uzhhorod: "Uzhgorod",
  zaporizhzhia: "Zaporozhe",
  "ivano-frankivsk": "Ivanofrankovsk",
  kropyvnytskyi: "Kropivnickiy-Kirovograd",
  luhansk: "Lugansk",
  lviv: "Lvov",
  mykolaiv: "Nikolaev",
  odesa: "Odessa",
  poltava: "Poltava",
  rivne: "Rovno",
  sumy: "Sumy",
  ternopil: "Ternopol",
  kharkiv: "Kharkov",
  kherson: "Kherson",
  khmelnytskyi: "Khmelnytskyi",
  cherkasy: "Cherkassy",
  chernihiv: "Chernigov",
  chernivtsi: "Chernovtsy",
};

export class AutoMotoCollector implements SourceCollector {
  readonly source = "AUTOMOTO" as const;
  readonly supportsNewestFirst = false;
  readonly newestFirstVerified = false;

  async collect(
    context: SourceSearchContext,
    state: SourceSearchState,
    input?: CollectorScanOptions,
  ): Promise<CollectorResult> {
    const scan = collectorScanOptions(input);
    const listings: NormalizedListing[] = [];
    const seenExternalIds = new Set<string>();
    const classifiedExternalIds = new Set<string>();
    const now = new Date();
    const semanticWarnings: string[] = [];
    const maxPages = scan.lane === "BACKFILL" ? Math.max(1, scan.maxPages) : 1;
    const maxCandidates = Math.max(1, Math.min(scan.maxCandidates, scan.lane === "REALTIME" ? MAX_NEW_PER_RUN : scan.maxCandidates));
    let pageCount = 0;
    let requestCount = 0;
    let observedCount = 0;
    const cutoffReached = false;
    const searchUrls = autoMotoSearchUrls(env.AUTOMOTO_SEARCH_URL, context.cities);

    targetLoop: for (const searchUrl of searchUrls) {
      for (let page = 1; page <= maxPages; page += 1) {
        if (scanDeadlineReached(scan)) {
          semanticWarnings.push(`AutoMoto.ua scan deadline reached after ${pageCount} page(s)`);
          break targetLoop;
        }

        const pageUrl = withPageNumber(searchUrl, page);
        const response = await fetchHtml(pageUrl, { source: "AUTOMOTO", timeoutMs: env.AUTOMOTO_REQUEST_TIMEOUT_MS });
        requestCount += 1;
        const blocked = isBlockedHtml(response.status, response.body);
        if (blocked.rateLimited || blocked.captchaDetected) {
          return { listings, ...blocked, responseStatus: response.status, affectedUrl: pageUrl, pageCount, requestCount, observedCount, semanticWarnings };
        }
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`AutoMoto.ua search failed: HTTP ${response.status}`);
        }

        const cards = extractCards(response.body);
        pageCount += 1;
        let observedOnPage = 0;
        if (cards.length === 0) {
          if (page === 1) semanticWarnings.push(`AutoMoto.ua returned no parseable adverts for ${searchUrl}`);
          break;
        }

        const pageCandidates: NormalizedListing[] = [];
        for (const card of cards) {
          const externalId = attribute(card, "data-ids") ?? card.match(/trackEvent\('show',\s*'auto',\s*(\d+)\)/u)?.[1];
          if (!externalId || seenExternalIds.has(externalId)) continue;
          seenExternalIds.add(externalId);
          observedOnPage += 1;
          if (state.knownExternalIds.has(externalId)) {
            classifiedExternalIds.add(externalId);
            continue;
          }
          if (listings.length >= maxCandidates) continue;
          const listing = normalizeAutoMotoCard(card, externalId, now, scan.lane === "REALTIME");
          if (!listing) continue;
          classifiedExternalIds.add(externalId);
          // AutoMoto explicitly does not guarantee strict newest-first order.
          // An old/promoted card cannot terminate the page because a fresh card
          // may follow it.
          if (!autoMotoListingIsInFreshnessWindow(listing.publishedAt, context.publishedAfter)) continue;
          listings.push(listing);
          pageCandidates.push(listing);
        }

        observedCount += observedOnPage;
        if (pageCandidates.length > 0 && scan.onHotCandidates) {
          await scan.onHotCandidates(pageCandidates);
        }
        if (listings.length >= maxCandidates) break targetLoop;
      }
    }

    return {
      listings,
      scannedExternalIds: [...classifiedExternalIds],
      observedCount,
      pageCount,
      requestCount,
      cutoffReached,
      semanticWarnings,
      limited: true,
      limitedReason: "AutoMoto.ua показывает день публикации без точного времени и не гарантирует строгую сортировку по новизне",
    };
  }
}

export function autoMotoSearchUrls(value: string, cityIds: readonly string[]): string[] {
  const cityPaths = [...new Set(cityIds
    .map((cityId) => AUTOMOTO_CITY_PATH_BY_ID[cityId])
    .filter((cityPath): cityPath is string => Boolean(cityPath)))];
  if (cityPaths.length === 0) return [value];

  return cityPaths.map((cityPath) => {
    const url = new URL(value);
    url.pathname = `/uk/city/${cityPath}/car`;
    return url.toString();
  });
}

export function autoMotoListingIsInFreshnessWindow(
  publishedAt: Date | undefined,
  publishedAfter: Date | undefined,
): boolean {
  return !publishedAfter || !publishedAt || publishedAt >= publishedAfter;
}

function normalizeAutoMotoCard(
  card: string,
  externalId: string,
  now: Date,
  allowFirstSeenFreshness: boolean,
): NormalizedListing | undefined {
  const href = card.match(/<div class="card-name[^"]*"[\s\S]*?<a[^>]+href="(?<href>[^"]+)"/u)?.groups?.href;
  if (!href) return undefined;
  const url = absoluteUrl(decodeHtmlEntities(href), BASE_URL);
  const title = stripTags(card.match(/<div class="card-name[^"]*"[\s\S]*?<a[^>]*>(?<title>[\s\S]*?)<\/a>/u)?.groups?.title ?? "");
  if (!title) return undefined;

  const brand = decodedAttribute(card, "data-mark");
  const model = decodedAttribute(card, "data-model");
  const year = parseInteger(attribute(card, "data-year"));
  const price = parseInteger(attribute(card, "data-price"));
  const regionParts = (decodedAttribute(card, "data-region") ?? "").split("|").map((part) => part.trim()).filter(Boolean);
  const specs = [...card.matchAll(/<div class="description">(?<value>[\s\S]*?)<\/div>/gu)]
    .map((match) => stripTags(match.groups?.value ?? ""))
    .filter(Boolean);
  const description = stripTags(card.match(/<div class="text-muted comment-text">(?<value>[\s\S]*?)<\/div>/u)?.groups?.value ?? "");
  const attributes = inferVehicleAttributes(`${title} ${specs.join(" ")} ${description}`);
  const mileageThousands = parseInteger(specs.find((value) => /тис\.\s*км|тыс\.\s*км/iu.test(value)));
  const photo = card.match(/<img[^>]+src="(?<src>https?:\/\/img\.automoto\.ua\/[^"]+)"/u)?.groups?.src;
  const plateText = stripTags(card.match(/<div class="card-number">(?<value>[\s\S]*?)<\/div>/u)?.groups?.value ?? "");
  const plate = extractPlateFromText(plateText);
  const dateText = stripTags(card.match(/<div class="card-date">(?<value>[\s\S]*?)<\/div>/u)?.groups?.value ?? "");
  const publishedAt = parseDayOnlyDate(dateText);

  return {
    source: "AUTOMOTO",
    externalId,
    url,
    canonicalUrl: canonicalizeUrl(url),
    title,
    brand,
    model,
    bodyType: attributes.bodyType,
    fuelType: attributes.fuelType,
    gearbox: attributes.gearbox,
    driveType: attributes.driveType,
    engineVolume: parseEngineVolume(specs.join(" ")),
    year,
    priceOriginal: price,
    currencyOriginal: price != null ? "USD" : undefined,
    priceNormalized: price,
    mileage: mileageThousands != null ? mileageThousands * 1_000 : undefined,
    city: regionParts[0],
    region: regionParts[1],
    plateNormalized: plate?.normalized,
    description,
    photoUrls: photo ? [photo] : [],
    publishedAt,
    timestampConfidence: publishedAt ? "LOW" : "UNKNOWN",
    skipReason: publishedAt ? "PUBLICATION_TIME_DAY_ONLY" : "UNKNOWN_PUBLICATION_DATE",
    freshnessFallback: !publishedAt && allowFirstSeenFreshness ? "FIRST_SEEN" : undefined,
    firstSeenAt: now,
    raw: {
      partner: decodedAttribute(card, "data-partner"),
      publicationDate: dateText || null,
      html: card.slice(0, 8_000),
    },
  };
}

export function extractCards(html: string): string[] {
  return [...html.matchAll(/<auto-item\s+inline-template>[\s\S]*?<\/auto-item>/gu)].map((match) => match[0]);
}

function attribute(card: string, name: string): string | undefined {
  const match = card.match(new RegExp(`${name}="([^"]*)"`, "u"));
  return match?.[1]?.trim() || undefined;
}

function decodedAttribute(card: string, name: string): string | undefined {
  const value = attribute(card, name);
  return value ? decodeHtmlEntities(value).trim() : undefined;
}

function parseDayOnlyDate(value: string): Date | undefined {
  const match = value.match(/^(?<day>\d{2})\.(?<month>\d{2})\.(?<year>\d{4})$/u);
  if (!match?.groups) return undefined;
  const utcNoon = Date.UTC(Number(match.groups.year), Number(match.groups.month) - 1, Number(match.groups.day), 12);
  const parsed = new Date(utcNoon);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
