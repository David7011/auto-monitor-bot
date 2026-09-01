import { describe, expect, it } from "vitest";
import { sourceHealthEntry } from "../apps/api/src/routes/system-health-routes.js";

const checkedAt = new Date("2026-08-27T12:00:00.000Z");

describe("source runtime health", () => {
  it("does not report intentional laptop downtime as a source failure", () => {
    const health = sourceHealthEntry({
      source: "OLX",
      status: "ACTIVE",
      intervalSeconds: 60,
      lastCheckedAt: new Date("2026-08-26T12:00:00.000Z"),
      lastSuccessfulAt: new Date("2026-08-26T12:00:00.000Z"),
      pausedUntil: null,
    }, checkedAt, false);

    expect(health.status).toBe("IDLE");
    expect(health.sourceStatus).toBe("ACTIVE");
    expect(health.message).toMatch(/свежесть не оценивается/iu);
  });

  it("still reports the same stale source as failed while monitoring runs", () => {
    const health = sourceHealthEntry({
      source: "OLX",
      status: "ACTIVE",
      intervalSeconds: 60,
      lastCheckedAt: new Date("2026-08-26T12:00:00.000Z"),
      lastSuccessfulAt: new Date("2026-08-26T12:00:00.000Z"),
      pausedUntil: null,
    }, checkedAt, true);

    expect(health.status).toBe("FAIL");
  });
});
