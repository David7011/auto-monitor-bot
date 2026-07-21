import { createHash } from "node:crypto";
import { ensureRedisReady, redisConnection } from "../lib/queues.js";

const WINDOW_SECONDS = 15 * 60;
const GLOBAL_MAX_ATTEMPTS = 120;
const CLIENT_MAX_ATTEMPTS = 30;
const ACCOUNT_CLIENT_MAX_FAILURES = 10;
const KEY_PREFIX = "amb:auth:login";

type LimitStatus = { blocked: boolean; retryAfterSeconds: number };

export async function loginRateLimitStatus(username: string, clientId: string): Promise<LimitStatus> {
  await ensureRedisReady();
  const keys = rateLimitKeys(username, clientId);
  const values = await redisConnection.multi()
    .get(keys.global)
    .ttl(keys.global)
    .get(keys.client)
    .ttl(keys.client)
    .get(keys.accountClient)
    .ttl(keys.accountClient)
    .exec();
  if (!values) throw new Error("Redis login rate-limit transaction failed");

  const globalCount = redisNumber(values[0]);
  const globalTtl = redisNumber(values[1]);
  const clientCount = redisNumber(values[2]);
  const clientTtl = redisNumber(values[3]);
  const accountFailures = redisNumber(values[4]);
  const accountTtl = redisNumber(values[5]);
  const blocked = globalCount >= GLOBAL_MAX_ATTEMPTS ||
    clientCount >= CLIENT_MAX_ATTEMPTS ||
    accountFailures >= ACCOUNT_CLIENT_MAX_FAILURES;
  return {
    blocked,
    retryAfterSeconds: blocked ? Math.max(1, globalTtl, clientTtl, accountTtl) : 0,
  };
}

export async function recordLoginAttempt(username: string, clientId: string): Promise<void> {
  await ensureRedisReady();
  const keys = rateLimitKeys(username, clientId);
  await incrementWindowCounters([keys.global, keys.client]);
}

export async function recordLoginFailure(username: string, clientId: string): Promise<void> {
  await ensureRedisReady();
  await incrementWindowCounters([rateLimitKeys(username, clientId).accountClient]);
}

export async function clearLoginFailures(username: string, clientId: string): Promise<void> {
  await ensureRedisReady();
  await redisConnection.del(rateLimitKeys(username, clientId).accountClient);
}

function rateLimitKeys(username: string, clientId: string): {
  global: string;
  client: string;
  accountClient: string;
} {
  const accountHash = digest(username.trim().toLocaleLowerCase("en-US"));
  const safeClientId = /^[a-f0-9]{64}$/u.test(clientId) ? clientId : digest(clientId || "unknown-client");
  return {
    global: `${KEY_PREFIX}:global`,
    client: `${KEY_PREFIX}:client:${safeClientId}`,
    accountClient: `${KEY_PREFIX}:account-client:${accountHash}:${safeClientId}`,
  };
}

async function incrementWindowCounters(keys: string[]): Promise<void> {
  const script = `
    for i, key in ipairs(KEYS) do
      local value = redis.call('INCR', key)
      if value == 1 then redis.call('EXPIRE', key, ARGV[1]) end
    end
    return 1
  `;
  await redisConnection.eval(script, keys.length, ...keys, String(WINDOW_SECONDS));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redisNumber(result: [Error | null, unknown] | undefined): number {
  if (!result || result[0]) return 0;
  const parsed = Number(result[1]);
  return Number.isFinite(parsed) ? parsed : 0;
}
