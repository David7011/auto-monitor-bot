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
    RST_HARVEST_ENABLED: true,
    RST_HARVEST_TIMEOUT_MS: 5_000,
    RST_HARVEST_MIN_INTERVAL_HOURS: 6,
    RST_HARVEST_PROFILE_DIR: "",
    RST_HARVEST_EXECUTABLE_PATH: "",
    RST_CF_CLEARANCE: "",
    RST_USER_AGENT: "",
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
vi.mock("../apps/worker/src/lib/log.js", () => ({ log: { warn: mocks.logWarn, info: mocks.logInfo } }));
vi.mock("../apps/worker/src/lib/queues.js", () => ({
  redisConnection: { get: mocks.redisGet, set: mocks.redisSet },
}));
vi.mock("../apps/worker/src/collectors/html-utils.js", () => ({ fetchHtml: mocks.fetchHtml }));

import {
  attemptRstHarvest,
  extractClearanceCookie,
  kickOffRstHarvest,
  shouldAttemptRstHarvest,
} from "../apps/worker/src/modules/rst-clearance-harvester.js";

function fakePage(overrides: Record<string, unknown> = {}) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue("challenge"),
    $$eval: vi.fn().mockResolvedValue(0),
    mouse: {
      move: vi.fn().mockResolvedValue(undefined),
      wheel: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
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

describe("rst harvest gate", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock === "function") mock.mockReset();
    }
    mocks.env.RST_HARVEST_ENABLED = true;
    mocks.env.RST_HARVEST_TIMEOUT_MS = 5_000;
    mocks.env.RST_HARVEST_MIN_INTERVAL_HOURS = 6;
    mocks.logWarn.mockResolvedValue(undefined);
    mocks.logInfo.mockResolvedValue(undefined);
  });

  it("refuses when disabled", async () => {
    mocks.env.RST_HARVEST_ENABLED = false;

    await expect(shouldAttemptRstHarvest()).resolves.toBe(false);
    expect(mocks.redisGet).not.toHaveBeenCalled();
  });

  it("allows the first attempt", async () => {
    mocks.redisGet.mockResolvedValue(null);

    await expect(shouldAttemptRstHarvest()).resolves.toBe(true);
  });

  it("blocks within the min interval", async () => {
    mocks.redisGet.mockResolvedValue(new Date(Date.now() - 60 * 60 * 1000).toISOString());

    await expect(shouldAttemptRstHarvest()).resolves.toBe(false);
  });

  it("allows after the min interval", async () => {
    mocks.redisGet.mockResolvedValue(new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString());

    await expect(shouldAttemptRstHarvest()).resolves.toBe(true);
  });

  it("fails closed on Redis errors", async () => {
    mocks.redisGet.mockRejectedValue(new Error("redis down"));

    await expect(shouldAttemptRstHarvest()).resolves.toBe(false);
  });
});

describe("clearance extraction", () => {
  it("finds cf_clearance among cookies", () => {
    expect(extractClearanceCookie([
      { name: "other", value: "1" },
      { name: "cf_clearance", value: "abc" },
    ])).toBe("cf_clearance=abc");
  });

  it("returns null without clearance", () => {
    expect(extractClearanceCookie([{ name: "other", value: "1" }])).toBeNull();
  });
});

describe("harvest attempt", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock === "function") mock.mockReset();
    }
    mocks.logWarn.mockResolvedValue(undefined);
    mocks.logInfo.mockResolvedValue(undefined);
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue("OK");
    mocks.sourceUpdate.mockResolvedValue({});
    mocks.fetchHtml.mockResolvedValue({ status: 403, body: "" });
    mocks.launchPersistentContext.mockReset();
  });

  it("harvests, validates and stores a working clearance", async () => {
    const page = fakePage({
      $$eval: vi.fn().mockResolvedValue(20),
    });
    const context = fakeContext(page, [{ name: "cf_clearance", value: "fresh" }]);
    mocks.launchPersistentContext.mockResolvedValue(context);
    mocks.fetchHtml.mockResolvedValue({ status: 200, body: "<html>listings</html>" });

    const outcome = await attemptRstHarvest();

    expect(outcome).toEqual({ ok: true, cookieNames: ["cf_clearance"] });
    expect(mocks.redisSet).toHaveBeenCalledWith("rst:cf_clearance", "cf_clearance=fresh");
    expect(mocks.sourceUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { source: "RST" },
    }));
    expect(context.close).toHaveBeenCalled();
  });

  it("rejects a clearance the origin does not accept", async () => {
    mocks.env.RST_HARVEST_TIMEOUT_MS = 300;
    const page = fakePage();
    const context = fakeContext(page, [{ name: "cf_clearance", value: "stale" }]);
    mocks.launchPersistentContext.mockResolvedValue(context);
    mocks.fetchHtml.mockResolvedValue({ status: 403, body: "Performing security verification" });

    const outcome = await attemptRstHarvest();

    expect(outcome.ok).toBe(false);
    expect(mocks.redisSet).not.toHaveBeenCalledWith("rst:cf_clearance", expect.anything());
  });

  it("gives up when gated without launching a browser", async () => {
    mocks.redisGet.mockResolvedValue(new Date().toISOString());

    const outcome = await attemptRstHarvest();

    expect(outcome.ok).toBe(false);
    expect(mocks.launchPersistentContext).not.toHaveBeenCalled();
  });

  it("kickOff never throws", () => {
    mocks.redisGet.mockResolvedValue(new Date().toISOString());

    expect(() => kickOffRstHarvest("test")).not.toThrow();
  });
});
