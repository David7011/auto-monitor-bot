import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WorkerHeartbeatTelemetry,
  hotWorkerReplicaHeartbeatPath,
  workerHeartbeatPath,
} from "../apps/worker/src/modules/worker-heartbeat.js";

describe("worker heartbeat telemetry", () => {
  it("identifies the role and exposes bounded event-loop measurements", () => {
    const telemetry = new WorkerHeartbeatTelemetry();
    const startedAt = new Date("2026-08-27T08:00:00.000Z");
    const sample = telemetry.sample("hot", startedAt, { instanceId: "a", leadership: "leader" });
    telemetry.close();

    expect(sample.role).toBe("hot");
    expect(sample.pid).toBe(process.pid);
    expect(sample.startedAt).toBe(startedAt.toISOString());
    expect(sample.instanceId).toBe("a");
    expect(sample.leadership).toBe("leader");
    expect(sample.eventLoopDelayP95Ms).toBeGreaterThanOrEqual(0);
    expect(sample.eventLoopUtilization).toBeGreaterThanOrEqual(0);
    expect(sample.eventLoopUtilization).toBeLessThanOrEqual(1);
  });

  it("uses separate local heartbeat files", () => {
    const root = path.resolve("D:/auto-monitor-bot");
    expect(workerHeartbeatPath(root, "hot")).toMatch(/worker-heartbeats[\\/]hot\.json$/u);
    expect(workerHeartbeatPath(root, "background")).toMatch(/worker-heartbeats[\\/]background\.json$/u);
    expect(hotWorkerReplicaHeartbeatPath(root, "a")).toMatch(/worker-heartbeats[\\/]hot-a\.json$/u);
    expect(hotWorkerReplicaHeartbeatPath(root, "b")).toMatch(/worker-heartbeats[\\/]hot-b\.json$/u);
  });
});
