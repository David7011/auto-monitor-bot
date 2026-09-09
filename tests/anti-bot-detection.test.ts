import { describe, expect, it } from "vitest";
import { isBlockedHtml, isNetworkTimeoutError } from "../apps/worker/src/collectors/html-utils.js";

describe("anti-bot detection", () => {
  it("classifies HTTP 429 as a rate limit", () => {
    const result = isBlockedHtml(429, "Too many requests");
    expect(result.rateLimited).toBe(true);
    expect(result.limitedReason).toContain("429");
    expect(result.responseStatus).toBe(429);
  });

  it("classifies Cloudflare challenge pages as captcha/anti-bot", () => {
    const result = isBlockedHtml(200, "<title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/h/b/orchestrate/managed/v1'></script>");
    expect(result.captchaDetected).toBe(true);
    expect(result.detector).toBe("cloudflare-challenge-document");
    expect(result.responseStatus).toBe(200);
  });

  it("does not flag normal listing HTML containing a 429 value or CAPTCHA asset", () => {
    const html = [
      "<html><title>cars</title>",
      "<script src='https://www.google.com/recaptcha/api.js'></script>",
      "<script src='/cdn-cgi/challenge-platform/scripts/jsd/main.js'></script>",
      "<article>BMW 320, mileage 429 km</article></html>",
    ].join("");
    expect(isBlockedHtml(200, html)).toEqual({});
  });

  it("classifies document-level verification text with a CAPTCHA widget", () => {
    const html = "<html><h1>Verify that you are human</h1><div class='h-captcha' data-sitekey='key'></div></html>";
    const result = isBlockedHtml(200, html);
    expect(result.captchaDetected).toBe(true);
    expect(result.detector).toBe("captcha-challenge-document");
  });

  it("classifies aborted source fetches as network timeouts", () => {
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";

    expect(isNetworkTimeoutError(abortError)).toBe(true);
    expect(isNetworkTimeoutError(new Error("request timed out after 8000ms"))).toBe(true);
    expect(isNetworkTimeoutError(new Error("HTTP 500"))).toBe(false);
  });
});
