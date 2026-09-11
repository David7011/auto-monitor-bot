import { describe, expect, it } from "vitest";
import { isBlockedHtml, isNetworkTimeoutError } from "../apps/worker/src/collectors/html-utils.js";

describe("anti-bot detection", () => {
  it("classifies HTTP 429 as a rate limit", () => {
    const result = isBlockedHtml(429, "Too many requests");
    expect(result.rateLimited).toBe(true);
    expect(result.limitedReason).toContain("429");
    expect(result.responseStatus).toBe(429);
  });

  it("classifies a bare HTTP 403 as access denied, never as CAPTCHA", () => {
    const result = isBlockedHtml(403, "Forbidden");
    expect(result).toMatchObject({
      rateLimited: true,
      accessDenied: true,
      detector: "http-403-access-denied",
      responseStatus: 403,
    });
    expect(result.captchaDetected).toBeUndefined();
    expect(result.limitedReason).toContain("без подтверждённой CAPTCHA");
  });

  it("preserves an upstream ACCESS_DENIED classification without reclassifying it", () => {
    const result = isBlockedHtml(403, "<html><title>Forbidden</title></html>", undefined, {
      classification: "ACCESS_DENIED",
      detector: "access-denied-document",
      contentType: "text/html",
    });
    expect(result).toMatchObject({
      rateLimited: true,
      accessDenied: true,
      detector: "access-denied-document",
      responseStatus: 403,
    });
    expect(result.captchaDetected).toBeUndefined();
  });

  it("assigns the precise bare-403 detector when upstream has no body detector", () => {
    const result = isBlockedHtml(403, "Forbidden", undefined, {
      classification: "ACCESS_DENIED",
      contentType: "text/plain",
    });
    expect(result).toMatchObject({
      rateLimited: true,
      accessDenied: true,
      detector: "http-403-access-denied",
      responseStatus: 403,
    });
    expect(result.captchaDetected).toBeUndefined();
  });

  it("keeps an authoritative Cloudflare challenge distinct from a bare 403", () => {
    const result = isBlockedHtml(403, "opaque body", undefined, {
      classification: "CHALLENGE",
      detector: "cloudflare-cf-mitigated",
      contentType: "text/html",
    });
    expect(result).toMatchObject({
      captchaDetected: true,
      detector: "cloudflare-cf-mitigated",
      responseStatus: 403,
    });
    expect(result.rateLimited).toBeUndefined();
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
