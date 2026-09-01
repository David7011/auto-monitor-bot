import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { SOURCE_CAPABILITIES } from "../packages/shared/src/types/source-capabilities.js";
import { SourceHttpClient } from "../apps/worker/src/collectors/source-http-client.js";
import { OlxRequestCoordinator } from "../apps/worker/src/modules/olx-request-coordinator.js";

describe("SourceHttpClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies HTTP 429 as RATE_LIMITED and preserves Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Too many requests", { status: 429, headers: { "retry-after": "30", "content-type": "text/html" } })),
    );

    const client = freshSourceHttpClient();
    const result = await client.text("https://example.test/list", { source: "OLX" });
    expect(result.classification).toBe("RATE_LIMITED");
    expect(result.retryAfterSeconds).toBe(30);
    expect(result.requestId).toMatch(/^olx-/);
    expect(result.requestStartedAt).toBeInstanceOf(Date);
    expect(result.firstByteAt).toBeInstanceOf(Date);
    expect(result.firstByteAt!.getTime()).toBeGreaterThanOrEqual(result.requestStartedAt!.getTime());
    expect(result.coordinatorQueuedAt).toBeInstanceOf(Date);
    expect(result.coordinatorStartedAt).toBeInstanceOf(Date);
    expect(result.coordinatorWaitMs).toBeGreaterThanOrEqual(0);
    expect(result.coordinatorWaitMs).toBeLessThan(100);
    expect(result.coordinatorPostFinishQuietMs).toBe(0);

    const blockedLocally = await client.text("https://example.test/list", { source: "OLX" });
    expect(blockedLocally.classification).toBe("RATE_LIMITED");
    expect(blockedLocally.detector).toBe("olx-local-circuit-breaker");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("classifies challenge pages without treating them as parser errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<script src='/cdn-cgi/challenge-platform/h/b/orchestrate'></script>", { status: 200, headers: { "content-type": "text/html" } })),
    );

    const result = await freshSourceHttpClient().text("https://example.test/list", { source: "CARS_UA" });
    expect(result.classification).toBe("CHALLENGE");
    expect(result.detector).toBe("cloudflare-challenge");
  });

  it("enforces response size limit before parsing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("large", { status: 200, headers: { "content-length": "100", "content-type": "text/html" } })),
    );

    const result = await freshSourceHttpClient().text("https://example.test/list", { source: "RST", maxBytes: 10 });
    expect(result.classification).toBe("INVALID_RESPONSE");
    expect(result.errorMessage).toContain("Response too large");
  });

  it("parses JSON only after a successful HTTP classification", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ids: [1, 2] }), { status: 200, headers: { "content-type": "application/json" } })),
    );

    const result = await freshSourceHttpClient().json<{ ids: number[] }>("https://example.test/api", { source: "AUTO_RIA" });
    expect(result.classification).toBe("SUCCESS");
    expect(result.data?.ids).toEqual([1, 2]);
  });

  it("preserves the underlying network cause for diagnostics", async () => {
    const error = new TypeError("fetch failed");
    error.cause = { code: "ECONNRESET", message: "socket hang up" };
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw error;
    }));

    const result = await freshSourceHttpClient().text("https://example.test/list", { source: "OLX" });
    expect(result.classification).toBe("NETWORK_ERROR");
    expect(result.requestStartedAt).toBeInstanceOf(Date);
    expect(result.firstByteAt).toBeUndefined();
    expect(result.errorMessage).toContain("ECONNRESET");
    expect(result.errorMessage).toContain("socket hang up");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries bounded DNS failures after resume without retrying HTTP protection", async () => {
    const dnsError = new TypeError("fetch failed");
    dnsError.cause = { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND example.test" };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(dnsError)
      .mockRejectedValueOnce(dnsError)
      .mockResolvedValueOnce(new Response("ok", {
        status: 200,
        headers: { "content-type": "text/html" },
      }));
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);

    const client = new SourceHttpClient(new OlxRequestCoordinator({
      maxBackgroundConcurrency: 1,
      backgroundMinIntervalMs: 0,
      backgroundQuietAfterRealtimeMs: 0,
      postFinishQuietMs: 0,
      rateLimitPauseMs: 1_000,
      challengePauseMs: 1_000,
    }), {
      sleep,
      transientRetryCount: 3,
      transientRetryBaseDelayMs: 1_000,
    });
    const result = await client.text("https://example.test/list", { source: "CARS_UA" });

    expect(result.classification).toBe("SUCCESS");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2_000);
  });

  it("aborts an in-flight OLX backfill fetch and resumes it after realtime", async () => {
    const order: string[] = [];
    let backfillAttempt = 0;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("backfill")) {
        backfillAttempt += 1;
        order.push(`backfill-${backfillAttempt}`);
        if (backfillAttempt === 1) {
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return reject(new Error("missing AbortSignal"));
            signal.addEventListener("abort", () => {
              order.push("backfill-aborted");
              reject(signal.reason);
            }, { once: true });
          });
        }
      } else {
        order.push("realtime");
      }
      return Promise.resolve(new Response("ok", {
        status: 200,
        headers: { "content-type": "text/html" },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const coordinator = new OlxRequestCoordinator({
      maxBackgroundConcurrency: 1,
      backgroundMinIntervalMs: 0,
      backgroundQuietAfterRealtimeMs: 0,
      postFinishQuietMs: 0,
    });
    const client = new SourceHttpClient(coordinator, { transientRetryCount: 0 });

    const backfill = client.text("https://example.test/backfill", {
      source: "OLX",
      requestClass: "BACKFILL",
    });
    await waitUntil(() => coordinator.snapshot().activeBackgroundClass === "BACKFILL");
    const realtime = client.text("https://example.test/realtime", {
      source: "OLX",
      requestClass: "REALTIME",
    });

    await expect(realtime).resolves.toMatchObject({ classification: "SUCCESS" });
    await expect(backfill).resolves.toMatchObject({ classification: "SUCCESS" });
    expect(order).toEqual(["backfill-1", "backfill-aborted", "realtime", "backfill-2"]);
    expect(coordinator.snapshot().realtimePreemptions).toBe(1);
  });

  it("closes the real backfill HTTP socket before transparently replaying it", async () => {
    const order: string[] = [];
    let backfillAttempt = 0;
    let resolveFirstStarted!: () => void;
    let resolveFirstClosed!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    const firstClosed = new Promise<void>((resolve) => {
      resolveFirstClosed = resolve;
    });
    const server = createServer((request, response) => {
      if (request.url === "/backfill") {
        backfillAttempt += 1;
        order.push(`backfill-${backfillAttempt}`);
        if (backfillAttempt === 1) {
          response.once("close", () => {
            if (response.writableEnded) return;
            order.push("backfill-socket-closed");
            resolveFirstClosed();
          });
          resolveFirstStarted();
          return;
        }
      } else {
        order.push("realtime");
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end("ok");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback server has no TCP address");

    try {
      const coordinator = new OlxRequestCoordinator({
        maxBackgroundConcurrency: 1,
        backgroundMinIntervalMs: 0,
        backgroundQuietAfterRealtimeMs: 0,
        postFinishQuietMs: 0,
      });
      const client = new SourceHttpClient(coordinator, { transientRetryCount: 0 });
      const origin = `http://127.0.0.1:${address.port}`;
      const backfill = client.text(`${origin}/backfill`, {
        source: "OLX",
        requestClass: "BACKFILL",
        timeoutMs: 5_000,
      });
      await firstStarted;
      const realtime = client.text(`${origin}/realtime`, {
        source: "OLX",
        requestClass: "REALTIME",
        timeoutMs: 5_000,
      });

      await expect(realtime).resolves.toMatchObject({ classification: "SUCCESS" });
      await expect(backfill).resolves.toMatchObject({ classification: "SUCCESS" });
      await firstClosed;
      expect(order.indexOf("backfill-1")).toBeLessThan(order.indexOf("realtime"));
      expect(order.indexOf("realtime")).toBeLessThan(order.indexOf("backfill-2"));
      expect(order).toContain("backfill-socket-closed");
      expect(coordinator.snapshot().realtimePreemptions).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("preempts a background DNS retry delay instead of making realtime wait", async () => {
    const dnsError = new TypeError("fetch failed");
    dnsError.cause = { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND example.test" };
    let backfillAttempt = 0;
    const order: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      if (String(input).includes("backfill")) {
        backfillAttempt += 1;
        order.push(`backfill-fetch-${backfillAttempt}`);
        if (backfillAttempt === 1) return Promise.reject(dnsError);
      } else {
        order.push("realtime-fetch");
      }
      return Promise.resolve(new Response("ok", {
        status: 200,
        headers: { "content-type": "text/html" },
      }));
    }));
    const neverFinishingSleep = vi.fn(() => new Promise<void>(() => undefined));
    const coordinator = new OlxRequestCoordinator({
      maxBackgroundConcurrency: 1,
      backgroundMinIntervalMs: 0,
      backgroundQuietAfterRealtimeMs: 0,
      postFinishQuietMs: 0,
    });
    const client = new SourceHttpClient(coordinator, {
      sleep: neverFinishingSleep,
      transientRetryCount: 1,
      transientRetryBaseDelayMs: 10_000,
    });

    const backfill = client.text("https://example.test/backfill", {
      source: "OLX",
      requestClass: "BACKFILL",
    });
    await waitUntil(() => neverFinishingSleep.mock.calls.length === 1);
    const realtime = client.text("https://example.test/realtime", {
      source: "OLX",
      requestClass: "REALTIME",
    });

    await expect(realtime).resolves.toMatchObject({ classification: "SUCCESS" });
    await expect(backfill).resolves.toMatchObject({ classification: "SUCCESS" });
    expect(order).toEqual(["backfill-fetch-1", "realtime-fetch", "backfill-fetch-2"]);
    expect(coordinator.snapshot().realtimePreemptions).toBe(1);
  });
});

function freshSourceHttpClient(): SourceHttpClient {
  return new SourceHttpClient(new OlxRequestCoordinator({
    maxBackgroundConcurrency: 1,
    backgroundMinIntervalMs: 0,
    backgroundQuietAfterRealtimeMs: 0,
    postFinishQuietMs: 0,
    rateLimitPauseMs: 1_000,
    challengePauseMs: 1_000,
  }), { transientRetryCount: 0 });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

describe("source capability contract", () => {
  it("keeps official and public HTTP source capabilities explicit", () => {
    expect(SOURCE_CAPABILITIES.OLX.accessMode).toBe("PUBLIC_HTTP");
    expect(SOURCE_CAPABILITIES.OLX.supportsPolling).toBe(true);
    expect(SOURCE_CAPABILITIES.AUTO_RIA.accessMode).toBe("OFFICIAL_API");
  });
});
