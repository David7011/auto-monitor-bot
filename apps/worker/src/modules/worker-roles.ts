import {
  BACKGROUND_WORKER_HEARTBEAT_KEY,
  HOT_WORKER_REPLICA_HEARTBEAT_KEYS,
  QUEUE_NAMES,
  WORKER_HEARTBEAT_KEY,
  type HotWorkerInstance,
  type QueueName,
} from "@amb/shared";

export const WORKER_ROLES = ["hot", "background", "all"] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];
export type DedicatedWorkerRole = Exclude<WorkerRole, "all">;
export const HOT_WORKER_INSTANCES = ["a", "b"] as const satisfies readonly HotWorkerInstance[];

const HOT_QUEUES = new Set<QueueName>([
  QUEUE_NAMES.COLLECTOR_RUN,
  // OLX pacing is intentionally process-local. Keep every queue that can
  // issue OLX HTTP requests in the same event loop so realtime retains strict
  // priority and background traffic cannot bypass the origin circuit breaker.
  QUEUE_NAMES.COLLECTOR_COVERAGE,
  QUEUE_NAMES.COLLECTOR_BACKFILL,
  QUEUE_NAMES.LISTING_DETECTED,
  QUEUE_NAMES.LISTING_ENRICH,
  QUEUE_NAMES.TELEGRAM_SEND,
  QUEUE_NAMES.TELEGRAM_FLASH,
  // First sends and edits share one process-local Telegram gate. This keeps
  // enrichment edits from racing a fresh advert for the same chat allowance.
  QUEUE_NAMES.TELEGRAM_UPDATE,
]);

const BACKGROUND_QUEUES = new Set<QueueName>([
  QUEUE_NAMES.OBSERVATION_REPLAY,
  QUEUE_NAMES.VEHICLE_CHECK,
]);

export function resolveWorkerRole(argv: string[]): WorkerRole {
  const raw = argv.find((value) => value.startsWith("--role="))?.slice("--role=".length);
  if (!raw) return "all";
  if (WORKER_ROLES.includes(raw as WorkerRole)) return raw as WorkerRole;
  throw new Error(`Unknown worker role: ${raw}. Expected hot, background, or all.`);
}

export function resolveHotWorkerInstance(
  argv: string[],
  role: WorkerRole,
): HotWorkerInstance | null {
  if (role !== "hot") return null;
  const raw = argv.find((value) => value.startsWith("--instance="))?.slice("--instance=".length);
  if (!raw) return "a";
  if (HOT_WORKER_INSTANCES.includes(raw as HotWorkerInstance)) return raw as HotWorkerInstance;
  throw new Error(`Unknown hot worker instance: ${raw}. Expected a or b.`);
}

export function workerRoleConsumesQueue(role: WorkerRole, queueName: QueueName): boolean {
  if (role === "all") return HOT_QUEUES.has(queueName) || BACKGROUND_QUEUES.has(queueName);
  return role === "hot" ? HOT_QUEUES.has(queueName) : BACKGROUND_QUEUES.has(queueName);
}

export function workerRoleRunsMaintenance(role: WorkerRole): boolean {
  return role !== "hot";
}

export function heartbeatRolesForWorker(role: WorkerRole): DedicatedWorkerRole[] {
  return role === "all" ? ["hot", "background"] : [role];
}

export function heartbeatKeyForWorkerRole(role: DedicatedWorkerRole): string {
  return role === "hot" ? WORKER_HEARTBEAT_KEY : BACKGROUND_WORKER_HEARTBEAT_KEY;
}

export function heartbeatKeyForHotWorkerReplica(instance: HotWorkerInstance): string {
  return HOT_WORKER_REPLICA_HEARTBEAT_KEYS[instance];
}
