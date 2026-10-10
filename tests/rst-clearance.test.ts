import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redisGet: vi.fn(),
  logWarn: vi.fn(),
  env: {
    RST_CF_CLEARANCE: "",
    RST_USER_AGENT: "",
  },
}));

vi.mock("../apps/worker/src/lib/queues.js", () => ({
  redisConnection: { get: mocks.redisGet },
}));
vi.mock("../apps/worker/src/env.js", () => ({ env: mocks.env }));
vi.mock("../apps/worker/src/lib/log.js", () => ({ log: { warn: mocks.logWarn } }));

import {
  getRstClearanceCookie,
  normalizeClearanceCookie,
  RST_CLEARANCE_REDIS_KEY,
  RST_OPERA_USER_AGENT,
  rstRequestHeaders,
} from "../apps/worker/src/collectors/rst-clearance.js";

describe("rst clearance", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock === "function") mock.mockReset();
    }
    mocks.env.RST_CF_CLEARANCE = "";
    mocks.env.RST_USER_AGENT = "";
    mocks.redisGet.mockResolvedValue(null);
    mocks.logWarn.mockResolvedValue(undefined);
  });

  it("wraps a raw clearance value from Redis", async () => {
    mocks.redisGet.mockResolvedValueOnce("abc123");

    await expect(getRstClearanceCookie()).resolves.toBe("cf_clearance=abc123");
    expect(mocks.redisGet).toHaveBeenCalledWith(RST_CLEARANCE_REDIS_KEY);
  });

  it("passes through a full cookie pair from Redis", async () => {
    mocks.redisGet.mockResolvedValueOnce("cf_clearance=abc123; other=1");

    await expect(getRstClearanceCookie()).resolves.toBe("cf_clearance=abc123; other=1");
  });

  it("falls back to env when Redis is empty", async () => {
    mocks.env.RST_CF_CLEARANCE = "env-token";

    await expect(getRstClearanceCookie()).resolves.toBe("cf_clearance=env-token");
  });

  it("prefers Redis over env", async () => {
    mocks.redisGet.mockResolvedValueOnce("redis-token");
    mocks.env.RST_CF_CLEARANCE = "env-token";

    await expect(getRstClearanceCookie()).resolves.toBe("cf_clearance=redis-token");
  });

  it("returns null when nothing is configured", async () => {
    await expect(getRstClearanceCookie()).resolves.toBeNull();
  });

  it("falls back to env when Redis throws", async () => {
    mocks.redisGet.mockRejectedValueOnce(new Error("redis down"));
    mocks.env.RST_CF_CLEARANCE = "env-token";

    await expect(getRstClearanceCookie()).resolves.toBe("cf_clearance=env-token");
    expect(mocks.logWarn).toHaveBeenCalledWith("collector", expect.stringContaining("Redis"));
  });

  it("normalizes blank input to null", () => {
    expect(normalizeClearanceCookie("   ")).toBeNull();
    expect(normalizeClearanceCookie("")).toBeNull();
  });

  it("builds headers with the Opera UA and clearance cookie", () => {
    mocks.env.RST_USER_AGENT = "CustomUA/1.0";

    expect(rstRequestHeaders("cf_clearance=x")).toEqual({
      "user-agent": "CustomUA/1.0",
      Cookie: "cf_clearance=x",
    });
  });

  it("defaults to the Opera UA and omits Cookie without clearance", () => {
    const headers = rstRequestHeaders(null);

    expect(headers["user-agent"]).toBe(RST_OPERA_USER_AGENT);
    expect(headers).not.toHaveProperty("Cookie");
    expect(RST_OPERA_USER_AGENT).toContain("OPR/");
  });
});
