import {
  autoRiaGeoParamsForSelection,
  canonicalizeUrl,
  inferBrandFromText,
  inferVehicleAttributes,
  normalizeBrandName,
  stripBrandFromTitle,
  type NormalizedListing,
} from "@amb/shared";
import {
  collectorScanOptions,
  scanDeadlineReached,
  type CollectorResult,
  type CollectorScanOptions,
  type SourceCollector,
  type SourceSearchContext,
  type SourceSearchState,
} from "./base.js";
import { inferBargainPossible, inferCustomsCleared, isBlockedHtml, parseEnginePower, parseEngineVolume } from "./html-utils.js";
import { sourceHttpClient } from "./source-http-client.js";

const PUBLIC_BASE = "https://auto.ria.com";
const PUBLIC_LIMITATION = "AUTO.RIA public: новизна определяется первым появлением; точное время публикации и полнота исторического окна не доказаны";

type PublicCard = {
  id?: number | string;
  type?: string;
  title?: { content?: string };
  subtitle?: string;
  description?: { content?: string };
  link?: string;
  price?: { USD?: number; UAH?: number; EUR?: number };
  photos?: Array<{ src?: string; alt?: string }>;
  basicInfo?: Array<{ icon?: { data?: { style?: string } }; content?: string }>;
  labels?: Array<{ elements?: Array<{ content?: string }> }>;
  publishTime?: string;
};

/** Public, server-rendered search cards: one HTML request, no per-ad info requests. */
export class AutoRiaPublicCollector implements SourceCollector {
  readonly source = "AUTO_RIA" as const;
  readonly supportsNewestFirst = true;
  // The page mixes refreshed/promoted cards. Never claim proven original publication order.
  readonly newestFirstVerified = false;

  async collect(context: SourceSearchContext, state: SourceSearchState, input?: CollectorScanOptions): Promise<CollectorResult> {
    const scan = collectorScanOptions(input);
    const listings: NormalizedListing[] = [];
    const observedIds = new Set<string>();
    const classifiedIds = new Set<string>();
    const semanticWarnings: string[] = [];
    const maxCandidates = Math.max(1, Math.trunc(scan.maxCandidates));
    const maxPages = scan.lane === "BACKFILL" ? Math.min(3, Math.max(1, scan.maxPages)) : 1;
    let requestCount = 0;
    let pageCount = 0;
    let parserDegraded = false;

    for (let page = 0; page < maxPages; page += 1) {
      if (scanDeadlineReached(scan)) {
        semanticWarnings.push("AUTO.RIA public scan deadline reached");
        break;
      }
      const url = buildAutoRiaPublicSearchUrl(context, page);
      const response = await sourceHttpClient.text(url, {
        source: "AUTO_RIA",
        timeoutMs: Math.max(1, Math.min(15_000, scan.deadlineAt.getTime() - Date.now())),
        maxBytes: 4 * 1024 * 1024,
      });
      requestCount += 1;
      const blocked = isBlockedHtml(response.status, response.body, response.retryAfterSeconds, response);
      if (blocked.rateLimited || blocked.captchaDetected) {
        return { listings, ...blocked, affectedUrl: url, requestCount, pageCount, observedCount: observedIds.size };
      }
      if (response.classification !== "SUCCESS") {
        throw new Error(`AUTO.RIA public search failed: ${response.classification} HTTP ${response.status}`);
      }
      pageCount += 1;
      const parsed = parseAutoRiaPublicCards(response.body);
      if (parsed.cards.length === 0 || parsed.malformedCount > 0) {
        parserDegraded = true;
        semanticWarnings.push(`AUTO.RIA public card schema unverified: ${parsed.cards.length} cards, ${parsed.malformedCount} malformed`);
      }
      const candidates: NormalizedListing[] = [];
      let newIdsOnPage = 0;
      for (const card of parsed.cards) {
        const id = String(card.id);
        if (observedIds.has(id)) continue;
        observedIds.add(id);
        if (state.knownExternalIds.has(id)) {
          classifiedIds.add(id);
          continue;
        }
        newIdsOnPage += 1;
        if (listings.length >= maxCandidates) continue;
        const listing = normalizePublicCard(card, new Date(), scan.lane === "REALTIME");
        if (!listing) {
          parserDegraded = true;
          continue;
        }
        classifiedIds.add(id);
        listing.requestStartedAt = response.requestStartedAt;
        listing.firstByteAt = response.firstByteAt;
        listings.push(listing);
        candidates.push(listing);
      }
      if (candidates.length > 0 && scan.onHotCandidates) await scan.onHotCandidates(candidates);
      if (parsed.cards.length === 0 || listings.length >= maxCandidates || newIdsOnPage === 0) break;
    }
    return {
      listings,
      scannedExternalIds: [...classifiedIds],
      observedCount: observedIds.size,
      requestCount,
      pageCount,
      limited: true,
      limitedReason: PUBLIC_LIMITATION,
      semanticWarnings,
      parserHealth: parserDegraded ? "DEGRADED" : "HEALTHY",
      parserHealthDetails: { strategy: "PUBLIC_HTTP", exactPublicationTimestamp: false, continuityVerified: false },
    };
  }
}

export function buildAutoRiaPublicSearchUrl(context: SourceSearchContext, page = 0): string {
  const url = new URL("/uk/search/", PUBLIC_BASE);
  const params = url.searchParams;
  params.set("indexName", "auto");
  params.set("categories.main.id", String(context.autoRiaCategoryId ?? 1));
  params.set("sort[0].order", "dates.created.desc");
  params.set("size", "20");
  params.set("page", String(Math.max(0, Math.trunc(page))));
  params.set("price.currency", "1");
  const setNumber = (key: string, value: number | undefined) => {
    if (typeof value === "number" && Number.isFinite(value)) params.set(key, String(value));
  };
  if (context.autoRiaMarkId != null) {
    setNumber("brand.id[0]", context.autoRiaMarkId);
    setNumber("model.id[0]", context.autoRiaModelId);
  }
  setNumber("year[0].gte", context.yearFrom);
  setNumber("year[0].lte", context.yearTo);
  setNumber("price.USD.gte", context.priceFrom);
  setNumber("price.USD.lte", context.priceTo);
  autoRiaGeoParamsForSelection(context.regions, context.cities).slice(0, 25).forEach((geo, index) => {
    setNumber(`region.id[${index}]`, geo.stateId);
    if (geo.cityIdValue > 0) setNumber(`city.id[${index}]`, geo.cityIdValue);
  });
  // Unsupported criteria stay in the existing local filter engine; do not guess
  // server parameter names or falsely narrow a search and silently lose adverts.
  return url.toString();
}

export function parseAutoRiaPublicCards(html: string): { cards: PublicCard[]; malformedCount: number } {
  const cards: PublicCard[] = [];
  const ids = new Set<string>();
  const marker = /"advertisementCard"\s*:\s*\{/gu;
  let malformedCount = 0;
  for (const match of html.matchAll(marker)) {
    const start = match.index + match[0].length - 1;
    const json = readJsonObject(html, start);
    if (!json) { malformedCount += 1; continue; }
    try {
      const parsed: unknown = JSON.parse(json);
      if (!parsed || typeof parsed !== "object" || !("data" in parsed)) { malformedCount += 1; continue; }
      const card = parsed.data as PublicCard | null;
      if (!card || typeof card !== "object") { malformedCount += 1; continue; }
      // UsedAuto is a recommendation/offer-of-the-day widget outside the query.
      if (card.type !== "Auto") continue;
      const id = String(card.id ?? "");
      if (!/^\d+$/u.test(id) || typeof card.link !== "string" || typeof card.title?.content !== "string") {
        malformedCount += 1;
        continue;
      }
      if (ids.has(id)) continue;
      ids.add(id);
      cards.push(card);
    } catch { malformedCount += 1; }
  }
  return { cards, malformedCount };
}

/** Bounded JSON extraction from SSR state; scripts are data, never evaluated. */
function readJsonObject(input: string, start: number): string | undefined {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < Math.min(input.length, start + 128 * 1024); index += 1) {
    const char = input[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return input.slice(start, index + 1);
  }
  return undefined;
}

function normalizePublicCard(card: PublicCard, now: Date, firstSeenFreshness: boolean): NormalizedListing | undefined {
  const id = String(card.id);
  const url = new URL(card.link!, PUBLIC_BASE);
  if (url.protocol !== "https:" || url.hostname !== "auto.ria.com" || !url.pathname.endsWith(`_${id}.html`)) return undefined;
  const title = card.title!.content!;
  const specs = Array.isArray(card.basicInfo) ? card.basicInfo : [];
  const spec = (pattern: RegExp) => specs.find((item) => pattern.test(item.icon?.data?.style ?? ""))?.content;
  const location = spec(/location/u);
  const mileageText = spec(/speedometer/u);
  const mileageValue = mileageText?.match(/(\d[\d\s]*(?:[.,]\d+)?)/u)?.[1];
  const mileage = mileageValue != null
    ? Number(mileageValue.replace(/\s/gu, "").replace(",", ".")) * (/тис|тыс/u.test(mileageText ?? "") ? 1000 : 1)
    : undefined;
  const photos = Array.isArray(card.photos) ? card.photos : [];
  const labels = Array.isArray(card.labels) ? card.labels.flatMap((label) => label.elements?.map((item) => item.content ?? "") ?? []).join(" ") : "";
  const details = [title, card.subtitle, ...specs.map((item) => item.content), photos[0]?.alt, labels].filter(Boolean).join(" ");
  const description = card.description?.content ?? "";
  const attributes = inferVehicleAttributes(details);
  const brand = normalizeBrandName(inferBrandFromText(title));
  const year = title.match(/\b((?:19|20)\d{2})\s*$/u)?.[1];
  const priceUsd = finiteNumber(card.price?.USD);
  const priceUah = finiteNumber(card.price?.UAH);
  return {
    source: "AUTO_RIA", externalId: id, url: url.toString(), canonicalUrl: canonicalizeUrl(url.toString()), title,
    brand, model: stripBrandFromTitle(title.replace(/\s+(?:19|20)\d{2}\s*$/u, ""), brand),
    year: year ? Number(year) : undefined,
    bodyType: attributes.bodyType, fuelType: attributes.fuelType, gearbox: attributes.gearbox, driveType: attributes.driveType,
    engineVolume: parseEngineVolume(details), enginePower: parseEnginePower(details),
    customsCleared: inferCustomsCleared(`${details} ${description}`), bargainPossible: inferBargainPossible(labels),
    priceOriginal: priceUsd ?? priceUah, currencyOriginal: priceUsd != null ? "USD" : priceUah != null ? "UAH" : undefined,
    priceNormalized: priceUsd, mileage: Number.isFinite(mileage) ? mileage : undefined,
    city: location, region: location, description,
    photoUrls: photos.map((photo) => photo.src).filter((photo): photo is string => typeof photo === "string" && /^https:\/\/(?:cdn\d*\.)?riastatic\.com\//u.test(photo)).slice(0, 4),
    timestampConfidence: "UNKNOWN", freshnessFallback: firstSeenFreshness ? "FIRST_SEEN" : undefined,
    skipReason: "FRESHNESS_BY_FIRST_SEEN", firstSeenAt: now,
    raw: { provider: "AUTO_RIA_PUBLIC", autoId: id, publicationLabel: card.publishTime ?? null, originalPublicationTimestampVerified: false },
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
