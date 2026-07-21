import { afterEach, describe, expect, it, vi } from "vitest";
import { SOURCE_CAPABILITIES } from "../packages/shared/src/types/source-capabilities.js";
import { SourceHttpClient } from "../apps/worker/src/collectors/source-http-client.js";

describe("SourceHttpClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies HTTP 429 as RATE_LIMITED and preserves Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Too many requests", { status: 429, headers: { "retry-after": "30", "content-type": "text/html" } })),
    );

    const result = await new SourceHttpClient().text("https://example.test/list", { source: "OLX" });
    expect(result.classification).toBe("RATE_LIMITED");
    expect(result.retryAfterSeconds).toBe(30);
    expect(result.requestId).toMatch(/^olx-/);
  });

  it("classifies challenge pages without treating them as parser errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<script src='/cdn-cgi/challenge-platform/h/b/orchestrate'></script>", { status: 200, headers: { "content-type": "text/html" } })),
    );

    const result = await new SourceHttpClient().text("https://example.test/list", { source: "CARS_UA" });
    expect(result.classification).toBe("CHALLENGE");
    expect(result.detector).toBe("cloudflare-challenge");
  });

  it("enforces response size limit before parsing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("large", { status: 200, headers: { "content-length": "100", "content-type": "text/html" } })),
    );

    const result = await new SourceHttpClient().text("https://example.test/list", { source: "RST", maxBytes: 10 });
    expect(result.classification).toBe("INVALID_RESPONSE");
    expect(result.errorMessage).toContain("Response too large");
  });

  it("parses JSON only after a successful HTTP classification", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ids: [1, 2] }), { status: 200, headers: { "content-type": "application/json" } })),
    );

    const result = await new SourceHttpClient().json<{ ids: number[] }>("https://example.test/api", { source: "AUTO_RIA" });
    expect(result.classification).toBe("SUCCESS");
    expect(result.data?.ids).toEqual([1, 2]);
  });
});

describe("source capability contract", () => {
  it("keeps official and public HTTP source capabilities explicit", () => {
    expect(SOURCE_CAPABILITIES.OLX.accessMode).toBe("PUBLIC_HTTP");
    expect(SOURCE_CAPABILITIES.OLX.supportsPolling).toBe(true);
    expect(SOURCE_CAPABILITIES.AUTO_RIA.accessMode).toBe("OFFICIAL_API");
  });
});
