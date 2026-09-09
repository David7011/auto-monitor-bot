import { afterEach, describe, expect, it, vi } from "vitest";
import * as html from "../apps/worker/src/collectors/html-utils.js";
import { sourceHttpClient } from "../apps/worker/src/collectors/source-http-client.js";
import { extractRenderedOlxCards, fetchOlxApiFeed, fetchOlxHtmlFeed, isAdsResult } from "../apps/worker/src/collectors/olx-feed.js";

afterEach(() => vi.restoreAllMocks());

function htmlResponse(id: string) {
  return {
    status: 200,
    contentType: "text/html",
    classification: "SUCCESS" as const,
    body: `<div data-cy="l-card" id="${id}"><a href="/d/uk/obyavlenie/test-ID${id}.html"><h4>Test listing</h4></a><p data-testid="ad-price">8 000 $</p></div>`,
    cacheAgeSeconds: 2,
  };
}

describe("OLX concurrent request sharing", () => {
  it("parses only additional rendered cards while retaining every ID missing from structured state", () => {
    const cards = extractRenderedOlxCards(
      htmlResponse("123").body + htmlResponse("124").body,
      new Date(),
      new Set(["123"]),
    );
    expect(cards.map((card) => card.id)).toEqual(["124"]);
    expect(cards[0]?.price?.regularPrice?.value).toBe(8_000);
  });

  it("fetches and parses one HTML response for identical concurrent searches, retaining separate subscribers", async () => {
    const fetch = vi.spyOn(html, "fetchHtml").mockResolvedValue(htmlResponse("123"));
    const [first, second] = await Promise.all([
      fetchOlxHtmlFeed("https://www.olx.ua/uk/transport/", true, "OLX_PUBLIC_HTML", "search:first", "REALTIME"),
      fetchOlxHtmlFeed("https://www.olx.ua/uk/transport/", false, "OLX_REGIONAL_HTML", "search:second", "REALTIME"),
    ]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ primary: true, channel: "OLX_PUBLIC_HTML", observationTarget: "search:first", requestCount: 1 });
    expect(second).toMatchObject({ primary: false, channel: "OLX_REGIONAL_HTML", observationTarget: "search:second", requestCount: 0, cacheAgeSeconds: 2 });
    expect(isAdsResult(first) && isAdsResult(second)).toBe(true);
    if (!isAdsResult(first) || !isAdsResult(second)) return;
    first.ads[0]!.price!.regularPrice!.value = 1;
    first.ads.pop();
    expect(second.ads).toHaveLength(1);
    expect(second.ads[0]!.price!.regularPrice!.value).toBe(8_000);
  });

  it("always fetches again on the next poll instead of returning a stale cached feed", async () => {
    const fetch = vi.spyOn(html, "fetchHtml")
      .mockResolvedValueOnce(htmlResponse("123"))
      .mockResolvedValueOnce(htmlResponse("124"));
    await fetchOlxHtmlFeed("https://www.olx.ua/uk/transport/", true, "OLX_PUBLIC_HTML", "poll:one", "REALTIME");
    const fresh = await fetchOlxHtmlFeed("https://www.olx.ua/uk/transport/", true, "OLX_PUBLIC_HTML", "poll:two", "REALTIME");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(isAdsResult(fresh) && fresh.ads[0]?.id).toBe("124");
    expect(fresh.requestCount).toBe(1);
  });

  it("never attaches realtime to background work or merges different pages", async () => {
    const fetch = vi.spyOn(html, "fetchHtml").mockResolvedValue(htmlResponse("123"));
    const results = await Promise.all([
      fetchOlxHtmlFeed("https://www.olx.ua/uk/transport/", false, "OLX_HTML_COVERAGE", "coverage", "COVERAGE"),
      fetchOlxHtmlFeed("https://www.olx.ua/uk/transport/", true, "OLX_PUBLIC_HTML", "realtime", "REALTIME"),
      fetchOlxHtmlFeed("https://www.olx.ua/uk/transport/?page=2", true, "OLX_PUBLIC_HTML", "page:two", "REALTIME"),
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(results.every((result) => result.requestCount === 1)).toBe(true);
  });

  it("evicts a failed in-flight request so a later scheduled poll can recover", async () => {
    const fetch = vi.spyOn(html, "fetchHtml")
      .mockRejectedValueOnce(new Error("connection closed"))
      .mockResolvedValueOnce(htmlResponse("125"));
    const failed = await Promise.all([
      fetchOlxHtmlFeed("https://www.olx.ua/uk/transport/", true),
      fetchOlxHtmlFeed("https://www.olx.ua/uk/transport/", false),
    ]);
    expect(failed.every((result) => "error" in result)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const recovered = await fetchOlxHtmlFeed("https://www.olx.ua/uk/transport/", true);
    expect(isAdsResult(recovered)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shares matching JSON fallbacks but keeps different request deadlines independent", async () => {
    const fetch = vi.spyOn(sourceHttpClient, "json").mockResolvedValue({
      requestId: "test",
      status: 200,
      contentType: "application/json",
      classification: "SUCCESS",
      data: { data: [{ id: 126, url: "https://www.olx.ua/d/test-ID126.html" }] },
    });
    const results = await Promise.all([
      fetchOlxApiFeed("https://www.olx.ua/api/v1/offers", true, 2_000, "OLX_PUBLIC_API", "first", "REALTIME"),
      fetchOlxApiFeed("https://www.olx.ua/api/v1/offers", false, 2_000, "OLX_REGIONAL_API", "second", "REALTIME"),
      fetchOlxApiFeed("https://www.olx.ua/api/v1/offers", true, 5_000, "OLX_PUBLIC_API", "third", "REALTIME"),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.requestCount)).toEqual([1, 0, 1]);
    expect(results.every(isAdsResult)).toBe(true);
  });
});
