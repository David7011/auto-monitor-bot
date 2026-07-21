import { Queue, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_NAMES, QUEUE_PRIORITIES, type QueueName } from "@amb/shared";
import { env } from "../env.js";

export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  connectTimeout: 1000,
  enableOfflineQueue: true,
  retryStrategy: (attempt) => Math.min(1000 + attempt * 100, 5000),
});
redisConnection.on("error", () => {
  // Individual processors fall back or fail fast depending on their queue semantics.
});
export const bullConnection: ConnectionOptions = redisOptionsFromUrl(env.REDIS_URL);

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: bullConnection, skipVersionCheck: true });
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

export async function closeQueues(): Promise<void> {
  for (const queue of queues.values()) {
    await queue.close();
  }
  redisConnection.disconnect();
}

export { QUEUE_NAMES };

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
    connectTimeout: 1000,
    enableOfflineQueue: true,
    retryStrategy: (attempt) => Math.min(1000 + attempt * 100, 5000),
  };
}
