import { prisma } from "@amb/db";
import { sourceHttpClient } from "../collectors/source-http-client.js";
import { redisConnection } from "../lib/queues.js";
import { log } from "../lib/log.js";

const SELLER_PHONE_CACHE_TTL_SECONDS = 24 * 60 * 60;
const SELLER_PHONE_NEGATIVE_TTL_SECONDS = 60 * 60;
const SELLER_PHONE_TIMEOUT_MS = 8_000;
const SELLER_PHONE_MAX = 3;

function cacheKey(source: string, externalId: string): string {
  return `seller-phone:v1:${source}:${externalId}`;
}

/**
 * Normalizes a raw phone candidate to E.164-like form.
 * Ukrainian numbers become `+380XXXXXXXXX`. Other plausible international
 * numbers are kept as `+<digits>` (7-15 digits). Returns null when the
 * candidate does not look like a dialable phone.
 */
export function normalizePhoneNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/gu, "");
  if (!digits) return null;
  if (digits.startsWith("380") && digits.length === 12) return `+${digits}`;
  if (hasPlus && digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10 && digits.startsWith("0")) return `+38${digits}`;
  if (digits.length === 12 && digits.startsWith("380")) return `+${digits}`;
  return null;
}

export function splitStoredPhones(stored: string | null | undefined): string[] {
  if (!stored) return [];
  const out: string[] = [];
  for (const part of stored.split(",")) {
    const normalized = normalizePhoneNumber(part);
    if (normalized && !out.includes(normalized)) out.push(normalized);
    if (out.length >= SELLER_PHONE_MAX) break;
  }
  return out;
}

const UA_PHONE_TEXT_PATTERN = /(?:\+?380[\s\-().]*\d{2,3}[\s\-().]*\d{2,3}[\s\-().]*\d{2,3}|(?<![\d+])(?:0\d{2}[\s\-().]*\d{3}[\s\-().]*\d{2}[\s\-().]*\d{2})(?![\d]))/gu;

/** Zero-request extraction from already-available text (title/description/raw). */
export function extractPhonesFromText(text: string): string[] {
  const out: string[] = [];
  if (!text) return out;
  for (const match of text.matchAll(UA_PHONE_TEXT_PATTERN)) {
    const normalized = normalizePhoneNumber(match[0] ?? "");
    if (normalized && !out.includes(normalized)) out.push(normalized);
    if (out.length >= SELLER_PHONE_MAX) break;
  }
  return out;
}

/** Zero-request extraction from a detail/search HTML page. */
export function extractPhonesFromHtml(html: string): string[] {
  const out: string[] = [];
  if (!html) return out;
  for (const match of html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/giu)) {
    const normalized = normalizePhoneNumber(match[1] ?? "");
    if (normalized && !out.includes(normalized)) out.push(normalized);
    if (out.length >= SELLER_PHONE_MAX) break;
  }
  for (const match of html.matchAll(/"(?:phone|phoneFormatted|telephone)"\s*:\s*"([^"]+)"/giu)) {
    const normalized = normalizePhoneNumber(match[1] ?? "");
    if (normalized && !out.includes(normalized)) out.push(normalized);
    if (out.length >= SELLER_PHONE_MAX) break;
  }
  if (out.length < SELLER_PHONE_MAX) {
    const text = html.replace(/<script[\s\S]*?<\/script>/giu, " ").replace(/<style[\s\S]*?<\/style>/giu, " ");
    for (const phone of extractPhonesFromText(text)) {
      if (!out.includes(phone)) out.push(phone);
      if (out.length >= SELLER_PHONE_MAX) break;
    }
  }
  return out;
}

function stringifyRaw(raw: unknown): string {
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw) ?? "";
  } catch {
    return "";
  }
}

function pickString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function collectPhoneCandidates(data: unknown): string[] {
  const out: string[] = [];
  const visit = (item: unknown, depth: number): void => {
    if (out.length >= 8 || depth > 4 || item == null) return;
    if (typeof item === "string") {
      const normalized = normalizePhoneNumber(item);
      if (normalized && !out.includes(normalized)) out.push(normalized);
      return;
    }
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry, depth + 1);
      return;
    }
    if (typeof item !== "object") return;
    for (const [key, nested] of Object.entries(item)) {
      if (/phone/i.test(key)) visit(nested, depth + 1);
      else if (nested && typeof nested === "object") visit(nested, depth + 1);
    }
  };
  visit(data, 0);
  return out;
}

/** Parses the OLX `limited-phones` payload in any known shape. */
export function parseOlxLimitedPhones(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, unknown>;
  const nested = root.data ?? root;
  const candidates = Array.isArray(nested)
    ? nested
    : (nested as Record<string, unknown>).phones ?? (nested as Record<string, unknown>).phone_numbers ?? [];
  const out: string[] = [];
  const items = Array.isArray(candidates) ? candidates : [candidates];
  for (const item of items) {
    if (typeof item === "string") {
      const normalized = normalizePhoneNumber(item);
      if (normalized && !out.includes(normalized)) out.push(normalized);
      continue;
    }
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      for (const key of ["phoneFormatted", "phone", "number", "value"]) {
        const candidate = pickString(record[key]);
        if (!candidate) continue;
        const normalized = normalizePhoneNumber(candidate);
        if (normalized && !out.includes(normalized)) out.push(normalized);
        break;
      }
    }
    if (out.length >= SELLER_PHONE_MAX) break;
  }
  return out.slice(0, SELLER_PHONE_MAX);
}

/** Parses the AUTO.RIA `users/phones` payload in any known shape. */
export function parseAutoRiaPhones(data: unknown): string[] {
  const collected = collectPhoneCandidates(data);
  const out: string[] = [];
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const phones = record.phones;
    if (Array.isArray(phones)) {
      for (const entry of phones) {
        if (typeof entry === "string") {
          const normalized = normalizePhoneNumber(entry);
          if (normalized && !out.includes(normalized)) out.push(normalized);
          continue;
        }
        if (entry && typeof entry === "object") {
          const row = entry as Record<string, unknown>;
          for (const key of ["phoneFormatted", "phone", "number"]) {
            const candidate = pickString(row[key]);
            if (!candidate) continue;
            const normalized = normalizePhoneNumber(candidate);
            if (normalized && !out.includes(normalized)) out.push(normalized);
            break;
          }
        }
        if (out.length >= SELLER_PHONE_MAX) break;
      }
    }
  }
  for (const phone of collected) {
    if (!out.includes(phone)) out.push(phone);
    if (out.length >= SELLER_PHONE_MAX) break;
  }
  return out.slice(0, SELLER_PHONE_MAX);
}

function extractAutoRiaUserHash(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const root = data as Record<string, unknown>;
  const secure = root.userSecure as Record<string, unknown> | undefined;
  return pickString(secure?.hash) ?? pickString(root.userSecureHash) ?? pickString(root.hash);
}

/**
 * Background-only AUTO.RIA phone lookup (public rotator + phones endpoints).
 * The official developers.ria.com API always masks phones, so the public
 * two-step flow is the only source. Never consumes paid API quota.
 *
 * OLX has no anonymous phone surface: the detail page and prerendered state
 * contain no number, and `limited-phones` answers 400 "Disallowed for this
 * user" without an OLX login session. OLX is therefore text-only.
 */
export async function fetchAutoRiaPhones(externalId: string): Promise<string[]> {
  if (!/^\d+$/u.test(externalId)) return [];
  try {
    const rotator = await sourceHttpClient.json<unknown>(
      `https://auto.ria.com/demo/bu/mainPage/rotator/item/${encodeURIComponent(externalId)}?type=bu&langId=4`,
      { source: "AUTO_RIA", timeoutMs: SELLER_PHONE_TIMEOUT_MS, maxBytes: 512_000 },
    );
    if (rotator.classification !== "SUCCESS" || rotator.data == null) return [];
    const hash = extractAutoRiaUserHash(rotator.data);
    if (!hash) return [];
    const phones = await sourceHttpClient.json<unknown>(
      `https://auto.ria.com/users/phones/${encodeURIComponent(externalId)}?hash=${encodeURIComponent(hash)}`,
      { source: "AUTO_RIA", timeoutMs: SELLER_PHONE_TIMEOUT_MS, maxBytes: 256_000 },
    );
    if (phones.classification !== "SUCCESS" || phones.data == null) return [];
    return parseAutoRiaPhones(phones.data);
  } catch {
    return [];
  }
}

async function readCachedPhones(source: string, externalId: string): Promise<string[] | null> {
  try {
    const cached = await redisConnection.get(cacheKey(source, externalId));
    if (cached == null) return null;
    if (cached === "") return [];
    return splitStoredPhones(cached);
  } catch {
    return null;
  }
}

async function writeCachedPhones(source: string, externalId: string, phones: string[]): Promise<void> {
  try {
    await redisConnection.set(
      cacheKey(source, externalId),
      phones.join(", "),
      "EX",
      phones.length > 0 ? SELLER_PHONE_CACHE_TTL_SECONDS : SELLER_PHONE_NEGATIVE_TTL_SECONDS,
    );
  } catch {
    // Cache is best-effort only; a Redis outage must not fail enrichment.
  }
}

export type SellerPhoneLookup = {
  source: string;
  externalId: string;
  title?: string | null;
  description?: string | null;
  rawData?: unknown;
};

/**
 * Resolves seller phones with zero extra traffic first (text/raw), then at
 * most one cached background lookup per AUTO.RIA listing. OLX exposes no
 * anonymous phone surface, so it stays text-only. Never throws and never
 * touches realtime.
 */
export async function resolveSellerPhones(lookup: SellerPhoneLookup): Promise<string[]> {
  try {
    const haystack = [lookup.title ?? "", lookup.description ?? "", stringifyRaw(lookup.rawData)]
      .filter(Boolean)
      .join("\n");
    const fromText = extractPhonesFromText(haystack);
    if (fromText.length > 0) return fromText;

    if (lookup.source !== "AUTO_RIA") return [];

    const cached = await readCachedPhones(lookup.source, lookup.externalId);
    if (cached) return cached.slice(0, SELLER_PHONE_MAX);

    const fetched = await fetchAutoRiaPhones(lookup.externalId);
    await writeCachedPhones(lookup.source, lookup.externalId, fetched);
    return fetched;
  } catch (error) {
    await log.warn(
      "seller-phone",
      "Не удалось получить номер продавца",
      error instanceof Error ? error.message : String(error),
    ).catch(() => undefined);
    return [];
  }
}

/**
 * Loads the listing, resolves missing phones once, and persists the first
 * result to `listing.sellerPhone`. Best-effort: returns [] on any failure so
 * enrichment and Telegram update never break because of phones.
 */
export async function ensureListingSellerPhone(listingId: string): Promise<string[]> {
  try {
    const listing = await prisma.listing.findUnique({
      where: { id: listingId },
      select: {
        source: true,
        externalId: true,
        title: true,
        description: true,
        sellerPhone: true,
        rawData: true,
      },
    });
    if (!listing) return [];
    const existing = splitStoredPhones(listing.sellerPhone);
    if (existing.length > 0) return existing;
    const phones = await resolveSellerPhones({
      source: listing.source,
      externalId: listing.externalId,
      title: listing.title,
      description: listing.description,
      rawData: listing.rawData,
    });
    if (phones.length === 0) return [];
    await prisma.listing.update({
      where: { id: listingId },
      data: { sellerPhone: phones.join(", ") },
    }).catch(() => undefined);
    return phones;
  } catch {
    return [];
  }
}
