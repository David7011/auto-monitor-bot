import {
  canonicalizeUrl,
  inferVehicleAttributes,
  inferBrandFromText,
  normalizeBrandName,
  stripBrandFromTitle,
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
  fetchHtml,
  inferBargainPossible,
  inferCustomsCleared,
  isBlockedHtml,
  parseEnginePower,
  parseEngineVolume,
  parseInteger,
  stripTags,
} from "./html-utils.js";

const BASE_URL = "https://cars.ua";
const CARS_UA_CITY_PATH_BY_ID: Readonly<Record<string, string>> = {
  kyiv: "kiev",
  vinnytsia: "vinnica",
  lutsk: "luck",
  dnipro: "dnepr",
  donetsk: "doneck",
  zhytomyr: "zhitomir",
  uzhhorod: "uzhgorod",
  zaporizhzhia: "zaporozhe",
  "ivano-frankivsk": "ivano-frankovsk",
  kropyvnytskyi: "kropivnickij",
  luhansk: "lugansk",
  lviv: "lvov",
  mykolaiv: "nikolaev",
  odesa: "odessa",
  poltava: "poltava",
  rivne: "rovno",
  sumy: "sumy",
  ternopil: "ternopol",
  kharkiv: "harkov",
  kherson: "herson",
  khmelnytskyi: "hmelnickij",
  cherkasy: "cherkassy",
  chernihiv: "chernigov",
  chernivtsi: "chernovcy",
  sevastopol: "sevastopol",
};

export class CarsUaCollector implements SourceCollector {
  readonly source = "CARS_UA" as const;
  readonly supportsNewestFirst = true;
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
    const isBackfill = scan.lane === "BACKFILL";
    const maxPages = isBackfill
      ? Math.max(1, scan.maxPages)
      : Math.max(1, scan.maxPages, env.CARS_UA_REALTIME_MAX_PAGES);
    const maxCandidates = Math.max(1, Math.min(scan.maxCandidates, scan.lane === "REALTIME" ? env.CARS_UA_MAX_NEW_PER_RUN : scan.maxCandidates));
    let pageCount = 0;
    let requestCount = 0;
    let observedCount = 0;
    const cutoffReached = false;
    const searchUrls = carsUaSearchUrls(env.CARS_UA_SEARCH_URL, context.cities);
    let anchoredTargets = 0;
    targetLoop: for (const searchUrl of searchUrls) {
      let targetAnchored = false;
      for (let page = 1; page <= maxPages; page += 1) {
        if (scanDeadlineReached(scan)) {
          semanticWarnings.push(`Cars.ua scan deadline reached after ${pageCount} page(s)`);
          break targetLoop;
        }

        const pageUrl = carsUaPageUrl(searchUrl, page);
        const response = await fetchHtml(pageUrl, { source: "CARS_UA" });
        requestCount += 1;
        const blocked = isBlockedHtml(response.status, response.body, response.retryAfterSeconds);
        if (blocked.rateLimited || blocked.captchaDetected) {
          return { listings, ...blocked, responseStatus: response.status, affectedUrl: pageUrl, pageCount, requestCount, observedCount, semanticWarnings };
        }
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Cars.ua search failed: HTTP ${response.status}`);
        }

        const cards = extractCards(response.body);
        pageCount += 1;
        let observedOnPage = 0;
        const knownSequence: boolean[] = [];
        const pageCandidates: NormalizedListing[] = [];

        for (const card of cards) {
          if (!card.id || seenExternalIds.has(card.id)) continue;
          seenExternalIds.add(card.id);
          observedOnPage += 1;

          const known = state.knownExternalIds.has(card.id);
          knownSequence.push(known);
          if (known) {
            classifiedExternalIds.add(card.id);
            continue;
          }
          if (listings.length >= maxCandidates) continue;

          const listing = normalizeCarsUaCard(card, now);
          if (!listing) continue;
          classifiedExternalIds.add(card.id);
          // Cars.ua order is not verified newest-first, so a single out-of-window
          // card must not truncate the rest of the page — skip it, keep scanning.
          if (context.publishedAfter && listing.publishedAt && listing.publishedAt < context.publishedAfter) {
            continue;
          }
          listings.push(listing);
          pageCandidates.push(listing);
        }

        observedCount += observedOnPage;
        if (pageCandidates.length > 0 && scan.onHotCandidates) {
          await scan.onHotCandidates(pageCandidates);
        }
        if (observedOnPage === 0) {
          if (page === 1) semanticWarnings.push(`Cars.ua returned no parseable adverts for ${searchUrl}`);
          targetAnchored = true;
          break;
        }
        // Every selected city is scanned independently. An overlap in one city
        // must not suppress another selected city's hot page.
        if (!isBackfill && (
          carsUaPageIsAnchored(knownSequence, env.KNOWN_LISTING_STOP_THRESHOLD)
          || listings.length >= maxCandidates
        )) {
          targetAnchored = true;
          break;
        }
      }
      if (targetAnchored) anchoredTargets += 1;
      if (listings.length >= maxCandidates) break;
    }
    const anchored = anchoredTargets === searchUrls.length;

    if (!isBackfill && !anchored && state.knownExternalIds.size > 0 && observedCount > 0) {
      semanticWarnings.push(
        `Cars.ua realtime window overflow: ${pageCount} page(s) scanned without overlapping known adverts`,
      );
    }

    return {
      listings,
      scannedExternalIds: [...classifiedExternalIds],
      observedCount,
      pageCount,
      requestCount,
      cutoffReached,
      semanticWarnings,
    };
  }
}

export function carsUaPageIsAnchored(
  knownSequence: readonly boolean[],
  knownTailThreshold: number,
): boolean {
  if (knownSequence.length === 0) return true;
  if (knownSequence.every(Boolean)) return true;
  const threshold = Math.max(1, Math.trunc(knownTailThreshold));
  let trailingKnown = 0;
  for (let index = knownSequence.length - 1; index >= 0 && knownSequence[index]; index -= 1) {
    trailingKnown += 1;
  }
  return trailingKnown >= threshold;
}

export function carsUaPageUrl(value: string, page: number): string {
  if (page <= 1) return value;
  const url = new URL(value);
  const basePath = url.pathname.replace(/\/p=\d+\/?$/u, "/").replace(/\/?$/u, "/");
  url.pathname = `${basePath}p=${Math.max(2, Math.trunc(page))}/`;
  return url.toString();
}

export function carsUaSearchUrls(value: string, cityIds: readonly string[]): string[] {
  const cityPaths = [...new Set(cityIds
    .map((cityId) => CARS_UA_CITY_PATH_BY_ID[cityId])
    .filter((cityPath): cityPath is string => Boolean(cityPath)))];
  if (cityPaths.length === 0) return [value];

  return cityPaths.map((cityPath) => {
    const url = new URL(value);
    url.pathname = `/avtobazar/${cityPath}/`;
    return url.toString();
  });
}

function normalizeCarsUaCard(card: { id: string; html: string }, now: Date): NormalizedListing | undefined {
  const headerMatch = card.html.match(/<div class="header">[\s\S]*?<a[^>]+href="(?<href>[^"]+)"[^>]*>(?<title>[\s\S]*?)<\/a>/);
  const href = headerMatch?.groups?.href;
  if (!href) return undefined;

  const url = absoluteUrl(href, BASE_URL);
  const title = stripTags(headerMatch.groups?.title ?? "");
  const city = extractCity(card.html);
  const publishedAt = parseDate(card.html.match(/<span class="source">(?<date>\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})<\/span>/)?.groups?.date);
  const priceOriginal = parseInteger(card.html.match(/<div class="price"><span>(?<price>[\d\s]+)\s*\$/)?.groups?.price);
  const specText = stripTags(card.html.match(/<div class="description">(?<description>[\s\S]*?)<\/div>\s*<div class="ui right floated text stat/)?.groups?.description ?? "");
  const description = stripTags(card.html.match(/<div class="extra">(?<extra>[\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/)?.groups?.extra ?? specText);
  const year = parseInteger(specText.match(/(?<year>\d{4})\s*р/i)?.groups?.year);
  const mileageThousand = parseInteger(specText.match(/(?<mileage>[\d\s]+)\s*тыс\.\s*км/i)?.groups?.mileage);
  const photo = card.html.match(/<img[^>]+src="(?<src>[^"]+)"[^>]+(?:alt|title)="[^"]*Продам/i)?.groups?.src;
  const attributes = inferVehicleAttributes(`${title} ${specText} ${description}`);
  const brand = inferBrand(title);

  return {
    source: "CARS_UA",
    externalId: card.id,
    url,
    canonicalUrl: canonicalizeUrl(url),
    title,
    brand,
    model: inferModel(title, brand),
    bodyType: attributes.bodyType,
    fuelType: attributes.fuelType,
    gearbox: attributes.gearbox,
    driveType: attributes.driveType,
    engineVolume: parseEngineVolume(specText),
    enginePower: parseEnginePower(specText),
    customsCleared: inferCustomsCleared(`${specText} ${description}`),
    bargainPossible: inferBargainPossible(`${specText} ${description}`),
    year,
    priceOriginal,
    currencyOriginal: priceOriginal != null ? "USD" : undefined,
    priceNormalized: priceOriginal,
    mileage: mileageThousand != null ? mileageThousand * 1000 : undefined,
    city,
    region: city,
    description,
    photoUrls: photo ? [absoluteUrl(photo, BASE_URL)] : [],
    publishedAt,
    timestampConfidence: publishedAt ? "HIGH" : "UNKNOWN",
    skipReason: publishedAt ? undefined : "UNKNOWN_PUBLICATION_DATE",
    firstSeenAt: now,
    raw: { html: card.html.slice(0, 5000) },
  };
}

function extractCards(html: string): Array<{ id: string; html: string }> {
  const cards: Array<{ id: string; html: string }> = [];
  const cardRegex = /<div class="item[^"]*" data-id="(?<id>\d+)"[\s\S]*?(?=<div class="item[^"]*" data-id="|<div class="ui stackable grid container cars-links|<\/body>)/g;

  for (const match of html.matchAll(cardRegex)) {
    const id = match.groups?.id;
    if (!id) continue;
    cards.push({ id, html: match[0] });
  }

  return cards;
}

function extractCity(html: string): string | undefined {
  const contacts = html.match(/<div class="ui right floated text contacts mobile-hide">[\s\S]*?<b>(?<city>[\s\S]*?)<\/b>/)?.groups?.city;
  if (contacts) return stripTags(contacts);
  return stripTags(html.match(/<div class="text contacts desktop-hide">[\s\S]*?<b>(?<city>[\s\S]*?)<\/b>/)?.groups?.city ?? "") || undefined;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const match = value.match(/^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})\s+(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})$/);
  if (!match?.groups) return undefined;
  const parsed = zonedTimeToUtc(
    Number(match.groups.year),
    Number(match.groups.month),
    Number(match.groups.day),
    Number(match.groups.hour),
    Number(match.groups.minute),
    Number(match.groups.second),
    "Europe/Kyiv",
  );
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(utcGuess);
  const actualAsUtc = Date.UTC(
    Number(parts.find((part) => part.type === "year")?.value),
    Number(parts.find((part) => part.type === "month")?.value) - 1,
    Number(parts.find((part) => part.type === "day")?.value),
    Number(parts.find((part) => part.type === "hour")?.value) % 24,
    Number(parts.find((part) => part.type === "minute")?.value),
    Number(parts.find((part) => part.type === "second")?.value),
  );
  return new Date(utcGuess.getTime() - (actualAsUtc - utcGuess.getTime()));
}

function inferBrand(title: string): string | undefined {
  return normalizeBrandName(inferBrandFromText(title) ?? title.trim().split(/\s+/)[0]);
}

function inferModel(title: string, brand: string | undefined): string | undefined {
  const withoutBrand = stripBrandFromTitle(title, brand);
  if (withoutBrand) return withoutBrand;
  const tokens = title.trim().split(/\s+/);
  return tokens.length > 1 ? tokens.slice(1).join(" ") : undefined;
}
