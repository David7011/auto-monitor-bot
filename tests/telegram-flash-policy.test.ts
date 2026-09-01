import { describe, expect, it } from "vitest";
import { planTelegramFlashBundle } from "../apps/worker/src/modules/telegram-flash-policy.js";

describe("Telegram flash bundle policy", () => {
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
