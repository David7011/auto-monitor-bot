import { describe, expect, it } from "vitest";
import type { NormalizedListing } from "@amb/shared";
import {
  claimHotListingWithRedis,
  hotListingClaimKey,
  releaseHotListingClaimWithRedis,
  type HotDuplicateRedis,
} from "../apps/worker/src/modules/hot-duplicate-guard.js";

describe("hot listing duplicate guard", () => {
  it("uses an owner token and does not let an expired owner delete a newer claim", async () => {
    const values = new Map<string, string>();
    const redis = fakeRedis(values);
    const listing = normalizedListing();

    const first = await claimHotListingWithRedis(listing, redis, 120, "owner-1");
    expect(first).toEqual({ key: hotListingClaimKey(listing), token: "owner-1" });

    // Simulate expiry followed by a new worker claiming the same advert.
    values.delete(hotListingClaimKey(listing));
    const second = await claimHotListingWithRedis(listing, redis, 120, "owner-2");
    expect(second?.token).toBe("owner-2");

    await releaseHotListingClaimWithRedis(first!, redis);
    expect(values.get(hotListingClaimKey(listing))).toBe("owner-2");

    await releaseHotListingClaimWithRedis(second!, redis);
    expect(values.has(hotListingClaimKey(listing))).toBe(false);
  });

  it("rejects a concurrent claim for the same listing", async () => {
    const redis = fakeRedis(new Map());
    const listing = normalizedListing();

    expect(await claimHotListingWithRedis(listing, redis, 120, "owner-1")).not.toBeNull();
    expect(await claimHotListingWithRedis(listing, redis, 120, "owner-2")).toBeNull();
  });
});

function fakeRedis(values: Map<string, string>): HotDuplicateRedis {
  return {
    set: async (key, value) => {
      if (values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
    eval: async (_script, _numberOfKeys, key, token) => {
      if (values.get(String(key)) !== String(token)) return 0;
      values.delete(String(key));
      return 1;
    },
  };
}

function normalizedListing(): NormalizedListing {
  return {
    source: "OLX",
    externalId: "claim-test-1",
    url: "https://www.olx.ua/d/uk/obyavlenie/claim-test-1.html",
    canonicalUrl: "https://www.olx.ua/d/uk/obyavlenie/claim-test-1.html",
    title: "Test listing",
    photoUrls: [],
    publishedAt: new Date("2026-08-30T10:00:00.000Z"),
    timestampConfidence: "HIGH",
    firstSeenAt: new Date("2026-08-30T10:00:01.000Z"),
    raw: {},
  };
}
