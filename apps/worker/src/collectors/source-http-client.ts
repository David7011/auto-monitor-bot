import { env } from "../env.js";
import { Agent, setGlobalDispatcher } from "undici";
import { readResponseBuffer, ResponseTooLargeError } from "../lib/response-body.js";

export type SourceHttpClassification =
  | "SUCCESS"
  | "EMPTY_RESULT"
  | "NOT_MODIFIED"
  | "RATE_LIMITED"
  | "CHALLENGE"
  | "ACCESS_DENIED"
  | "PARSER_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "INVALID_RESPONSE"
  | "SOURCE_UNAVAILABLE";

export type SourceHttpOptions = {
  source: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  encoding?: "utf8" | "windows-1251";
  acceptedContentTypes?: string[];
};

export type SourceHttpTextResult = {
  requestId: string;
  status: number;
  contentType: string;
  body: string;
  classification: SourceHttpClassification;
  detector?: string;
  retryAfterSeconds?: number;
  errorMessage?: string;
};

export type SourceHttpJsonResult<T> = Omit<SourceHttpTextResult, "body"> & {
  data?: T;
  body?: string;
};

const DEFAULT_ACCEPTED_TEXT = ["text/html", "application/xhtml+xml", "application/xml", "text/plain"];
const DEFAULT_ACCEPTED_JSON = ["application/json", "text/json"];
const CHALLENGE_PATTERNS: Array<{ detector: string; pattern: RegExp }> = [
  { detector: "recaptcha", pattern: /\b(?:g-recaptcha|recaptcha|hcaptcha|h-captcha)\b/iu },
  { detector: "cloudflare-challenge", pattern: /\b(?:cf-chl|cf-browser-verification|challenge-platform|turnstile)\b/iu },
  { detector: "human-verification", pattern: /\b(?:verify you are human|checking your browser|robot or human|unusual traffic)\b/iu },
  { detector: "access-denied", pattern: /\b(?:access denied|forbidden|доступ заборонено|доступ запрещен)\b/iu },
];
const RATE_LIMIT_PATTERNS: Array<{ detector: string; pattern: RegExp }> = [
  { detector: "too-many-requests", pattern: /\b(?:too many requests|rate limit|try again later|429)\b/iu },
  { detector: "temporary-ban", pattern: /\b(?:temporarily blocked|temporary block|заблокировано временно|тимчасово заблоковано)\b/iu },
];
const sourceDispatcher = new Agent({
  connections: env.SOURCE_HTTP_CONNECTIONS_PER_ORIGIN,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 120_000,
  connect: { timeout: 5_000 },
});
setGlobalDispatcher(sourceDispatcher);

export class SourceHttpClient {
  async text(url: string, options: SourceHttpOptions): Promise<SourceHttpTextResult> {
    const requestId = sourceRequestId(options.source);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? env.SOURCE_HTTP_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: requestHeaders(options, requestId),
        body: options.body,
        redirect: "follow",
        signal: controller.signal,
      });

      const contentType = response.headers.get("content-type") ?? "";
      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      const maxBytes = options.maxBytes ?? env.SOURCE_HTTP_MAX_RESPONSE_BYTES;
      if (contentLength > maxBytes) {
        return invalidResponse(requestId, response.status, contentType, retryAfterSeconds, `Response too large: ${contentLength} bytes`);
      }

      let buffer: Buffer;
      try {
        buffer = await readResponseBuffer(response, maxBytes);
      } catch (error) {
        if (error instanceof ResponseTooLargeError) {
          return invalidResponse(requestId, response.status, contentType, retryAfterSeconds, error.message);
        }
        throw error;
      }

      const encoding = options.encoding ?? (contentType.toLowerCase().includes("windows-1251") ? "windows-1251" : "utf8");
      const body = new TextDecoder(encoding).decode(buffer);
      const { classification, detector } = classifyResponse(response.status, contentType, body, options.acceptedContentTypes ?? DEFAULT_ACCEPTED_TEXT);

      return {
        requestId,
        status: response.status,
        contentType,
        body,
        classification,
        detector,
        retryAfterSeconds,
      };
    } catch (error) {
      return {
        requestId,
        status: 0,
        contentType: "",
        body: "",
        classification: isAbortLike(error) ? "TIMEOUT" : "NETWORK_ERROR",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async json<T>(url: string, options: SourceHttpOptions): Promise<SourceHttpJsonResult<T>> {
    const text = await this.text(url, {
      ...options,
      acceptedContentTypes: options.acceptedContentTypes ?? DEFAULT_ACCEPTED_JSON,
    });

    if (text.classification !== "SUCCESS") return text;
    if (!text.body.trim()) return { ...text, classification: "EMPTY_RESULT" };

    try {
      return { ...text, data: JSON.parse(text.body) as T };
    } catch (error) {
      return {
        ...text,
        classification: "PARSER_ERROR",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export const sourceHttpClient = new SourceHttpClient();

export async function closeSourceHttpClient(): Promise<void> {
  await sourceDispatcher.close();
}

function requestHeaders(options: SourceHttpOptions, requestId: string): Headers {
  const headers = new Headers(options.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", env.SOURCE_HTTP_USER_AGENT);
  if (!headers.has("accept")) {
    headers.set(
      "accept",
      options.acceptedContentTypes?.includes("application/json")
        ? "application/json,text/json;q=0.9,*/*;q=0.5"
        : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    );
  }
  if (!headers.has("accept-language")) {
    headers.set("accept-language", "uk-UA,uk;q=0.9,ru-UA;q=0.8,ru;q=0.7,en;q=0.5");
  }
  headers.set("x-request-id", requestId);
  return headers;
}

function classifyResponse(
  status: number,
  contentType: string,
  body: string,
  acceptedContentTypes: string[],
): { classification: SourceHttpClassification; detector?: string } {
  if (status === 304) return { classification: "NOT_MODIFIED" };
  if (status === 429) return { classification: "RATE_LIMITED" };
  if (status === 403) {
    const detector = detectorForBody(body);
    return { classification: detector ? "CHALLENGE" : "ACCESS_DENIED", detector };
  }
  if (status >= 500) return { classification: "SOURCE_UNAVAILABLE" };
  if (status < 200 || status >= 300) return { classification: "INVALID_RESPONSE" };

  const detector = detectorForBody(body);
  if (detector) return { classification: "CHALLENGE", detector };
  if (rateLimitDetectorForBody(body)) return { classification: "RATE_LIMITED" };
  if (!contentTypeAllowed(contentType, acceptedContentTypes)) return { classification: "INVALID_RESPONSE" };
  if (!body.trim()) return { classification: "EMPTY_RESULT" };
  return { classification: "SUCCESS" };
}

function contentTypeAllowed(contentType: string, accepted: string[]): boolean {
  const normalized = contentType.toLowerCase();
  return !normalized || accepted.some((item) => normalized.includes(item));
}

function detectorForBody(body: string): string | undefined {
  const lower = body.slice(0, 20_000).toLowerCase();
  return CHALLENGE_PATTERNS.find((item) => item.pattern.test(lower))?.detector;
}

function rateLimitDetectorForBody(body: string): string | undefined {
  const lower = body.slice(0, 20_000).toLowerCase();
  return RATE_LIMIT_PATTERNS.find((item) => item.pattern.test(lower))?.detector;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
}

function invalidResponse(
  requestId: string,
  status: number,
  contentType: string,
  retryAfterSeconds: number | undefined,
  errorMessage: string,
): SourceHttpTextResult {
  return {
    requestId,
    status,
    contentType,
    body: "",
    classification: "INVALID_RESPONSE",
    retryAfterSeconds,
    errorMessage,
  };
}

function isAbortLike(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function sourceRequestId(source: string): string {
  const safeSource = source.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "source";
  return `${safeSource}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
