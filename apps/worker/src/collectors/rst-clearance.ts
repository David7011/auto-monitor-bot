import { env } from "../env.js";
import { redisConnection } from "../lib/queues.js";
import { log } from "../lib/log.js";

export const RST_CLEARANCE_REDIS_KEY = "rst:cf_clearance";

export const RST_OPERA_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 OPR/136.0.0.0";

/**
 * Cloudflare clearance for rst.ua, harvested from a manual pass in Opera GX.
 * Bots (curl, Node fetch, automated Chromium — including the Opera binary
 * under CDP) are held in an endless verification loop; only a human-passed
 * `cf_clearance` from the same egress IP opens the site.
 *
 * Resolution order: Redis (hot-swappable without a restart) first, then the
 * `RST_CF_CLEARANCE` env fallback. Returns a ready `Cookie` header value or
 * null when no clearance is configured.
 */
export async function getRstClearanceCookie(): Promise<string | null> {
  const fromEnv = (env.RST_CF_CLEARANCE ?? "").trim();
  try {
    const fromRedis = ((await redisConnection.get(RST_CLEARANCE_REDIS_KEY)) ?? "").trim();
    return normalizeClearanceCookie(fromRedis || fromEnv);
  } catch (error) {
    await log.warn(
      "collector",
      `RST clearance Redis read failed, using env fallback: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ).catch(() => undefined);
    return normalizeClearanceCookie(fromEnv);
  }
}

export function normalizeClearanceCookie(raw: string): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  return value.includes("=") ? value : `cf_clearance=${value}`;
}

/** Request headers that must accompany every rst.ua fetch. */
export function rstRequestHeaders(clearanceCookie: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": env.RST_USER_AGENT || RST_OPERA_USER_AGENT,
  };
  if (clearanceCookie) headers.Cookie = clearanceCookie;
  return headers;
}
