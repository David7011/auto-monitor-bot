import { Queue, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_NAMES, QUEUE_PRIORITIES, type QueueName } from "@amb/shared";
import { env } from "../env.js";

export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  connectTimeout: 500,
  enableOfflineQueue: false,
  retryStrategy: () => null,
});
redisConnection.on("error", () => {
  // Redis is optional for read-only dashboard endpoints; queue writes still fail fast.
});
const bullConnection: ConnectionOptions = redisOptionsFromUrl(env.REDIS_URL);

const queues = new Map<QueueName, Queue>();
const MIN_REDIS_VERSION = [6, 2] as const;

export type RedisDiagnostics = {
  version: string;
  bullMqCompatible: boolean;
};

export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: bullConnection });
    queues.set(name, queue);
  }
  return queue;
}

export async function enqueue(
  name: QueueName,
  jobName: string,
  data: unknown,
  options: { jobId?: string; priority?: number; delay?: number } = {},
): Promise<void> {
  await getQueue(name).add(jobName, data, {
    jobId: options.jobId,
    priority: options.priority ?? QUEUE_PRIORITIES[name],
    delay: options.delay,
    removeOnComplete: 500,
    removeOnFail: 200,
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  });
}

export async function getQueueCounts(): Promise<Record<string, { waiting: number; active: number; failed: number }>> {
  const result: Record<string, { waiting: number; active: number; failed: number }> = {};
  await getRedisDiagnostics();

  for (const name of Object.values(QUEUE_NAMES)) {
    const q = getQueue(name);
    const counts = await q.getJobCounts("waiting", "active", "failed");
    result[name] = {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
    };
  }
  return result;
}

export async function getRedisDiagnostics(): Promise<RedisDiagnostics> {
  await ensureRedisReady();
  const info = await Promise.race([
    redisConnection.info("server"),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Redis diagnostics timeout")), 1_500)),
  ]);
  const version = info.match(/^redis_version:([^\r\n]+)$/m)?.[1]?.trim();
  if (!version) throw new Error("Redis did not report its version");

  const bullMqCompatible = compareVersions(version, MIN_REDIS_VERSION) >= 0;
  if (!bullMqCompatible) {
    throw new Error(`Redis ${version} is incompatible with BullMQ; Redis ${MIN_REDIS_VERSION.join(".")}+ is required`);
  }

  return { version, bullMqCompatible };
}

export async function ensureRedisReady(): Promise<void> {
  if (redisConnection.status === "ready") return;
  if (redisConnection.status === "wait" || redisConnection.status === "end") {
    await redisConnection.connect();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      redisConnection.off("ready", onReady);
      redisConnection.off("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Redis connection timeout"));
    }, 1_500);
    redisConnection.once("ready", onReady);
    redisConnection.once("error", onError);
  });
}

export async function closeQueues(): Promise<void> {
  for (const queue of queues.values()) {
    await queue.close();
  }
  redisConnection.disconnect();
}

function redisOptionsFromUrl(value: string): ConnectionOptions {
  const url = new URL(value);
  const db = url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined;
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number.isFinite(db) ? db : undefined,
    maxRetriesPerRequest: null,
    lazyConnect: true,
    connectTimeout: 500,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  };
}

function compareVersions(version: string, minimum: readonly number[]): number {
  const current = version.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < minimum.length; index += 1) {
    const difference = (current[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
