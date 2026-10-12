import { describe, expect, it, vi } from "vitest";

vi.mock("../packages/db/src/index.js", () => ({ prisma: {} }));
vi.mock("../apps/worker/src/env.js", () => ({ env: {} }));
vi.mock("../apps/worker/src/lib/queues.js", () => ({
  redisConnection: { get: vi.fn(), set: vi.fn() },
}));
vi.mock("../apps/worker/src/lib/log.js", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../apps/worker/src/lib/browser.js", () => ({
  chromium: {},
  resolveBundledChromiumExecutable: () => "",
  projectRootDir: () => "",
}));
vi.mock("../apps/worker/src/collectors/html-utils.js", () => ({ fetchHtml: vi.fn() }));

import { detectBodyProtection } from "../apps/worker/src/collectors/source-http-client.js";
import { detectChallengeKind } from "../apps/worker/src/modules/challenge-solver.js";

/**
 * The collector gate (detectBodyProtection) decides pause + solver trigger;
 * the solver (detectChallengeKind) decides how to act. A challenge the
 * collector cannot see never reaches the solver, so both must agree on
 * challenge pages while listing pages with embedded contact-form captchas
 * stay clean on the collector side.
 */
describe("protection marker sync (collector vs solver)", () => {
  it("flags a Cloudflare interstitial on both sides", () => {
    const body = [
      "<html><head><title>Just a moment...</title></head><body>",
      "<h1>Performing security verification</h1>",
      '<script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/8d.js"></script>',
      "</body></html>",
    ].join("");
    expect(detectBodyProtection("text/html", body)?.classification).toBe("CHALLENGE");
    expect(detectChallengeKind({ title: "Just a moment...", bodyExcerpt: body, frameSrcs: [] })).not.toBe("CLEAN");
  });

  it("flags a PerimeterX press-and-hold living in divs (no h1)", () => {
    const body = [
      "<html><head><title>Access denied</title></head><body>",
      "<div>Press & Hold to confirm you are human (and not a bot)</div>",
      '<script>window._pxAppId = "PX123";</script><script src="captcha.js"></script>',
      '<div id="px-captcha"></div>',
      "</body></html>",
    ].join("");
    const signal = detectBodyProtection("text/html", body);
    expect(signal?.classification).toBe("CHALLENGE");
    expect(signal?.detector).toBe("challenge-document-markers");
    expect(detectChallengeKind({ title: "Access denied", bodyExcerpt: body, frameSrcs: [] })).toBe("PX_PRESS_HOLD");
  });

  it("flags Turnstile by frame plus prose on both sides", () => {
    const body = "<html><head><title>Verify</title></head><body><p>Verify you are human</p></body></html>";
    const frames = ["https://challenges.cloudflare.com/turnstile/v0/api.js"];
    expect(detectBodyProtection("text/html", body)?.classification).not.toBe("CHALLENGE");
    const withWidget = `${body}<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>`;
    expect(detectBodyProtection("text/html", withWidget)?.classification).toBe("CHALLENGE");
    expect(detectChallengeKind({ title: "Verify", bodyExcerpt: withWidget, frameSrcs: frames })).toBe("TURNSTILE");
  });

  it("keeps a listing page with a contact-form captcha clean for the collector", () => {
    const body = [
      "<html><head><title>Buy a car</title></head><body>",
      '<div data-cy="l-card">car 1</div><div data-cy="l-card">car 2</div>',
      '<form id="contact"><div class="g-recaptcha" data-sitekey="abc"></div></form>',
      "</body></html>",
    ].join("");
    expect(detectBodyProtection("text/html", body)).toBeUndefined();
  });

  it("keeps access-denied headings on the ACCESS_DENIED path", () => {
    const body = "<html><head><title>Access denied</title></head><body><h1>Access denied</h1></body></html>";
    expect(detectBodyProtection("text/html", body)?.classification).toBe("ACCESS_DENIED");
  });
});
