// Telegram global rate-gate slot acquisition without redis-cli.exe.
// Some Windows hosts block redis-cli.exe via Application Control while the
// bundled node runtime is allowed; this helper runs the exact same Lua gate
// through ioredis so the watchdog keeps global (worker-shared) pacing.
//
// Usage: node telegram-rate-gate.mjs <redisUrl> <key> <intervalMs>
// Exit 0 when the slot is acquired (waits in-process). Non-zero + stderr on
// Redis errors (the caller falls back to its emergency path).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "worker", "package.json"),
);
const { default: Redis } = require("ioredis");

const LUA = `local t=redis.call("TIME"); local n=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000); local i=math.max(0,tonumber(ARGV[1]) or 0); local c=tonumber(redis.call("GET",KEYS[1])) or 0; if c>n then return c-n end; local x=n+i; local ttl=math.max(5000,i*5); redis.call("SET",KEYS[1],tostring(x),"PX",tostring(ttl)); return 0`;

async function main() {
  const [redisUrl, key, intervalText] = process.argv.slice(2);
  const intervalMs = Math.max(250, Math.min(5000, Number.parseInt(intervalText ?? "", 10) || 1100));
  if (!redisUrl || !key) {
    console.error("usage: telegram-rate-gate.mjs <redisUrl> <key> <intervalMs>");
    process.exit(2);
  }
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 2000,
    commandTimeout: 3000,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });
  try {
    await redis.connect();
    for (;;) {
      const raw = await redis.eval(LUA, 1, key, String(intervalMs));
      const delayMs = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new Error("invalid Redis rate-gate response");
      }
      if (delayMs <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    redis.disconnect();
  }
}

await main();
