import { describe, expect, it } from "vitest";
import {
  BACKGROUND_WORKER_HEARTBEAT_KEY,
  HOT_WORKER_REPLICA_HEARTBEAT_KEYS,
  QUEUE_NAMES,
  WORKER_HEARTBEAT_KEY,
} from "../packages/shared/src/constants/queues.js";
import {
  heartbeatKeyForWorkerRole,
  heartbeatKeyForHotWorkerReplica,
  heartbeatRolesForWorker,
  resolveWorkerRole,
  resolveHotWorkerInstance,
  workerRoleConsumesQueue,
  workerRoleRunsMaintenance,
} from "../apps/worker/src/modules/worker-roles.js";

describe("worker role isolation", () => {
  it("keeps realtime and first-notification queues on the hot worker", () => {
    for (const queue of [
      QUEUE_NAMES.COLLECTOR_RUN,
      QUEUE_NAMES.COLLECTOR_COVERAGE,
      QUEUE_NAMES.COLLECTOR_BACKFILL,
      QUEUE_NAMES.LISTING_DETECTED,
      QUEUE_NAMES.LISTING_ENRICH,
      QUEUE_NAMES.TELEGRAM_FLASH,
      QUEUE_NAMES.TELEGRAM_SEND,
      QUEUE_NAMES.TELEGRAM_UPDATE,
    ]) {
      expect(workerRoleConsumesQueue("hot", queue)).toBe(true);
      expect(workerRoleConsumesQueue("background", queue)).toBe(false);
    }
  });

  it("keeps CPU-heavy and maintenance queues away from the hot event loop", () => {
    for (const queue of [
      QUEUE_NAMES.OBSERVATION_REPLAY,
      QUEUE_NAMES.VEHICLE_CHECK,
    ]) {
      expect(workerRoleConsumesQueue("background", queue)).toBe(true);
      expect(workerRoleConsumesQueue("hot", queue)).toBe(false);
    }
    expect(workerRoleRunsMaintenance("hot")).toBe(false);
    expect(workerRoleRunsMaintenance("background")).toBe(true);
  });

  it("co-locates every OLX-capable queue with the process-local origin coordinator", () => {
    expect(workerRoleConsumesQueue("hot", QUEUE_NAMES.COLLECTOR_BACKFILL)).toBe(true);
    expect(workerRoleConsumesQueue("hot", QUEUE_NAMES.COLLECTOR_COVERAGE)).toBe(true);
    expect(workerRoleConsumesQueue("hot", QUEUE_NAMES.LISTING_ENRICH)).toBe(true);
    expect(workerRoleConsumesQueue("background", QUEUE_NAMES.COLLECTOR_BACKFILL)).toBe(false);
    expect(workerRoleConsumesQueue("background", QUEUE_NAMES.COLLECTOR_COVERAGE)).toBe(false);
    expect(workerRoleConsumesQueue("background", QUEUE_NAMES.LISTING_ENRICH)).toBe(false);
  });

  it("co-locates first sends and message edits with one Telegram send gate", () => {
    expect(workerRoleConsumesQueue("hot", QUEUE_NAMES.TELEGRAM_FLASH)).toBe(true);
    expect(workerRoleConsumesQueue("hot", QUEUE_NAMES.TELEGRAM_SEND)).toBe(true);
    expect(workerRoleConsumesQueue("hot", QUEUE_NAMES.TELEGRAM_UPDATE)).toBe(true);
    expect(workerRoleConsumesQueue("background", QUEUE_NAMES.TELEGRAM_UPDATE)).toBe(false);
    expect(workerRoleConsumesQueue("background", QUEUE_NAMES.TELEGRAM_FLASH)).toBe(false);
  });

  it("preserves an all-in-one role for explicit development compatibility", () => {
    expect(resolveWorkerRole([])).toBe("all");
    expect(resolveWorkerRole(["--role=hot"])).toBe("hot");
    expect(resolveWorkerRole(["--role=background"])).toBe("background");
    expect(resolveHotWorkerInstance(["--role=hot", "--instance=a"], "hot")).toBe("a");
    expect(resolveHotWorkerInstance(["--role=hot", "--instance=b"], "hot")).toBe("b");
    expect(resolveHotWorkerInstance([], "all")).toBeNull();
    expect(heartbeatRolesForWorker("all")).toEqual(["hot", "background"]);
  });

  it("uses independent heartbeat keys for targeted recovery", () => {
    expect(heartbeatKeyForWorkerRole("hot")).toBe(WORKER_HEARTBEAT_KEY);
    expect(heartbeatKeyForWorkerRole("background")).toBe(BACKGROUND_WORKER_HEARTBEAT_KEY);
    expect(heartbeatKeyForHotWorkerReplica("a")).toBe(HOT_WORKER_REPLICA_HEARTBEAT_KEYS.a);
    expect(heartbeatKeyForHotWorkerReplica("b")).toBe(HOT_WORKER_REPLICA_HEARTBEAT_KEYS.b);
  });

  it("rejects an unknown worker role", () => {
    expect(() => resolveWorkerRole(["--role=other"])).toThrow(/Unknown worker role/u);
    expect(() => resolveHotWorkerInstance(["--instance=c"], "hot")).toThrow(/Unknown hot worker instance/u);
  });
});
