import { describe, expect, it } from "vitest";
import {
  filterReliableFreshListings,
  freshnessCutoff,
  isFreshListing,
  sortListingsNewestFirst,
  startOfTodayInKyiv,
} from "../packages/shared/src/utils/freshness.js";

describe("freshness check", () => {
  it("accepts a listing published today in Europe/Kyiv", () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    const publishedAt = new Date("2026-07-10T06:00:00.000Z");
    expect(isFreshListing(publishedAt, "TODAY", now)).toBe(true);
  });

  it("rejects an old listing even if firstSeenAt would be today", () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    const oldPublishedAt = new Date("2026-06-10T10:00:00.000Z");
    expect(isFreshListing(oldPublishedAt, "TODAY", now)).toBe(false);
  });

  it("rejects missing or invalid publication timestamps for TODAY", () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    expect(isFreshListing(undefined, "TODAY", now)).toBe(false);
    expect(isFreshListing("not-a-date", "TODAY", now)).toBe(false);
  });

  it("uses Europe/Kyiv midnight for summer time", () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    expect(startOfTodayInKyiv(now).toISOString()).toBe("2026-07-09T21:00:00.000Z");
  });

  it("uses Europe/Kyiv midnight for winter time", () => {
    const now = new Date("2026-01-10T10:00:00.000Z");
    expect(startOfTodayInKyiv(now).toISOString()).toBe("2026-01-09T22:00:00.000Z");
  });

  it("handles 23:59 Kyiv as today and previous day as stale", () => {
    const now = new Date("2026-07-10T20:59:30.000Z");
    expect(isFreshListing(new Date("2026-07-10T20:59:00.000Z"), "TODAY", now)).toBe(true);
    expect(isFreshListing(new Date("2026-07-09T20:59:00.000Z"), "TODAY", now)).toBe(false);
  });

  it("calculates LAST_24_HOURS as rolling now minus exactly 24 hours", () => {
    const now = new Date("2026-07-10T12:30:00.000Z");
    expect(freshnessCutoff("LAST_24_HOURS", now)?.toISOString()).toBe("2026-07-09T12:30:00.000Z");
  });

  it("keeps LAST_24_HOURS different from TODAY", () => {
    const now = new Date("2026-07-10T12:30:00.000Z");
    const lastNightKyiv = new Date("2026-07-09T20:30:00.000Z");
    expect(isFreshListing(lastNightKyiv, "LAST_24_HOURS", now)).toBe(true);
    expect(isFreshListing(lastNightKyiv, "TODAY", now)).toBe(false);
  });

  it("sorts reliable listings newest first", () => {
    const now = new Date("2026-07-10T12:30:00.000Z");
    const ordered = filterReliableFreshListings(
      [
        listing("old", "2026-07-10T10:30:00.000Z"),
        listing("new", "2026-07-10T12:29:00.000Z"),
        listing("middle", "2026-07-10T11:30:00.000Z"),
      ],
      "LAST_24_HOURS",
      now,
    );
    expect(ordered.map((item) => item.externalId)).toEqual(["new", "middle", "old"]);
  });

  it("excludes older than 24 hours, missing dates and UNKNOWN confidence", () => {
    const now = new Date("2026-07-10T12:30:00.000Z");
    const ordered = filterReliableFreshListings(
      [
        listing("inside", "2026-07-10T10:30:00.000Z"),
        listing("older", "2026-07-09T12:29:59.000Z"),
        { ...listing("unknown", "2026-07-10T12:00:00.000Z"), timestampConfidence: "UNKNOWN" as const },
        { ...listing("missing", undefined), timestampConfidence: "UNKNOWN" as const },
      ],
      "LAST_24_HOURS",
      now,
    );
    expect(ordered.map((item) => item.externalId)).toEqual(["inside"]);
  });

  it("accepts an unknown timestamp only with an explicit fresh first-seen fallback", () => {
    const now = new Date("2026-07-10T12:30:00.000Z");
    const ordered = filterReliableFreshListings(
      [
        {
          ...listing("first-seen", undefined),
          firstSeenAt: new Date("2026-07-10T12:29:59.000Z"),
          freshnessFallback: "FIRST_SEEN" as const,
        },
        {
          ...listing("not-opted-in", undefined),
          firstSeenAt: new Date("2026-07-10T12:29:59.000Z"),
        },
        {
          ...listing("stale-first-seen", undefined),
          firstSeenAt: new Date("2026-07-09T12:29:59.000Z"),
          freshnessFallback: "FIRST_SEEN" as const,
        },
      ],
      "LAST_24_HOURS",
      now,
    );
    expect(ordered.map((item) => item.externalId)).toEqual(["first-seen"]);
  });

  it("uses a deterministic source and externalId tie-breaker for identical timestamps", () => {
    const sameTime = "2026-07-10T12:00:00.000Z";
    const ordered = sortListingsNewestFirst([
      listing("100", sameTime, "CARS_UA"),
      listing("900", sameTime, "AUTO_RIA"),
      listing("800", sameTime, "AUTO_RIA"),
      listing("700", sameTime, "OLX"),
    ]);
    expect(ordered.map((item) => `${item.source}:${item.externalId}`)).toEqual([
      "AUTO_RIA:900",
      "AUTO_RIA:800",
      "OLX:700",
      "CARS_UA:100",
    ]);
  });

  it("does not treat refreshedAt as publishedAt", () => {
    const now = new Date("2026-07-10T12:30:00.000Z");
    const ordered = filterReliableFreshListings(
      [
        {
          ...listing("refreshed-old", "2026-07-01T12:30:00.000Z"),
          refreshedAt: new Date("2026-07-10T12:29:00.000Z"),
        },
      ],
      "LAST_24_HOURS",
      now,
    );
    expect(ordered).toHaveLength(0);
  });
});

function listing(externalId: string, publishedAt: string | undefined, source: "AUTO_RIA" | "OLX" | "CARS_UA" = "OLX") {
  return {
    source,
    externalId,
    publishedAt: publishedAt ? new Date(publishedAt) : undefined,
    timestampConfidence: publishedAt ? ("HIGH" as const) : ("UNKNOWN" as const),
  };
}
