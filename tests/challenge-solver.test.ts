import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  sourceUpdate: vi.fn(),
  fetchHtml: vi.fn(),
  launchPersistentContext: vi.fn(),
  env: {
    CHALLENGE_SOLVER_ENABLED: true,
    CHALLENGE_SOLVER_TIMEOUT_MS: 5_000,
    CHALLENGE_SOLVER_MIN_INTERVAL_HOURS: 6,
    RST_HARVEST_EXECUTABLE_PATH: "",
    RST_USER_AGENT: "",
    RST_CF_CLEARANCE: "",
    OLX_SESSION_COOKIE: "",
    AUTO_RIA_SESSION_COOKIE: "",
  },
}));

vi.mock("../apps/worker/src/lib/browser.js", () => ({
  chromium: { launchPersistentContext: mocks.launchPersistentContext },
  resolveBundledChromiumExecutable: () => "C:\\fake\\chrome.exe",
  projectRootDir: () => "C:\\fake\\root",
}));
vi.mock("../packages/db/src/index.js", () => ({
  prisma: { source: { update: mocks.sourceUpdate } },
}));
vi.mock("../apps/worker/src/env.js", () => ({ env: mocks.env }));
vi.mock("../apps/worker/src/lib/log.js", () => ({
  log: { warn: mocks.logWarn, info: mocks.logInfo },
}));
vi.mock("../apps/worker/src/lib/queues.js", () => ({
  redisConnection: { get: mocks.redisGet, set: mocks.redisSet },
}));
vi.mock("../apps/worker/src/collectors/html-utils.js", () => ({ fetchHtml: mocks.fetchHtml }));

import {
  attemptChallengeSolve,
  detectChallengeKind,
  kickOffChallengeSolve,
  pressHoldDurationMs,
  shouldAttemptChallengeSolve,
} from "../apps/worker/src/modules/challenge-solver.js";

function fakePage(overrides: Record<string, unknown> = {}) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue("challenge"),
    content: vi.fn().mockResolvedValue("<html>challenge</html>"),
    frames: vi.fn(() => []),
    mouse: {
      move: vi.fn().mockResolvedValue(undefined),
      wheel: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      down: vi.fn().mockResolvedValue(undefined),
      up: vi.fn().mockResolvedValue(undefined),
    },
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    frameLocator: vi.fn(() => ({ locator: () => ({ count: vi.fn().mockResolvedValue(0) }) })),
    ...overrides,
  };
}

function fakeContext(page: unknown, cookies: Array<{ name: string; value: string }> = []) {
  return {
    pages: vi.fn(() => [page]),
    newPage: vi.fn().mockResolvedValue(page),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    cookies: vi.fn().mockResolvedValue(cookies),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("challenge kind detection", () => {
  it("recognizes the Cloudflare interstitial", () => {
    expect(detectChallengeKind({ title: "Just a moment...", bodyExcerpt: "Performing security verification", frameSrcs: [] }))
      .toBe("CLOUDFLARE_INTERSTITIAL");
    expect(detectChallengeKind({ title: "Трохи зачекайте…", bodyExcerpt: "", frameSrcs: [] }))
      .toBe("CLOUDFLARE_INTERSTITIAL");
  });

  it("recognizes checkbox and Turnstile variants", () => {
    expect(detectChallengeKind({ title: "Just a moment...", bodyExcerpt: "click to verify you are human", frameSrcs: [] }))
      .toBe("CLOUDFLARE_CHECKBOX");
    expect(detectChallengeKind({ title: "x", bodyExcerpt: "", frameSrcs: ["https://challenges.cloudflare.com/turnstile/v0/api.js"] }))
      .toBe("TURNSTILE");
  });

  it("recognizes PerimeterX press-and-hold", () => {
    expect(detectChallengeKind({ title: "Access denied", bodyExcerpt: "Press & Hold to confirm", frameSrcs: [] }))
      .toBe("PX_PRESS_HOLD");
    expect(detectChallengeKind({ title: "x", bodyExcerpt: "window._pxAppId captcha.js", frameSrcs: [] }))
      .toBe("PX_PRESS_HOLD");
  });

  it("recognizes visual recaptcha and clean pages", () => {
    expect(detectChallengeKind({ title: "x", bodyExcerpt: "g-recaptcha", frameSrcs: [] })).toBe("RECAPTCHA");
    expect(detectChallengeKind({ title: "Buy a car", bodyExcerpt: "20 fresh adverts", frameSrcs: [] })).toBe("CLEAN");
  });
});

describe("press-and-hold humanization", () => {
  it("holds within the proof-of-work window", () => {
    for (let i = 0; i < 100; i += 1) {
      const ms = pressHoldDurationMs(Math.random);
      expect(ms).toBeGreaterThanOrEqual(8500);
      expect(ms).toBeLessThanOrEqual(11000);
    }
  });
});

describe("solver gate", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock === "function") mock.mockReset();
    }
    mocks.env.CHALLENGE_SOLVER_ENABLED = true;
    mocks.env.CHALLENGE_SOLVER_TIMEOUT_MS = 5_000;
    mocks.logWarn.mockResolvedValue(undefined);
    mocks.logInfo.mockResolvedValue(undefined);
  });

  it("refuses when disabled", async () => {
    mocks.env.CHALLENGE_SOLVER_ENABLED = false;
    await expect(shouldAttemptChallengeSolve("OLX")).resolves.toBe(false);
  });

  it("allows the first attempt and blocks within the interval", async () => {
    mocks.redisGet.mockResolvedValue(null);
    await expect(shouldAttemptChallengeSolve("OLX")).resolves.toBe(true);
    mocks.redisGet.mockResolvedValue(new Date().toISOString());
    await expect(shouldAttemptChallengeSolve("OLX")).resolves.toBe(false);
  });
});

describe("solve attempt", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock === "function") mock.mockReset();
    }
    mocks.env.CHALLENGE_SOLVER_ENABLED = true;
    mocks.env.CHALLENGE_SOLVER_TIMEOUT_MS = 5_000;
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue("OK");
    mocks.sourceUpdate.mockResolvedValue({});
    mocks.logWarn.mockResolvedValue(undefined);
    mocks.logInfo.mockResolvedValue(undefined);
    mocks.launchPersistentContext.mockReset();
  });

  it("harvests when no challenge is presented", async () => {
    const page = fakePage({
      title: vi.fn().mockResolvedValue("Buy cars"),
      content: vi.fn().mockResolvedValue("<html>20 fresh adverts</html>"),
    });
    const context = fakeContext(page, [{ name: "sessionid", value: "abc" }]);
    mocks.launchPersistentContext.mockResolvedValue(context);
    mocks.fetchHtml.mockResolvedValue({ status: 200, body: "<html>20 fresh adverts</html>" });

    const outcome = await attemptChallengeSolve("OLX", "https://www.olx.ua/uk/");

    expect(outcome).toEqual({ ok: true, via: "no challenge presented", cookieNames: ["sessionid"] });
    expect(mocks.redisSet).toHaveBeenCalledWith("session:OLX", "sessionid=abc");
    expect(context.close).toHaveBeenCalled();
  });

  it("performs a genuine input-layer press-and-hold", async () => {    let held = false;
    const page = fakePage({
      title: vi.fn().mockResolvedValue("Access denied"),
      content: vi.fn()
        .mockResolvedValueOnce('<html><div>Press & Hold to confirm</div><script src="captcha.js"></script></html>')
        .mockResolvedValue("<html>20 fresh adverts</html>"),
      frameLocator: vi.fn(() => ({
        locator: () => ({
          count: vi.fn().mockResolvedValue(1),
          boundingBox: vi.fn().mockResolvedValue({ x: 100, y: 100, width: 200, height: 40 }),
        }),
      })),
    });
    (page.mouse.down as ReturnType<typeof vi.fn>).mockImplementation(async () => { held = true; });
    const context = fakeContext(page, [{ name: "sess", value: "1" }]);
    mocks.launchPersistentContext.mockResolvedValue(context);
    mocks.fetchHtml.mockResolvedValue({ status: 200, body: "<html>ok</html>" });

    const outcome = await attemptChallengeSolve("OLX", "https://www.olx.ua/uk/");

    expect(held).toBe(true);
    expect(page.mouse.down).toHaveBeenCalled();
    expect(page.mouse.up).toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
  }, 25000);

  it("declines visual recaptcha without pretending", async () => {
    const page = fakePage({
      title: vi.fn().mockResolvedValue("x"),
      content: vi.fn().mockResolvedValue("<html><div class='g-recaptcha'></div></html>"),
    });
    const context = fakeContext(page, []);
    mocks.launchPersistentContext.mockResolvedValue(context);

    const outcome = await attemptChallengeSolve("OLX", "https://www.olx.ua/uk/");

    expect(outcome).toEqual({ ok: false, reason: "visual recaptcha requires manual or paid solving" });
    expect(context.close).toHaveBeenCalled();
  });

  it("kickOff never throws", () => {
    expect(() => kickOffChallengeSolve("OLX", "test")).not.toThrow();
  });
});
