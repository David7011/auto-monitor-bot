import { env } from "../env.js";
import { Agent, setGlobalDispatcher } from "undici";
import { readResponseBuffer, ResponseTooLargeError } from "../lib/response-body.js";
import {
  OlxCircuitOpenError,
  type OlxRequestCoordinator,
  olxRequestCoordinator,
  type OlxRequestClass,
} from "../modules/olx-request-coordinator.js";

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
  requestClass?: OlxRequestClass;
};

export type SourceHttpTextResult = {
  requestId: string;
  coordinatorQueuedAt?: Date;
  coordinatorStartedAt?: Date;
  coordinatorWaitMs?: number;
  coordinatorPostFinishQuietMs?: number;
  requestStartedAt?: Date;
  firstByteAt?: Date;
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

type SourceHttpClientDependencies = {
  sleep?: (milliseconds: number) => Promise<void>;
  transientRetryCount?: number;
  transientRetryBaseDelayMs?: number;
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
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly transientRetryCount: number;
  private readonly transientRetryBaseDelayMs: number;

  constructor(
    private readonly olxCoordinator: OlxRequestCoordinator = olxRequestCoordinator,
    dependencies: SourceHttpClientDependencies = {},
  ) {
    this.sleep = dependencies.sleep
      ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.transientRetryCount = dependencies.transientRetryCount
      ?? env.SOURCE_HTTP_TRANSIENT_RETRY_COUNT;
    this.transientRetryBaseDelayMs = dependencies.transientRetryBaseDelayMs
      ?? env.SOURCE_HTTP_TRANSIENT_RETRY_BASE_DELAY_MS;
  }

  async text(url: string, options: SourceHttpOptions): Promise<SourceHttpTextResult> {
    const operation = (signal?: AbortSignal) =>
      this.performTextRequestWithTransientRetries(url, options, signal);
    if (options.source !== "OLX") return operation();

    try {
      let coordinatorTiming: {
        queuedAt: Date;
        coordinatorStartedAt: Date;
        coordinatorWaitMs: number;
        postFinishQuietMs: number;
      } | undefined;
      const result = await this.olxCoordinator.run(
        options.requestClass ?? "ENRICHMENT",
        operation,
        (timing) => { coordinatorTiming = timing; },
      );
      return coordinatorTiming
        ? {
            ...result,
            coordinatorQueuedAt: coordinatorTiming.queuedAt,
            coordinatorStartedAt: coordinatorTiming.coordinatorStartedAt,
            coordinatorWaitMs: coordinatorTiming.coordinatorWaitMs,
            coordinatorPostFinishQuietMs: coordinatorTiming.postFinishQuietMs,
          }
        : result;
    } catch (error) {
      if (!(error instanceof OlxCircuitOpenError)) throw error;
      return {
        requestId: sourceRequestId(options.source),
        status: 0,
        contentType: "",
        body: "",
        classification: error.classification,
        detector: "olx-local-circuit-breaker",
        retryAfterSeconds: error.retryAfterSeconds,
        errorMessage: error.message,
      };
    }
  }

  private async performTextRequestWithTransientRetries(
    url: string,
    options: SourceHttpOptions,
    preemptionSignal?: AbortSignal,
  ): Promise<SourceHttpTextResult> {
    const retryCount = options.method === "POST" ? 0 : Math.max(0, this.transientRetryCount);
    for (let attempt = 0; ; attempt += 1) {
      preemptionSignal?.throwIfAborted();
      const result = await this.performTextRequest(url, options, preemptionSignal);
      if (
        attempt >= retryCount
        || result.classification !== "NETWORK_ERROR"
        || !isTransientDnsFailure(result.errorMessage)
      ) {
        return result;
      }

      const delayMs = Math.min(
        10_000,
        Math.max(0, this.transientRetryBaseDelayMs) * (2 ** attempt),
      );
      if (delayMs > 0) await sleepWithAbort(this.sleep, delayMs, preemptionSignal);
    }
  }

  private async performTextRequest(
    url: string,
    options: SourceHttpOptions,
    preemptionSignal?: AbortSignal,
  ): Promise<SourceHttpTextResult> {
    const requestId = sourceRequestId(options.source);
    const requestStartedAt = new Date();
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new DOMException("Source HTTP request timed out", "TimeoutError")),
      options.timeoutMs ?? env.SOURCE_HTTP_TIMEOUT_MS,
    );
    const requestSignal = preemptionSignal
      ? AbortSignal.any([preemptionSignal, timeoutController.signal])
      : timeoutController.signal;

    try {
      requestSignal.throwIfAborted();
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: requestHeaders(options, requestId),
        body: options.body,
        redirect: "follow",
        signal: requestSignal,
      });
      const firstByteAt = new Date();

      const contentType = response.headers.get("content-type") ?? "";
      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      const maxBytes = options.maxBytes ?? env.SOURCE_HTTP_MAX_RESPONSE_BYTES;
      if (contentLength > maxBytes) {
        return invalidResponse(requestId, response.status, contentType, retryAfterSeconds, `Response too large: ${contentLength} bytes`, requestStartedAt, firstByteAt);
      }

      let buffer: Buffer;
      try {
        buffer = await readResponseBuffer(response, maxBytes);
      } catch (error) {
        if (error instanceof ResponseTooLargeError) {
          return invalidResponse(requestId, response.status, contentType, retryAfterSeconds, error.message, requestStartedAt, firstByteAt);
        }
        throw error;
      }

      const encoding = options.encoding ?? (contentType.toLowerCase().includes("windows-1251") ? "windows-1251" : "utf8");
      const body = new TextDecoder(encoding).decode(buffer);
      const { classification, detector } = classifyResponse(response.status, contentType, body, options.acceptedContentTypes ?? DEFAULT_ACCEPTED_TEXT);

      return {
        requestId,
        requestStartedAt,
        firstByteAt,
        status: response.status,
        contentType,
        body,
        classification,
        detector,
        retryAfterSeconds,
      };
    } catch (error) {
      if (preemptionSignal?.aborted) {
        throw preemptionSignal.reason instanceof Error
          ? preemptionSignal.reason
          : new Error("OLX request preempted without an abort reason");
      }
      return {
        requestId,
        requestStartedAt,
        status: 0,
        contentType: "",
        body: "",
        classification: isAbortLike(error) ? "TIMEOUT" : "NETWORK_ERROR",
        errorMessage: networkErrorMessage(error),
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

async function sleepWithAbort(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return sleep(milliseconds);
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(
      signal.reason instanceof Error ? signal.reason : new Error("OLX request preempted"),
    ));
    signal.addEventListener("abort", onAbort, { once: true });
    void sleep(milliseconds).then(
      () => finish(resolve),
      (error) => finish(() => reject(error)),
    );
  });
  signal.throwIfAborted();
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

function networkErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof Error) || !error.cause) return message;
  if (error.cause instanceof Error) return `${message}: ${error.cause.message}`;
  if (typeof error.cause === "object") {
    const cause = error.cause as { code?: unknown; message?: unknown };
    const details = [cause.code, cause.message]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ");
    if (details) return `${message}: ${details}`;
  }
  return message;
}

export function isTransientDnsFailure(message: string | undefined): boolean {
  return /\b(?:ENOTFOUND|EAI_AGAIN|ENETDOWN|ENETUNREACH|WSAHOST_NOT_FOUND|WSATRY_AGAIN)\b/iu
    .test(message ?? "");
}

function invalidResponse(
  requestId: string,
  status: number,
  contentType: string,
  retryAfterSeconds: number | undefined,
  errorMessage: string,
  requestStartedAt?: Date,
  firstByteAt?: Date,
): SourceHttpTextResult {
  return {
    requestId,
    requestStartedAt,
    firstByteAt,
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
