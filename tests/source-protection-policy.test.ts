import { describe, expect, it } from "vitest";
import {
  captchaPauseSeconds,
  rateLimitPauseSeconds,
} from "../apps/worker/src/modules/source-protection-policy.js";

describe("source protection policy", () => {
  it("backs off repeatedly challenged RST probes for one day", () => {
    expect(captchaPauseSeconds({
      source: "RST",
      consecutiveErrors: 3,
      baseSeconds: 900,
      maxSeconds: 3600,
    })).toBe(24 * 60 * 60);
  });

  it("keeps the normal capped policy for OLX and initial RST incidents", () => {
    expect(captchaPauseSeconds({
      source: "OLX",
      consecutiveErrors: 8,
      baseSeconds: 900,
      maxSeconds: 3600,
    })).toBe(3600);
    expect(captchaPauseSeconds({
      source: "RST",
      consecutiveErrors: 2,
      baseSeconds: 900,
      maxSeconds: 3600,
    })).toBe(3600);
  });
});

describe("OLX HTTP 403 recovery pacing", () => {
  it("backs off 6h, 12h, then 24h instead of probing every hour forever", () => {
    const pause = (consecutiveErrors: number) => rateLimitPauseSeconds({
      source: "OLX",
      responseStatus: 403,
      consecutiveErrors,
      baseSeconds: 90,
      maxSeconds: 3_600,
    });
    expect(pause(0)).toBe(6 * 60 * 60);
    expect(pause(1)).toBe(12 * 60 * 60);
    expect(pause(2)).toBe(24 * 60 * 60);
    expect(pause(77)).toBe(24 * 60 * 60);
  });

  it("keeps ordinary Retry-After handling for non-403 responses", () => {
    expect(rateLimitPauseSeconds({
      source: "OLX",
      responseStatus: 429,
      retryAfterSeconds: 120,
      consecutiveErrors: 0,
      baseSeconds: 90,
      maxSeconds: 3_600,
    })).toBe(120);
  });
});
