import { describe, expect, it } from "vitest";
import { planTelegramFlashBundle } from "../apps/worker/src/modules/telegram-flash-policy.js";

describe("Telegram flash bundle policy", () => {
  it.each([2, 5, 10, 20])("collapses a %i-item realtime burst into one ordered first notification", (size) => {
    const listings = Array.from({ length: size }, (_, index) => `newest-${index}`);
    const plan = planTelegramFlashBundle({ listings, lane: "REALTIME", enabled: true, minItems: 2, maxItems: 20 });

    expect(plan).toEqual({ enabled: true, flash: listings, remainder: [] });
    expect(plan.flash[0]).toBe("newest-0");
    // One flash request avoids (size - 1) global Telegram rate-gate slots on
    // the first-alert path; detailed cards remain background work.
    expect(plan.flash.length).toBe(size);
  });

  it("bundles a realtime burst and preserves newest-first order", () => {
    const plan = planTelegramFlashBundle({
      listings: ["newest", "middle", "oldest"],
      lane: "REALTIME",
      enabled: true,
      minItems: 2,
      maxItems: 20,
    });

    expect(plan).toEqual({ enabled: true, flash: ["newest", "middle", "oldest"], remainder: [] });
  });

  it("never bundles a singleton or backfill recovery", () => {
    expect(planTelegramFlashBundle({ listings: ["one"], lane: "REALTIME", enabled: true, minItems: 2, maxItems: 20 }).enabled).toBe(false);
    expect(planTelegramFlashBundle({ listings: ["one", "two"], lane: "BACKFILL", enabled: true, minItems: 2, maxItems: 20 }).enabled).toBe(false);
  });

  it("caps one message while retaining the oversized tail", () => {
    const listings = Array.from({ length: 25 }, (_, index) => index);
    const plan = planTelegramFlashBundle({ listings, lane: "REALTIME", enabled: true, minItems: 2, maxItems: 20 });

    expect(plan.flash).toEqual(listings.slice(0, 20));
    expect(plan.remainder).toEqual(listings.slice(20));
  });
});
