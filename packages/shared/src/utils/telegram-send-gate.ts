export type TelegramRateGateRedis = {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
};

type GateDependencies = {
  redis: TelegramRateGateRedis;
  key: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export const TELEGRAM_RATE_GATE_RESERVE_LUA = `
-- amb-telegram-rate-gate-reserve-v3
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local interval = math.max(0, tonumber(ARGV[1]) or 0)
local member = ARGV[2]
local lease = math.max(5000, tonumber(ARGV[3]) or 0)
local queued = redis.call("ZRANGE", KEYS[2], 0, -1)
for _, queuedMember in ipairs(queued) do
  local expiresAt = tonumber(redis.call("HGET", KEYS[3], queuedMember)) or 0
  if expiresAt <= now then
    redis.call("ZREM", KEYS[2], queuedMember)
    redis.call("HDEL", KEYS[3], queuedMember)
  end
end
redis.call("ZADD", KEYS[2], 0, member)
redis.call("HSET", KEYS[3], member, tostring(now + lease))
redis.call("PEXPIRE", KEYS[2], tostring(lease * 2))
redis.call("PEXPIRE", KEYS[3], tostring(lease * 2))
local current = tonumber(redis.call("GET", KEYS[1])) or 0
local head = redis.call("ZRANGE", KEYS[2], 0, 0)[1]
if head ~= member then
  if current > now then return current - now end
  return 25
end
-- Never grant a future slot: every waiter must recheck new retry_after and
-- a higher-priority waiter may join while this process sleeps.
if current > now then return current - now end
local nextSlot = now + interval
local ttl = math.max(5000, interval * 5)
redis.call("SET", KEYS[1], tostring(nextSlot), "PX", tostring(ttl))
redis.call("ZREM", KEYS[2], member)
redis.call("HDEL", KEYS[3], member)
return 0
`;

export const TELEGRAM_RATE_GATE_DEFER_LUA = `
-- amb-telegram-rate-gate-defer-v1
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local delay = math.max(0, tonumber(ARGV[1]) or 0)
local current = tonumber(redis.call("GET", KEYS[1])) or 0
local nextSlot = math.max(current, now + delay)
local ttl = math.max(5000, nextSlot - now + delay)
redis.call("SET", KEYS[1], tostring(nextSlot), "PX", tostring(ttl))
return nextSlot - now
`;

/**
 * Redis atomically orders and spaces Telegram request starts across every API
 * and worker process. Waiters have renewable expiry metadata, so a crashed
 * process cannot leave a permanent queue head. Redis TIME avoids clock-skew.
 * A Redis failure rejects instead of silently bypassing the global limit.
 */
export class TelegramSendGate {
  private sequence = 0;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  constructor(
    private readonly minimumIntervalMs: number,
    private readonly dependencies: GateDependencies,
  ) {
    void dependencies.now;
    this.sleep = dependencies.sleep
      ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async waitForSlot(priority = 0, rank = 0): Promise<void> {
    const member = telegramWaiterMember(priority, rank, this.instanceId, this.sequence++);
    const waiterLeaseMs = Math.max(5_000, Math.trunc(this.minimumIntervalMs) * 10);
    while (true) {
      const rawDelay = await this.dependencies.redis.eval(
        TELEGRAM_RATE_GATE_RESERVE_LUA,
        3,
        this.dependencies.key,
        `${this.dependencies.key}:waiters`,
        `${this.dependencies.key}:waiter-leases`,
        Math.max(0, Math.trunc(this.minimumIntervalMs)),
        member,
        waiterLeaseMs,
      );
      const delay = redisInteger(rawDelay, "Telegram global priority gate returned an invalid delay");
      if (delay === 0) return;
      // Renew before expiry even across a long retry_after cooldown.
      await this.sleep(Math.min(delay, Math.max(25, Math.floor(waiterLeaseMs / 2))));
    }
  }

  async deferFor(milliseconds: number): Promise<void> {
    const delay = Math.max(0, Math.trunc(milliseconds));
    if (delay === 0) return;
    await this.dependencies.redis.eval(
      TELEGRAM_RATE_GATE_DEFER_LUA,
      1,
      this.dependencies.key,
      delay,
    );
  }
}

export function telegramRateGateKey(botToken: string, chatId: string | number): string {
  const botId = botToken.split(":", 1)[0]?.replace(/[^0-9]/gu, "") || "unconfigured";
  const chat = String(chatId).replace(/[^0-9-]/gu, "_") || "unconfigured";
  return `amb:telegram:rate:v1:${botId}:${chat}`;
}

function redisInteger(value: unknown, message: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(message);
  return Math.max(0, Math.ceil(parsed));
}

function telegramWaiterMember(priority: number, rank: number, instanceId: string, sequence: number): string {
  const safePriority = Math.max(-999_999, Math.min(999_999, Math.trunc(Number.isFinite(priority) ? priority : 0)));
  const safeRank = Math.max(-8_000_000_000_000_000, Math.min(8_000_000_000_000_000, Math.trunc(Number.isFinite(rank) ? rank : 0)));
  const priorityKey = String(safePriority + 1_000_000).padStart(7, "0");
  const rankKey = String(safeRank + 8_000_000_000_000_000).padStart(17, "0");
  return `${priorityKey}:${rankKey}:${instanceId}:${String(sequence).padStart(10, "0")}`;
}
