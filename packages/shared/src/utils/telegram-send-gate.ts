export type TelegramRateGateRedis = {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
};

type GateDependencies = {
  redis: TelegramRateGateRedis;
  key: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

type GateWaiter = {
  priority: number;
  rank: number;
  sequence: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export const TELEGRAM_RATE_GATE_RESERVE_LUA = `
-- amb-telegram-rate-gate-reserve-v1
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local interval = math.max(0, tonumber(ARGV[1]) or 0)
local current = tonumber(redis.call("GET", KEYS[1])) or 0
local slot = math.max(now, current)
local nextSlot = slot + interval
local ttl = math.max(5000, nextSlot - now + interval * 4)
redis.call("SET", KEYS[1], tostring(nextSlot), "PX", tostring(ttl))
return slot - now
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
 * Keeps priority ordering inside each process while Redis atomically spaces
 * actual Telegram request starts across every API and worker process. Redis
 * TIME avoids clock-skew between processes. A Redis failure rejects the
 * waiter instead of silently bypassing the global limit.
 */
export class TelegramSendGate {
  private readonly waiters: GateWaiter[] = [];
  private draining = false;
  private sequence = 0;
  private nextLocalSelectionAt = 0;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly minimumIntervalMs: number,
    private readonly dependencies: GateDependencies,
  ) {
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep
      ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  waitForSlot(priority = 0, rank = 0): Promise<void> {
    const turn = new Promise<void>((resolve, reject) => {
      this.waiters.push({
        priority: Number.isFinite(priority) ? priority : 0,
        rank: Number.isFinite(rank) ? rank : 0,
        sequence: this.sequence++,
        resolve,
        reject,
      });
    });
    void this.drain();
    return turn;
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
    this.nextLocalSelectionAt = Math.max(this.nextLocalSelectionAt, this.now() + delay);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.waiters.length > 0) {
        const localDelay = Math.max(0, this.nextLocalSelectionAt - this.now());
        if (localDelay > 0) await this.sleep(localDelay);

        // Select after the local spacing delay so a fresh realtime advert can
        // overtake background edits already waiting in this process.
        this.waiters.sort((left, right) =>
          left.priority - right.priority
          || left.rank - right.rank
          || left.sequence - right.sequence);
        const waiter = this.waiters.shift();
        if (!waiter) continue;
        try {
          const rawDelay = await this.dependencies.redis.eval(
            TELEGRAM_RATE_GATE_RESERVE_LUA,
            1,
            this.dependencies.key,
            Math.max(0, Math.trunc(this.minimumIntervalMs)),
          );
          const globalDelay = redisInteger(rawDelay, "Telegram global rate gate returned an invalid delay");
          if (globalDelay > 0) await this.sleep(globalDelay);
          this.nextLocalSelectionAt = this.now() + Math.max(0, this.minimumIntervalMs);
          waiter.resolve();
        } catch (error) {
          waiter.reject(error);
        }
        await Promise.resolve();
      }
    } finally {
      this.draining = false;
      if (this.waiters.length > 0) void this.drain();
    }
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
