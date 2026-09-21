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

  it("reports a retained future protection pause as WARN rather than a crashed worker", () => {
    const health = sourceHealthEntry({
      source: "OLX",
      status: "DISABLED",
      intervalSeconds: 20,
      lastCheckedAt: new Date("2026-08-26T12:00:00.000Z"),
      lastSuccessfulAt: new Date("2026-08-26T12:00:00.000Z"),
      pausedUntil: new Date("2026-08-28T12:00:00.000Z"),
    }, checkedAt, true);

    expect(health.status).toBe("WARN");
    expect(health.message).toContain("2026-08-28T12:00:00.000Z");
  });

  it("uses the persisted effective STANDARD deadline instead of the LIVE default", () => {
    const lastCheckedAt = new Date("2026-08-27T11:58:00.000Z");
    const cadence = {
      intervalSeconds: 120,
      jitterSeconds: 20,
      nextExpectedRunAt: new Date("2026-08-27T12:00:20.000Z"),
    };
    const beforeDeadline = sourceHealthEntry({
      source: "OLX", status: "ACTIVE", intervalSeconds: 20,
      lastCheckedAt, lastSuccessfulAt: lastCheckedAt, pausedUntil: null,
    }, checkedAt, true, cadence);
    expect(beforeDeadline.status).toBe("OK");
    expect(beforeDeadline.staleAfterSeconds).toBe(165);

    const afterDeadline = sourceHealthEntry({
      source: "OLX", status: "ACTIVE", intervalSeconds: 20,
      lastCheckedAt, lastSuccessfulAt: lastCheckedAt, pausedUntil: null,
    }, new Date("2026-08-27T12:00:46.000Z"), true, cadence);
    expect(afterDeadline.status).toBe("FAIL");
  });
});
