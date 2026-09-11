import {
  detectBodyProtection,
  sourceHttpClient,
  type SourceHttpClassification,
} from "./source-http-client.js";
import type { OlxRequestClass } from "../modules/olx-request-coordinator.js";
import type { SourceNetworkTelemetry } from "./source-http-network-telemetry.js";

export type BlockedHtmlResult = {
  rateLimited?: boolean;
  captchaDetected?: boolean;
  /** The source refused this request, but no interactive challenge was proven. */
  accessDenied?: boolean;
  limitedReason?: string;
  detector?: string;
  retryAfterSeconds?: number;
  responseStatus?: number;
};

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
  bodyReceivedAt?: Date;
  cacheAgeSeconds?: number;
  coordinatorWaitMs?: number;
  coordinatorPostFinishQuietMs?: number;
  network?: SourceNetworkTelemetry;
  classification: SourceHttpClassification;
  detector?: string;
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
    bodyReceivedAt: response.bodyReceivedAt,
    cacheAgeSeconds: response.cacheAgeSeconds,
    coordinatorWaitMs: response.coordinatorWaitMs,
    coordinatorPostFinishQuietMs: response.coordinatorPostFinishQuietMs,
    network: response.network,
    classification: response.classification,
    detector: response.detector,
  };
}

export function isBlockedHtml(
  status: number,
  body: string,
  retryAfterSeconds?: number,
  upstream?: { classification: SourceHttpClassification; detector?: string; contentType?: string },
): BlockedHtmlResult {
  if (status === 429) {
    return {
      rateLimited: true,
      detector: "http-429",
      limitedReason: "Источник вернул HTTP 429. Проверки поставлены на паузу без агрессивных повторов.",
      retryAfterSeconds,
      responseStatus: status,
    };
  }

  const signal = upstream?.classification === "CHALLENGE"
      || upstream?.classification === "RATE_LIMITED"
      || upstream?.classification === "ACCESS_DENIED"
    ? {
        classification: upstream.classification,
        detector: upstream.detector
          ?? (upstream.classification === "ACCESS_DENIED" && status === 403
            ? "http-403-access-denied"
            : "source-http-classification"),
      }
    : detectBodyProtection(upstream?.contentType ?? "text/html", body);
  if (signal?.classification === "CHALLENGE") return {
    captchaDetected: true,
    detector: signal.detector,
    limitedReason: `Обнаружена CAPTCHA или защитная страница (${signal.detector}). Источник поставлен на паузу.`,
    responseStatus: status,
  };
  if (signal?.classification === "RATE_LIMITED") return {
    rateLimited: true,
    detector: signal.detector,
    limitedReason: `Обнаружено ограничение запросов или временная блокировка (${signal.detector}). Источник поставлен на паузу.`,
    retryAfterSeconds,
    responseStatus: status,
  };
  if (signal?.classification === "ACCESS_DENIED") return {
    rateLimited: true,
    accessDenied: true,
    detector: signal.detector ?? "http-403-access-denied",
    limitedReason: status === 403
      ? "Источник вернул HTTP 403 без подтверждённой CAPTCHA; включена безопасная пауза без агрессивных повторов."
      : `Источник отклонил доступ без подтверждённой CAPTCHA (${signal.detector ?? "access-denied"}); включена безопасная пауза.`,
    responseStatus: status,
  };

  if (status === 403) {
    return {
      rateLimited: true,
      accessDenied: true,
      detector: "http-403-access-denied",
      limitedReason: "Источник вернул HTTP 403 без подтверждённой CAPTCHA; включена безопасная пауза без агрессивных повторов.",
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
