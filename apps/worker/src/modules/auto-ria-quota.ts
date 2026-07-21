import { randomUUID } from "node:crypto";
import { env } from "../env.js";
import { redisConnection } from "../lib/queues.js";

export type AutoRiaQuotaKind = "search" | "info" | "paid";

export type AutoRiaQuotaDecision = {
  allowed: boolean;
  reason?: string;
  retryAfterSeconds?: number;
  totalUsed: number;
  hourlyUsed: number;
  totalLimit: number;
  hourlyLimit: number;
};

const ROLLING_WINDOW_MS = 60 * 60 * 1000;
const ROLLING_KEY = "auto-ria:quota:rolling-hour";
const memoryMonthlyCounters = new Map<string, number>();
let memoryRollingRequests: number[] = [];

export async function consumeAutoRiaQuota(kind: AutoRiaQuotaKind, cost = 1): Promise<AutoRiaQuotaDecision> {
  if (kind === "paid" && !env.AUTO_RIA_PAID_ENRICHMENT_ENABLED) {
    return denied("PAID_METHODS_DISABLED", 0, 0);
  }

  const normalizedCost = Math.max(1, Math.floor(cost));
  const now = new Date();
  const nowMs = now.getTime();
  const monthlyKey = autoRiaMonthlyQuotaKey(now);
  const totalTtlSeconds = secondsUntilMonthAfterNext(now);
  const args = [
    String(normalizedCost),
    String(env.AUTO_RIA_TOTAL_REQUEST_LIMIT),
    String(env.AUTO_RIA_HOURLY_REQUEST_LIMIT),
    String(env.AUTO_RIA_SOFT_RESERVE),
    String(env.AUTO_RIA_MIN_SEARCH_RESERVE),
    kind,
    String(nowMs),
    String(ROLLING_WINDOW_MS),
    String(totalTtlSeconds),
    `${process.pid}:${nowMs}:${randomUUID()}`,
  ];

  try {
    const raw = (await redisConnection.eval(QUOTA_LUA, 2, monthlyKey, ROLLING_KEY, ...args)) as unknown[];
    return {
      allowed: Number(raw[0]) === 1,
      reason: typeof raw[1] === "string" && raw[1] !== "OK" ? raw[1] : undefined,
      totalUsed: Number(raw[2] ?? 0),
      hourlyUsed: Number(raw[3] ?? 0),
      retryAfterSeconds: Number(raw[4] ?? 0) || undefined,
      totalLimit: env.AUTO_RIA_TOTAL_REQUEST_LIMIT,
      hourlyLimit: env.AUTO_RIA_HOURLY_REQUEST_LIMIT,
    };
  } catch {
    return consumeMemoryQuota(kind, normalizedCost, monthlyKey, nowMs);
  }
}

export function autoRiaMonthlyQuotaKey(now = new Date()): string {
  return `auto-ria:quota:${now.toISOString().slice(0, 7)}:total`;
}

function consumeMemoryQuota(
  kind: AutoRiaQuotaKind,
  cost: number,
  monthlyKey: string,
  nowMs: number,
): AutoRiaQuotaDecision {
  memoryRollingRequests = memoryRollingRequests.filter((timestamp) => timestamp > nowMs - ROLLING_WINDOW_MS);
  const totalUsed = memoryMonthlyCounters.get(monthlyKey) ?? 0;
  const hourlyUsed = memoryRollingRequests.length;
  const reason = quotaDenialReason(kind, cost, totalUsed, hourlyUsed);
  if (reason) {
    const retryAfterSeconds = reason === "HOURLY_LIMIT" ? rollingRetryAfterSeconds(memoryRollingRequests, nowMs) : undefined;
    return denied(reason, totalUsed, hourlyUsed, retryAfterSeconds);
  }

  memoryMonthlyCounters.set(monthlyKey, totalUsed + cost);
  for (let index = 0; index < cost; index += 1) memoryRollingRequests.push(nowMs);
  return {
    allowed: true,
    totalUsed: totalUsed + cost,
    hourlyUsed: hourlyUsed + cost,
    totalLimit: env.AUTO_RIA_TOTAL_REQUEST_LIMIT,
    hourlyLimit: env.AUTO_RIA_HOURLY_REQUEST_LIMIT,
  };
}

function quotaDenialReason(kind: AutoRiaQuotaKind, cost: number, totalUsed: number, hourlyUsed: number): string | undefined {
  const totalAfter = totalUsed + cost;
  const hourlyAfter = hourlyUsed + cost;
  const remainingAfter = env.AUTO_RIA_TOTAL_REQUEST_LIMIT - totalAfter;

  if (hourlyAfter > env.AUTO_RIA_HOURLY_REQUEST_LIMIT) return "HOURLY_LIMIT";
  if (totalAfter > env.AUTO_RIA_TOTAL_REQUEST_LIMIT) return "TOTAL_LIMIT";
  if (remainingAfter < env.AUTO_RIA_SOFT_RESERVE) return "SOFT_RESERVE";
  if (kind !== "search" && remainingAfter < env.AUTO_RIA_SOFT_RESERVE + env.AUTO_RIA_MIN_SEARCH_RESERVE) {
    return "SEARCH_RESERVE";
  }
  return undefined;
}

function denied(
  reason: string,
  totalUsed: number,
  hourlyUsed: number,
  retryAfterSeconds?: number,
): AutoRiaQuotaDecision {
  return {
    allowed: false,
    reason,
    retryAfterSeconds,
    totalUsed,
    hourlyUsed,
    totalLimit: env.AUTO_RIA_TOTAL_REQUEST_LIMIT,
    hourlyLimit: env.AUTO_RIA_HOURLY_REQUEST_LIMIT,
  };
}

function rollingRetryAfterSeconds(timestamps: number[], nowMs: number): number {
  const oldest = timestamps[0];
  if (oldest == null) return 1;
  return Math.max(1, Math.ceil((oldest + ROLLING_WINDOW_MS - nowMs) / 1000));
}

function secondsUntilMonthAfterNext(now: Date): number {
  const expiry = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1);
  return Math.max(24 * 60 * 60, Math.ceil((expiry - now.getTime()) / 1000));
}

const QUOTA_LUA = `
local cost = tonumber(ARGV[1])
local total_limit = tonumber(ARGV[2])
local hourly_limit = tonumber(ARGV[3])
local soft_reserve = tonumber(ARGV[4])
local min_search_reserve = tonumber(ARGV[5])
local kind = ARGV[6]
local now_ms = tonumber(ARGV[7])
local window_ms = tonumber(ARGV[8])
local total_ttl = tonumber(ARGV[9])
local member_prefix = ARGV[10]

redis.call("zremrangebyscore", KEYS[2], "-inf", now_ms - window_ms)
local total_used = tonumber(redis.call("get", KEYS[1]) or "0")
local hourly_used = tonumber(redis.call("zcard", KEYS[2]) or "0")
local total_after = total_used + cost
local hourly_after = hourly_used + cost
local remaining_after = total_limit - total_after
local reason = "OK"
local retry_after = 0

if hourly_after > hourly_limit then
  reason = "HOURLY_LIMIT"
  local oldest = redis.call("zrange", KEYS[2], 0, 0, "WITHSCORES")
  if oldest[2] then
    retry_after = math.max(1, math.ceil((tonumber(oldest[2]) + window_ms - now_ms) / 1000))
  else
    retry_after = 1
  end
elseif total_after > total_limit then
  reason = "TOTAL_LIMIT"
elseif remaining_after < soft_reserve then
  reason = "SOFT_RESERVE"
elseif kind ~= "search" and remaining_after < (soft_reserve + min_search_reserve) then
  reason = "SEARCH_RESERVE"
end

if reason ~= "OK" then
  return {0, reason, total_used, hourly_used, retry_after}
end

total_used = redis.call("incrby", KEYS[1], cost)
redis.call("expire", KEYS[1], total_ttl)
for index = 1, cost do
  redis.call("zadd", KEYS[2], now_ms, member_prefix .. ":" .. index)
end
redis.call("expire", KEYS[2], 7200)
return {1, "OK", total_used, hourly_used + cost, 0}
`;
