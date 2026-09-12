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

  await redisClients[0]?.del(key);
  await deferGate.waitForSlot();
  let entered!: () => void;
  let release!: () => void;
  const firstSleepEntered = new Promise<void>((resolve) => { entered = resolve; });
  const firstSleepReleased = new Promise<void>((resolve) => { release = resolve; });
  let firstSleep = true;
  const lateFollower = new TelegramSendGate(intervalMs, {
    redis: redisClients[2]!, key,
    sleep: async (milliseconds) => {
      if (firstSleep) {
        firstSleep = false;
        entered();
        await firstSleepReleased;
      }
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    },
  });
  const follower = lateFollower.waitForSlot();
  // Attach immediately so a failed Redis call cannot become unhandled.
  void follower.catch(() => undefined);
  await Promise.race([
    firstSleepEntered,
    follower.then(() => { throw new Error("Follower unexpectedly admitted without waiting"); }),
  ]);
  await deferGate.deferFor(600);
  const extendedAt = performance.now();
  release();
  await follower;
  const extendedCooldownWaitMs = performance.now() - extendedAt;
  if (extendedCooldownWaitMs < 585) {
    throw new Error(`Already waiting follower ignored new cooldown: ${extendedCooldownWaitMs}ms`);
  }

  console.log(JSON.stringify({
    status: "OK",
    independentRedisClients: redisClients.length,
    intervalMs,
    observedStartGapsMs: gaps.map((gap) => Math.round(gap)),
    sharedCooldownWaitMs: Math.round(deferWaitMs),
    alreadyWaitingExtendedCooldownMs: Math.round(extendedCooldownWaitMs),
  }));
} finally {
  await redisClients[0]?.del(key).catch(() => undefined);
  await Promise.all(redisClients.map((redis) => redis.quit().catch(() => undefined)));
}
