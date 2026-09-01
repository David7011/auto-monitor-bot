import { describe, expect, it } from "vitest";
import { sourcePortfolioHealth } from "../apps/api/src/lib/source-portfolio-health.js";

const NOW = new Date("2026-08-22T15:00:00Z");

describe("source portfolio health", () => {
  it("does not report a coverage failure while monitoring is intentionally stopped", () => {
    const result = sourcePortfolioHealth({
      monitoringRunning: false,
      now: NOW,
      sources: [{ source: "OLX", enabled: true, status: "ACTIVE", intervalSeconds: 20, lastSuccessfulAt: null }],
    });

    expect(result.status).toBe("OK");
    expect(result.message).toContain("остановлен пользователем");
  });

  it("reports an explicit degraded live mode when two fresh fallbacks survive", () => {
    const result = sourcePortfolioHealth({
      now: NOW,
      sources: [
        { source: "OLX", enabled: true, status: "RATE_LIMITED", intervalSeconds: 60, lastSuccessfulAt: new Date("2026-08-10T10:00:00Z") },
        { source: "CARS_UA", enabled: true, status: "ACTIVE", intervalSeconds: 15, lastSuccessfulAt: new Date("2026-08-22T14:59:50Z") },
        { source: "AUTOMOTO", enabled: true, status: "LIMITED", intervalSeconds: 60, lastSuccessfulAt: new Date("2026-08-22T14:59:00Z") },
      ],
    });
    expect(result.status).toBe("WARN");
    expect(result.activeFallbacks).toEqual(["CARS_UA", "AUTOMOTO"]);
  });

  it("fails when neither OLX nor a fresh fallback is available", () => {
    expect(sourcePortfolioHealth({
      now: NOW,
      sources: [{ source: "OLX", enabled: true, status: "RATE_LIMITED", intervalSeconds: 60, lastSuccessfulAt: null }],
    }).status).toBe("FAIL");
  });
});
