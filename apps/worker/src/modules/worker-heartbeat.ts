import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { DedicatedWorkerRole } from "./worker-roles.js";
import type { HotWorkerInstance } from "@amb/shared";

export type WorkerHeartbeatPayload = {
  role: DedicatedWorkerRole;
  pid: number;
  startedAt: string;
  checkedAt: string;
  eventLoopDelayP95Ms: number;
  eventLoopUtilization: number;
  instanceId?: HotWorkerInstance;
  leadership?: "leader" | "standby";
};

export class WorkerHeartbeatTelemetry {
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private previousUtilization = performance.eventLoopUtilization();

  constructor() {
    this.eventLoopDelay.enable();
  }

  sample(
    role: DedicatedWorkerRole,
    startedAt: Date,
    details: Pick<WorkerHeartbeatPayload, "instanceId" | "leadership"> = {},
  ): WorkerHeartbeatPayload {
    const utilization = performance.eventLoopUtilization(this.previousUtilization);
    this.previousUtilization = performance.eventLoopUtilization();
    const eventLoopDelayP95Ms = Number.isFinite(this.eventLoopDelay.percentile(95))
      ? this.eventLoopDelay.percentile(95) / 1_000_000
      : 0;
    this.eventLoopDelay.reset();
    return {
      role,
      pid: process.pid,
      startedAt: startedAt.toISOString(),
      checkedAt: new Date().toISOString(),
      eventLoopDelayP95Ms: Math.round(eventLoopDelayP95Ms * 100) / 100,
      eventLoopUtilization: Math.round(utilization.utilization * 10_000) / 10_000,
      ...details,
    };
  }

  close(): void {
    this.eventLoopDelay.disable();
  }
}

export function workerHeartbeatPath(projectRoot: string, role: DedicatedWorkerRole): string {
  return path.join(projectRoot, ".runtime", "worker-heartbeats", `${role}.json`);
}

export function hotWorkerReplicaHeartbeatPath(
  projectRoot: string,
  instance: HotWorkerInstance,
): string {
  return path.join(projectRoot, ".runtime", "worker-heartbeats", `hot-${instance}.json`);
}

export async function writeWorkerHeartbeatFile(
  projectRoot: string,
  payload: WorkerHeartbeatPayload,
): Promise<void> {
  const target = workerHeartbeatPath(projectRoot, payload.role);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(payload), "utf8");
}

export async function writeHotWorkerReplicaHeartbeatFile(
  projectRoot: string,
  payload: WorkerHeartbeatPayload & { instanceId: HotWorkerInstance },
): Promise<void> {
  const target = hotWorkerReplicaHeartbeatPath(projectRoot, payload.instanceId);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(payload), "utf8");
}

export async function removeWorkerHeartbeatFile(projectRoot: string, role: DedicatedWorkerRole): Promise<void> {
  await unlink(workerHeartbeatPath(projectRoot, role)).catch(() => undefined);
}

export async function removeHotWorkerReplicaHeartbeatFile(
  projectRoot: string,
  instance: HotWorkerInstance,
): Promise<void> {
  await unlink(hotWorkerReplicaHeartbeatPath(projectRoot, instance)).catch(() => undefined);
}
