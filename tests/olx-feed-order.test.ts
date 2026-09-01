import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchOlxFeed,
  isAdsResult,
} from "../apps/worker/src/collectors/olx-feed.js";

const openServers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("OLX public feed preference", () => {
  it("uses the public HTML page first and does not call the internal API after success", async () => {
    let apiRequests = 0;
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/api")) {
        apiRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: 999 }] }));
        return;
      }

      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end([
        "<!doctype html>",
        '<div data-cy="l-card" id="123">',
        '<a href="/d/uk/obyavlenie/test-ID123.html"><h4>Test listing</h4></a>',
        "</div>",
      ].join(""));
    });
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port");

    const result = await fetchOlxFeed(
      `http://127.0.0.1:${address.port}/api`,
      `http://127.0.0.1:${address.port}/html`,
      true,
      "OLX_PUBLIC_API",
      "test:html-first",
      "REALTIME",
    );

    expect(isAdsResult(result)).toBe(true);
    if (!isAdsResult(result)) return;
    expect(result.channel).toBe("OLX_PUBLIC_HTML");
    expect(result.ads.map((ad) => String(ad.id))).toEqual(["123"]);
    expect(result.requestCount).toBe(1);
    expect(apiRequests).toBe(0);
  });
});
