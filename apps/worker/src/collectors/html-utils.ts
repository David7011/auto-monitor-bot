import { sourceHttpClient } from "./source-http-client.js";
import type { OlxRequestClass } from "../modules/olx-request-coordinator.js";

export type BlockedHtmlResult = {
  rateLimited?: boolean;
  captchaDetected?: boolean;
  limitedReason?: string;
  detector?: string;
  retryAfterSeconds?: number;
  responseStatus?: number;
};

const CAPTCHA_PATTERNS: Array<{ detector: string; pattern: RegExp }> = [
  { detector: "recaptcha", pattern: /\b(?:g-recaptcha|recaptcha|hcaptcha|h-captcha)\b/iu },
  { detector: "cloudflare-challenge", pattern: /\b(?:cf-chl|cf-browser-verification|challenge-platform|turnstile)\b/iu },
  { detector: "human-verification", pattern: /\b(?:verify you are human|checking your browser|robot or human|unusual traffic)\b/iu },
  { detector: "access-denied", pattern: /\b(?:access denied|forbidden|доступ заборонено|доступ запрещен)\b/iu },
];

const RATE_LIMIT_PATTERNS: Array<{ detector: string; pattern: RegExp }> = [
  { detector: "too-many-requests", pattern: /\b(?:too many requests|rate limit|try again later|429)\b/iu },
  { detector: "temporary-ban", pattern: /\b(?:temporarily blocked|temporary block|заблокировано временно|тимчасово заблоковано)\b/iu },
];

export async function fetchHtml(
  url: string,
  options: {
    encoding?: "utf8" | "windows-1251";
    timeoutMs?: number;
    source?: string;
    headers?: Record<string, string>;
    requestClass?: OlxRequestClass;
  } = {},
): Promise<{
  status: number;
  contentType: string;
  body: string;
  retryAfterSeconds?: number;
  requestStartedAt?: Date;
  firstByteAt?: Date;
  coordinatorWaitMs?: number;
  coordinatorPostFinishQuietMs?: number;
}> {
  const response = await sourceHttpClient.text(url, {
    source: options.source ?? "PUBLIC_HTTP",
    timeoutMs: options.timeoutMs,
    encoding: options.encoding,
    headers: options.headers,
    requestClass: options.requestClass,
  });

  if (response.classification === "TIMEOUT") {
    throw new Error(response.errorMessage ?? "Source HTTP request timed out");
  }
  if (response.classification === "NETWORK_ERROR") {
    throw new Error(response.errorMessage ?? "Source HTTP network error");
  }

  return {
    status: response.status,
    contentType: response.contentType,
    body: response.body,
    retryAfterSeconds: response.retryAfterSeconds,
    requestStartedAt: response.requestStartedAt,
    firstByteAt: response.firstByteAt,
    coordinatorWaitMs: response.coordinatorWaitMs,
    coordinatorPostFinishQuietMs: response.coordinatorPostFinishQuietMs,
  };
}

export function isBlockedHtml(status: number, body: string, retryAfterSeconds?: number): BlockedHtmlResult {
  if (status === 429) {
    return {
      rateLimited: true,
      detector: "http-429",
      limitedReason: "Источник вернул HTTP 429. Проверки поставлены на паузу без агрессивных повторов.",
      retryAfterSeconds,
      responseStatus: status,
    };
  }

  const lower = body.slice(0, 20_000).toLowerCase();

  for (const item of CAPTCHA_PATTERNS) {
    if (item.pattern.test(lower)) {
      return {
        captchaDetected: true,
        detector: item.detector,
        limitedReason: `Обнаружена CAPTCHA или защитная страница (${item.detector}). Источник поставлен на паузу.`,
        responseStatus: status,
      };
    }
  }

  for (const item of RATE_LIMIT_PATTERNS) {
    if (item.pattern.test(lower)) {
      return {
        rateLimited: true,
        detector: item.detector,
        limitedReason: `Обнаружено ограничение запросов или временная блокировка (${item.detector}). Источник поставлен на паузу.`,
        retryAfterSeconds,
        responseStatus: status,
      };
    }
  }

  if (status === 403) {
    return {
      captchaDetected: true,
      detector: "http-403",
      limitedReason: "Источник вернул защитный ответ HTTP 403 и поставлен на паузу.",
      responseStatus: status,
    };
  }

  return {};
}

export function isNetworkTimeoutError(error: unknown, fallbackMessage = ""): boolean {
  const message = error instanceof Error ? error.message : fallbackMessage || String(error);
  if (error instanceof Error && error.name === "AbortError") return true;
  if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") return true;
  return /\b(?:aborted|aborterror|timeout|timed out)\b/i.test(message);
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => fromCodePointSafe(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => fromCodePointSafe(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // &amp; is decoded last so an escaped entity like "&amp;lt;" survives as the
    // literal "&lt;" instead of collapsing into "<".
    .replace(/&amp;/g, "&");
}

function fromCodePointSafe(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  return String.fromCodePoint(code);
}

export function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function absoluteUrl(url: string, base: string): string {
  if (url.startsWith("//")) return `https:${url}`;
  return new URL(url, base).toString();
}

export function withPageNumber(value: string, page: number, parameter = "page"): string {
  const url = new URL(value);
  if (page <= 1) url.searchParams.delete(parameter);
  else url.searchParams.set(parameter, String(page));
  return url.toString();
}

export function parseInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseEngineVolume(value: string | undefined): number | undefined {
  if (!value) return undefined;
  // The bare "л" unit must not match the "л" inside "л.с." / "лс" (horsepower),
  // otherwise a power-only string like "150 л.с." is misread as 150cc.
  const match = value.match(/(?<volume>\d{1,2}(?:[.,]\d{1,2})?|\d{3,4})\s*(?:л(?!\.?\s*с)|l|см3|cm3|куб)/i);
  const raw = match?.groups?.volume;
  if (!raw) return undefined;

  const parsed = Number.parseFloat(raw.replace(",", "."));
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed > 20 ? Math.round((parsed / 1000) * 10) / 10 : parsed;
}

export function parseEnginePower(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/(?<power>\d{2,4})\s*(?:л\.?\s*с\.?|лс|hp|к\.?\s*с\.?)/i);
  return parseInteger(match?.groups?.power);
}

export function inferCustomsCleared(value: string): boolean | undefined {
  const text = value.toLowerCase();
  if (/не\s*(растамож|розмитн)|нерозмит|нерастамож/.test(text)) return false;
  if (/растамож|розмитн/.test(text)) return true;
  return undefined;
}

export function inferBargainPossible(value: string): boolean | undefined {
  const text = value.toLowerCase();
  if (/без\s+торг|торг\s+не/.test(text)) return false;
  if (/торг|торговаться|можливий\s+торг/.test(text)) return true;
  return undefined;
}
