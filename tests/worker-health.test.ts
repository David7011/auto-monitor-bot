import { describe, expect, it } from "vitest";
import { workerHealthStatus } from "../apps/api/src/lib/worker-health.js";

describe("worker health aggregation", () => {
  it("warns without declaring the worker crashed when a remote source stops making progress", () => {
    expect(workerHealthStatus({
      monitoringRunning: true,
      heartbeatStale: false,
      hasSuccessfulScan: true,
      sourceStatuses: ["OK", "FAIL"],
    })).toBe("WARN");
  });

  it("also fails when the worker heartbeat itself is stale", () => {
    expect(workerHealthStatus({
      monitoringRunning: true,
      heartbeatStale: true,
      hasSuccessfulScan: true,
      sourceStatuses: ["OK"],
    })).toBe("FAIL");
  });

  it("is idle when monitoring is stopped", () => {
    expect(workerHealthStatus({
      monitoringRunning: false,
      heartbeatStale: true,
      hasSuccessfulScan: false,
      sourceStatuses: ["FAIL"],
    })).toBe("IDLE");
  });
});
