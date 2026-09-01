import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Redis } from "ioredis";
import { TelegramSendGate } from "@amb/shared";
import { env } from "../env.js";

const intervalMs = 250;
const redisClients = Array.from({ length: 3 }, () => new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  lazyConnect: true,
  connectTimeout: 1_000,
  retryStrategy: () => null,
}));
const key = `amb:test:telegram-rate-gate:${randomUUID()}`;

try {
  await Promise.all(redisClients.map((redis) => redis.connect()));
  await Promise.all(redisClients.map((redis) => redis.ping()));
  const starts: number[] = [];
  const gates = redisClients.map((redis) => new TelegramSendGate(intervalMs, { redis, key }));
  await Promise.all(gates.map((gate) => gate.waitForSlot().then(() => starts.push(performance.now()))));
  starts.sort((left, right) => left - right);
  const gaps = starts.slice(1).map((startedAt, index) => startedAt - (starts[index] ?? startedAt));
  if (gaps.some((gap) => gap < intervalMs - 15)) {
    throw new Error(`Independent Redis clients received overlapping slots: ${gaps.join(", ")}ms`);
  }

  await redisClients[0]?.del(key);
  const deferGate = new TelegramSendGate(intervalMs, { redis: redisClients[0]!, key });
  const followerGate = new TelegramSendGate(intervalMs, { redis: redisClients[1]!, key });
  await deferGate.deferFor(400);
  const deferStartedAt = performance.now();
  await followerGate.waitForSlot();
  const deferWaitMs = performance.now() - deferStartedAt;
  if (deferWaitMs < 385) {
    throw new Error(`Shared retry_after cooldown ended too early: ${deferWaitMs}ms`);
  }

  console.log(JSON.stringify({
    status: "OK",
    independentRedisClients: redisClients.length,
    intervalMs,
    observedStartGapsMs: gaps.map((gap) => Math.round(gap)),
    sharedCooldownWaitMs: Math.round(deferWaitMs),
  }));
} finally {
  await redisClients[0]?.del(key).catch(() => undefined);
  await Promise.all(redisClients.map((redis) => redis.quit().catch(() => undefined)));
}
