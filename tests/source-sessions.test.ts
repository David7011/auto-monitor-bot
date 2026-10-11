import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  logWarn: vi.fn(),
  env: {
    OLX_SESSION_COOKIE: "",
    AUTO_RIA_SESSION_COOKIE: "",
    RST_CF_CLEARANCE: "",
  },
}));

vi.mock("../apps/worker/src/lib/queues.js", () => ({
  redisConnection: { get: mocks.redisGet, set: mocks.redisSet },
}));
vi.mock("../apps/worker/src/env.js", () => ({ env: mocks.env }));
vi.mock("../apps/worker/src/lib/log.js", () => ({ log: { warn: mocks.logWarn } }));

import {
  getSourceSessionCookie,
  invalidateSourceSessionCache,
  normalizeSessionCookie,
  sourceSessionRedisKey,
  storeSourceSessionCookie,
  withSessionCookie,
} from "../apps/worker/src/collectors/source-sessions.js";

describe("source sessions", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock === "function") mock.mockReset();
    }
    mocks.env.OLX_SESSION_COOKIE = "";
    mocks.env.AUTO_RIA_SESSION_COOKIE = "";
    mocks.env.RST_CF_CLEARANCE = "";
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue("OK");
    mocks.logWarn.mockResolvedValue(undefined);
    invalidateSourceSessionCache();
  });

  it("keys sessions per source", () => {
    expect(sourceSessionRedisKey("OLX")).toBe("session:OLX");
  });

  it("normalizes blank input to null", () => {
    expect(normalizeSessionCookie("   ")).toBeNull();
    expect(normalizeSessionCookie("a=b")).toBe("a=b");
  });

  it("prefers Redis over env and caches the answer", async () => {
    mocks.redisGet.mockResolvedValue("k=v");
    mocks.env.OLX_SESSION_COOKIE = "env=1";

    await expect(getSourceSessionCookie("OLX")).resolves.toBe("k=v");
    await expect(getSourceSessionCookie("OLX")).resolves.toBe("k=v");
    expect(mocks.redisGet).toHaveBeenCalledTimes(1);
  });

  it("falls back to env when Redis is empty", async () => {
    mocks.env.AUTO_RIA_SESSION_COOKIE = "env=2";

    await expect(getSourceSessionCookie("AUTO_RIA")).resolves.toBe("env=2");
  });

  it("falls back on Redis errors without hammering", async () => {
    mocks.redisGet.mockRejectedValue(new Error("down"));

    await expect(getSourceSessionCookie("OLX")).resolves.toBeNull();
    await expect(getSourceSessionCookie("OLX")).resolves.toBeNull();
    expect(mocks.redisGet).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
  });

  it("store writes through and invalidates the cache", async () => {
    await expect(storeSourceSessionCookie("OLX", "  ")).resolves.toBe(false);
    expect(mocks.redisSet).not.toHaveBeenCalled();

    await expect(storeSourceSessionCookie("OLX", "k=v")).resolves.toBe(true);
    expect(mocks.redisSet).toHaveBeenCalledWith("session:OLX", "k=v");
    await expect(getSourceSessionCookie("OLX")).resolves.toBe("k=v");
    expect(mocks.redisGet).not.toHaveBeenCalled();
  });

  it("merges cookies without touching other headers", () => {
    expect(withSessionCookie({ a: "b" }, null)).toEqual({ a: "b" });
    expect(withSessionCookie({ a: "b" }, "k=v")).toEqual({ a: "b", Cookie: "k=v" });
  });
});
